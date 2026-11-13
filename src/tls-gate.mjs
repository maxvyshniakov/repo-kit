// The TLS gate (README.md#tls-gate): does this Bun runtime still trust the
// compromised eMudhra intermediates? Incident write-up and test hosts:
// https://emudhra.we-have-a-problem.com/ (its roots.json lists the roots below).
//
//   bun src/tls-gate.mjs [--offline] [--require-registry]
//
// The gate is offline and deterministic, and takes milliseconds:
// - the runtime is Bun BUN_VERSION or later (1.3.14 trusted the chains);
// - none of the incident roots is in tls.rootCertificates, by SHA-256 fingerprint;
// - the bundles the CA variables Bun 1.4.4 reads name (NODE_EXTRA_CA_CERTS,
//   SSL_CERT_FILE, SSL_CERT_DIR) hold none of the incident roots either, and can
//   be read; stores it cannot read offline (NODE_USE_SYSTEM_CA, --use-system-ca,
//   --use-openssl-ca without SSL_CERT_FILE/SSL_CERT_DIR in NODE_OPTIONS or
//   BUN_OPTIONS) fail. REPO_KIT_TLS_ALLOW_CA_ENV=1 lets what the gate cannot
//   read through with a warning; an incident root fails regardless.
//
// The live probe is secondary and has a sunset (LIVE_PROBE_SUNSET): from that
// day on, the incident hosts are not asked. Its requests run side by side. It
// fails only on positive evidence of trust, an incident host that answers; a
// trust rejection passes, and a timeout, DNS error or other failure only warns,
// because it proves nothing either way. registry.npmjs.org must answer under
// --require-registry (publish); otherwise its failure warns too.
//
// It runs from the action's checkout before any install: Node's standard
// library and ./token.mjs only.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { pathToFileURL } from "node:url";

import { BUN_VERSION, compareBunVersions } from "./token.mjs";

/** From this day the live probe no longer asks the incident hosts; remove it then (repo-kit#17). */
export const LIVE_PROBE_SUNSET = "2027-02-01";

/** The roots the compromised intermediates chain to, from the write-up's roots.json. */
export const INCIDENT_ROOTS = [
  { name: "emSign ECC Root CA - G3", sha256: "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B" },
  { name: "emSign Root TLS CA - G3", sha256: "7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D" },
  { name: "emSign Root CS CA - G3", sha256: "F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5" },
  // The Sectigo cross-signs of the intermediates chain here; Mozilla and Chrome removed it.
  { name: "AAA Certificate Services", sha256: "D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4" },
];

export const ALLOW_CA_ENV = "REPO_KIT_TLS_ALLOW_CA_ENV";
const CA_FLAGS = /(^|\s)--use-(system|openssl)-ca(\s|$)/;

export const INCIDENT_HOSTS = ["dv-g3b", "dv-g3c", "ov-g3b", "ov-g3c", "ev-g3b", "ev-g3c"]
  .flatMap(id => [`${id}-emudhra.we-have-a-problem.com`, `${id}-aaa-emudhra.we-have-a-problem.com`]);
export const REGISTRY = "registry.npmjs.org";
const TRUST_ERRORS = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_REVOKED",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERT_UNTRUSTED",
]);
const TIMEOUT_MS = 10000;

// PEM certificates, also OpenSSL's TRUSTED CERTIFICATE form (the DER, then trust settings), which OpenSSL and BoringSSL load.
const PEM = /-----BEGIN (TRUSTED )?CERTIFICATE-----([^-]+)-----END \1?CERTIFICATE-----/g;

/** The DER element at the start of `der` (a certificate's outer SEQUENCE), without what follows it. */
function firstElement(der) {
  if (der.length < 2) return der;
  const first = der[1];
  if (first < 0x80) return der.subarray(0, 2 + first);
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + der[2 + i];
  return der.subarray(0, 2 + count + length);
}

/** The certificates in a PEM text that parse, as X509Certificate. */
export function certificatesIn(text) {
  const certificates = [];
  for (const [, trusted, body] of text.matchAll(PEM)) {
    try {
      const der = Buffer.from(body.replace(/\s+/g, ""), "base64");
      certificates.push(new X509Certificate(trusted ? firstElement(der) : der));
    } catch {
      // Not a certificate this gate can parse; it cannot add trust Bun would use either.
    }
  }
  return certificates;
}

const fingerprint = certificate => certificate.fingerprint256.replaceAll(":", "");
const incidentRootOf = (certificate, roots) => roots.find(root => root.sha256 === fingerprint(certificate));
function present(pems, roots) {
  const have = new Set(pems.flatMap(pem => certificatesIn(pem).map(fingerprint)));
  return roots.filter(root => have.has(root.sha256));
}

