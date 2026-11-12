// Safari Technology Preview over WebDriver, for repo-kit shoot's `safari`.
//
// Playwright drives WebKit, not Safari, and safaridriver refuses a Safari the user already
// has open ("Safari was not launched for automation"), so the checks use Safari Technology
// Preview: it runs beside Safari and has its own WebDriver. One-time setup:
// install it (`brew install --cask safari-technology-preview`), then in its Settings turn on
// Advanced → Show features for web developers and Developer → Allow remote automation.
//
// safaridriver brings the browser to the front. The session hands focus straight back to
// the app that had it; the window stays on screen behind it. Hiding or minimising it is not
// an option: WebKit then marks the page hidden, stops drawing frames and cannot screenshot.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const app = "/Applications/Safari Technology Preview.app";
const driverPath = `${app}/Contents/MacOS/safaridriver`;
const previewBundle = "com.apple.SafariTechnologyPreview";

function jxa(source) {
  return execFileSync("osascript", ["-l", "JavaScript", "-e", source], { encoding: "utf8" }).trim();
}

const frontmostBundle = () => jxa('ObjC.import("AppKit"); ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)');
// JXA hands NSArray's count over as a string, so "0" is truthy: compare it. Handing
// focus back is best effort: the app may have quit since.
const activate = (bundle) => {
  try {
    jxa(`ObjC.import("AppKit"); const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(bundle)}); apps.count > 0 ? apps.objectAtIndex(0).activateWithOptions(0) : false`);
  } catch {}
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    }).on("error", reject);
  });
}

