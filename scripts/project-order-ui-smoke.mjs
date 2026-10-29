// Real renderer and preload, with fixture IPC: projects move by dragging
// their name or through the ⋯ menu, and each move is saved on the Mac.
// Drags go through Chromium's own drag pipeline (DevTools drag interception),
// so a name that cannot actually be dragged fails here.
// CPH_TEST_APP_ROOT can point to an extracted or packaged app to test its build.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = process.env.CPH_TEST_APP_ROOT || resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "cph-project-order-test-"));
app.setPath("userData", join(temp, "profile"));
let paths = ["/work/coding-plan-hub", "/work/infra", "/work/website", "/work/api-server"];
const listed = () => paths.map((path) => ({ path, name: basename(path) }));
const saves = [];
const handlers = {
  "plans:list": () => [{ id: "fixture", label: "Claude Max", engine: "claude", installed: true, models: ["fixture"] }],
  "usage:get": () => ({}), "usage:refresh": () => ({}), "effort:defaults": () => ({}),
  "projects:list": () => listed(), "projects:branches": () => ({ current: "", branches: [] }),
  "projects:ensure-dev": () => ({ branches: { current: "", branches: [] } }),
  "projects:reorder": (_event, order) => {
    saves.push(order);
    paths = order;
    return listed();
  },
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
const sidebarOrder = () => evaluate("Array.from(document.querySelectorAll('.project-open')).map(b => b.firstChild.textContent)");
const item = (name) =>
  `Array.from(document.querySelectorAll('.project-item')).find(el => el.querySelector('.project-open').firstChild.textContent === ${JSON.stringify(name)})`;
// the point `at` (0 top, 1 bottom) down a project's name row, in window pixels
const pointOn = (name, at) =>
  evaluate(`(() => { const r = ${item(name)}.querySelector('.project-row').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * ${at} }; })()`);
const nameOf = (name) =>
  evaluate(`(() => { const r = ${item(name)}.querySelector('.project-open').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);

const cdp = window.webContents.debugger;
let intercepted = null;
cdp.on("message", (_event, method, params) => {
  if (method === "Input.dragIntercepted") intercepted = params.data;
});
const mouse = (type, { x, y }) =>
  cdp.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
// Presses on a project's name and moves until Chromium starts a real drag;
// returns the drag's data.
const startDrag = async (name) => {
  intercepted = null;
  const from = await nameOf(name);
  await mouse("mousePressed", from);
  for (let i = 1; i <= 10 && !intercepted; i++) {
    await mouse("mouseMoved", { x: from.x, y: from.y + i * 4 });
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(intercepted, `dragging the name "${name}" did not start a drag`);
  return intercepted;
};
const dragTo = (type, point, data) => cdp.sendCommand("Input.dispatchDragEvent", { type, ...point, data, modifiers: 0 });
// "<project> before" or "<project> after" where the drop line shows, else null
const DROP_LINE =
  "(() => { const el = document.querySelector('.project-item.drop-before, .project-item.drop-after'); return el ? el.querySelector('.project-open').firstChild.textContent + (el.classList.contains('drop-before') ? ' before' : ' after') : null; })()";
const dropLine = () => evaluate(DROP_LINE);

const results = [];
const check = async (name, body) => {
  try {
    await body();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message.split("\n")[0]}`);
  }
};
const timeout = setTimeout(() => { console.error("Project order test timed out"); app.exit(1); }, 60_000);
try {
  await window.loadFile(join(root, "out/renderer/index.html"));
  await waitFor("document.querySelectorAll('.project-open').length === 4", "the projects");
  cdp.attach("1.3");
  await cdp.sendCommand("Input.setInterceptDrags", { enabled: true });

  await check("dragging a project onto the top half of the first puts it on top", async () => {
    const data = await startDrag("api-server");
    assert.ok(data.items.some((i) => i.mimeType === "application/x-cph-project"), JSON.stringify(data.items));
    const target = await pointOn("coding-plan-hub", 0.25);
    await dragTo("dragEnter", target, data);
    await dragTo("dragOver", target, data);
    await waitFor(`${DROP_LINE} === "coding-plan-hub before"`, "the drop line above the first project");
    await dragTo("drop", target, data);
    await mouse("mouseReleased", target);
    await waitFor("document.querySelector('.project-open').firstChild.textContent === 'api-server'", "the new order");
    assert.deepEqual(saves.at(-1), ["/work/api-server", "/work/coding-plan-hub", "/work/infra", "/work/website"]);
    assert.equal(await dropLine(), null, "the drop line stays after the drop");
  });

  await check("a drop that changes nothing shows no line and saves nothing", async () => {
    const before = saves.length;
    const data = await startDrag("infra");
    // below coding-plan-hub is where infra already is
    const target = await pointOn("coding-plan-hub", 0.75);
    await dragTo("dragEnter", target, data);
    await dragTo("dragOver", target, data);
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(await dropLine(), null);
    await dragTo("drop", target, data);
    await mouse("mouseReleased", target);
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(saves.length, before);
  });

  await check("dragging below the last project moves it to the bottom", async () => {
    const data = await startDrag("coding-plan-hub");
    const target = await pointOn("website", 0.9);
    await dragTo("dragEnter", target, data);
    await dragTo("dragOver", target, data);
    await waitFor(`${DROP_LINE} === "website after"`, "the drop line below the last project");
    await dragTo("drop", target, data);
    await mouse("mouseReleased", target);
    await waitFor("document.querySelectorAll('.project-open')[3].firstChild.textContent === 'coding-plan-hub'", "the new order");
    assert.deepEqual(await sidebarOrder(), ["api-server", "infra", "website", "coding-plan-hub"]);
  });

  await check("the ⋯ menu offers only the moves that do something", async () => {
    const labels = async (name) => {
      await evaluate(`${item(name)}.querySelector('.project-more').click()`);
      await waitFor("Boolean(document.querySelector('.project-menu'))", "the menu");
      const out = await evaluate("Array.from(document.querySelectorAll('.project-menu button')).map(b => b.textContent)");
      await evaluate("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
      await waitFor("!document.querySelector('.project-menu')", "the menu to close on a click elsewhere");
      return out;
    };
    assert.deepEqual(await labels("api-server"), ["Move down"]);
    assert.deepEqual(await labels("infra"), ["Move to top", "Move down"]);
    assert.deepEqual(await labels("website"), ["Move to top", "Move up", "Move down"]);
    assert.deepEqual(await labels("coding-plan-hub"), ["Move to top", "Move up"]);
  });

  await check("Move to top from the menu (right-click) saves the new order", async () => {
    await evaluate(`${item("website")}.querySelector('.project-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
    await waitFor("Boolean(document.querySelector('.project-menu'))", "the menu");
    await evaluate("Array.from(document.querySelectorAll('.project-menu button')).find(b => b.textContent === 'Move to top').click()");
    await waitFor("document.querySelector('.project-open').firstChild.textContent === 'website'", "the new order");
    assert.deepEqual(await sidebarOrder(), ["website", "api-server", "infra", "coding-plan-hub"]);
    assert.deepEqual(saves.at(-1), ["/work/website", "/work/api-server", "/work/infra", "/work/coding-plan-hub"]);
    assert.equal(await evaluate("Boolean(document.querySelector('.project-menu'))"), false);
  });

  await check("a file dragged over a project is not a project move", async () => {
    const before = saves.length;
    const taken = await evaluate(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));
      const el = ${item("infra")}.querySelector('.project-row');
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return Boolean(document.querySelector('.project-item.drop-before, .project-item.drop-after'));
    })()`);
    assert.equal(taken, false);
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(saves.length, before);
  });

  console.log(results.join("\n"));
  cdp.detach();
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
