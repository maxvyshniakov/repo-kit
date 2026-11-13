import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";

import { ALLOW_CA_ENV, INCIDENT_HOSTS, INCIDENT_ROOTS, LIVE_PROBE_SUNSET, REGISTRY, caEnvironment, liveProbe, offlineGate, runGate } from "../src/tls-gate.mjs";
import { TLS_GATE } from "../src/tls.mjs";

// The four roots of the write-up's roots.json, public certificates.
const incidentPems = fs.readFileSync(new URL("./incident-roots.pem", import.meta.url), "utf8")
  .match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g);
const incidentPem = name => incidentPems.find(pem => new X509Certificate(pem).subject.includes(`CN=${name}`));
const clean = { bunVersion: "1.4.4", rootCertificates: tls.rootCertificates, env: {} };

test("the incident roots are named by the fingerprints of their certificates", () => {
  assert.deepEqual(incidentPems.map(pem => new X509Certificate(pem).fingerprint256.replaceAll(":", "")).sort(), INCIDENT_ROOTS.map(root => root.sha256).sort());
});

test("the gate passes a current Bun with its own root store and no CA environment", () => {
  const result = offlineGate(clean);
  assert.deepEqual(result.failures, []);
  assert.match(result.passes.join("\n"), /Bun 1\.4\.4/);
  assert.match(result.passes.join("\n"), /none of the 4 incident roots/);
});

test("the gate fails a Bun older than 1.4.4, and a runtime that is not Bun", () => {
  assert.match(offlineGate({ ...clean, bunVersion: "1.3.14" }).failures.join("\n"), /Bun 1\.3\.14 trusts the compromised eMudhra chains; 1\.4\.4 or later/);
  assert.match(offlineGate({ ...clean, bunVersion: undefined }).failures.join("\n"), /not running on Bun/);
  assert.deepEqual(offlineGate({ ...clean, bunVersion: "1.5.0" }).failures, []);
});

