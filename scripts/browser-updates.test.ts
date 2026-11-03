import assert from "node:assert/strict";
import { test } from "node:test";
import { findBrowserProcess, shouldRestart, TABS_WAIT, versionOf } from "../src/main/browserUpdates.ts";

const PROFILE = "/data/cph/browser";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FRAMEWORK = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework";

test("the chats' browser is the main Chrome process on its own profile", () => {
  const ps = [
    `  501 ${CHROME} --origin-trial-disabled-features=X`,
    `38721 ${CHROME} --user-data-dir=${PROFILE} --remote-debugging-port=9337 --no-startup-window`,
    `38826 ${FRAMEWORK}/Versions/155.0.8059.80/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer --user-data-dir=${PROFILE}`,
    `  777 ${CHROME} --user-data-dir=${PROFILE}-dev --remote-debugging-port=9338`
  ].join("\n");
  assert.deepEqual(findBrowserProcess(ps, PROFILE), { pid: 38721, app: "/Applications/Google Chrome.app" });
  assert.deepEqual(findBrowserProcess(ps, `${PROFILE}-dev`), { pid: 777, app: "/Applications/Google Chrome.app" });
  assert.equal(findBrowserProcess(ps, "/elsewhere"), undefined);
});

test("the running version is read from DevTools' Browser field", () => {
  assert.equal(versionOf("Chrome/156.0.8078.80"), "156.0.8078.80");
  assert.equal(versionOf("HeadlessChrome/151.0.7922.34"), "151.0.7922.34");
  assert.equal(versionOf(undefined), undefined);
  assert.equal(versionOf("Chrome"), undefined);
});

test("the browser restarts only when Chrome on disk is newer and no chat is browsing", () => {
  const base = { running: "155.0.8059.80", installed: "156.0.8078.80", busy: false, tabs: 0, waitingSince: 0, now: 1000 };
  assert.equal(shouldRestart(base), true);
  assert.equal(shouldRestart({ ...base, installed: base.running }), false);
  assert.equal(shouldRestart({ ...base, installed: undefined }), false);
  assert.equal(shouldRestart({ ...base, busy: true }), false);
  // open tabs hold it for up to a day, then it restarts anyway
  assert.equal(shouldRestart({ ...base, tabs: 2 }), false);
  assert.equal(shouldRestart({ ...base, tabs: 2, now: TABS_WAIT }), true);
  assert.equal(shouldRestart({ ...base, tabs: 2, now: TABS_WAIT, busy: true }), false);
});
