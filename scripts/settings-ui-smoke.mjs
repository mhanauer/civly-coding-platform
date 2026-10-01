// Real renderer and preload, with fixture IPC: Settings turns the features
// built for one setup on and off (src/main/settings.ts). Each chat's Filter
// control shows only with the plain-English filter on, a Claude chat's Tools
// control only with lean chats on, and the project settings take effect
// without a restart.
// CPH_TEST_APP_ROOT can point to an extracted or packaged app to test its build.
// CPH_TEST_SCREENSHOT=<file.png> saves the window with Settings open.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.CPH_TEST_APP_ROOT || resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "cph-settings-test-"));
app.setPath("userData", join(temp, "profile"));
const session = {
  id: "settings-fixture", cwd: "/work/app", title: "Settings fixture",
  planId: "fixture", planLabel: "Claude Max", planEngine: "claude",
  color: "#c9baf0", model: "fixture", effort: "high", defaultEffort: "high",
  fullAccess: false, filter: true, tools: "auto", autoFull: false, running: false, status: "done", empty: false,
  side: false, queue: [], createdAt: Date.now(), updatedAt: Date.now()
};
let settings = { replyFilter: false, devBranch: false, zcodeProjects: false, leanChats: false };
const saved = [];
const patched = [];
const calls = { list: 0, ensureDev: 0 };
const handlers = {
  "plans:list": () => [{ id: "fixture", label: session.planLabel, engine: "claude", installed: true, models: ["fixture"] }],
  "usage:get": () => ({}), "usage:refresh": () => ({}), "effort:defaults": () => ({}),
  "projects:list": () => {
    calls.list++;
    return [{ path: "/work/app", name: "app" }];
  },
  "projects:branches": () => ({ current: "main", branches: ["main"] }),
  "projects:ensure-dev": () => {
    calls.ensureDev++;
    return { error: null, branches: { current: "main", branches: ["main"] } };
  },
  "session:list": () => [session], "session:transcript": () => [{ kind: "user", text: "Hello there" }],
  "ui:active-chat": () => undefined, "update:status": () => ({ ready: false, waiting: false }),
  "browser:checks": () => [],
  "session:update": (_event, _id, patch) => {
    patched.push(patch);
    Object.assign(session, patch);
    return { summary: session };
  },
  "settings:get": () => settings,
  "settings:set": (_event, patch) => {
    saved.push(patch);
    settings = { ...settings, ...patch };
    return settings;
  }
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

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
  const waitUntil = async (test, what) => {
    const start = Date.now();
    while (!test()) {
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
  const hasFilterControl = "Array.from(document.querySelectorAll('.ctl-label')).some(l => l.textContent === 'Filter')";
  const toolsSelect = "Array.from(document.querySelectorAll('.ctl-group')).find(g => g.querySelector('.ctl-label')?.textContent === 'Tools')?.querySelector('select')";
  const toggle = (label) =>
    evaluate(`Array.from(document.querySelectorAll('.setting-row')).find(r => r.textContent.includes(${JSON.stringify(label)})).querySelector('input').click()`);
  const timeout = setTimeout(() => { console.error("Settings test timed out"); app.exit(1); }, 60_000);
  try {
    await window.loadFile(join(root, "out/renderer/index.html"));
    await waitFor("Boolean(document.querySelector('.session-open'))");
    await evaluate("document.querySelector('.session-open').click()");
    await waitFor("document.querySelector('.transcript')?.textContent.includes('Hello there')");

    await check("a chat has no Filter or Tools control while those settings are off", async () => {
      assert.equal(await evaluate(hasFilterControl), false);
      assert.equal(await evaluate(`Boolean(${toolsSelect})`), false);
    });

    await check("Settings opens with everything off", async () => {
      await evaluate("Array.from(document.querySelectorAll('.usage-btn')).find(b => b.textContent === 'Settings').click()");
      await waitFor("document.querySelectorAll('.setting-row').length === 4", "the four settings");
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.setting-row input')).map(i => i.checked)"), [false, false, false, false]);
    });

    await check("turning lean chats on gives a Claude chat its Tools control, starting on Auto", async () => {
      await toggle("Lean Claude chats");
      await waitUntil(() => saved.length === 1, "the save");
      assert.deepEqual(saved[0], { leanChats: true });
      await waitFor(`Boolean(${toolsSelect})`, "the Tools control");
      assert.deepEqual(await evaluate(`Array.from(${toolsSelect}.options).map(o => [o.value, o.textContent])`), [
        ["auto", "Auto"],
        ["lean", "Lean"],
        ["full", "Full"]
      ]);
      assert.equal(await evaluate(`${toolsSelect}.value`), "auto");
    });

    await check("picking Full in the Tools control changes that chat", async () => {
      await evaluate(`(() => { const s = ${toolsSelect}; s.value = "full"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await waitUntil(() => patched.length === 1, "the chat update");
      assert.deepEqual(patched[0], { tools: "full" });
    });

    await check("turning the filter on saves it and shows the chat's Filter control", async () => {
      await toggle("Plain-English filter");
      await waitUntil(() => saved.length === 2, "the save");
      assert.deepEqual(saved[1], { replyFilter: true });
      await waitFor(hasFilterControl, "the Filter control");
    });

    await check("showing ZCode's projects reads the project list again", async () => {
      const before = calls.list;
      await toggle("Show ZCode's projects");
      await waitUntil(() => calls.list > before, "the project list");
      assert.deepEqual(saved.at(-1), { zcodeProjects: true });
    });

    await check("turning the dev branch on puts the projects on dev", async () => {
      const before = calls.ensureDev;
      await toggle("Work on a dev branch");
      await waitUntil(() => calls.ensureDev > before, "the dev branch pass");
      assert.deepEqual(saved.at(-1), { devBranch: true });
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.setting-row input')).map(i => i.checked)"), [true, true, true, true]);
      if (process.env.CPH_TEST_SCREENSHOT) {
        writeFileSync(process.env.CPH_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
      }
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
