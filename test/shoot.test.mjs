import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withDefaults } from "../src/config.mjs";
import { browserNames, launchBrowser, loadPlaywright, parseBrowserNames, parseShootArgs, readIndex, shootStories, shotFile, storyUrl } from "../src/shoot.mjs";
import { pairingRecovery } from "../src/safari.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

const defaults = { root: "/work/sid-kit", env: {}, tmpdir: "/tmp", cwd: "/work/sid-kit", shoot: withDefaults({}).shoot };
const parse = (argv, overrides = {}) => parseShootArgs(argv, { ...defaults, ...overrides });

test("shoot defaults: light, 1280 wide, Chromium, full page, the local Storybook, a folder named for the repository", () => {
  assert.deepEqual(parse(["button"]), {
    filters: ["button"],
    themes: ["light"],
    widths: [1280],
    browsers: ["chromium"],
    out: "/tmp/sid-kit-shots",
    full: true,
    url: "http://127.0.0.1:6010",
  });
});

test("shoot reads story id filters, themes, widths, browsers, the output folder and --viewport", () => {
  const options = parse(["tokens--colors", "button", "--theme=light,dark", "--width=1280,375", "--browser=chromium,firefox,webkit,safari", "--out=shots", "--viewport"]);
  assert.deepEqual(options.filters, ["tokens--colors", "button"]);
  assert.deepEqual(options.themes, ["light", "dark"]);
  assert.deepEqual(options.widths, [1280, 375]);
  assert.deepEqual(options.browsers, ["chromium", "firefox", "webkit", "safari"]);
  assert.equal(options.out, "/work/sid-kit/shots", "--out resolves against the working directory");
  assert.equal(options.full, false);
});

test("the Storybook is a bare URL or --url=, then SID_KIT_STORYBOOK_URL, STORYBOOK_URL and shoot.url", () => {
  assert.equal(parse(["button", "http://127.0.0.1:6020/"]).url, "http://127.0.0.1:6020");
  assert.equal(parse(["--url=https://sid-kit.example/", "button"]).url, "https://sid-kit.example");
  assert.deepEqual(parse(["http://127.0.0.1:6020", "button"]).filters, ["button"], "a URL is not a filter");
  const env = { SID_KIT_STORYBOOK_URL: "http://127.0.0.1:7001", STORYBOOK_URL: "http://127.0.0.1:7002" };
  assert.equal(parse(["button"], { env }).url, "http://127.0.0.1:7001");
  assert.equal(parse(["button"], { env: { STORYBOOK_URL: "http://127.0.0.1:7002" } }).url, "http://127.0.0.1:7002");
  assert.equal(parse(["button", "--url=http://127.0.0.1:7003"], { env }).url, "http://127.0.0.1:7003", "an argument wins over the environment");
  assert.equal(parse(["button"], { shoot: { ...defaults.shoot, url: "http://127.0.0.1:6040" } }).url, "http://127.0.0.1:6040");
});

test("shoot refuses what it cannot shoot", () => {
  assert.throws(() => parse([]), /Name at least one story id filter/);
  assert.throws(() => parse(["--theme=dark"]), /Name at least one story id filter/);
  assert.throws(() => parse(["button", "--full"]), /Unknown option --full/);
  assert.throws(() => parse(["button", "--browser=chrome"]), /Unknown browser chrome; use chromium, firefox, webkit, safari/);
  assert.throws(() => parse(["button", "--browser="]), /Name a browser/);
  assert.throws(() => parse(["button", "--width=wide"]), /--width takes pixel widths/);
  assert.throws(() => parse(["button", "--theme="]), /--theme takes theme names/);
  assert.throws(() => parse(["button", "--url=ftp://x"]), /--url takes an http\(s\) URL/);
});

test("a lone -- before the filters is skipped", () => {
  assert.deepEqual(parse(["--", "button"]).filters, ["button"]);
});

test("browser names are the four engines, trimmed and deduplicated in order", () => {
  assert.deepEqual(browserNames, ["chromium", "firefox", "webkit", "safari"]);
  assert.deepEqual(parseBrowserNames(" firefox , chromium,firefox "), ["firefox", "chromium"]);
});

// A Playwright stand-in that records each launch.
function fakePlaywright() {
  const launches = [];
  const engine = name => ({ launch: options => (launches.push([name, options]), `${name} browser`) });
  return { launches, playwright: { chromium: engine("chromium"), firefox: engine("firefox"), webkit: engine("webkit") } };
}

