// Real renderer and preload, with fixture IPC: Accounts adds a Claude or
// ChatGPT subscription with its own sign-in, keeps API fields to key plans,
// shows which account each plan is signed in as, and opens the chats' browser.
// CPH_TEST_APP_ROOT can point to an extracted or packaged app to test its build.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.CPH_TEST_APP_ROOT || resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "cph-accounts-ui-test-"));
app.setPath("userData", join(temp, "profile"));
let plans = [
  { id: "claude-max", label: "Claude Max", engine: "claude", installed: true, loggedIn: true, email: "main@example.com", models: ["claude-opus-5-5"], color: "#d97757" },
  { id: "claude-work-1", label: "Claude Max (work)", engine: "claude", installed: true, loggedIn: true, ownLogin: true, email: "work@example.com", env: { CLAUDE_CONFIG_DIR: "/data/accounts/claude-work-1" }, models: ["claude-opus-5-5"], color: "#d97757" },
  { id: "chatgpt-main", label: "ChatGPT (Codex)", engine: "codex", installed: true, loggedIn: true, models: ["gpt-6-sol"], color: "#10a37f" },
  { id: "chatgpt-2", label: "ChatGPT (second)", engine: "codex", installed: true, loggedIn: false, ownLogin: true, env: { CODEX_HOME: "/data/accounts/chatgpt-2" }, models: ["gpt-6-sol"], color: "#10a37f" }
];
const usage = {
  "chatgpt-main": {
    windows: [{ label: "Weekly", usedPct: 90, resetsAt: 1791104086000 }],
    credits: { balance: 62500, unlimited: false },
    resets: {
      availableCount: 2,
      details: [
        { title: "Full reset", expiresAt: 1792701915000 },
        { title: "Full reset", expiresAt: 1793300477000 }
      ]
    },
    updatedAt: Date.now()
  }
};
const created = [];
const logins = [];
const updates = [];
let browserOpens = 0;
const handlers = {
  "plans:list": () => plans,
  "plans:create": (_event, opts) => {
    created.push(opts);
    const label = opts.label.trim() || (opts.engine === "claude" ? "Claude Code account" : "ChatGPT account");
    plans = [...plans, { id: `new-${created.length}`, label, engine: opts.engine, installed: true, loggedIn: false, ownLogin: Boolean(opts.ownLogin), models: ["gpt-6-sol"], color: "#10a37f" }];
    return { plans };
  },
  "plans:update": (_event, id, patch) => {
    updates.push({ id, patch });
    return { plans };
  },
  "plan:login": (_event, id) => {
    logins.push(id);
    return {};
  },
  "browser:open": () => {
    browserOpens++;
    return {};
  },
  "usage:get": () => usage, "usage:refresh": () => usage, "effort:defaults": () => ({}),
  "projects:list": () => [], "projects:branches": () => ({ current: "", branches: [] }),
  "projects:ensure-dev": () => ({ branches: { current: "", branches: [] } }),
  "session:list": () => [], "ui:active-chat": () => undefined,
  "update:status": () => ({ ready: false, waiting: false }),
  "browser:checks": () => [],
  "settings:get": () => ({ replyFilter: false, devBranch: false, zcodeProjects: false })
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

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
  const modal = "document.querySelector('.modal')";
  const row = (label) =>
    `Array.from(document.querySelectorAll('.usage-plan')).find(el => el.querySelector('.usage-plan-head').textContent.startsWith(${JSON.stringify(label)}))`;
  const rowText = (label) => evaluate(`${row(label)}?.querySelector('.usage-plan-head').textContent ?? ''`);
  const clickButton = (scope, label) =>
    evaluate(`Array.from(${scope}.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  // React tracks the value itself; go through the native setter
  const setField = (labelText, value) =>
    evaluate(`(() => {
      const field = Array.from(${modal}.querySelectorAll('.account-form:not(.edit-form) .form-field')).find(f => f.querySelector('span').textContent.startsWith(${JSON.stringify(labelText)}));
      const el = field.querySelector('input, select');
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
  const addForm = () => evaluate(`${modal}.querySelector('.account-form:not(.edit-form)').innerText`);
  const addButton = () => evaluate(`${modal}.querySelector('.account-form:not(.edit-form) button.primary').textContent`);
  const settle = () => new Promise((done) => setTimeout(done, 60));

  const timeout = setTimeout(() => { console.error("Accounts UI test timed out"); app.exit(1); }, 60_000);
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`PASS ${name}`);
    } catch (err) {
      results.push(`FAIL ${name}: ${err.message}`);
    }
  };
  try {
    await window.loadFile(join(root, "out/renderer/index.html"));
    await waitFor("document.querySelector('.usage-btn')", "the Accounts button");
    await evaluate("document.querySelector('.usage-btn').click()");
    await waitFor(`${modal}`, "the Accounts panel");

    await check("each plan says which account it is signed in as", async () => {
      assert.match(await rowText("Claude Max (work)"), /Logged in as work@example\.com/);
      assert.match(await rowText("Claude Max (work)"), /Log in again/);
      assert.match(await rowText("Claude Max"), /Logged in as main@example\.com/);
      assert.doesNotMatch(await rowText("Claude Max"), /Log in again/);
      const buttons = await evaluate(`Array.from(${row("ChatGPT (second)")}.querySelectorAll('button')).map(b => b.textContent.trim())`);
      assert.deepEqual(buttons, ["Log in", "Edit", "Delete"]);
    });

    await check("ChatGPT account shows usage, credits, and reset expirations", async () => {
      const text = await evaluate(`${row("ChatGPT (Codex)")}.innerText`);
      assert.match(text, /90% used/);
      assert.match(text, /Credits: 62,500 remaining/);
      assert.match(text, /Resets: 2 available/);
      assert.match(text, /Full reset expires Oct 22/);
      assert.match(text, /Full reset expires Oct 29/);
    });

    await check("a Claude subscription is the default, with no API fields", async () => {
      const form = await addForm();
      assert.match(form, /Label \(optional\)/);
      assert.match(form, /Sign in with/);
      assert.match(form, /shares your\s+instructions, rules, skills and settings and your Claude chats and memory/);
      assert.doesNotMatch(form, /API base URL|API token/);
      assert.equal(await addButton(), "Add and sign in");
      assert.equal(await evaluate(`${modal}.querySelector('.account-form:not(.edit-form) button.primary').disabled`), false);
    });

    await check("an API key plan shows its key fields", async () => {
      await setField("Sign in with", "key");
      await settle();
      const form = await addForm();
      assert.match(form, /API base URL/);
      assert.match(form, /API token/);
      assert.doesNotMatch(form, /shares your/);
      assert.equal(await addButton(), "Add account");
    });

    await check("a ChatGPT subscription adds with its own sign-in, then opens it", async () => {
      await setField("Engine", "codex");
      await settle();
      const form = await addForm();
      assert.doesNotMatch(form, /Sign in with|API base URL|API token/);
      assert.match(form, /shares your\s+instructions, rules, skills and settings with/);
      assert.equal(await addButton(), "Add and sign in");
      await setField("Label", "ChatGPT (work)");
      await settle();
      await evaluate(`${modal}.querySelector('.account-form:not(.edit-form) button.primary').click()`);
      await waitFor(`${row("ChatGPT (work)")}`, "the new account's row");
      await settle();
      assert.deepEqual(created, [{ label: "ChatGPT (work)", engine: "codex", baseUrl: "", token: "", models: [], ownLogin: true }]);
      assert.deepEqual(logins, ["new-1"]);
    });

    await check("an unnamed Claude account gets added and opens sign-in", async () => {
      await evaluate(`${modal}.querySelector('.account-form:not(.edit-form) button.primary').click()`);
      await waitFor(`${row("Claude Code account")}`, "the unnamed account's row");
      await settle();
      assert.deepEqual(created[1], { label: "", engine: "claude", baseUrl: "", token: "", models: [], ownLogin: true });
      assert.deepEqual(logins, ["new-1", "new-2"]);
    });

    await check("Log in on a signed-out account opens its sign-in", async () => {
      await clickButton(row("ChatGPT (second)"), "Log in");
      await settle();
      assert.deepEqual(logins, ["new-1", "new-2", "chatgpt-2"]);
    });

    await check("editing a subscription account leaves its sign-in alone", async () => {
      await clickButton(row("Claude Max (work)"), "Edit");
      await settle();
      const edit = await evaluate(`${row("Claude Max (work)")}.querySelector('.edit-form').innerText`);
      assert.doesNotMatch(edit, /API base URL|API token/);
      await clickButton(`${row("Claude Max (work)")}.querySelector('.edit-form')`, "Save");
      await settle();
      assert.equal(updates.length, 1);
      assert.equal(updates[0].patch.baseUrl, undefined);
      assert.equal(updates[0].patch.token, undefined);
      await clickButton(row("Claude Max"), "Edit");
      await settle();
      const main = await evaluate(`${row("Claude Max")}.querySelector('.edit-form').innerText`);
      assert.match(main, /API base URL/);
    });

    await check("Open the chats' browser opens it to sign in", async () => {
      await clickButton(modal, "Open the chats' browser");
      await settle();
      assert.equal(browserOpens, 1);
    });

    await check("the Usage dashboard shows ChatGPT usage and its balance", async () => {
      await clickButton(modal, "Close");
      await evaluate("Array.from(document.querySelectorAll('.usage-btn')).find(b => b.textContent.trim() === 'Usage').click()");
      await waitFor("document.querySelector('.usage-dash')", "the Usage dashboard");
      const text = await evaluate("document.querySelector('.usage-dash').innerText");
      assert.match(text, /90% used/);
      assert.match(text, /Credits: 62,500 remaining/);
      assert.match(text, /Resets: 2 available/);
    });
  } catch (err) {
    results.push(`FAIL setup: ${err.message}`);
  }
  clearTimeout(timeout);
  for (const r of results) console.log(r);
  rmSync(temp, { recursive: true, force: true });
  app.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
});
