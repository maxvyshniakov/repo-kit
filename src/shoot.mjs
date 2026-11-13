// repo-kit shoot: screenshots Storybook stories for a visual review, every
// story whose id contains one of the filters, in each theme, width and browser.
//
//   repo-kit shoot button--default
//   repo-kit shoot showcase --theme=light,dark --width=1280,375 --out=/tmp/shots
//   repo-kit shoot showcase --browser=chromium,firefox,webkit,safari
//   repo-kit shoot http://127.0.0.1:6020 showcase --viewport      (no full page)
//
// It reads a running Storybook and writes <out>/<story-id>-<theme>-<width>.png,
// with -<browser> appended for every browser but Chromium. Before each picture
// it waits for Storybook's rendered mark (sb-show-main), a settle for mounted
// content, then the images in the viewport loaded and decode()d: Safari paints
// lazy, async-decoded images late, and a wait over an empty list of images
// passes before the content mounts, so the settle comes first.
//
// A dev server keeps a failed story index until the broken file changes again;
// shoot touches the file the error names so the index rebuilds, and reloads a
// story that shows the Vite error overlay.
//
// Engines (README.md, "Story screenshots"):
// - chromium: Playwright's Chromium (the `chromium` channel, not the headless shell).
// - firefox: the installed Firefox over WebDriver BiDi (Playwright's `moz-firefox`
//   channel). Playwright's own patched Firefox does not start on macOS 27 ("Could
//   not find profile folder"), and it is not the Firefox users run.
// - webkit: Playwright's WebKit. It renders like Safari but is not Safari.
// - safari: Safari Technology Preview over its own safaridriver (./safari.mjs).
//
// Playwright is the repository's own devDependency, loaded from its root: the
// kit stays dependency-free and Safari needs no Playwright at all.
import fs from "node:fs";
import nodeModule from "node:module";
import os from "node:os";
import path from "node:path";

export const browserNames = ["chromium", "firefox", "webkit", "safari"];
export const VIEWPORT_HEIGHT = 900;
// The tallest full-page picture: Firefox refuses one over 65535 px, and Chromium
// writes a PNG that viewers cannot open long before that.
export const MAX_FULL_PAGE_HEIGHT = 16384;
const SETTLE_MS = 1200;
const IMAGE_TIMEOUT_MS = 15000;

const USAGE_HINT = "such as button--default";

/** Comma-separated browser names, checked, in order, without repeats. */
export function parseBrowserNames(value) {
  const names = [...new Set(value.split(",").map(name => name.trim()).filter(Boolean))];
  if (!names.length) throw new Error(`Name a browser: ${browserNames.join(", ")}`);
  for (const name of names) {
    if (!browserNames.includes(name)) throw new Error(`Unknown browser ${name}; use ${browserNames.join(", ")}`);
  }
  return names;
}

const isUrl = value => /^https?:\/\//.test(value);
const list = (flag, value, what) => {
  const items = value.split(",").map(item => item.trim()).filter(Boolean);
  if (!items.length) throw new Error(`${flag} takes ${what}`);
  return items;
};

/**
 * `repo-kit shoot` arguments. The Storybook is the first bare http(s) URL or
 * `--url=`, else SID_KIT_STORYBOOK_URL, STORYBOOK_URL, then `shoot.url` from
 * repo-kit.config.mjs (default http://127.0.0.1:6010).
 */
export function parseShootArgs(argv, { root, env = process.env, tmpdir = os.tmpdir(), cwd = process.cwd(), shoot = {} } = {}) {
  const options = {
    filters: [],
    themes: ["light"],
    widths: [1280],
    browsers: ["chromium"],
    out: path.join(tmpdir, `${path.basename(root ?? cwd)}-shots`),
    full: true,
    url: undefined,
  };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg.startsWith("--theme=")) options.themes = list("--theme", arg.slice("--theme=".length), "theme names, such as light,dark");
    else if (arg.startsWith("--width=")) {
      const widths = list("--width", arg.slice("--width=".length), "pixel widths, such as 1280,375").map(Number);
      if (widths.some(width => !Number.isInteger(width) || width <= 0)) throw new Error("--width takes pixel widths, such as 1280,375");
      options.widths = widths;
    } else if (arg.startsWith("--browser=")) options.browsers = parseBrowserNames(arg.slice("--browser=".length));
    else if (arg.startsWith("--out=")) options.out = path.resolve(cwd, arg.slice("--out=".length));
    else if (arg === "--viewport") options.full = false;
    else if (arg.startsWith("--url=")) {
      const value = arg.slice("--url=".length);
      if (!isUrl(value)) throw new Error("--url takes an http(s) URL");
      options.url ??= value;
    } else if (isUrl(arg)) options.url ??= arg;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else options.filters.push(arg);
  }
  if (!options.filters.length) throw new Error(`Name at least one story id filter, ${USAGE_HINT}`);
  options.url = (options.url ?? env.SID_KIT_STORYBOOK_URL ?? env.STORYBOOK_URL ?? shoot.url ?? "http://127.0.0.1:6010").replace(/\/+$/, "");
  return options;
}