// The variables Bun 1.4.4 reads for extra trust, with or without --use-openssl-ca (tried against a local
// server). It ignores npm_config_cafile and npm_config_ca, so they are not inspected.
const CA_FILE_VARIABLES = new Set(["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]);
// The names OpenSSL's hashed-directory lookup loads (<subject hash>.<n>; .r<n> are CRLs), plus the .pem/.crt
// files such a directory keeps beside them or in place of them.
const CERT_DIR_ENTRY = /^([0-9a-f]{8}\.\d+|.*\.(pem|crt))$/i;

/**
 * The environment's CA-adding settings, each { name } with what to read: `files`
 * or `dir`, `files: []` for nothing of its own (--use-openssl-ca reads
 * SSL_CERT_FILE and SSL_CERT_DIR), `files: null` for a store the gate cannot read.
 */
export function caEnvironment(env) {
  const found = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    const upper = name.toUpperCase();
    if (CA_FILE_VARIABLES.has(upper)) found.push({ name, files: [value] });
    else if (upper === "SSL_CERT_DIR") found.push({ name, dir: value });
    else if (upper === "NODE_USE_SYSTEM_CA" && value !== "0") found.push({ name, files: null });
    else if ((upper === "NODE_OPTIONS" || upper === "BUN_OPTIONS") && CA_FLAGS.test(value)) {
      if (/--use-system-ca/.test(value)) found.push({ name, files: null });
      // --use-openssl-ca reads SSL_CERT_FILE and SSL_CERT_DIR, read on their own; without them OpenSSL's default store.
      else found.push({ name, files: env.SSL_CERT_FILE || env.SSL_CERT_DIR ? [] : null, store: "OpenSSL's default store" });
    }
  }
  return found;
}

/**
 * The bundles a setting names: { bundles: [{ path, certificates }], unreadable:
 * [{ path, reason }] }. A path the gate cannot read, or that holds no
 * certificate, never stops it from reading the others.
 */
function readBundles(setting, cache) {
  const read = file => {
    if (!cache.has(file)) cache.set(file, certificatesIn(fs.readFileSync(file, "utf8")));
    return cache.get(file);
  };
  const bundles = [];
  const unreadable = [];
  const cannotRead = (where, error) => unreadable.push({ path: where, reason: `which the gate cannot read (${error.code ?? error.message})` });
  const noCertificate = where => unreadable.push({ path: where, reason: "which holds no certificate the gate can parse" });
  if (setting.dir) {
    // Like OpenSSL, a list of directories.
    for (const dir of setting.dir.split(path.delimiter).filter(Boolean)) {
      let entries;
      try {
        entries = fs.readdirSync(dir).filter(entry => CERT_DIR_ENTRY.test(entry)).sort();
      } catch (error) {
        cannotRead(dir, error);
        continue;
      }
      let count = 0;
      for (const entry of entries) {
        const file = path.join(dir, entry);
        if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
        try {
          const certificates = read(file);
          count += certificates.length;
          bundles.push({ path: file, certificates });
        } catch (error) {
          cannotRead(file, error);
        }
      }
      if (!count) noCertificate(dir);
    }
    return { bundles, unreadable, label: setting.dir };
  }
  for (const file of setting.files) {
    let certificates;
    try {
      certificates = read(file);
    } catch (error) {
      cannotRead(file, error);
      continue;
    }
    if (!certificates.length) noCertificate(file);
    bundles.push({ path: file, certificates });
  }
  return { bundles, unreadable, label: setting.files.join(", ") };
}

/**
 * The offline gate: { failures, warnings, passes }, lists of lines.
 * `bunVersion` is process.versions.bun, undefined outside Bun.
 */
export function offlineGate({ bunVersion = process.versions.bun, rootCertificates = tls.rootCertificates, env = process.env, roots = INCIDENT_ROOTS } = {}) {
  const failures = [];
  const warnings = [];
  const passes = [];
  if (!bunVersion) failures.push(`not running on Bun: run the gate with bun, ${BUN_VERSION} or later`);
  else if (compareBunVersions(bunVersion, BUN_VERSION) < 0) failures.push(`Bun ${bunVersion} trusts the compromised eMudhra chains; ${BUN_VERSION} or later rejects them`);
  else passes.push(`Bun ${bunVersion} (${BUN_VERSION} or later)`);

  const trusted = present(rootCertificates, roots);
  for (const root of trusted) failures.push(`the runtime's root store holds ${root.name} (SHA-256 ${root.sha256})`);
  if (!trusted.length) passes.push(`none of the ${roots.length} incident roots is among the runtime's ${rootCertificates.length} roots`);

  // What the gate cannot read fails, unless ALLOW_CA_ENV lets it through unchecked.
  const allowed = env[ALLOW_CA_ENV] === "1";
  const unverifiable = line => allowed
    ? warnings.push(`${line}; allowed unchecked by ${ALLOW_CA_ENV}=1`)
    : failures.push(`${line}; unset it, or set ${ALLOW_CA_ENV}=1 to allow it unchecked`);
  const cache = new Map();
  for (const setting of caEnvironment(env)) {
    if (setting.files === null) {
      unverifiable(`${setting.name} adds ${setting.store ?? "the operating system's store"}, which the gate cannot read`);
      continue;
    }
    if (!setting.files?.length && !setting.dir) continue;
    const read = readBundles(setting, cache);
    for (const { path: where, reason } of read.unreadable) unverifiable(`${setting.name} names ${where}, ${reason}`);
    let held = 0;
    for (const bundle of read.bundles) {
      for (const certificate of bundle.certificates) {
        const root = incidentRootOf(certificate, roots);
        if (!root) continue;
        held++;
        failures.push(`${setting.name}: ${bundle.path} holds ${root.name} (subject ${certificate.subject.replaceAll("\n", ", ")}; SHA-256 ${root.sha256})`);
      }
    }
    const count = read.bundles.reduce((sum, bundle) => sum + bundle.certificates.length, 0);
    if (!held && !read.unreadable.length) passes.push(`${setting.name}: ${count} certificate${count === 1 ? "" : "s"} in ${read.label}, no incident root`);
  }
  return { failures, warnings, passes };
}

/** One request with the runtime's fetch or https client: resolves when the host answered, rejects with its error. */
export async function request(api, host, timeoutMs = TIMEOUT_MS) {
  if (api === "fetch") {
    const response = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await response.body?.cancel();
    return;
  }
  await new Promise((resolve, reject) => {
    const req = https.get(`https://${host}/`, { signal: AbortSignal.timeout(timeoutMs) }, response => {
      response.resume();
      resolve();
    });
    req.on("error", reject);
  });
}

// Node's and Bun's string codes (ENOTFOUND, CERT_REVOKED); an abort's DOMException has a number there, so its name.
const errorCode = error => [error?.cause?.code, error?.code].find(code => typeof code === "string") ?? error?.name ?? "error";

/**
 * The live probe: each host with both clients, all side by side:
 * { failures, warnings, passes }. From LIVE_PROBE_SUNSET on it asks only the
 * registry, and that only under requireRegistry.
 */
export async function liveProbe({ probe = request, today = new Date().toISOString().slice(0, 10), requireRegistry = false, hosts = INCIDENT_HOSTS } = {}) {
  const failures = [];
  const warnings = [];
  const passes = [];
  const sunset = today >= LIVE_PROBE_SUNSET;
  if (sunset) warnings.push(`the live probe of the incident hosts is past its sunset (${LIVE_PROBE_SUNSET}) and no longer runs; remove it (repo-kit#17)`);
  const targets = [...(sunset && !requireRegistry ? [] : [REGISTRY]), ...(sunset ? [] : hosts)];
  const results = await Promise.all(targets.flatMap(host => ["fetch", "https"].map(async api => {
    try {
      await probe(api, host);
      return { api, host, answered: true };
    } catch (error) {
      return { api, host, answered: false, code: errorCode(error), message: error?.message ?? String(error) };
    }
  })));
  for (const { api, host, answered, code, message } of results) {
    const label = `${api} ${host}`;
    if (host === REGISTRY) {
      if (answered) passes.push(`${label}: valid chain`);
      else (requireRegistry ? failures : warnings).push(`${label}: ${code} ${message}`);
    } else if (answered) failures.push(`${label}: answered, so this runtime trusts a compromised chain`);
    else if (TRUST_ERRORS.has(code)) passes.push(`${label}: rejected (${code})`);
    else warnings.push(`${label}: ${code} ${message}; proves nothing either way`);
  }
  return { failures, warnings, passes };
}

/** Runs the gate, then the live probe unless --offline, printing each line; resolves to the exit code. */
export async function runGate(args = [], { offline = offlineGate, live = liveProbe, print = console.log, env = process.env } = {}) {
  const started = performance.now();
  const report = (result, phase) => {
    for (const line of result.passes) print(`PASS ${phase}: ${line}`);
    for (const line of result.warnings) print(`${env.GITHUB_ACTIONS === "true" ? "::warning title=TLS gate::" : "WARN "}${phase}: ${line}`);
    for (const line of result.failures) print(`FAIL ${phase}: ${line}`);
  };
  const gate = offline({ env });
  report(gate, "gate");
  let failed = gate.failures.length > 0;
  if (!failed && !args.includes("--offline")) {
    const probe = await live({ requireRegistry: args.includes("--require-registry") });
    report(probe, "live probe");
    failed = probe.failures.length > 0;
  }
  print(`TLS gate ${failed ? "failed" : "passed"} in ${Math.round(performance.now() - started)} ms`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runGate(process.argv.slice(2));
}
