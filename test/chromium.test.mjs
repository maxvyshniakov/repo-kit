import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  SOFTWARE_SWITCHES,
  chromiumExecutables,
  defaultBrowsersPath,
  shadowBrowsers,
  softwareCompositing,
  wrapperScript,
} from "../src/chromium.mjs";
import { tempRepository } from "./fixtures.mjs";

// A fake Playwright browsers directory: each "browser" is a shell script that
// prints the arguments it was started with.
const echoArgs = '#!/bin/sh\nprintf "%s\\n" "$@"\n';
const macChromium = "chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const macHelper = "chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Helpers/Google Chrome for Testing Helper.app/Contents/MacOS/Google Chrome for Testing Helper";
const macShell = "chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const linuxChromium = "chromium-1248/chrome-linux64/chrome";
const linuxShell = "chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";

function browsersDirectory(files) {
  const repository = tempRepository(Object.fromEntries(files.map(file => [file, echoArgs])));
  for (const file of files) fs.chmodSync(path.join(repository.root, file), 0o755);
  return repository;
}

test("the software switches are the Linux CI runner's: no GPU, so software compositing", () => {
  // Linux CI started agent-browser's Chromium with --disable-gpu; the Mac's
  // headless Chromium composites on the GPU (Metal) unless told otherwise, and
  // missed two Sid-Kit defects that broke only under software compositing.
  assert.deepEqual(SOFTWARE_SWITCHES, ["--disable-gpu"]);
});

test("the Chromium executables are the browsers Playwright starts, not their helpers", () => {
  const mac = browsersDirectory([macChromium, macHelper, macShell, "chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Resources/x.pak", "firefox-1555/firefox/firefox"]);
  const linux = browsersDirectory([linuxChromium, linuxShell, "chromium-1248/chrome-linux64/chrome_crashpad_handler", "webkit-2370/pw_run.sh"]);
  try {
    assert.deepEqual(chromiumExecutables(mac.root).sort(), [macShell, macChromium].sort());
    assert.deepEqual(chromiumExecutables(linux.root).sort(), [linuxChromium, linuxShell].sort());
  } finally {
    mac.cleanup();
    linux.cleanup();
  }
});

test("a wrapper adds the switches before the caller's, logs the launch and runs the real browser", () => {
  const script = wrapperScript({ executable: "/real/Google Chrome's", switches: ["--disable-gpu"], log: "/tmp/launches log" });
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.ok(script.includes(`exec '/real/Google Chrome'\\''s' '--disable-gpu' "$@"`), script);
  assert.ok(script.includes(">> '/tmp/launches log'"), script);
});

test("the mirrored browsers directory starts every Chromium with the switches and leaves the rest as it was", () => {
  const real = browsersDirectory([macChromium, macHelper, macShell, "firefox-1555/firefox/firefox"]);
  const shadow = tempRepository();
  try {
    const mirror = path.join(shadow.root, "ms-playwright");
    const log = path.join(shadow.root, "launches.log");
    const wrapped = shadowBrowsers(real.root, mirror, { switches: SOFTWARE_SWITCHES, log });
    assert.deepEqual(wrapped.map(entry => path.relative(mirror, entry.wrapper)).sort(), [macShell, macChromium].sort());
    // The wrapped browser runs the real one with the switches first.
    const started = spawnSync(path.join(mirror, macChromium), ["--headless", "about:blank"], { encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    assert.deepEqual(started.stdout.trim().split("\n"), ["--disable-gpu", "--headless", "about:blank"]);
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "one launch logged");
    // Everything else is the real directory's: helpers, resources, other browsers.
    assert.equal(fs.realpathSync(path.join(mirror, macHelper)), fs.realpathSync(path.join(real.root, macHelper)));
    assert.equal(fs.realpathSync(path.join(mirror, "firefox-1555")), fs.realpathSync(path.join(real.root, "firefox-1555")));
    assert.ok(fs.lstatSync(path.join(mirror, "firefox-1555")).isSymbolicLink());
    // The real directory is untouched.
    assert.equal(fs.readFileSync(path.join(real.root, macChromium), "utf8"), echoArgs);
  } finally {
    real.cleanup();
    shadow.cleanup();
  }
});

test("Playwright's browsers live in PLAYWRIGHT_BROWSERS_PATH or the platform's cache", () => {
  assert.equal(defaultBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "/x" }, { platform: "darwin", home: "/h" }), "/x");
  assert.equal(defaultBrowsersPath({}, { platform: "darwin", home: "/h" }), "/h/Library/Caches/ms-playwright");
  assert.equal(defaultBrowsersPath({}, { platform: "linux", home: "/h" }), "/h/.cache/ms-playwright");
  assert.equal(defaultBrowsersPath({ XDG_CACHE_HOME: "/c" }, { platform: "linux", home: "/h" }), "/c/ms-playwright");
});

test("software compositing is what Chromium reports with the GPU off", () => {
  // SystemInfo.getInfo's gpu.featureStatus on this Mac: Metal by default,
  // "disabled_software" with --disable-gpu.
  assert.equal(softwareCompositing({ gpu_compositing: "disabled_software", rasterization: "disabled_software" }), true);
  assert.equal(softwareCompositing({ gpu_compositing: "enabled", rasterization: "enabled" }), false);
  assert.equal(softwareCompositing({}), false);
  assert.equal(softwareCompositing(undefined), false);
});
