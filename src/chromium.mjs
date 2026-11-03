// Chromium with software compositing for the local release gate.
//
// The Linux CI runner has no GPU: its Chromium composites in software (Sid-Kit
// starts agent-browser's with --disable-gpu there). On this Mac headless
// Chromium composites on the GPU (Metal) unless told otherwise, and two Sid-Kit
// defects (ScrollArea edge fades, a rounded scroll clip) broke only under
// software compositing: a Mac run passed them, CI caught them.
//
// The gate cannot edit every launch site in every repository (Playwright's
// launch, agent-browser behind a wrapper of the repository's own, checks that
// launch a browser themselves). Every one of them starts the Chromium that
// Playwright installed, found through PLAYWRIGHT_BROWSERS_PATH. So the gate
// points that variable at a mirror of the real browsers directory, where each
// Chromium executable is a wrapper that logs the launch and starts the real
// browser with SOFTWARE_SWITCHES first; everything else in the mirror links to
// the real files. The gate then asks the wrapped Chromium itself (DevTools
// SystemInfo.getInfo) whether it composites in software, and counts the
// launches the checks made through the wrappers.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SOFTWARE_SWITCHES = ["--disable-gpu"];

/** The directory Playwright installs browsers into. */
export function defaultBrowsersPath(env = process.env, { platform = process.platform, home = os.homedir() } = {}) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === "darwin") return path.join(home, "Library/Caches/ms-playwright");
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData/Local"), "ms-playwright");
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "ms-playwright");
}

const isFile = file => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
const children = dir => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * The Chromium executables Playwright starts, relative to `browsersDir`:
 * chromium-<rev>/<platform>/<App>.app/Contents/MacOS/<App> on macOS,
 * chromium-<rev>/<platform>/chrome on Linux, and each headless shell. Helper
 * apps inside the framework are left alone: the real browser starts them from
 * its own location.
 */
export function chromiumExecutables(browsersDir) {
  const found = [];
  for (const browser of children(browsersDir).filter(name => name.startsWith("chromium"))) {
    for (const platform of children(path.join(browsersDir, browser))) {
      const platformDir = path.join(browsersDir, browser, platform);
      for (const name of ["chrome", "chrome-headless-shell", "headless_shell"]) {
        if (isFile(path.join(platformDir, name))) found.push(path.join(browser, platform, name));
      }
      for (const app of children(platformDir).filter(name => name.endsWith(".app"))) {
        for (const name of children(path.join(platformDir, app, "Contents/MacOS"))) {
          if (isFile(path.join(platformDir, app, "Contents/MacOS", name))) found.push(path.join(browser, platform, app, "Contents/MacOS", name));
        }
      }
    }
  }
  return found;
}

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/** A wrapper that logs the launch and starts `executable` with `switches` before the caller's arguments. */
export function wrapperScript({ executable, switches, log }) {
  return [
    "#!/bin/sh",
    "# repo-kit release-gate: Chromium with software compositing, as on the Linux CI runner.",
    `printf '%s\\n' "$$" >> ${shellQuote(log)}`,
    `exec ${shellQuote(executable)} ${switches.map(shellQuote).join(" ")} "$@"`,
    "",
  ].join("\n");
}

/**
 * Mirrors `realDir` at `mirrorDir`: each Chromium executable becomes a wrapper
 * (wrapperScript), every other entry a symbolic link to the real one. Returns
 * [{ real, wrapper }].
 */
export function shadowBrowsers(realDir, mirrorDir, { switches = SOFTWARE_SWITCHES, log }) {
  const executables = chromiumExecutables(realDir);
  const prefixes = new Set(executables.flatMap(relative => {
    const parts = relative.split(path.sep);
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join(path.sep));
  }));
  const wrapped = [];
  const mirror = relative => {
    fs.mkdirSync(path.join(mirrorDir, relative), { recursive: true });
    for (const name of children(path.join(realDir, relative))) {
      const child = path.join(relative, name);
      const real = path.join(realDir, child);
      const target = path.join(mirrorDir, child);
      if (prefixes.has(child)) mirror(child);
      else if (executables.includes(child)) {
        fs.writeFileSync(target, wrapperScript({ executable: real, switches, log }), { mode: 0o755 });
        wrapped.push({ real, wrapper: target });
      } else fs.symlinkSync(real, target);
    }
  };
  mirror("");
  return wrapped;
}

/** Whether Chromium's gpu.featureStatus says it composites in software. */
export function softwareCompositing(featureStatus) {
  return typeof featureStatus?.gpu_compositing === "string" && featureStatus.gpu_compositing.startsWith("disabled");
}

/**
 * The Chromium a checkout's Playwright starts (`chromium.executablePath()`),
 * under `env`; undefined when the checkout has no Playwright.
 */
export function playwrightChromium(cwd, env = process.env) {
  const script = `const req = require("node:module").createRequire(require("node:path").join(process.cwd(), "package.json"));
let pw;
for (const name of ["playwright", "playwright-core"]) { try { pw = req(name); break; } catch {} }
if (pw) console.log(pw.chromium.executablePath());`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`reading Playwright's Chromium path failed: ${result.stderr.trim()}`);
  return result.stdout.trim() || undefined;
}

/**
 * Starts `executable` headless and returns DevTools' SystemInfo.getInfo
 * gpu.featureStatus: what this Chromium actually composites with.
 */
export async function compositingStatus(executable, { timeout = 30_000 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-chromium-"));
  const child = spawn(executable, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  const exited = new Promise(resolve => child.on("close", resolve));
  const deadline = Date.now() + timeout;
  let socket;
  let timer;
  try {
    let port;
    while (!port) {
      if (child.exitCode !== null) throw new Error(`Chromium exited ${child.exitCode}: ${stderr.trim()}`);
      if (Date.now() > deadline) throw new Error(`Chromium did not open DevTools within ${timeout / 1000}s: ${stderr.trim()}`);
      const file = path.join(profile, "DevToolsActivePort");
      if (fs.existsSync(file)) port = fs.readFileSync(file, "utf8").split("\n")[0].trim();
      if (!port) await new Promise(resolve => setTimeout(resolve, 100));
    }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error("DevTools connection failed")));
    });
    const reply = new Promise((resolve, reject) => {
      socket.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (message.id === 1) message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      });
      timer = setTimeout(() => reject(new Error("SystemInfo.getInfo timed out")), Math.max(1000, deadline - Date.now()));
    });
    socket.send(JSON.stringify({ id: 1, method: "SystemInfo.getInfo" }));
    return (await reply).gpu.featureStatus;
  } finally {
    clearTimeout(timer);
    socket?.close();
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(killer);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
