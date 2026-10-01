// Real renderer and preload, with fixture IPC instead of coding engines:
// Claude's question cards must always leave a way to continue.
// CPH_TEST_APP_ROOT can point to an extracted or packaged app to test its build.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.CPH_TEST_APP_ROOT || resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "cph-question-test-"));
app.setPath("userData", join(temp, "profile"));
const session = {
  id: "question-fixture", cwd: "/example/project", title: "Question regression",
  planId: "fixture", planLabel: "Claude Max", planEngine: "claude",
  color: "#c9baf0", model: "fixture", effort: "high", defaultEffort: "high",
  fullAccess: false, filter: false, running: true, status: "running", empty: false,
  side: false, queue: [], createdAt: Date.now(), updatedAt: Date.now()
};
const transcript = [{ kind: "user", text: "First question" }];
const answers = [];
// what the next answer gets back from the main process
let answerReply = {};
const handlers = {
  "plans:list": () => [{ id: "fixture", label: session.planLabel, engine: "claude", installed: true, models: ["fixture"] }],
  "usage:get": () => ({}), "usage:refresh": () => ({}), "effort:defaults": () => ({}),
  "projects:list": () => [], "projects:branches": () => ({ current: "", branches: [] }),
  "session:list": () => [session], "session:transcript": () => transcript,
  "ui:active-chat": () => undefined, "update:status": () => ({ ready: false, waiting: false }),
  "browser:checks": () => [],
  "settings:get": () => ({ replyFilter: false, devBranch: false, zcodeProjects: false }),
  "session:permission": (_event, id, requestId, allow, always, given, response) => {
    assert.equal(id, session.id);
    answers.push({ requestId, allow, answers: given, response });
    const reply = answerReply;
    answerReply = {};
    return reply;
  }
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

const threeQuestions = [
  { question: "Ship the Coding page?", header: "Coding page", multiSelect: false,
    options: [{ label: "Hold it", description: "Keep it on dev" }, { label: "Include it", description: "Ship it now" }] },
  { question: "Ship the chat menu changes?", header: "Chat menu", multiSelect: false,
    options: [{ label: "Hold them" }, { label: "Include them" }] },
  { question: "What should I push now?", header: "Go ahead", multiSelect: true,
    options: [{ label: "Update the draft" }, { label: "Push the dev fixes" }, { label: "Merge after checks" }] }
];
const oneQuestion = [
  { question: "Which database?", header: "Database", multiSelect: false,
    options: [{ label: "Postgres" }, { label: "SQLite" }] }
];

app.whenReady().then(async () => {
app.dock?.hide();
const window = new BrowserWindow({
  show: false, width: 1280, height: 900,
  webPreferences: { preload: join(root, "out/preload/index.js"), webviewTag: true, backgroundThrottling: false }
});
const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
const waitFor = async (expression, what = expression) => {
  const start = Date.now();
  while (!(await evaluate(expression))) {
    if (Date.now() - start > 5_000) throw new Error(`Timed out: ${what}`);
    await new Promise((done) => setTimeout(done, 30));
  }
};
const emit = (event) => {
  transcript.push(event);
  window.webContents.send("session:event", { sessionId: session.id, event });
};
const ask = (requestId, questions) =>
  emit({ kind: "permission", requestId, tool: "AskUserQuestion", input: { questions }, step: { type: "other", label: "AskUserQuestion", target: "" }, suggestions: [] });
// the card for one request: the nth question card on screen
const card = (n) => `document.querySelectorAll('.transcript .perm-card')[${n}]`;
const option = (n, label) =>
  `Array.from(${card(n)}.querySelectorAll('.q-option')).find(b => b.textContent.startsWith(${JSON.stringify(label)}))`;
const click = (expression) => evaluate(`${expression}.click()`);
// resolves once an answer beyond the first `count` reached the main process
const sent = async (count) => {
  const start = Date.now();
  while (answers.length <= count) {
    if (Date.now() - start > 5_000) throw new Error("Timed out: the answer never reached the main process");
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
const timeout = setTimeout(() => { console.error("Question card test timed out"); app.exit(1); }, 60_000);
try {
  await window.loadFile(join(root, "out/renderer/index.html"));
  await waitFor("Boolean(document.querySelector('.session-open'))");
  await evaluate("document.querySelector('.session-open').click()");
  await waitFor("document.querySelector('.transcript')?.textContent.includes('First question')");

  // 1. Three questions: pick an answer for each, then Send answers.
  await check("three questions: picks for every question send", async () => {
    ask("q1", threeQuestions);
    await waitFor(`Boolean(${card(0)})`, "the question card");
    await click(option(0, "Include it"));
    // Send waits on the rest, and says how many are left
    await waitFor(`${card(0)}.querySelector('.send-btn').disabled`, "Send disabled until every question has an answer");
    await waitFor(`${card(0)}.textContent.includes('1 of 3 answered')`, "the answered count");
    await click(option(0, "Include them"));
    // other output arriving while the card waits must not clear the picks
    emit({ kind: "thinking_delta", text: "", startedAt: Date.now() });
    emit({ kind: "thinking_delta", text: "a background helper reports in" });
    await click(option(0, "Update the draft"));
    await click(option(0, "Merge after checks"));
    await waitFor(`!${card(0)}.querySelector('.send-btn').disabled`, "Send answers enabled");
    const before = answers.length;
    await click(`${card(0)}.querySelector('.send-btn')`);
    await sent(before);
    const last = answers.at(-1);
    assert.equal(last.requestId, "q1");
    assert.deepEqual(last.answers, {
      "Ship the Coding page?": "Include it",
      "Ship the chat menu changes?": "Include them",
      "What should I push now?": "Update the draft, Merge after checks"
    });
    emit({ kind: "permission_decision", requestId: "q1", allowed: true, always: false, answers: last.answers });
    await waitFor(`${card(0)}.classList.contains('done')`, "the card shows answered");
  });

  // 2. A pick that the main process could not deliver must not leave the
  // card frozen: the options come back so you can try again or skip.
  await check("a failed answer leaves the card answerable", async () => {
    answerReply = { error: "The answer did not reach the Mac: relay dropped" };
    ask("q2", oneQuestion);
    await waitFor(`Boolean(${card(1)})`, "the second card");
    let before = answers.length;
    await click(option(1, "Postgres"));
    await sent(before);
    await waitFor(`${card(1)}.textContent.includes('relay dropped')`, "the error on the card");
    await waitFor(`!${option(1, "Postgres")}.disabled`, "the options back after a failed answer");
    // trying again goes through
    before = answers.length;
    await click(option(1, "SQLite"));
    await sent(before);
    assert.deepEqual(answers.at(-1).answers, { "Which database?": "SQLite" });
    emit({ kind: "permission_decision", requestId: "q2", allowed: true, always: false, answers: answers.at(-1).answers });
    await waitFor(`${card(1)}.classList.contains('done')`, "the card shows answered");
  });

  await check("an answer to a request nothing waits on closes the card and says what to do", async () => {
    answerReply = { error: "Claude is no longer waiting on this. Type your answer in the message box instead.", gone: true };
    ask("q2b", oneQuestion);
    await waitFor(`Boolean(${card(2)})`, "the card");
    const before = answers.length;
    await click(option(2, "Postgres"));
    await sent(before);
    await waitFor(`${card(2)}.classList.contains('done')`, "the card to close");
    const text = await evaluate(`${card(2)}.textContent`);
    assert.ok(text.includes("No longer waiting") && text.includes("message box"), text);
  });

  // 3. Claude Code can withdraw a question (the call was interrupted, or it
  // was settled another way). The card must stop offering answers.
  await check("a withdrawn question stops offering answers", async () => {
    ask("q3", oneQuestion);
    await waitFor(`Boolean(${card(3)})`, "the card");
    emit({ kind: "permission_decision", requestId: "q3", allowed: false, withdrawn: true });
    await waitFor(`${card(3)}.classList.contains('done')`, "the withdrawn card to close");
    const text = await evaluate(`${card(3)}.textContent`);
    assert.ok(text.includes("No longer waiting") && !/Skipped/.test(text), `withdrawn card reads: ${text}`);
  });

  // 4. A question left unanswered when its reply ended must not come back to
  // life when the next reply starts: nothing is waiting on it any more.
  await check("an old unanswered question stays closed during the next reply", async () => {
    ask("q4", oneQuestion);
    await waitFor(`Boolean(${card(4)})`, "the card");
    session.running = false;
    session.status = "done";
    emit({ kind: "done", ok: true });
    await waitFor(`${card(4)}.classList.contains('done')`, "the card to close when the reply ends");
    session.running = true;
    session.status = "running";
    emit({ kind: "user", text: "Second message" });
    await waitFor("document.querySelector('.transcript').textContent.includes('Second message')");
    await new Promise((done) => setTimeout(done, 200));
    const reopened = await evaluate(`!${card(4)}.classList.contains('done')`);
    assert.equal(reopened, false, "the old card offers answers again while the new reply runs");
  });

  // 5. Typing in the message box while Claude waits on a question answers
  // it, in either mode. Queue mode used to park the answer behind a reply
  // that could not finish until the question was answered.
  for (const mode of ["queue", "steer"]) {
    await check(`the message box answers a waiting question (${mode} mode)`, async () => {
      await evaluate(`(() => {
        const select = Array.from(document.querySelectorAll('select')).find(s => s.title === 'What Enter does while a reply is running');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(mode)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const id = `q5-${mode}`;
      const n = await evaluate("document.querySelectorAll('.transcript .perm-card').length");
      ask(id, threeQuestions);
      await waitFor(`Boolean(${card(n)})`, "the card");
      await waitFor("document.querySelector('.composer-input').placeholder.includes('waiting on its question')", "the message box to offer answering");
      await evaluate(`(() => {
        const box = document.querySelector('.composer-input');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Ship all of it, no need to hold anything');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const before = answers.length;
      await evaluate(`document.querySelector('.composer-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await sent(before);
      const last = answers.at(-1);
      assert.equal(last.requestId, id);
      assert.equal(last.allow, true);
      assert.equal(last.response, "Ship all of it, no need to hold anything");
      assert.equal(await evaluate("document.querySelector('.composer-input').value"), "");
      emit({ kind: "permission_decision", requestId: id, allowed: true, always: false, response: last.response });
      await waitFor(`${card(n)}.classList.contains('done') && ${card(n)}.textContent.includes('Ship all of it')`, "the card to show the reply");
    });
  }

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
