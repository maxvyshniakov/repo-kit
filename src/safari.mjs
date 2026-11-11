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

/** Process ids of Safari Technology Preview's safaridriver other than `own`. */
function otherDrivers(own) {
  try {
    return execFileSync("pgrep", ["-f", driverPath], { encoding: "utf8" }).split("\n").map(Number).filter(pid => pid && pid !== own);
  } catch {
    return [];
  }
}

// Only the instance safaridriver started (--automation); the user's own window is left alone.
const automationInstance = `${app}/Contents/MacOS/Safari Technology Preview .*--automation`;

async function quitAutomationInstance() {
  try {
    execFileSync("pkill", ["-TERM", "-f", automationInstance]);
  } catch {}
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      execFileSync("pgrep", ["-f", automationInstance]);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Safari Technology Preview's automation window did not quit");
}

function automationInstanceRuns() {
  try {
    execFileSync("pgrep", ["-f", automationInstance]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends a run's Safari: the WebDriver session, then the driver, then, when this
 * run started it, the automation window. Ending the session leaves Safari
 * Technology Preview open in --automation mode, ignoring real input and
 * holding memory; it ignores NSRunningApplication.terminate and window close
 * there, so it gets SIGTERM. A window that lingers warns: the pictures are taken.
 */
export async function closeSafari({ deleteSession, killDriver, startedInstance, quit = quitAutomationInstance, warn = console.warn }) {
  try {
    await deleteSession();
  } finally {
    killDriver();
    if (startedInstance) {
      try {
        await quit();
      } catch (error) {
        warn(`repo-kit: ${error.message}`);
      }
    }
  }
}

export async function launchSafari() {
  if (!fs.existsSync(driverPath)) throw new Error(`Safari Technology Preview is not installed: ${app} (repo-kit README, "Story screenshots")`);
  const port = await freePort();
  const driver = spawn(driverPath, ["-p", String(port)], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  await waitForDriver(base);
  const previous = frontmostBundle();
  const call = async (method, path, body) => {
    const init = body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const response = await fetch(`${base}${path}`, init);
    const { value } = await response.json();
    if (!response.ok) throw new Error(`safaridriver ${method} ${path}: ${value?.message ?? response.status}`);
    return value;
  };
  const capabilities = { capabilities: { alwaysMatch: { browserName: "Safari Technology Preview" } } };
  // An automation window that runs already belongs to another run, or to one that died.
  let startedInstance = !automationInstanceRuns();
  let session;
  try {
    try {
      session = await call("POST", "/session", capabilities);
    } catch (error) {
      const others = otherDrivers(driver.pid);
      const recovery = pairingRecovery(error.message, others);
      if (recovery === "busy") throw new Error(`${error.message} Another run holds it (safaridriver ${others.join(", ")}); try again when it ends.`);
      if (recovery !== "restart") throw error;
      console.warn("repo-kit: Safari Technology Preview was left paired by a run that ended; restarting its automation window");
      await quitAutomationInstance();
      startedInstance = true;
      session = await call("POST", "/session", capabilities);
    }
  } catch (error) {
    driver.kill();
    if (startedInstance) await quitAutomationInstance().catch(() => {});
    throw error;
  } finally {
    if (previous && previous !== previewBundle) activate(previous);
  }
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
    close: () => closeSafari({ deleteSession: () => call("DELETE", at("")), killDriver: () => driver.kill(), startedInstance }),
  };
  return browser;
}