/** The repository's Playwright, resolved from its root. */
export function loadPlaywright(root) {
  const require = nodeModule.createRequire(path.join(root, "package.json"));
  try {
    return require("playwright");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    throw new Error(`repo-kit shoot needs playwright in ${root}: add it to its devDependencies`);
  }
}

// The first Playwright that launches the moz-firefox channel. The optional peer
// range stays >=1.50.0: only `--browser=firefox` needs this one.
export const FIREFOX_PLAYWRIGHT = "1.57.0";

/** The version of the repository's Playwright, or undefined when it has none or it cannot be read. */
export function playwrightVersion(root) {
  try {
    const require = nodeModule.createRequire(path.join(root, "package.json"));
    let dir = path.dirname(require.resolve("playwright"));
    for (; ;) {
      const file = path.join(dir, "package.json");
      if (fs.existsSync(file)) {
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        if (manifest.name === "playwright") return manifest.version;
      }
      if (path.dirname(dir) === dir) return undefined;
      dir = path.dirname(dir);
    }
  } catch {
    return undefined;
  }
}

const olderThan = (version, floor) => {
  const [a, b] = [version, floor].map(text => text.split(/[.-]/).slice(0, 3).map(Number));
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
};

/**
 * Launches one engine. `playwright` is the module or a function that loads it,
 * so Safari never loads Playwright. Resolves to a Playwright Browser, or for
 * Safari the subset of one that shoot uses.
 */
export async function launchBrowser(name, { playwright, playwrightVersion: version, launchSafari } = {}) {
  if (name === "safari") return (launchSafari ?? (await import("./safari.mjs")).launchSafari)();
  if (!browserNames.includes(name)) throw new Error(`Unknown browser ${name}; use ${browserNames.join(", ")}`);
  const engines = typeof playwright === "function" ? playwright() : playwright;
  if (name === "chromium") return engines.chromium.launch({ channel: "chromium" });
  if (name === "firefox") {
    const installed = typeof version === "function" ? version() : version;
    if (installed && olderThan(installed, FIREFOX_PLAYWRIGHT)) {
      throw new Error(`shoot --browser=firefox needs Playwright ${FIREFOX_PLAYWRIGHT} or later (the moz-firefox channel); this repository has ${installed}. Raise its playwright devDependency, or leave firefox out of --browser.`);
    }
    return engines.firefox.launch({ channel: "moz-firefox" });
  }
  return engines.webkit.launch({});
}

export const shotFile = (out, id, theme, width, browser) =>
  path.join(out, `${id}-${theme}-${width}${browser === "chromium" ? "" : `-${browser}`}.png`);

export const storyUrl = (base, id, theme) => `${base}/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`;

// Each of these runs in the page and stands alone.
// The Vite error overlay can keep Storybook from marking the body: it counts as shown, so the reloads run.
function storyShown() {
  return document.body.classList.contains("sb-show-main") || document.body.classList.contains("sb-show-errordisplay")
    || Boolean(document.querySelector("vite-error-overlay"));
}
function viewportImagesLoaded() {
  return [...document.images]
    .filter(image => { const box = image.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth; })
    .every(image => image.complete && image.naturalWidth > 0);
}
// Decodes the loaded images in view, for at most 5 s: decode() on an image that never
// loaded stays pending, and the wait before it already gave up on those.
export function decodeViewportImages() {
  const decoded = Promise.all([...document.images]
    .filter(image => { const box = image.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth; })
    .filter(image => image.complete && image.naturalWidth > 0)
    .map(image => image.decode().catch(() => {})));
  return Promise.race([decoded, new Promise(resolve => setTimeout(resolve, 5000))]).then(() => true);
}