async function waitForDriver(base) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${base}/status`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("safaridriver did not start");
}

/**
 * What to do when Safari Technology Preview refuses a session. A run that died
 * before closing its session (killed, or its safaridriver gone) leaves the
 * browser "already paired" until it quits: with no other safaridriver of
 * Safari Technology Preview running, nobody can use that pairing, so the
 * automation instance is restarted ("restart"). With one running, another run
 * holds it ("busy").
 */
export function pairingRecovery(message, otherDrivers) {
  if (!/already paired with another WebDriver session/.test(message)) return "fail";
  return otherDrivers.length ? "busy" : "restart";
}

/**
 * Other safaridrivers, split into live ones and orphans. An orphan is a driver
 * a repo-kit run started (`started`, pid to its start time) whose run was
 * killed before it could stop it: it is reparented to launchd (ppid 1), serves
 * nobody, and keeps the browser paired. Any other driver, detached or not,
 * may serve someone and counts as live. `rows` are { pid, ppid, start }.
 */
export function splitDrivers(rows, own, started = {}) {
  const others = rows.filter(({ pid }) => pid && pid !== own);
  const orphan = ({ pid, ppid, start }) => ppid === 1 && started[pid] !== undefined && started[pid] === start;
  return { live: others.filter(row => !orphan(row)).map(({ pid }) => pid), orphans: others.filter(orphan).map(({ pid }) => pid) };
}

// The safaridrivers repo-kit runs started, by pid and start time, so a later run knows its own orphans.
const startedFile = path.join(os.tmpdir(), "repo-kit-safaridrivers.json");
const readStarted = () => { try { return JSON.parse(fs.readFileSync(startedFile, "utf8")); } catch { return {}; } };
const startTime = pid => { try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return null; } };
function recordStarted(pid, add) {
  const started = readStarted();
  if (add) started[pid] = startTime(pid);
  else delete started[pid];
  try { fs.writeFileSync(startedFile, JSON.stringify(started)); } catch {}
}

function pids(pattern) {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).split("\n").map(Number).filter(Boolean);
  } catch {
    return [];
  }
}

/** Safari Technology Preview's safaridrivers other than `own`, live and orphaned. */
function otherDrivers(own) {
  const rows = pids(driverPath).map(pid => {
    try {
      return { pid, ppid: Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()), start: startTime(pid) };
    } catch {
      return { pid: 0, ppid: 0 };
    }
  });
  return splitDrivers(rows, own, readStarted());
}

// Only the instance safaridriver started (--automation); the user's own window is left alone.
const automationInstance = `${app}/Contents/MacOS/Safari Technology Preview .*--automation`;
const automationPids = () => pids(automationInstance);

/** SIGTERM to the given automation windows, or every one when `which` is "all"; waits until they quit. */
async function quitAutomationInstance(which = "all") {
  const targets = () => which === "all" ? automationPids() : automationPids().filter(pid => which.includes(pid));
  for (const pid of targets()) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!targets().length) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Safari Technology Preview's automation window did not quit");
}

/**
 * Ends a run's Safari: the WebDriver session, then the driver, then, when this
 * run started it, the automation window. Ending the session leaves Safari
 * Technology Preview open in --automation mode, ignoring real input and
 * holding memory; it ignores NSRunningApplication.terminate and window close
 * there, so it gets SIGTERM. A window that lingers warns: the pictures are taken.
 */
export async function closeSafari({ deleteSession, killDriver, startedInstance, ownWindows = [], quit = quitAutomationInstance, warn = console.warn }) {
  try {
    await deleteSession();
  } finally {
    killDriver();
    if (startedInstance && ownWindows.length) {
      try {
        // Only this run's window: another run may have attached its own meanwhile.
        await quit(ownWindows);
      } catch (error) {
        warn(`repo-kit: ${error.message}`);
      }
    }
  }
}

/** The defaults launchSafari runs with; tests replace them. */
export const safariSystem = { exists: fs.existsSync, freePort, spawn, recordStarted, waitForDriver, frontmostBundle, activate, otherDrivers, automationPids, quitAutomationInstance, fetch: (...args) => fetch(...args), warn: (...args) => console.warn(...args) };

export async function launchSafari(system = safariSystem) {
  const { exists, freePort: pickPort, spawn: start, recordStarted: record, waitForDriver: ready, frontmostBundle: frontmost, activate: focus, otherDrivers: drivers, automationPids: windows, quitAutomationInstance: quit, fetch: get, warn } = { ...safariSystem, ...system };
  if (!exists(driverPath)) throw new Error(`Safari Technology Preview is not installed: ${app} (repo-kit README, "Story screenshots")`);
  const port = await pickPort();
  const spawned = start(driverPath, ["-p", String(port)], { stdio: "ignore" });
  record(spawned.pid, true);
  const driver = { pid: spawned.pid, kill: () => { spawned.kill(); record(spawned.pid, false); } };
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const init = body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const response = await get(`${base}${path}`, init);
    const { value } = await response.json();
    if (!response.ok) throw new Error(`safaridriver ${method} ${path}: ${value?.message ?? response.status}`);
    return value;
  };
  const capabilities = { capabilities: { alwaysMatch: { browserName: "Safari Technology Preview" } } };
  // The automation windows before this run's session: any that runs already belongs to
  // another run, or to one that died. This run owns only the windows its session added.
  let before = windows();
  let previous = null;
  let restarted = false;
  let session;
  try {
    await ready(base);
    try {
      previous = frontmost();
    } catch {
      previous = null;
    }
    try {
      session = await call("POST", "/session", capabilities);
    } catch (error) {
      const { live, orphans } = drivers(driver.pid);
      const recovery = pairingRecovery(error.message, live);
      if (recovery === "busy") throw new Error(`${error.message} Another run holds it (safaridriver ${live.join(", ")}); try again when it ends.`);
      if (recovery !== "restart") throw error;
      warn("repo-kit: Safari Technology Preview was left paired by a run that ended; restarting its automation window");
      for (const pid of orphans) {
        try { process.kill(pid, "SIGTERM"); } catch {}
        record(pid, false);
      }
      await quit("all");
      before = [];
      restarted = true;
      session = await call("POST", "/session", capabilities);
    }
  } catch (error) {
    driver.kill();
    // Only a window this run's session started; a busy run started none.
    const own = windows().filter(pid => !before.includes(pid));
    if ((session || restarted) && own.length) await quit(own).catch(() => {});
    throw error;
  } finally {
    if (previous && previous !== previewBundle) focus(previous);
  }
  const ownWindows = windows().filter(pid => !before.includes(pid));
  const startedInstance = ownWindows.length > 0;
  const at = (path) => `/session/${session.sessionId}${path}`;
  const browser = {
    version: () => session.capabilities.browserVersion,
    async newPage({ viewport }) {
      const page = {
        async setViewportSize({ width, height }) {
          // The window rect includes the toolbar; size it, then correct by the measured difference.
          await call("POST", at("/window/rect"), { x: 0, y: 0, width, height });
          const inner = await page.evaluate(() => [innerWidth, innerHeight]);
          await call("POST", at("/window/rect"), { width: width * 2 - inner[0], height: height * 2 - inner[1] });
          // Safari keeps a minimum window size: a picture named for 375 px must be 375 px wide.
          const [gotWidth, gotHeight] = await page.evaluate(() => [innerWidth, innerHeight]);
          if (gotWidth !== width) throw new Error(`Safari Technology Preview gives a ${gotWidth} px wide viewport, not ${width} px; pick a width it can show`);
          // A short display cannot fit the height: the picture is shorter, not wrong.
          if (gotHeight !== height) console.warn(`repo-kit: Safari Technology Preview gives a ${gotHeight} px tall viewport, not ${height} px`);
        },
        goto: (url) => call("POST", at("/url"), { url }),
        reload: () => call("POST", at("/refresh"), {}),
        evaluate: (fn, ...args) => call("POST", at("/execute/sync"), { script: `return (${fn}).apply(null, arguments)`, args }),
        async waitForFunction(fn, arg, { timeout = 30000 } = {}) {
          for (const end = Date.now() + timeout; Date.now() < end;) {
            if (await page.evaluate(fn, arg)) return;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          throw new Error("waitForFunction timed out");
        },
        locator: (selector) => ({ count: () => page.evaluate((s) => document.querySelectorAll(s).length, selector) }),
        /** WebDriver screenshots the viewport only; `fullPage` is ignored. */
        async screenshot({ path }) {
          fs.writeFileSync(path, Buffer.from(await call("GET", at("/screenshot")), "base64"));
        },
        close: async () => {},
      };
      if (viewport) await page.setViewportSize(viewport);
      return page;
    },
    close: () => closeSafari({ deleteSession: () => call("DELETE", at("")), killDriver: () => driver.kill(), startedInstance, ownWindows, quit }),
  };
  return browser;
}
