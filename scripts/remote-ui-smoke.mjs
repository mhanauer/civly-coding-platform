import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.CPH_TEST_APP_ROOT || resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "cph-remote-ui-"));
app.setPath("userData", join(temp, "profile"));
const plan = { id: "fixture", label: "Claude Max", engine: "claude", color: "#d97757", installed: true, loggedIn: true, models: ["fixture"] };
const mac = { id: "studio", label: "Mac Studio", sshHost: "mac-studio", online: true, plans: [plan] };
const sessions = [];
let createOptions;
let continued;
let transcript = [];
const handlers = {
  "plans:list": () => [plan], "remote:macs": () => [mac],
  "settings:get": () => ({ replyFilter: false, devBranch: false, zcodeProjects: false, leanChats: false, updateClis: false, acceptRemoteChats: false }),
  "usage:get": () => ({}), "effort:defaults": () => ({}), "browser:checks": () => [],
  "update:status": () => ({ ready: false, waiting: false }), "ui:active-chat": () => undefined,
  "projects:list": () => [{ path: "/work/app", name: "app" }],
  "projects:branches": () => ({ current: "main", branches: ["main"] }),
  "projects:ensure-dev": () => ({ error: null, branches: { current: "main", branches: ["main"] } }),
  "session:list": () => sessions,
  "session:transcript": () => transcript,
  "session:create": (_event, opts) => {
    createOptions = opts;
    sessions.push({ id: "remote-chat", planId: plan.id, planLabel: plan.label, planEngine: plan.engine,
      color: plan.color, cwd: opts.cwd, model: opts.model, effort: opts.effort,
      fullAccess: opts.fullAccess, filter: true, tools: "auto", autoFull: false,
      running: false, title: "", empty: true, status: "idle", queue: [], defaultEffort: "",
      side: false, createdAt: Date.now(), updatedAt: Date.now(), hostId: mac.id, hostLabel: mac.label, hostOnline: true });
    return { sessionId: "remote-chat" };
  },
  "remote:continue": (_event, source, destination) => {
    continued = [source, destination];
    sessions.push({ ...sessions[0], id: "local-continuation", hostId: undefined, hostLabel: undefined, title: "Continued" });
    sessions[0].transferredTo = "This Mac";
    return { sessionId: "local-continuation" };
  }
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

app.whenReady().then(async () => {
  app.dock?.hide();
  const window = new BrowserWindow({ show: false, width: 1200, height: 850,
    webPreferences: { preload: join(root, "out/preload/index.js"), backgroundThrottling: false } });
  const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
  const waitFor = async (expression) => {
    const start = Date.now();
    while (!(await evaluate(expression))) {
      if (Date.now() - start > 8_000) throw new Error(`Timed out: ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const timeout = setTimeout(() => app.exit(1), 30_000);
  try {
    await window.loadFile(join(root, "out/renderer/index.html"));
    await waitFor("Boolean(document.querySelector('.run-on-row select'))");
    await evaluate(`(() => { const s = document.querySelector('.run-on-row select'); s.value = 'studio'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await evaluate("document.querySelector('.project-open').click()");
    await waitFor("Boolean(document.querySelector('.session-item'))");
    assert.equal(createOptions.hostId, "studio");
    assert.match(await evaluate("document.querySelector('.session-item').textContent"), /Mac Studio/);
    transcript = [{ kind: "user", text: "Build it" }, { kind: "text", text: "Remote reply" }];
    window.webContents.send("session:snapshot", { sessionId: "remote-chat", offset: 0, events: transcript });
    await waitFor("document.querySelector('.transcript')?.textContent.includes('Remote reply')");
    window.webContents.send("session:snapshot", { sessionId: "remote-chat", offset: 0, events: transcript });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await evaluate("document.querySelectorAll('.transcript .msg-text').length"), 1);
    await evaluate("document.querySelector('.session-more').click()");
    await waitFor("document.querySelector('.chat-menu')?.textContent.includes('Continue on another Mac')");
    await evaluate("Array.from(document.querySelectorAll('.chat-menu button')).find(b => b.textContent.includes('This Mac')).click()");
    await waitFor("document.querySelector('.header .host-chip')?.textContent.includes('This Mac')");
    assert.deepEqual(continued, ["remote-chat", "local"]);
    console.log("PASS: host selection, host label, reconnect snapshot, and Continue on another Mac controls");
    clearTimeout(timeout);
    window.destroy();
    rmSync(temp, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    window.destroy();
    rmSync(temp, { recursive: true, force: true });
    app.exit(1);
  }
});