test("each name launches one engine: Playwright's Chromium and WebKit, the installed Firefox, Safari Technology Preview", async () => {
  const { launches, playwright } = fakePlaywright();
  const safari = [];
  const deps = { playwright, launchSafari: () => (safari.push("safari"), "safari browser") };
  assert.equal(await launchBrowser("chromium", deps), "chromium browser");
  assert.equal(await launchBrowser("firefox", deps), "firefox browser");
  assert.equal(await launchBrowser("webkit", deps), "webkit browser");
  assert.equal(await launchBrowser("safari", deps), "safari browser");
  assert.deepEqual(launches, [["chromium", { channel: "chromium" }], ["firefox", { channel: "moz-firefox" }], ["webkit", {}]]);
  assert.deepEqual(safari, ["safari"]);
  await assert.rejects(launchBrowser("edge", deps), /Unknown browser edge/);
});

test("Safari needs no Playwright", async () => {
  const deps = { playwright: () => { throw new Error("loaded Playwright"); }, launchSafari: () => "safari browser" };
  assert.equal(await launchBrowser("safari", deps), "safari browser");
});

test("Playwright comes from the repository, with a message when it has none", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-shoot-"));
  try {
    fs.writeFileSync(path.join(empty, "package.json"), "{}\n");
    assert.throws(() => loadPlaywright(empty), /repo-kit shoot needs playwright in .*: add it to its devDependencies/);
    const module = path.join(empty, "node_modules/playwright");
    fs.mkdirSync(module, { recursive: true });
    fs.writeFileSync(path.join(module, "package.json"), '{"name": "playwright", "main": "index.js"}\n');
    fs.writeFileSync(path.join(module, "index.js"), "exports.chromium = { from: 'the repository' };\n");
    assert.deepEqual(loadPlaywright(empty).chromium, { from: "the repository" });
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("pictures are named <story>-<theme>-<width>, with the browser after it except for Chromium", () => {
  assert.equal(shotFile("/out", "button--default", "dark", 375, "chromium"), "/out/button--default-dark-375.png");
  assert.equal(shotFile("/out", "button--default", "dark", 375, "safari"), "/out/button--default-dark-375-safari.png");
  assert.equal(storyUrl("http://127.0.0.1:6010", "button--default", "dark"), "http://127.0.0.1:6010/iframe.html?id=button--default&viewMode=story&globals=theme:dark");
});

// A browser stand-in that records what a page was asked to do, in order.
function fakeBrowsers({ overlays = 0, height = 2000 } = {}) {
  const calls = [];
  let overlay = overlays;
  const launch = name => ({
    async newPage({ viewport }) {
      calls.push(`${name} newPage ${viewport.width}x${viewport.height}`);
      return {
        goto: url => calls.push(`goto ${url}`),
        reload: () => calls.push("reload"),
        waitForFunction: fn => calls.push(`wait ${fn.name}`),
        evaluate: fn => (calls.push(`evaluate ${fn.name}`), fn.name === "pageHeight" ? height : true),
        locator: selector => ({ count: () => (calls.push(`count ${selector}`), overlay > 0 ? overlay-- : 0) }),
        screenshot: ({ path: file, fullPage, clip }) => calls.push(`screenshot ${path.basename(file)} fullPage=${fullPage}${clip ? ` clip=${JSON.stringify(clip)}` : ""}`),
        close: () => calls.push("close page"),
      };
    },
    close: () => calls.push(`${name} close`),
  });
  return { calls, launch };
}

const index = { entries: {
  "button--default": { type: "story", id: "button--default" },
  "button--docs": { type: "docs", id: "button--docs" },
  "badge--default": { type: "story", id: "badge--default" },
} };
const fetchIndex = async url => ({ ok: true, json: async () => (assert.equal(url, "http://sb/index.json"), index) });

test("shoot waits for the story, a settle, then the viewport images loaded and decoded, before each picture", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-shoot-"));
  const { calls, launch } = fakeBrowsers();
  const sleeps = [];
  try {
    const files = await shootStories(
      { filters: ["button"], themes: ["light"], widths: [1280], browsers: ["chromium", "safari"], out, full: true, url: "http://sb" },
      { launch, fetch: fetchIndex, sleep: ms => (calls.push(`sleep ${ms}`), sleeps.push(ms)), log: () => {} },
    );
    assert.deepEqual(files.map(file => path.basename(file)), ["button--default-light-1280.png", "button--default-light-1280-safari.png"]);
    assert.deepEqual(calls.slice(0, 12), [
      "chromium newPage 1280x900",
      "goto http://sb/iframe.html?id=button--default&viewMode=story&globals=theme:light",
      "wait storyShown",
      "sleep 1200",
      "wait viewportImagesLoaded",
      "evaluate decodeViewportImages",
      "sleep 200",
      "count vite-error-overlay",
      "evaluate pageHeight",
      "screenshot button--default-light-1280.png fullPage=true",
      "close page",
      "chromium close",
    ]);
    assert.equal(calls[12], "safari newPage 1280x900");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("shoot reloads a story that shows the Vite error overlay, then waits again", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-shoot-"));
  const { calls, launch } = fakeBrowsers({ overlays: 1 });
  try {
    await shootStories(
      { filters: ["badge"], themes: ["dark"], widths: [375], browsers: ["firefox"], out, full: false, url: "http://sb" },
      { launch, fetch: fetchIndex, sleep: ms => calls.push(`sleep ${ms}`), log: () => {} },
    );
    const reload = calls.indexOf("reload");
    assert.ok(reload > 0, calls.join("\n"));
    assert.deepEqual(calls.slice(reload - 2, reload + 7), [
      "count vite-error-overlay",
      "sleep 4000",
      "reload",
      "wait storyShown",
      "sleep 1200",
      "wait viewportImagesLoaded",
      "evaluate decodeViewportImages",
      "sleep 200",
      "count vite-error-overlay",
    ]);
    assert.match(calls.at(-3), /^screenshot badge--default-dark-375-firefox\.png fullPage=false$/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("a full page taller than any engine can picture is cut to its top 16384 px, with a warning", async () => {
  // Firefox refuses a screenshot taller than 65535 px; Chromium writes a picture nothing opens.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-shoot-"));
  const { calls, launch } = fakeBrowsers({ height: 390104 });
  const warnings = [];
  try {
    await shootStories(
      { filters: ["badge"], themes: ["light"], widths: [1280], browsers: ["firefox", "safari"], out, full: true, url: "http://sb" },
      { launch, fetch: fetchIndex, sleep: () => {}, log: () => {}, warn: message => warnings.push(message) },
    );
    // Safari pictures the viewport only, so its height does not matter.
    assert.ok(calls.includes("screenshot badge--default-light-1280-safari.png fullPage=true"), calls.join("\n"));
    assert.ok(calls.includes('screenshot badge--default-light-1280-firefox.png fullPage=true clip={"x":0,"y":0,"width":1280,"height":16384}'), calls.join("\n"));
    assert.deepEqual(warnings, ["badge--default: the page is 390104px tall; the picture covers its top 16384px"]);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("shoot fails when no story id matches", async () => {
  const { launch } = fakeBrowsers();
  await assert.rejects(
    shootStories({ filters: ["nothing"], themes: ["light"], widths: [1280], browsers: ["chromium"], out: os.tmpdir(), full: true, url: "http://sb" }, { launch, fetch: fetchIndex, sleep: () => {}, log: () => {} }),
    /No story id contains nothing/,
  );
});

test("a failed index that names a story file touches it so the dev server indexes again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-shoot-"));
  try {
    const story = path.join(dir, "src/button.stories.tsx");
    fs.mkdirSync(path.dirname(story), { recursive: true });
    fs.writeFileSync(story, "");
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(story, old, old);
    const responses = [
      { ok: false, text: async () => "Unable to index ./src/button.stories.tsx: SyntaxError" },
      { ok: true, json: async () => index },
    ];
    const sleeps = [];
    assert.deepEqual(await readIndex("http://sb", { storybookDir: dir, fetch: async () => responses.shift(), sleep: ms => sleeps.push(ms) }), index);
    assert.ok(fs.statSync(story).mtimeMs > old.getTime());
    assert.deepEqual(sleeps, [4000]);
    await assert.rejects(readIndex("http://sb", { storybookDir: dir, fetch: async () => ({ ok: false, text: async () => "" }), sleep: () => {}, attempts: 2 }), /index\.json keeps failing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repo-kit shoot rejects bad arguments before it takes a lease", () => {
  const repository = tempRepository({ "package.json": { name: "example" }, "repo-kit.config.mjs": "export default {};\n" });
  try {
    const bin = path.join(repository.root, "bin");
    fs.mkdirSync(bin);
    // A slotfather that records being asked for a lease.
    fs.writeFileSync(path.join(bin, "slotfather"), `#!/bin/sh\ntouch "${path.join(repository.root, "leased")}"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete env.SLOTFATHER_LEASE;
    const result = spawnSync(process.execPath, [path.join(kitRoot, "src/cli.mjs"), "shoot", "--theme=dark"], { cwd: repository.root, encoding: "utf8", env });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Name at least one story id filter/);
    assert.equal(fs.existsSync(path.join(repository.root, "leased")), false);
    const leased = spawnSync(process.execPath, [path.join(kitRoot, "src/cli.mjs"), "shoot", "button"], { cwd: repository.root, encoding: "utf8", env });
    assert.equal(leased.status, 0, leased.stdout + leased.stderr);
    assert.equal(fs.existsSync(path.join(repository.root, "leased")), true, "a valid run leases shoot.slots");
  } finally {
    repository.cleanup();
  }
});

test("Safari Technology Preview left paired by a dead driver is restarted; one paired with a live driver is busy", () => {
  const paired = "safaridriver POST /session: Could not create a session: The Safari instance is already paired with another WebDriver session.";
  assert.equal(pairingRecovery(paired, []), "restart");
  assert.equal(pairingRecovery(paired, [4242]), "busy");
  assert.equal(pairingRecovery("safaridriver POST /session: You must enable 'Allow remote automation'", []), "fail");
});
