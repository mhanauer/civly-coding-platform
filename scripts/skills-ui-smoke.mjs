// Real renderer and preload, with fixture IPC: the Skills button beside
// Usage lists your skills with a one-line summary each, personal ones first,
// then each project's own (src/main/skills.ts). Clicking one shows its full
// description, and search narrows the list.
// CPH_TEST_APP_ROOT can point to an extracted or packaged app to test its build.
// CPH_TEST_SCREENSHOT=<file.png> saves the window with Skills open.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.CPH_TEST_APP_ROOT || resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "cph-skills-test-"));
app.setPath("userData", join(temp, "profile"));
let skills = [
  {
    name: "proposal", project: "", file: "/skills/proposal/SKILL.md",
    summary: "Generate concise proposals and statements of work.",
    description: "Generate concise proposals and statements of work. Use when asked to draft a proposal."
  },
  {
    name: "ticket", project: "", file: "/skills/ticket/SKILL.md",
    summary: "File a GitHub issue with built-in QC.",
    description: "File a GitHub issue with built-in QC (cross-repo dedup, scope)"
  },
  {
    name: "qc-pass", project: "team", file: "/team/.claude/skills/qc-pass/SKILL.md",
    summary: "Fact-check a deliverable before it ships.",
    description: "Fact-check a deliverable before it ships."
  }
];
const revealed = [];
const calls = { list: 0 };
const handlers = {
  "plans:list": () => [{ id: "fixture", label: "Claude Max", engine: "claude", installed: true, models: ["fixture"] }],
  "usage:get": () => ({}), "usage:refresh": () => ({}), "effort:defaults": () => ({}),
  "projects:list": () => [{ path: "/work/app", name: "app" }],
  "projects:branches": () => ({ current: "main", branches: ["main"] }),
  "projects:ensure-dev": () => ({ error: null, branches: { current: "main", branches: ["main"] } }),
  "session:list": () => [], "session:transcript": () => [],
  "ui:active-chat": () => undefined, "update:status": () => ({ ready: false, waiting: false }),
  "browser:checks": () => [],
  "settings:get": () => ({ replyFilter: false, devBranch: false, zcodeProjects: false, leanChats: false, updateClis: false }),
  "clis:status": () => [],
  "skills:list": () => {
    calls.list++;
    return skills;
  },
  "skills:reveal": (_event, file) => {
    revealed.push(file);
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
  const rows = "Array.from(document.querySelectorAll('.skill-row')).map(r => r.querySelector('.skill-name').textContent + ': ' + (r.querySelector('.skill-summary') ?? r.querySelector('.skill-detail div')).textContent)";
  const heads = "Array.from(document.querySelectorAll('.skills-group-head')).map(h => h.textContent)";
  const search = (text) =>
    evaluate(`(() => {
      const input = document.querySelector('.skills-dash input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  const timeout = setTimeout(() => { console.error("Skills test timed out"); app.exit(1); }, 60_000);
  try {
    await window.loadFile(join(root, "out/renderer/index.html"));
    await waitFor("Array.from(document.querySelectorAll('.sidebar-actions .usage-btn')).some(b => b.textContent === 'Skills')");

    await check("the Skills button sits right after Usage", async () => {
      assert.deepEqual(
        await evaluate("Array.from(document.querySelectorAll('.sidebar-actions .usage-btn')).map(b => b.textContent)"),
        ["Accounts", "Settings", "Usage", "Skills"]
      );
    });

    await check("Skills lists each skill with its summary, personal ones first", async () => {
      await evaluate("Array.from(document.querySelectorAll('.usage-btn')).find(b => b.textContent === 'Skills').click()");
      await waitFor("document.querySelectorAll('.skill-row').length === 3", "the three skills");
      assert.deepEqual(await evaluate(heads), ["All projects 2", "team 1"]);
      assert.deepEqual(await evaluate(rows), [
        "proposal: Generate concise proposals and statements of work.",
        "ticket: File a GitHub issue with built-in QC.",
        "qc-pass: Fact-check a deliverable before it ships."
      ]);
    });

    await check("clicking a skill shows its full description and where it lives", async () => {
      await evaluate("document.querySelectorAll('.skill-row')[1].click()");
      await waitFor("Boolean(document.querySelector('.skill-row.open .skill-detail'))", "the open skill");
      const detail = await evaluate("document.querySelector('.skill-row.open .skill-detail').textContent");
      assert.ok(detail.includes("(cross-repo dedup, scope)"), detail);
      assert.ok(detail.includes("/skills/ticket/SKILL.md"), detail);
      // its summary gives way to the full description it starts
      assert.equal(await evaluate("Boolean(document.querySelector('.skill-row.open .skill-summary'))"), false);
      await evaluate("document.querySelector('.skill-row.open .skill-file button').click()");
      await waitUntil(() => revealed.length === 1, "Show in Finder");
      assert.deepEqual(revealed, ["/skills/ticket/SKILL.md"]);
      // clicking inside the description leaves it open
      assert.equal(await evaluate("document.querySelectorAll('.skill-row.open').length"), 1);
    });

    await check("search narrows the list, and says when nothing matches", async () => {
      await search("fact");
      await waitFor("document.querySelectorAll('.skill-row').length === 1", "one match");
      assert.deepEqual(await evaluate(heads), ["team 1"]);
      await search("nothing like this");
      await waitFor("document.querySelector('.skills-empty')?.textContent === 'No skill matches that.'", "the no-match note");
      await search("");
      await waitFor("document.querySelectorAll('.skill-row').length === 3", "all three again");
    });

    await check("Refresh reads the skill folders again", async () => {
      skills = [...skills, { name: "video", project: "", file: "/skills/video/SKILL.md", summary: "Make a brand film.", description: "Make a brand film." }];
      const before = calls.list;
      await evaluate("Array.from(document.querySelectorAll('.skills-dash .mini-btn')).find(b => b.textContent === 'Refresh').click()");
      await waitUntil(() => calls.list > before, "the reread");
      await waitFor("document.querySelectorAll('.skill-row').length === 4", "the new skill");
      if (process.env.CPH_TEST_SCREENSHOT) {
        writeFileSync(process.env.CPH_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
      }
    });

    await check("Close shuts the Skills view", async () => {
      await evaluate("Array.from(document.querySelectorAll('.skills-dash .mini-btn')).find(b => b.textContent === 'Close').click()");
      await waitFor("!document.querySelector('.skills-dash')", "the closed view");
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
