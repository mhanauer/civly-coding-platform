// Real renderer and preload, with fixture IPC instead of coding engines.
// A long chat (more rows than render at once) must stay at the latest
// message after a send, and must still let you scroll up to read.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.CPH_TEST_APP_ROOT || resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "cph-chat-scroll-test-"));
app.setPath("userData", join(temp, "profile"));
const session = {
  id: "scroll-fixture", cwd: "/example/project", title: "Scroll regression",
  planId: "fixture", planLabel: "ChatGPT (Codex)", planEngine: "codex",
  color: "#c9baf0", model: "fixture", effort: "high", defaultEffort: "high",
  fullAccess: false, filter: false, running: false, status: "done", empty: false,
  side: false, queue: [], createdAt: Date.now(), updatedAt: Date.now()
};
// well past the 150 rows a chat renders at once, so each new row drops one
const transcript = [];
for (let i = 0; i < 120; i++) {
  transcript.push({ kind: "user", text: `Question ${i}` });
  transcript.push({ kind: "text", text: `Answer ${i}.\n\nA second paragraph so rows have some height.` });
  transcript.push({ kind: "done", ok: true });
}
// a reply heavy enough that React yields mid-update and the browser draws
// in between, the way a real long chat does
const heavy = (label) =>
  Array.from({ length: 400 }, (_, i) => `- **${label}** item ${i + 1} with \`code\` and [a link](https://example.com/${i})`).join("\n") +
  `\n\n${label} end`;
const tall = (label) => Array.from({ length: 12 }, (_, i) => `${label} line ${i + 1}`).join("\n\n");
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
    return {};
  }
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

app.whenReady().then(async () => {
app.dock?.hide();
// A hidden window skips the frames where the browser fires scroll events,
// so this one is shown but fully transparent, never takes focus, and lets
// your own clicks and scrolls pass through to whatever is underneath.
const window = new BrowserWindow({
  show: true, opacity: 0, focusable: false, skipTaskbar: true, width: 1280, height: 900,
  webPreferences: { preload: join(root, "out/preload/index.js"), webviewTag: true, backgroundThrottling: false }
});
window.setIgnoreMouseEvents(true);
const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
const waitFor = async (expression) => {
  const start = Date.now();
  while (!(await evaluate(expression))) {
    if (Date.now() - start > 10_000) throw new Error(`Timed out: ${expression}`);
    await new Promise((done) => setTimeout(done, 30));
  }
};
const settle = () => new Promise((done) => setTimeout(done, 400));
const emit = (event) => {
  transcript.push(event);
  window.webContents.send("session:event", { sessionId: session.id, event });
};
const gap = `(() => { const el = document.querySelector('.transcript');
  return el.scrollHeight - el.scrollTop - el.clientHeight; })()`;
const jumpShown = "Boolean(document.querySelector('.jump-latest'))";
const assertAtLatest = async (stage) => {
  await settle();
  const away = await evaluate(gap);
  assert.ok(away < 5, `${stage}: ${away}px short of the latest message`);
  assert.equal(await evaluate(jumpShown), false, `${stage}: "Jump to latest" is showing`);
};
const timeout = setTimeout(() => { console.error("Chat scroll test timed out"); app.exit(1); }, 60_000);
try {
  await window.loadFile(join(root, "out/renderer/index.html"));
  await waitFor("Boolean(document.querySelector('.session-open'))");
  await evaluate("document.querySelector('.session-open').click()");
  await waitFor("document.querySelector('.transcript')?.textContent.includes('Answer 119.')");
  await assertAtLatest("opening the chat");

  // The browser moving the view on its own (as when the oldest row drops
  // off a long chat) is not you scrolling up, so the chat stays at the end.
  // The test window may get no frames to fire scroll events in, so the
  // scroll events here are sent by hand.
  await evaluate(`{ const el = document.querySelector('.transcript');
    el.scrollTop -= 300;
    el.dispatchEvent(new Event('scroll')); }`);
  await assertAtLatest("after the browser moved the view");

  // the real race is timing-dependent, so a few rounds
  for (let round = 1; round <= 3; round++) {
    await evaluate(`{ const box = document.querySelector('.composer-input');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(tall(`Sent ${round}`))});
      box.dispatchEvent(new Event('input', { bubbles: true })); }`);
    await waitFor("!document.querySelector('.send-btn').disabled");
    await evaluate("document.querySelector('.send-btn').click()");
    await waitFor("Boolean(document.querySelector('.composer-input-row .stop'))");
    await assertAtLatest(`round ${round}, right after send`);
    emit({ kind: "user", text: sent });
    await waitFor(`document.querySelector('.transcript').textContent.includes('Sent ${round} line 12')`);
    await assertAtLatest(`round ${round}, after the sent message appears`);
    emit({ kind: "text", text: heavy(`Reply ${round}`) });
    await waitFor(`document.querySelector('.transcript').textContent.includes('Reply ${round} end')`);
    await assertAtLatest(`round ${round}, after the reply appears`);
    session.running = false;
    session.status = "done";
    emit({ kind: "done", ok: true });
    await waitFor("Boolean(document.querySelector('.send-btn'))");
  }

  // Scrolling up yourself still lets go of the bottom.
  await evaluate(`{ const el = document.querySelector('.transcript');
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }));
    el.scrollTop -= 600;
    el.dispatchEvent(new Event('scroll')); }`);
  await waitFor(jumpShown);
  const before = await evaluate(gap);
  emit({ kind: "tool", id: "t1", name: "Bash", input: { command: "ls" } });
  emit({ kind: "text", text: heavy("Later") });
  await waitFor("document.querySelector('.transcript').textContent.includes('Later end')");
  await settle();
  assert.ok((await evaluate(gap)) > before, "new text pulled you down while you were reading");
  assert.equal(await evaluate(jumpShown), true, '"Jump to latest" hid while you were reading');
  await evaluate("document.querySelector('.jump-latest').click()");
  await assertAtLatest("after Jump to latest");

  console.log("PASS: A long chat stays at the latest message through a send and its reply, and scrolling up still holds your place.");
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