function pageHeight() {
  return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The Storybook index, rebuilt by touching the story file a failed index names. */
export async function readIndex(base, { storybookDir, fetch: get = fetch, sleep = realSleep, attempts = 6 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await get(`${base}/index.json`);
    if (response.ok) return response.json();
    const file = /Unable to index (\S+?):/.exec(await response.text())?.[1];
    if (file && storybookDir) {
      const now = new Date();
      try {
        fs.utimesSync(path.resolve(storybookDir, file), now, now);
      } catch {}
    }
    await sleep(4000);
  }
  throw new Error(`${base}/index.json keeps failing; fix the story file it names`);
}

async function waitForStory(page, id, { sleep, log }) {
  // A cold browser can still be loading the story; Storybook marks the body once it rendered.
  await page.waitForFunction(storyShown, null, { timeout: 60000 });
  await sleep(SETTLE_MS);
  try {
    await page.waitForFunction(viewportImagesLoaded, null, { timeout: IMAGE_TIMEOUT_MS });
  } catch {
    log(`${id}: images still loading`);
  }
  await page.evaluate(decodeViewportImages);
  await sleep(200);
}

/**
 * Screenshots every matching story; resolves to the files written. `launch`
 * starts a browser by name.
 */
export async function shootStories(options, { launch, fetch: get = fetch, sleep = realSleep, log = console.log, warn = console.warn, storybookDir, signals = process, exit = code => process.exit(code) } = {}) {
  const index = await readIndex(options.url, { storybookDir, fetch: get, sleep });
  const ids = Object.values(index.entries)
    .filter(entry => entry.type === "story" && options.filters.some(filter => entry.id.includes(filter)))
    .map(entry => entry.id);
  if (!ids.length) throw new Error(`No story id contains ${options.filters.join(", ")}`);

  fs.mkdirSync(options.out, { recursive: true });
  const files = [];
  const broken = [];
  for (const browserName of options.browsers) {
    // A run stopped by SIGTERM or SIGHUP (one runLeased forwards, say) closes its browser
    // first, also one still launching: Safari's driver and automation window would outlive
    // it and keep the next run busy. One close serves the signal and the run's own end; a
    // close that hangs gives up after 10 s, and a second signal exits at once.
    let browser = null, closing = null, stopping = null;
    const close = () => (closing ??= Promise.resolve().then(() => browser?.close()).catch(() => {}));
    const stop = signal => {
      const code = 128 + os.constants.signals[signal];
      if (stopping) return exit(code);
      stopping = signal;
      if (!browser) return; // the launch below closes it once it resolves
      Promise.race([close(), new Promise(resolve => setTimeout(resolve, 10000).unref?.())]).finally(() => exit(code));
    };
    const onTerm = () => stop("SIGTERM"), onHup = () => stop("SIGHUP");
    signals.on("SIGTERM", onTerm);
    signals.on("SIGHUP", onHup);
    try {
      browser = await launch(browserName);
    } catch (error) {
      signals.off("SIGTERM", onTerm);
      signals.off("SIGHUP", onHup);
      throw error;
    }
    if (stopping) {
      await Promise.race([close(), new Promise(resolve => setTimeout(resolve, 10000).unref?.())]);
      return exit(128 + os.constants.signals[stopping]);
    }
    try {
      for (const width of options.widths) {
        const page = await browser.newPage({ viewport: { width, height: VIEWPORT_HEIGHT } });
        for (const theme of options.themes) {
          for (const id of ids) {
            await page.goto(storyUrl(options.url, id, theme), { waitUntil: "load" });
            await waitForStory(page, id, { sleep, log: warn });
            let overlay = await page.locator("vite-error-overlay").count();
            for (let attempt = 0; attempt < 6 && overlay; attempt += 1) {
              await sleep(4000);
              await page.reload({ waitUntil: "load" });
              await waitForStory(page, id, { sleep, log: warn });
              overlay = await page.locator("vite-error-overlay").count();
            }
            const file = shotFile(options.out, id, theme, width, browserName);
            // A picture of an error is no picture of the story: the run fails naming it.
            const error = overlay ? "the Vite error overlay stays after 6 reloads"
              : await page.locator("body.sb-show-errordisplay").count() ? "Storybook shows the story's error" : null;
            if (error) {
              warn(`${id}: ${error}; no picture ${path.basename(file)}`);
              broken.push(`${path.basename(file)} (${error})`);
              continue;
            }
            // Safari's WebDriver screenshot covers the viewport only; it ignores fullPage and clip.
            const shot = { path: file, fullPage: options.full };
            if (options.full && browserName !== "safari") {
              const height = await page.evaluate(pageHeight);
              if (height > MAX_FULL_PAGE_HEIGHT) {
                warn(`${id}: the page is ${height}px tall; the picture covers its top ${MAX_FULL_PAGE_HEIGHT}px`);
                shot.clip = { x: 0, y: 0, width, height: MAX_FULL_PAGE_HEIGHT };
              }
            }
            await page.screenshot(shot);
            log(file);
            files.push(file);
          }
        }
        await page.close();
      }
    } finally {
      if (!stopping) {
        signals.off("SIGTERM", onTerm);
        signals.off("SIGHUP", onHup);
      }
      await close();
    }
  }
  if (broken.length) throw new Error(`${broken.length} stor${broken.length === 1 ? "y" : "ies"} could not be pictured: ${broken.join(", ")}`);
  return files;
}

/** `repo-kit shoot <filters...> [<url>|--url=] [--theme=] [--width=] [--browser=] [--out=] [--viewport]`. */
export async function runShoot(config, argv) {
  const options = parseShootArgs(argv, { root: config.root, shoot: config.shoot });
  let playwright;
  const loadOnce = () => (playwright ??= loadPlaywright(config.root));
  await shootStories(options, {
    launch: name => launchBrowser(name, { playwright: loadOnce, playwrightVersion: () => playwrightVersion(config.root) }),
    storybookDir: path.resolve(config.root, config.shoot.storybookDir),
  });
  return 0;
}
