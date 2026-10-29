// Real renderer and preload, with fixture IPC: the strip that says the
// chats' browser is waiting on you appears, brings the right tab up, and
// goes away once the pages move on (src/main/browserChecks.ts).
// CPH_TEST_APP_ROOT can point to an extracted or packaged app to test its build.
// CPH_TEST_SCREENSHOT=<file.png> saves the window with the strip showing.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.CPH_TEST_APP_ROOT || resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "cph-browser-checks-test-"));
app.setPath("userData", join(temp, "profile"));
const session = {
  id: "browser-fixture", cwd: "/example/project", title: "Court checks",
  planId: "fixture", planLabel: "Claude Max", planEngine: "claude",
  color: "#c9baf0", model: "fixture", effort: "high", defaultEffort: "high",
  fullAccess: false, filter: false, running: true, status: "running", empty: false,
  side: false, queue: [], createdAt: Date.now(), updatedAt: Date.now()
};
const shown = [];
const handlers = {
  "plans:list": () => [{ id: "fixture", label: session.planLabel, engine: "claude", installed: true, models: ["fixture"] }],
  "usage:get": () => ({}), "usage:refresh": () => ({}), "effort:defaults": () => ({}),
  "projects:list": () => [], "projects:branches": () => ({ current: "", branches: [] }),
  "session:list": () => [session], "session:transcript": () => [{ kind: "user", text: "Search the county courts" }],
  "ui:active-chat": () => undefined, "update:status": () => ({ ready: false, waiting: false }),
  "browser:checks": () => [],
  "settings:get": () => ({ replyFilter: false, devBranch: false, zcodeProjects: false }),
  "browser:show-check": (_event, targetId) => {
    shown.push(targetId);
    return {};
  }
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

const checks = [
  { targetId: "T1", kind: "captcha", title: "Tyler Odyssey Portal", url: "https://portalnav19.galvestoncountytx.gov/portal" },
  { targetId: "T2", kind: "sign-in", title: "ClerkNet 3.0", url: "https://secure.sarasotaclerk.com/Login.aspx" }
];

app.whenReady().then(async () => {
  app.dock?.hide();
  const window = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { preload: join(root, "out/preload/index.js"), backgroundThrottling: false }
  });
  const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
  const waitFor = async (expression, what = expression) => {
    const start = Date.now();
    while (!(await evaluate(expression))) {
      if (Date.now() - start > 5_000) throw new Error(`Timed out: ${what}`);
      await new Promise((done) => setTimeout(done, 30));
    }
  };
  const results = [];
  const check = async (name, body) => {
    try {
      await body();
      results.push(`PASS ${name}`);
    } catch (error) {
      results.push(`FAIL ${name}: ${error.message.split("\n")[0]}`);
    }
  };
  const strip = "document.querySelector('.browser-checks')";
  const timeout = setTimeout(() => { console.error("Browser checks test timed out"); app.exit(1); }, 60_000);
  try {
    await window.loadFile(join(root, "out/renderer/index.html"));
    await waitFor("Boolean(document.querySelector('.session-open'))");
    await evaluate("document.querySelector('.session-open').click()");
    await waitFor("document.querySelector('.transcript')?.textContent.includes('Search the county courts')");

    await check("no strip while nothing waits", async () => {
      assert.equal(await evaluate(`Boolean(${strip})`), false);
    });

    await check("the strip names each site and what it needs", async () => {
      window.webContents.send("browser:checks", checks);
      await waitFor(`Boolean(${strip})`, "the strip");
      const labels = await evaluate(`Array.from(${strip}.querySelectorAll('button')).map(b => b.textContent)`);
      assert.deepEqual(labels, ["CAPTCHA on portalnav19.galvestoncountytx.gov", "Sign-in on secure.sarasotaclerk.com"]);
      assert.match(await evaluate(`${strip}.textContent`), /carries on once you are past them/);
      if (process.env.CPH_TEST_SCREENSHOT) {
        writeFileSync(process.env.CPH_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
      }
    });

    await check("a button brings that tab up", async () => {
      await evaluate(`${strip}.querySelectorAll('button')[1].click()`);
      const start = Date.now();
      while (!shown.length && Date.now() - start < 5_000) await new Promise((done) => setTimeout(done, 30));
      assert.deepEqual(shown, ["T2"]);
    });

    await check("the strip goes once the pages move on", async () => {
      window.webContents.send("browser:checks", [checks[1]]);
      await waitFor(`${strip}?.textContent.includes('past it')`, "one check left");
      window.webContents.send("browser:checks", []);
      await waitFor(`!${strip}`, "the strip to go");
    });

    console.log(results.join("\n"));
    window.destroy();
    clearTimeout(timeout);
    rmSync(temp, { recursive: true, force: true });
    app.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
  } catch (error) {
    console.log(results.join("\n"));
    console.error(error);
    clearTimeout(timeout);
    window.destroy();
    rmSync(temp, { recursive: true, force: true });
    app.exit(1);
  }
});
