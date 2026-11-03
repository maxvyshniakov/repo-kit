// Independent-consumer check for the packed packages.
//
// Packs each released package the way it is published, installs the archives
// into a throwaway project in the OS temporary directory (so no workspace
// node_modules can leak into module resolution) and checks that:
//   - every export target is in the tarball, no test files ship, and the
//     packed manifest is publishable (no workspace: ranges, not private);
//   - every JavaScript entrypoint imports in plain Node;
//   - the declarations type-check under module/moduleResolution "nodenext"
//     with skipLibCheck disabled.
// Then it runs the repository's probes (server rendering, a bundler build, ...).
//
//   repo-kit packed-consumer [--keep]   run `bun run build` first; --keep prints the project's path
//
// repo-kit.config.mjs:
//   packedConsumer: {
//     versionSources: ["package.json", "apps/storybook/package.json"], // where exact versions are pinned
//     dependencies: ["vite"], devDependencies: ["@types/node"],     // more consumer packages, at their pins
//     types: false,                                                  // the packages ship no declarations
//     probes: [async ({ consumerDir, run, ok, fail, writeFile, pinned, packages, args }) => {}],
//   }
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJson, releasedPackages } from "./config.mjs";

const TEST_FILE = /(^|\/)(__tests__|fixtures)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/;

export function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

export function runtimeTarget(value) {
  if (typeof value === "string") return value;
  return value?.import ?? value?.default ?? null;
}

