// Real renderer and preload, with fixture IPC instead of coding engines.
// CPH_TEST_APP_ROOT can point to an extracted or packaged app to test its build.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.CPH_TEST_APP_ROOT || resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "cph-chat-submit-test-"));
app.setPath("userData", join(temp, "profile"));
const firstAnswer = "The first answer is complete. Submitting another message must not type this answer again.";
const session = {
  id: "submit-fixture", cwd: "/example/project", title: "Submit regression",
  planId: "fixture", planLabel: "ChatGPT (Codex)", planEngine: "codex",
  color: "#c9baf0", model: "fixture", effort: "high", defaultEffort: "high",
  fullAccess: false, filter: false, running: true, status: "running", empty: false,
  side: false, queue: [], createdAt: Date.now(), updatedAt: Date.now()
};
const transcript = [{ kind: "user", text: "First question" }];
let sent = "";
const handlers = {
  "plans:list": () => [{ id: "fixture", label: session.planLabel, engine: "codex", installed: true, models: ["fixture"] }],
  "usage:get": () => ({}), "usage:refresh": () => ({}), "effort:defaults": () => ({}),
  "projects:list": () => [], "projects:branches": () => ({ current: "", branches: [] }),
  "session:list": () => [session], "session:transcript": () => transcript,
  "ui:active-chat": () => undefined, "update:status": () => ({ ready: false, waiting: false }),
  "browser:checks": () => [],
  "settings:get": () => ({ replyFilter: false, devBranch: false, zcodeProjects: false }),
  "session:send": (_event, id, text) => {
    assert.equal(id, session.id);
    sent = text;
    session.running = true;
    session.status = "running";
    // Deliberately withhold the user echo so the send/echo gap is observable.
    return {};
  }
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

app.whenReady().then(async () => {
app.dock?.hide();
const window = new BrowserWindow({
  show: false, width: 1280, height: 900,
  webPreferences: { preload: join(root, "out/preload/index.js"), webviewTag: true, backgroundThrottling: false }
});
const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
const waitFor = async (expression) => {
  const start = Date.now();
  while (!(await evaluate(expression))) {
    if (Date.now() - start > 10_000) throw new Error(`Timed out: ${expression}`);
    await new Promise((done) => setTimeout(done, 30));
  }
};
const emit = (event) => {
  transcript.push(event);
  window.webContents.send("session:event", { sessionId: session.id, event });
};
const snapshot = `Array.from(document.querySelectorAll('.transcript .msg-text')).map(el => el.textContent)`;
const checkOldAnswer = async (stage) => {
  // The observer also catches a brief reset that a single final snapshot misses.
  const samples = await evaluate(`new Promise(resolve => {
    const samples = [${snapshot}];
    const observer = new MutationObserver(() => samples.push(${snapshot}));
    observer.observe(document.querySelector('.transcript'), { subtree: true, childList: true, characterData: true });
    setTimeout(() => { observer.disconnect(); resolve(samples); }, 400);
  })`);
  for (const texts of samples) assert.deepEqual(texts, [firstAnswer], `${stage}: previous answer changed or duplicated`);
};
const timeout = setTimeout(() => { console.error("Chat submit test timed out"); app.exit(1); }, 30_000);
try {
  await window.loadFile(join(root, "out/renderer/index.html"));
  await waitFor("Boolean(document.querySelector('.session-open'))");
  await evaluate("document.querySelector('.session-open').click()");
  await waitFor("document.querySelector('.transcript')?.textContent.includes('First question')");
  emit({ kind: "text", text: firstAnswer });
  await waitFor(`${snapshot}.includes(${JSON.stringify(firstAnswer)})`);
  // Leave and reopen while the engine is still working after a full message.
  // Observe from the first paint, before a replay animation could finish.
  window.webContents.send("ui:open-chat", "");
  await waitFor("!document.querySelector('.transcript')");
  await evaluate(`window.reopenSamples = [];
    window.reopenObserver = new MutationObserver(() => {
      if (document.querySelector('.transcript .msg-text')) window.reopenSamples.push(${snapshot});
    });
    window.reopenObserver.observe(document.body, { subtree: true, childList: true, characterData: true });`);
  window.webContents.send("ui:open-chat", session.id);
  await waitFor("Boolean(document.querySelector('.transcript .msg-text'))");
  await checkOldAnswer("reopening a running chat");
  const reopenSamples = await evaluate("window.reopenObserver.disconnect(); window.reopenSamples");
  assert.ok(reopenSamples.length > 0);
  for (const texts of reopenSamples) assert.deepEqual(texts, [firstAnswer], "reopened answer replayed");
  session.running = false;
  session.status = "done";
  emit({ kind: "done", ok: true });
  await waitFor("Boolean(document.querySelector('.send-btn'))");
  await evaluate(`const box = document.querySelector('.composer-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Second question');
    box.dispatchEvent(new Event('input', { bubbles: true }));`);
  await waitFor("!document.querySelector('.send-btn').disabled");
  await evaluate("document.querySelector('.send-btn').click()");
  await waitFor("Boolean(document.querySelector('.composer-input-row .stop'))");
  assert.equal(sent, "Second question");
  await checkOldAnswer("before user echo");
  emit({ kind: "user", text: sent });
  await waitFor("document.querySelector('.transcript').textContent.includes('Second question')");
  await checkOldAnswer("after user echo");
  emit({ kind: "delta", text: "This is " });
  await waitFor(`${snapshot}.some(text => text.trim() === 'This is')`);
  emit({ kind: "delta", text: "the new answer." });
  await waitFor(`${snapshot}.includes('This is the new answer.')`);
  emit({ kind: "text", text: "This is the new answer." });
  await waitFor(`${snapshot}.includes('This is the new answer.')`);
  session.running = false;
  session.status = "done";
  emit({ kind: "done", ok: true });
  await waitFor("Boolean(document.querySelector('.send-btn'))");
  assert.deepEqual(await evaluate(snapshot), [firstAnswer, "This is the new answer."]);
  window.webContents.send("ui:open-chat", "");
  await waitFor("!document.querySelector('.transcript')");
  window.webContents.send("ui:open-chat", session.id);
  await waitFor("Boolean(document.querySelector('.transcript .msg-text'))");
  assert.deepEqual(await evaluate(snapshot), [firstAnswer, "This is the new answer."]);
  // Reload to fetch saved history as fresh event objects.
  const reloaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
  window.reload();
  await reloaded;
  await waitFor("Boolean(document.querySelector('.session-open'))");
  await evaluate("document.querySelector('.session-open').click()");
  await waitFor("Boolean(document.querySelector('.transcript .msg-text'))");
  assert.deepEqual(await evaluate(snapshot), [firstAnswer, "This is the new answer."]);
  console.log("PASS: Running and completed chats reopen without replay, submit preserves prior replies, streamed replies appear once, and saved history reloads correctly.");
  window.destroy();
  clearTimeout(timeout);
  rmSync(temp, { recursive: true, force: true });
  app.quit();
} catch (error) {
  console.error(error);
  clearTimeout(timeout);
  window.destroy();
  rmSync(temp, { recursive: true, force: true });
  app.exit(1);
}
});