test("the gate fails a root store that holds an incident root, naming it", () => {
  const aaa = incidentPem("AAA Certificate Services");
  const failures = offlineGate({ ...clean, rootCertificates: [...tls.rootCertificates, aaa] }).failures;
  assert.equal(failures.length, 1);
  assert.match(failures[0], /root store holds AAA Certificate Services \(SHA-256 D7A7A0FB/);
});

test("a CA-adding environment fails the gate unless allowed; allowed, its bundles must hold no incident root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-tls-"));
  try {
    const safe = path.join(dir, "safe.pem");
    fs.writeFileSync(safe, tls.rootCertificates.slice(0, 3).join("\n"));
    const bad = path.join(dir, "bad.pem");
    fs.writeFileSync(bad, `${tls.rootCertificates[0]}\n${incidentPem("emSign ECC Root CA - G3")}`);
    const certs = path.join(dir, "certs");
    fs.mkdirSync(certs);
    fs.writeFileSync(path.join(certs, "a.0"), incidentPem("AAA Certificate Services"));

    for (const env of [{ NODE_EXTRA_CA_CERTS: safe }, { SSL_CERT_FILE: safe }, { SSL_CERT_DIR: dir }, { NODE_USE_SYSTEM_CA: "1" },
      { NODE_OPTIONS: "--use-system-ca" }, { BUN_OPTIONS: "--max-old-space-size=1 --use-openssl-ca" }, { npm_config_cafile: safe }, { NPM_CONFIG_CA: tls.rootCertificates[0] }]) {
      const [name] = Object.keys(env);
      assert.match(offlineGate({ ...clean, env }).failures.join("\n"), new RegExp(`${name} adds certificate authorities.*${ALLOW_CA_ENV}=1`), name);
    }
    // Empty or switched-off settings add nothing.
    assert.deepEqual(caEnvironment({ NODE_EXTRA_CA_CERTS: "", NODE_USE_SYSTEM_CA: "0", NODE_OPTIONS: "--max-old-space-size=4096" }), []);

    const allow = { [ALLOW_CA_ENV]: "1" };
    assert.deepEqual(offlineGate({ ...clean, env: { ...allow, NODE_EXTRA_CA_CERTS: safe, SSL_CERT_FILE: safe, NODE_OPTIONS: "--use-openssl-ca" } }).failures, []);
    assert.match(offlineGate({ ...clean, env: { ...allow, NODE_EXTRA_CA_CERTS: bad } }).failures.join("\n"), /NODE_EXTRA_CA_CERTS adds emSign/);
    assert.match(offlineGate({ ...clean, env: { ...allow, SSL_CERT_DIR: certs } }).failures.join("\n"), /SSL_CERT_DIR adds AAA Certificate Services/);
    assert.match(offlineGate({ ...clean, env: { ...allow, SSL_CERT_FILE: path.join(dir, "missing.pem") } }).failures.join("\n"), /SSL_CERT_FILE: cannot read its certificates/);
    // The OS store cannot be read offline: allowed, it only warns.
    const system = offlineGate({ ...clean, env: { ...allow, NODE_USE_SYSTEM_CA: "1" } });
    assert.deepEqual(system.failures, []);
    assert.match(system.warnings.join("\n"), /NODE_USE_SYSTEM_CA adds the operating system's store/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A fake network: `answers` maps host to "ok" or an error code, the rest reject with a trust error.
const network = (answers = {}) => {
  const asked = [];
  const probe = async (api, host) => {
    asked.push(`${api} ${host}`);
    const answer = answers[host] ?? (host === REGISTRY ? "ok" : "UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    if (answer === "ok") return;
    throw Object.assign(new Error(`fake ${answer}`), { code: answer });
  };
  return { asked, probe };
};
const today = "2026-11-13";

test("the live probe asks every host with both clients and passes when the incident hosts are rejected", async () => {
  const { asked, probe } = network();
  const result = await liveProbe({ probe, today });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(asked.length, 2 * (1 + INCIDENT_HOSTS.length));
  assert.equal(INCIDENT_HOSTS.length, 12);
});

test("the live probe fails only on a trusted bad chain: an incident host that answers", async () => {
  const { probe } = network({ [INCIDENT_HOSTS[1]]: "ok" });
  const result = await liveProbe({ probe, today });
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0], new RegExp(`${INCIDENT_HOSTS[1]}: answered, so this runtime trusts a compromised chain`));
});

test("timeouts, DNS errors and other failures of an incident host only warn", async () => {
  const { probe } = network({ [INCIDENT_HOSTS[0]]: "ETIMEDOUT", [INCIDENT_HOSTS[2]]: "ENOTFOUND", [INCIDENT_HOSTS[3]]: "ECONNRESET" });
  const timeout = async (api, host) => {
    if (host === INCIDENT_HOSTS[4]) throw new DOMException("The operation timed out.", "TimeoutError");
    return probe(api, host);
  };
  const result = await liveProbe({ probe: timeout, today });
  assert.deepEqual(result.failures, []);
  assert.equal(result.warnings.length, 8);
  assert.match(result.warnings.join("\n"), /ETIMEDOUT .*proves nothing either way/);
  assert.match(result.warnings.join("\n"), /ENOTFOUND/);
  assert.match(result.warnings.join("\n"), /TimeoutError/);
});

test("the probes run side by side: the slowest host bounds the probe, not the sum", async () => {
  let running = 0;
  let most = 0;
  const probe = async (api, host) => {
    running++;
    most = Math.max(most, running);
    await new Promise(resolve => setImmediate(resolve));
    running--;
    if (host !== REGISTRY) throw Object.assign(new Error("rejected"), { code: "CERT_REVOKED" });
  };
  await liveProbe({ probe, today });
  assert.equal(most, 2 * (1 + INCIDENT_HOSTS.length));
});

test("the registry must answer for publish (--require-registry); elsewhere its failure warns", async () => {
  const { probe } = network({ [REGISTRY]: "ENOTFOUND" });
  assert.match((await liveProbe({ probe, today, requireRegistry: true })).failures.join("\n"), /registry\.npmjs\.org: ENOTFOUND/);
  const ordinary = await liveProbe({ probe, today });
  assert.deepEqual(ordinary.failures, []);
  assert.match(ordinary.warnings.join("\n"), /registry\.npmjs\.org: ENOTFOUND/);
});

test("after its sunset the live probe asks no incident host, and the registry only for publish", async () => {
  assert.equal(LIVE_PROBE_SUNSET, "2027-02-01");
  const after = network({ [INCIDENT_HOSTS[0]]: "ok" });
  const result = await liveProbe({ probe: after.probe, today: LIVE_PROBE_SUNSET });
  assert.deepEqual(after.asked, []);
  assert.deepEqual(result.failures, []);
  assert.match(result.warnings.join("\n"), /past its sunset \(2027-02-01\)/);
  const publish = network();
  await liveProbe({ probe: publish.probe, today: "2027-03-01", requireRegistry: true });
  assert.deepEqual(publish.asked, [`fetch ${REGISTRY}`, `https ${REGISTRY}`]);
  const before = network();
  await liveProbe({ probe: before.probe, today: "2027-01-31" });
  assert.equal(before.asked.length, 26);
});

test("runGate: a failed offline gate fails without the live probe; --offline skips it; warnings do not fail", async () => {
  const lines = [];
  const print = line => lines.push(line);
  let probed = 0;
  const live = async () => (probed++, { failures: [], warnings: ["fetch x: ETIMEDOUT"], passes: [] });
  assert.equal(await runGate([], { offline: () => ({ failures: ["old Bun"], warnings: [], passes: [] }), live, print, env: {} }), 1);
  assert.equal(probed, 0);
  assert.match(lines.join("\n"), /FAIL gate: old Bun/);
  const ok = () => ({ failures: [], warnings: [], passes: ["Bun"] });
  assert.equal(await runGate(["--offline"], { offline: ok, live, print, env: {} }), 0);
  assert.equal(probed, 0);
  lines.length = 0;
  assert.equal(await runGate([], { offline: ok, live, print, env: { GITHUB_ACTIONS: "true" } }), 0);
  assert.equal(probed, 1);
  assert.match(lines.join("\n"), /::warning title=TLS gate::live probe: fetch x: ETIMEDOUT/);
  assert.match(lines.at(-1), /^TLS gate passed in \d+ ms$/);
  assert.equal(await runGate([], { offline: ok, live: async () => ({ failures: ["trusted"], warnings: [], passes: [] }), print, env: {} }), 1);
  // The registry requirement reaches the probe.
  let required;
  await runGate(["--require-registry"], { offline: ok, live: async options => ((required = options.requireRegistry), { failures: [], warnings: [], passes: [] }), print, env: {} });
  assert.equal(required, true);
});

test("on this Bun the offline gate passes in milliseconds and an unallowed CA variable fails it", { skip: spawnSync("bun", ["--version"]).status !== 0 && "no bun" }, () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (caEnvironment({ [name]: env[name] }).length || name === ALLOW_CA_ENV) delete env[name];
  const passed = spawnSync("bun", [TLS_GATE, "--offline"], { env, encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /PASS gate: none of the 4 incident roots/);
  const injected = spawnSync("bun", [TLS_GATE, "--offline"], { env: { ...env, SSL_CERT_FILE: TLS_GATE }, encoding: "utf8" });
  assert.equal(injected.status, 1);
  assert.match(injected.stdout, /FAIL gate: SSL_CERT_FILE adds certificate authorities/);
});