/** The bare specifiers of a manifest's JavaScript entrypoints. */
export function entrySpecifiers(manifest) {
  return Object.entries(manifest.exports ?? {}).flatMap(([subpath, value]) => {
    const target = runtimeTarget(value);
    if (!target || /\.(css|json)$/.test(target) || subpath.includes("*")) return [];
    return [subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`];
  });
}

/** Problems with a packed tarball's listing and manifest. */
export function tarballIssues({ manifest, packedManifest, files }) {
  const issues = [];
  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    for (const target of exportTargets(value)) {
      if (!target.includes("*") && !files.has(target.replace(/^\.\//, ""))) {
        issues.push(`${manifest.name} export "${subpath}" points at ${target}, which is not in the tarball`);
      }
    }
  }
  const testFiles = [...files].filter(file => TEST_FILE.test(file));
  if (testFiles.length) issues.push(`${manifest.name} ships test files: ${testFiles.slice(0, 5).join(", ")}${testFiles.length > 5 ? ", ..." : ""}`);
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(packedManifest[field] ?? {})) {
      if (String(range).startsWith("workspace:")) issues.push(`${manifest.name} ${field}.${name} is ${range} in the tarball`);
    }
  }
  if (packedManifest.private) issues.push(`${manifest.name}: the packed manifest is private and cannot be published`);
  return issues;
}

/** A lookup of the exact versions the repository pins, first source first. */
export function pinnedVersions(manifests) {
  return name => {
    for (const manifest of manifests) {
      const version = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
      if (version && /^\d+\.\d+\.\d+/.test(version)) return version;
    }
    throw new Error(`No exact version of ${name} is pinned in the repository manifests.`);
  };
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...options.env },
  });
  if (result.error) throw result.error;
  return result;
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** Resolves to whether every check passed. */
export async function runPackedConsumer(config, { keep = false, args = [] } = {}) {
  const { root } = config;
  const options = config.packedConsumer;
  const failures = [];
  const fail = message => {
    failures.push(message);
    console.error(`  FAIL ${message}`);
  };
  const ok = message => console.log(`  ok ${message}`);
  const released = releasedPackages(root);
  const sources = (options.versionSources ?? [...new Set([...released.map(pkg => path.join(pkg.path, "package.json")), "package.json"])])
    .map(file => readJson(path.join(root, file)));
  const pinned = pinnedVersions(sources);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-consumer-"));
  const tarballDir = path.join(workDir, "tarballs");
  const consumerDir = path.join(workDir, "consumer");
  fs.mkdirSync(tarballDir);
  fs.mkdirSync(consumerDir);
  try {
    console.log(`Packing into ${tarballDir}`);
    const packages = released.map(pkg => {
      const distTargets = Object.values(pkg.manifest.exports ?? {}).flatMap(exportTargets).filter(target => target.startsWith("./dist/"));
      if (distTargets.length && !fs.existsSync(path.join(pkg.dir, "dist"))) throw new Error(`${pkg.name} has no dist; run \`bun run build\` first.`);
      const packed = run("bun", ["pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballDir], { cwd: pkg.dir });
      if (packed.status !== 0) throw new Error(`bun pm pack failed for ${pkg.name}:\n${packed.stderr}`);
      const tarball = packed.stdout.trim().split("\n").at(-1);
      if (!fs.existsSync(tarball)) throw new Error(`bun pm pack did not produce ${tarball}`);
      const files = new Set(run("tar", ["-tzf", tarball]).stdout.split("\n").filter(Boolean).map(entry => entry.replace(/^package\//, "")));
      const packedManifest = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"]).stdout);
      console.log(`  ${pkg.name}: ${path.basename(tarball)} (${files.size} files)`);
      return { ...pkg, packedManifest, tarball, files };
    });

    console.log("\nTarball contents");
    const before = failures.length;
    for (const pkg of packages) for (const issue of tarballIssues(pkg)) fail(issue);
    if (failures.length === before) ok("every export target is packed, no test files ship, the manifests are publishable");

    console.log(`\nInstalling a consumer in ${consumerDir}`);
    const names = new Set(packages.map(pkg => pkg.name));
    const peers = [...new Set(packages.flatMap(pkg => Object.keys(pkg.manifest.peerDependencies ?? {})))].filter(name => !names.has(name));
    const at = list => Object.fromEntries(list.map(name => [name, pinned(name)]));
    // Declarations are checked unless the config says the packages ship none
    // (types: false); then typescript must be pinned, so a range cannot skip it.
    const checkTypes = options.types !== false;
    const typePackages = [
      ...(checkTypes ? ["typescript"] : []),
      ...peers.map(peer => `@types/${peer.replace("@", "").replace("/", "__")}`).filter(name => {
        try {
          pinned(name);
          return true;
        } catch {
          return false;
        }
      }),
    ];
    const archives = Object.fromEntries(packages.map(pkg => [pkg.name, `file:${pkg.tarball}`]));
    writeFile(path.join(consumerDir, "package.json"), `${JSON.stringify({
      name: "packed-consumer",
      private: true,
      type: "module",
      dependencies: { ...archives, ...at(peers), ...at(options.dependencies ?? []) },
      devDependencies: at([...typePackages, ...(options.devDependencies ?? [])]),
      // A package that depends on another released here gets the local archive too.
      overrides: archives,
    }, null, 2)}\n`);
    // Dependencies on other @maxvyshniakov packages come from the private registry.
    if (fs.existsSync(path.join(root, "bunfig.toml"))) fs.copyFileSync(path.join(root, "bunfig.toml"), path.join(consumerDir, "bunfig.toml"));
    const install = run("bun", ["install", "--no-progress"], { cwd: consumerDir });
    if (install.status !== 0) throw new Error(`bun install failed in the consumer:\n${install.stdout}\n${install.stderr}`);
    ok("installed the archives");

    console.log("\nPlain Node imports");
    const specifiers = packages.flatMap(pkg => entrySpecifiers(pkg.manifest));
    for (const specifier of specifiers) {
      const result = run("node", ["--input-type=module", "-e", `const m = await import(${JSON.stringify(specifier)}); if (!Object.keys(m).length) throw new Error("no exports");`], { cwd: consumerDir });
      if (result.status === 0) ok(`import("${specifier}")`);
      else fail(`import("${specifier}"): ${result.stderr.trim().split("\n").filter(Boolean).at(-1)}`);
    }

    if (checkTypes) {
      console.log("\nDeclarations");
      writeFile(path.join(consumerDir, "index.ts"), `${specifiers.map((specifier, index) => `import * as entry${index} from ${JSON.stringify(specifier)};`).join("\n")}\nexport const entries = [${specifiers.map((_, index) => `entry${index}`).join(", ")}];\n`);
      writeFile(path.join(consumerDir, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "ES2022", strict: true, noEmit: true, skipLibCheck: false, lib: ["ES2023", "DOM", "DOM.Iterable"], types: [] },
        files: ["index.ts"],
      }, null, 2)}\n`);
      const typecheck = run(path.join(consumerDir, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], { cwd: consumerDir });
      if (typecheck.status === 0) ok('declarations type-check under "nodenext" without skipLibCheck');
      else fail(`tsc (nodenext):\n${typecheck.stdout}${typecheck.stderr}`);
    }

    for (const probe of options.probes ?? []) {
      await probe({ root, workDir, consumerDir, packages, specifiers, run, ok, fail, writeFile, pinned, args });
    }
  } catch (error) {
    fail(error.message);
  } finally {
    if (keep) console.log(`\nKept ${workDir}`);
    else fs.rmSync(workDir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\nPacked consumer check failed (${failures.length}):`);
    for (const failure of failures) console.error(`  ${failure}`);
    return false;
  }
  console.log("\nPacked consumer check passed.");
  return true;
}
