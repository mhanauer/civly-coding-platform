import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { DATA_DIR, IS_DEV_COPY, addPlan, loadPlans, removePlan, updatePlan } from "./store.ts";
import { resolveBin, runEngine } from "./engines/index.ts";
import { conversationStore, forgetAccount, linkShared, ownLoginArgs } from "./accounts.ts";
import {
  BROWSER_DOWNLOADS,
  BROWSER_ENDPOINT,
  browserServer,
  ensureBrowser,
  openBrowser,
  openInYourChrome,
  usesBrowser,
  warmBrowserServer
} from "./chromeBrowser.ts";
import { showCheck, watchBrowserChecks, type BrowserCheck } from "./browserChecks.ts";
import { adoptShellEnv } from "./shellPath.ts";
import { filterText } from "./filter.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";
import { newestWithin, recapLines, sideContext } from "./recap.ts";
import { AUTO, resolveEffort } from "./autoEffort.ts";
import { allUsage, onUsageChange, recordLimitError, recordUsage, refreshCodex, refreshPlanUsage } from "./usage.ts";
import type { EngineEvent, PlanConfig, RunHandle } from "./engines/types.ts";

app.setName("Civly Coding Platform");
// before any engine or terminal starts: a Dock launch has a bare PATH and
// none of the variables the user exports
adoptShellEnv();

interface Session {
  id: string;
  plan: PlanConfig;
  cwd: string;
  model: string;
  effort: string;
  fullAccess: boolean;
  filter: boolean;
  resumeId?: string;
  running: boolean;
  transcript: EngineEvent[];
  title: string;
  handle?: RunHandle;
  // true while a steer is stopping the current turn to start the next one
  steering?: boolean;
  // set when the chat moved to a plan on a different engine: that engine
  // cannot resume the old conversation, so the next turn carries a recap
  handoff?: boolean;
  // the plan the chat just moved from; the next turn tells the model, so it
  // never claims to be the plan it replaced
  switchedFrom?: string;
  // messages typed while a reply ran, sent one per turn as each finishes
  queue: string[];
  // permission requests waiting on Allow / Deny, by request id
  pending: Map<string, { input?: Record<string, unknown>; suggestions?: unknown[] }>;
  // drives the chat list order: most recently active first
  updatedAt: number;
  // keeps a chat's side conversation tabs in the order they were opened
  createdAt: number;
  // a side-pane conversation: kept out of the chat list
  side?: boolean;
  // the chat a side conversation belongs to; "" is the new-task screen
  parentId?: string;
  // how much of that chat's transcript the side conversation's engine has
  // been told about; unset until it has heard any of it
  parentSeen?: number;
  // Written only as the app is shutting down with this turn still in
  // flight. The next launch uses the engine's resume id (when available)
  // to finish it without making the user send the request again.
  restartTurn?: { prompt: string };
}

interface SessionSummary {
  id: string;
  planId: string;
  planLabel: string;
  planEngine: PlanConfig["engine"];
  color: string;
  cwd: string;
  model: string;
  effort: string;
  fullAccess: boolean;
  filter: boolean;
  running: boolean;
  title: string;
  // true until the first message: plan and folder can still change freely
  empty: boolean;
  status: ChatStatus;
  queue: string[];
  // the effort the engine will actually use when none is picked
  defaultEffort: string;
  side: boolean;
  parentId?: string;
  createdAt: number;
}

// What the sidebar light shows: working, waiting on a permission answer,
// needs you (an error, a blocked permission, a hit limit), or finished.
// "idle" is a new or stopped chat.
type ChatStatus = "idle" | "running" | "waiting" | "error" | "done";

const STOPPED = "Stopped";

function chatStatus(s: Session): ChatStatus {
  if (s.running) return s.pending.size > 0 ? "waiting" : "running";
  const t = s.transcript;
  const lastUser = t.map((e) => e.kind).lastIndexOf("user");
  if (lastUser === -1) return "idle";
  const turn = t.slice(lastUser + 1);
  if (turn.some((e) => e.kind === "status" && e.text === STOPPED)) return "idle";
  if (turn.some((e) => e.kind === "error" || (e.kind === "done" && !e.ok))) return "error";
  // a limit fallback moved the chat: the message has to be sent again
  if (turn.some((e) => e.kind === "status" && e.text.startsWith("Plan limit hit"))) return "error";
  return turn.some((e) => e.kind === "done") ? "done" : "idle";
}

function summary(s: Session): SessionSummary {
  return {
    id: s.id,
    planId: s.plan.id,
    planLabel: s.plan.label,
    planEngine: s.plan.engine,
    color: s.plan.color,
    cwd: s.cwd,
    model: s.model,
    effort: s.effort,
    fullAccess: s.fullAccess,
    filter: s.filter,
    running: s.running,
    title: s.title,
    // a chat with no messages yet can still switch plan and folder freely
    empty: s.transcript.length === 0,
    status: chatStatus(s),
    queue: s.queue,
    defaultEffort: EFFORT_LEVELS[s.plan.engine] ? AUTO : "",
    side: Boolean(s.side),
    parentId: s.parentId,
    createdAt: s.createdAt
  };
}

const sessions = new Map<string, Session>();
let mainWindow: BrowserWindow | null = null;

// Chats persist as JSON under ~/.coding-plan-hub/chats so the old-chats list
// survives restarts. The plan is stored by id and rehydrated from plans.json,
// so no plan secrets (env tokens) are written to chat files.
const CHATS_DIR = join(DATA_DIR, "chats");

interface PersistedChat {
  id: string;
  planId: string;
  title: string;
  cwd: string;
  model: string;
  effort: string;
  fullAccess: boolean;
  filter: boolean;
  resumeId?: string;
  handoff?: boolean;
  switchedFrom?: string;
  queue?: string[];
  side?: boolean;
  parentId?: string;
  parentSeen?: number;
  createdAt?: number;
  restartTurn?: { prompt: string };
  savedAt: number;
  transcript: EngineEvent[];
}

// A busy chat sends output many times a second, and each save rewrites the
// whole chat file: tens of milliseconds for a long chat, spent on the thread
// that also answers the window. Output is saved at most once a second;
// anything that changes where the chat stands is saved at once.
const SAVE_DELAY_MS = 1000;
const OUTPUT_KINDS = new Set<EngineEvent["kind"]>(["delta", "text", "thinking", "tool", "tool_result"]);
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function persistSoon(session: Session): void {
  if (saveTimers.has(session.id)) return;
  saveTimers.set(
    session.id,
    setTimeout(() => persistChat(session), SAVE_DELAY_MS)
  );
}

// every chat with output still waiting on its save, written now
function flushSaves(): void {
  for (const id of [...saveTimers.keys()]) {
    const session = sessions.get(id);
    if (session) persistChat(session);
    else {
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
    }
  }
}

function persistChat(session: Session): void {
  // this save covers anything that was waiting on a timer
  clearTimeout(saveTimers.get(session.id));
  saveTimers.delete(session.id);
  // a deleted chat whose engine is still winding down must not come back
  if (sessions.get(session.id) !== session) return;
  try {
    const record: PersistedChat = {
      id: session.id,
      planId: session.plan.id,
      title: session.title,
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
      fullAccess: session.fullAccess,
      filter: session.filter,
      resumeId: session.resumeId,
      handoff: session.handoff,
      switchedFrom: session.switchedFrom,
      queue: session.queue,
      side: session.side,
      parentId: session.parentId,
      parentSeen: session.parentSeen,
      createdAt: session.createdAt,
      restartTurn: session.restartTurn,
      savedAt: Date.now(),
      transcript: session.transcript
    };
    mkdirSync(CHATS_DIR, { recursive: true });
    writeFileSync(join(CHATS_DIR, `${session.id}.json`), JSON.stringify(record));
  } catch {
    // a failed save must never break the live session
  }
}

// A chat is named after the first line of its first message, the way the
// sidebar can show it whole; renaming caps at the same length.
const TITLE_MAX = 80;
function autoTitle(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, TITLE_MAX);
}

// chats named before the first-line rule kept the first 42 characters of the
// message, newlines and all; ones renamed since keep their name
function migratedTitle(record: PersistedChat): string {
  const title = record.title || "";
  const first = Array.isArray(record.transcript) ? record.transcript.find((e) => e.kind === "user") : undefined;
  if (!first || first.kind !== "user" || title !== first.text.slice(0, 42)) return title;
  return autoTitle(first.text) || title;
}

function loadChats(): void {
  try {
    if (!existsSync(CHATS_DIR)) return;
    const files = readdirSync(CHATS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({
        f,
        mtime: statSync(join(CHATS_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);
    const plans = loadPlans();
    for (const { f } of files) {
      try {
        const record = JSON.parse(readFileSync(join(CHATS_DIR, f), "utf8")) as PersistedChat;
        const plan = plans.find((p) => p.id === record.planId);
        if (!plan) continue;
        // a saved model can fall out of the plan's list (the plan's models
        // were edited); snap back so the picker never shows a dead value
        const model =
          record.model && (!plan.models?.length || plan.models.includes(record.model))
            ? record.model
            : plan.models?.[0] ?? "default";
        sessions.set(record.id, {
          id: record.id,
          plan,
          cwd: record.cwd || homedir(),
          model,
          effort: record.effort || "",
          fullAccess: Boolean(record.fullAccess),
          filter: record.filter !== false,
          resumeId: record.resumeId,
          handoff: Boolean(record.handoff),
          switchedFrom: record.switchedFrom,
          queue: Array.isArray(record.queue) ? record.queue : [],
          pending: new Map(),
          running: false,
          transcript: Array.isArray(record.transcript) ? record.transcript : [],
          title: migratedTitle(record),
          updatedAt: record.savedAt ?? 0,
          createdAt: record.createdAt ?? record.savedAt ?? 0,
          side: Boolean(record.side),
          // side chats from before they belonged to a chat have none and
          // show beside no chat
          parentId: typeof record.parentId === "string" ? record.parentId : undefined,
          parentSeen: typeof record.parentSeen === "number" ? record.parentSeen : undefined,
          restartTurn:
            record.restartTurn && typeof record.restartTurn.prompt === "string" && record.restartTurn.prompt.trim()
              ? { prompt: record.restartTurn.prompt }
              : undefined
        });
      } catch {
        // skip a corrupt chat file rather than refusing to start
      }
    }
  } catch {
    // no chats directory yet, start empty
  }
}

// Projects are the folders added in the app, persisted in
// ~/.coding-plan-hub/projects.json, plus ZCode's recent projects when that
// setting is on.
const PROJECTS_FILE = join(DATA_DIR, "projects.json");

function loadCustomProjectPaths(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(PROJECTS_FILE, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function saveCustomProjectPaths(paths: string[]): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PROJECTS_FILE, JSON.stringify(paths, null, 2));
  } catch {
    // a failed save must not break adding projects in-session
  }
}

// The sidebar order set by dragging projects.
const PROJECT_ORDER_FILE = join(DATA_DIR, "project-order.json");

function loadProjectOrder(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(PROJECT_ORDER_FILE, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function allProjects(): Array<{ path: string; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; name: string }> = [];
  const zcode = loadSettings().zcodeProjects ? zcodeRecentProjectPaths() : [];
  for (const p of [...loadCustomProjectPaths(), ...zcode]) {
    if (!p.trim() || seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, name: basename(p) });
  }
  // Ordered projects first; ones never placed (newly added, or new in
  // ZCode's recents) go at the bottom so they never shuffle the saved order.
  const order = loadProjectOrder();
  const rank = (path: string): number => {
    const i = order.indexOf(path);
    return i === -1 ? order.length : i;
  };
  return out.sort((a, b) => rank(a.path) - rank(b.path));
}

function zcodeRecentProjectPaths(): string[] {
  try {
    const setting = JSON.parse(
      readFileSync(join(homedir(), ".zcode", "v2", "setting.json"), "utf8")
    ) as { recentProjects?: unknown };
    return Array.isArray(setting.recentProjects) ? setting.recentProjects.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function gitBranches(path: string): { current: string; branches: string[] } {
  const run = (args: string[]): string => {
    try {
      const r = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
      return r.status === 0 ? (r.stdout ?? "") : "";
    } catch {
      return "";
    }
  };
  const out = run(["branch", "--list"]);
  if (!out) return { current: "", branches: [] };
  const branches: string[] = [];
  let current = "";
  for (const line of out.split("\n")) {
    const marked = line.startsWith("*");
    const name = line.slice(2).trim();
    if (!name || name.startsWith("(")) continue; // detached HEAD and friends
    branches.push(name);
    if (marked) current = name;
  }
  return { current, branches };
}

function gitRun(path: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
    if (r.status === 0) return null;
    const err = `${r.stderr ?? ""}`.trim();
    return err.split("\n")[0]?.slice(0, 200) || `git ${args[0]} failed`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function gitCheckout(path: string, branch: string): string | null {
  return gitRun(path, ["checkout", branch]);
}

// With the dev branch setting on, dev is the default branch everywhere in
// this tool. For each repo, create a dev branch at the current commit if it
// is missing, then check it out. Non-repo folders are left alone.
function ensureDevDefault(path: string): { error: string | null; branches: { current: string; branches: string[] } } {
  const info = gitBranches(path);
  if (info.branches.length === 0) return { error: null, branches: info };
  if (!info.branches.includes("dev")) {
    const err = gitRun(path, ["branch", "dev"]);
    if (err) return { error: err, branches: gitBranches(path) };
  }
  if (info.current !== "dev") {
    const err = gitCheckout(path, "dev");
    if (err) return { error: err, branches: gitBranches(path) };
  }
  return { error: null, branches: gitBranches(path) };
}

// A plan that runs dry switches the session to the next signed-in plan so
// work keeps going. Plans that can resume the conversation come first (another
// account of the same kind), then the same engine, then the rest; plans that
// are out themselves go last.
const LIMIT_PATTERNS =
  /usage limit|rate[ _-]?limit|quota|429|weekly limit|limit reached|exceeded|hit your limit|ran out/i;

function nextPlanAfterLimit(current: PlanConfig): PlanConfig | null {
  const usage = allUsage();
  const store = conversationStore(current);
  const rank = (p: PlanConfig): number =>
    (conversationStore(p) === store ? 0 : p.engine === current.engine ? 1 : 2) +
    (usage[p.id]?.limitedUntil !== undefined ? 3 : 0);
  const others = loadPlans().filter(
    (p) =>
      p.installed &&
      p.id !== current.id &&
      (p.loggedIn || Boolean(p.env?.ANTHROPIC_AUTH_TOKEN || p.env?.ANTHROPIC_API_KEY))
  );
  return others.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// Moves a chat to another plan. Plans that share a conversation store (every
// Claude plan: added Claude accounts link the main projects folder) keep the
// resume id. Anything else cannot read it: drop the id and mark the next turn
// to carry a recap instead.
function switchPlan(session: Session, next: PlanConfig): void {
  const prev = session.plan;
  // several switches before the next message: the model only needs to hear
  // about the first plan it is replacing
  if (session.transcript.some((e) => e.kind === "user")) {
    session.switchedFrom = session.switchedFrom ?? session.plan.label;
  }
  session.plan = next;
  session.model = next.models?.[0] ?? "default";
  if (next.engine !== prev.engine) session.effort = "";
  if (conversationStore(next) !== conversationStore(prev) && session.transcript.some((e) => e.kind === "user")) {
    session.resumeId = undefined;
    session.handoff = true;
  }
}

// The conversation so far as plain text, for an engine that joins mid-chat.
// Keeps the most recent exchanges when the whole history is too long.
const RECAP_LIMIT = 24000;
function recap(session: Session): string {
  return newestWithin(recapLines(session.transcript), RECAP_LIMIT).text;
}

// A side conversation's message carries the chat it sits beside: all of it
// until its engine has a conversation that heard it (a first message, or a
// move to another engine), then only what happened there since.
function besideContext(session: Session): string {
  const parent = session.side && session.parentId ? sessions.get(session.parentId) : undefined;
  if (!parent) return "";
  // the note points the engine at the chat's file; it has everything so far
  if (saveTimers.has(parent.id)) persistChat(parent);
  const context = sideContext(
    {
      title: parent.title,
      planLabel: parent.plan.label,
      cwd: parent.cwd,
      running: parent.running,
      transcript: parent.transcript,
      file: join(CHATS_DIR, `${parent.id}.json`)
    },
    session.resumeId ? session.parentSeen : undefined
  );
  if (context) session.parentSeen = parent.transcript.length;
  return context;
}

function pushEvent(session: Session, event: EngineEvent): void {
  // live reasoning arrives a word at a time; the window shows it as it
  // streams, but only the finished "thinking" event is kept on disk
  if (event.kind === "thinking_delta") {
    mainWindow?.webContents.send("session:event", { sessionId: session.id, event });
    return;
  }
  // plan usage feeds the usage view, not the chat
  if (event.kind === "usage") {
    recordUsage(session.plan.id, event.windows, event.limited);
    return;
  }
  if (event.kind === "permission") {
    session.pending.set(event.requestId, { input: event.input, suggestions: event.suggestions });
    const questions = event.tool === "AskUserQuestion" && Array.isArray(event.input?.questions) ? event.input.questions : undefined;
    if (questions) {
      const first = (questions[0] ?? {}) as { question?: unknown };
      notify(session, "permission", "Claude has a question", typeof first.question === "string" ? first.question : "");
    } else {
      notify(session, "permission", `Needs permission: ${event.tool}`, event.description || event.step?.target || "");
    }
    // the sidebar light turns to "waiting" as soon as the request lands
    setTimeout(sendSessions, 0);
  }
  if (event.kind === "permission_decision") session.pending.delete(event.requestId);
  if (
    (event.kind === "error" && LIMIT_PATTERNS.test(event.text)) ||
    (event.kind === "done" && !event.ok && event.summary && LIMIT_PATTERNS.test(event.summary))
  ) {
    recordLimitError(session.plan.id, event.kind === "error" ? event.text : event.summary ?? "");
  }
  session.transcript.push(event);
  session.updatedAt = Date.now();
  if (event.kind === "user" && !session.title) {
    session.title = autoTitle(event.text);
  }
  if (event.kind === "session") {
    session.resumeId = event.engineSessionId;
  }
  if (event.kind === "done") {
    session.running = false;
    session.pending.clear();
  }
  if (OUTPUT_KINDS.has(event.kind)) persistSoon(session);
  else persistChat(session);
  mainWindow?.webContents.send("session:event", { sessionId: session.id, event });

  if (event.kind === "error" && LIMIT_PATTERNS.test(event.text)) {
    const next = nextPlanAfterLimit(session.plan);
    if (next) {
      const from = session.plan.label;
      switchPlan(session, next);
      persistChat(session);
      pushEvent(session, {
        kind: "status",
        text: `Plan limit hit on ${from}. This session now runs on ${next.label}. Send your message again.`
      });
    }
  }
}

// Hidden: the dev copy runs with no window or Dock icon while tests drive it.
// The dev copy keeps its own browser profile (local storage, cache) so it
// can run next to the real app without sharing or locking its files.
const HIDDEN = process.env.CPH_HIDDEN === "1";
if (IS_DEV_COPY) app.setPath("userData", join(DATA_DIR, "electron-profile"));

// A link opens as a new tab in the Chrome you already have open, with its
// logins, never as a bare app window or in the chats' browser. No Chrome:
// the default browser.
function openLink(url: string): void {
  if (/^mailto:/i.test(url)) {
    void shell.openExternal(url);
    return;
  }
  // relative links resolve to the app's own files; nothing to open there
  if (!/^https?:\/\//i.test(url)) return;
  openInYourChrome(url, () => void shell.openExternal(url));
}

// every page (the app window and the side pane's browser) sends its
// new-window links to Chrome
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: "deny" };
  });
});

function createWindow(): void {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(join(__dirname, "../../build/civly-mark.png"));
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 760,
    minHeight: 480,
    resizable: true,
    title: IS_DEV_COPY ? "Civly Coding Platform (Dev)" : "Civly Coding Platform",
    // the dev copy runs hidden while it is driven by tests
    show: !HIDDEN,
    backgroundColor: "#0C0417",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      webviewTag: true
    }
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // a link without a new-window target would load over the app itself
  mainWindow.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    openLink(url);
  });

  // keep "(Dev)" in the title instead of the page's own title
  if (IS_DEV_COPY) mainWindow.on("page-title-updated", (e) => e.preventDefault());

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  if (HIDDEN) app.dock?.hide();
  loadChats();
  onUsageChange((all) => mainWindow?.webContents.send("usage:update", all));
  // the plans that can be asked directly, now and every ten minutes
  const pollUsage = (): void => {
    for (const plan of loadPlans().filter((p) => p.installed)) void refreshPlanUsage(plan);
  };
  pollUsage();
  setInterval(pollUsage, 10 * 60 * 1000);
  watchForUpdate();
  warmBrowserServer();
  watchBrowserChecks({
    endpoint: BROWSER_ENDPOINT,
    active: () => [...sessions.values()].some((s) => s.running && usesBrowser(s.plan.engine)),
    onChange: (checks) => {
      browserChecks = checks;
      mainWindow?.webContents.send("browser:checks", checks);
    },
    onNew: () => notifyBrowserChecks()
  });
  createWindow();
  // A restart ends child CLIs mid-turn. Their normal conversation ids are
  // durable in each CLI, so pick the work back up after chats are loaded.
  setTimeout(resumeRestartedTurns, 0);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// app.exit(), used by the in-app updater, does not give Electron's normal
// quit lifecycle a chance on every platform. relaunch() covers that path;
// before-quit covers Cmd-Q, quitting from the Dock, and system quit.
app.on("before-quit", rememberInterruptedTurns);

ipcMain.handle("plans:list", () => loadPlans());

ipcMain.handle(
  "plans:create",
  (
    _e,
    opts: { label: string; engine: string; bin?: string; baseUrl?: string; token?: string; models?: string[]; ownLogin?: boolean }
  ) => {
    const engines = ["claude", "kimi", "codex", "gemini", "opencode", "qwen"];
    if (!opts || !engines.includes(opts.engine)) return { error: `Unknown engine "${opts?.engine}"` };
    const plans = addPlan({
      label: opts.label,
      engine: opts.engine as PlanConfig["engine"],
      bin: opts.bin,
      baseUrl: opts.baseUrl,
      token: opts.token,
      models: opts.models,
      ownLogin: opts.ownLogin
    });
    return { plans };
  }
);

ipcMain.handle(
  "plans:update",
  (
    _e,
    planId: string,
    patch: { label?: string; baseUrl?: string; token?: string; models?: string[] }
  ) => {
    const saved = JSON.parse(readFileSync(join(DATA_DIR, "plans.json"), "utf8")) as PlanConfig[];
    if (!saved.some((p) => p.id === planId)) return { error: "Unknown plan" };
    return { plans: updatePlan(planId, patch) };
  }
);

ipcMain.handle("plans:delete", async (_e, planId: string) => {
  const running = [...sessions.values()].some((s) => s.plan.id === planId && s.running);
  if (running) {
    return { error: "That plan has a session running right now. Stop it first." };
  }
  // an added subscription account signs out and its own home goes with it
  const plan = loadPlans().find((p) => p.id === planId);
  if (plan?.ownLogin) await forgetAccount(plan, resolveBin(plan.bin));
  return { plans: removePlan(planId) };
});

ipcMain.handle("session:create", (_e, opts: { planId: string; cwd: string; model: string; effort: string; fullAccess: boolean; filter?: boolean; side?: boolean; parentId?: string }) => {
  const plan = loadPlans().find((p) => p.id === opts.planId);
  if (!plan) return { error: `Unknown plan: ${opts.planId}` };
  const session: Session = {
    id: randomUUID(),
    plan,
    cwd: opts.cwd || homedir(),
    model: opts.model || plan.models?.[0] || "default",
    effort: opts.effort || "",
    fullAccess: opts.fullAccess !== false,
    filter: opts.filter !== false,
    running: false,
    transcript: [],
    title: "",
    queue: [],
    pending: new Map(),
    updatedAt: Date.now(),
    createdAt: Date.now(),
    side: Boolean(opts.side),
    parentId: opts.side ? opts.parentId ?? "" : undefined
  };
  sessions.set(session.id, session);
  persistChat(session);
  return { sessionId: session.id };
});

// The new-task screen's side conversations go with the chat that screen
// starts. Only the link changes, so it is allowed mid-reply.
ipcMain.handle("session:set-parent", (_e, sessionId: string, parentId: string) => {
  const session = sessions.get(sessionId);
  if (!session?.side) return { error: "Unknown session" };
  session.parentId = parentId;
  // its engine has heard nothing of that chat yet
  session.parentSeen = undefined;
  persistChat(session);
  return {};
});

ipcMain.handle(
  "session:list",
  () => [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summary)
);

ipcMain.handle(
  "session:update",
  (
    _e,
    sessionId: string,
    patch: {
      cwd?: string;
      model?: string;
      effort?: string;
      fullAccess?: boolean;
      filter?: boolean;
      planId?: string;
    }
  ) => {
    const session = sessions.get(sessionId);
    if (!session) return { error: "Unknown session" };
    if (session.running) return { error: "Wait for the current message to finish before changing settings" };
    if (patch.planId !== undefined && patch.planId !== session.plan.id) {
      const plan = loadPlans().find((p) => p.id === patch.planId);
      if (!plan) return { error: `Unknown plan: ${patch.planId}` };
      const from = session.plan.label;
      switchPlan(session, plan);
      if (session.transcript.length > 0) {
        pushEvent(session, {
          kind: "status",
          text: session.handoff
            ? `Switched from ${from} to ${plan.label}. Your next message brings it up to speed on this chat.`
            : `Switched from ${from} to ${plan.label}. The conversation continues where it left off.`
        });
      }
    }
    if (patch.cwd !== undefined) session.cwd = patch.cwd || homedir();
    if (patch.model !== undefined) session.model = patch.model;
    if (patch.effort !== undefined) session.effort = patch.effort;
    if (patch.fullAccess !== undefined) session.fullAccess = patch.fullAccess;
    if (patch.filter !== undefined) session.filter = patch.filter;
    persistChat(session);
    return { summary: summary(session) };
  }
);

// Renaming only touches the label, so unlike session:update it is allowed
// while a message is running.
ipcMain.handle("session:rename", (_e, sessionId: string, title: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  const next = title.trim().slice(0, TITLE_MAX);
  if (!next) return { error: "A chat name cannot be empty" };
  session.title = next;
  persistChat(session);
  return { summary: summary(session) };
});

ipcMain.handle("chats:delete", (_e, sessionId: string) => {
  // a chat's side conversations go with it; nothing could show them again
  const doomed = [...sessions.values()].filter(
    (s) => s.id === sessionId || (s.side && s.parentId === sessionId)
  );
  for (const session of doomed) {
    // stopped the way the Stop button does, so no notification follows
    if (session.running && session.handle) {
      pushEvent(session, { kind: "status", text: STOPPED });
      session.handle.cancel();
    }
    sessions.delete(session.id);
    try {
      rmSync(join(CHATS_DIR, `${session.id}.json`));
    } catch {
      // already gone
    }
  }
  return {};
});

ipcMain.handle("projects:list", () => allProjects());

ipcMain.handle("projects:add", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return { projects: allProjects() };
  const custom = loadCustomProjectPaths();
  if (!custom.includes(result.filePaths[0])) {
    custom.push(result.filePaths[0]);
    saveCustomProjectPaths(custom);
  }
  return { projects: allProjects() };
});

ipcMain.handle("projects:reorder", (_e, paths: unknown) => {
  if (Array.isArray(paths)) {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(
        PROJECT_ORDER_FILE,
        JSON.stringify(paths.filter((p): p is string => typeof p === "string"), null, 2)
      );
    } catch {
      // the list below still reflects what was saved
    }
  }
  return allProjects();
});

ipcMain.handle("projects:branches", (_e, path: string) => gitBranches(path));

ipcMain.handle("projects:ensure-dev", (_e, path: string) =>
  loadSettings().devBranch ? ensureDevDefault(path) : { error: null, branches: gitBranches(path) }
);

ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => saveSettings(patch));

ipcMain.handle("projects:checkout", (_e, path: string, branch: string) => {
  const error = gitCheckout(path, branch);
  return { error, branches: gitBranches(path) };
});

// One-time logins live in each CLI's interactive flow. The app writes a
// .command script and opens it, so macOS runs it in a fresh Terminal window
// through LaunchServices; the login state lands in the shared config
// (~/.claude, ~/.codex, ...) where the engines pick it up. An added
// subscription account signs in with its own home set instead. Never drive
// Terminal through AppleScript here: the automation permission is granted
// per code-signing identity, and the ad-hoc signature changes on every
// rebuild, so the grant silently dies with each packaged build.
const ENGINE_LOGIN_ARGS: Record<string, string[]> = {
  claude: [],
  codex: ["login"],
  kimi: [],
  opencode: ["auth", "login"],
  gemini: []
};

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

ipcMain.handle("plan:login", (_e, planId: string) => {
  const plan = loadPlans().find((p) => p.id === planId);
  if (!plan) return { error: "Unknown plan" };
  const own = ownLoginArgs(plan);
  const args = own?.args ?? ENGINE_LOGIN_ARGS[plan.engine];
  if (!args) return { error: `No login flow for engine "${plan.engine}"` };
  const bin = resolveBin(plan.bin);
  const script = join(DATA_DIR, `login-${plan.id}.command`);
  const lines = ["#!/bin/zsh"];
  if (own) {
    linkShared(plan);
    for (const [name, value] of Object.entries(own.env)) lines.push(`export ${name}=${shellQuote(value)}`);
    lines.push(
      `echo ${shellQuote(`Signing in: ${plan.label}`)}`,
      `echo ${shellQuote("Sign in with the account for this plan. If your browser is signed in to a different account, sign out there first or open the link below in a private window.")}`,
      "echo"
    );
  }
  lines.push(`exec "${bin}" ${args.join(" ")}`);
  try {
    writeFileSync(script, lines.join("\n") + "\n");
    chmodSync(script, 0o755);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const opened = spawnSync("open", [script], { encoding: "utf8" });
  if (opened.status !== 0) {
    return {
      error: (opened.stderr ?? "").trim() || `open exited with code ${opened.status}`
    };
  }
  return {};
});

// Side-pane terminals. Node's child stdio are unix sockets, which macOS
// `script` rejects, so a tiny python bridge opens a real pty itself and
// relays raw bytes; it never calls terminal ioctls on its own stdio. Size is
// set once through TIOCSWINSZ at spawn; a later resize runs stty as a
// visible command.
const PTY_BRIDGE = `import os, sys, select, fcntl, termios, struct, signal

rows = int(os.environ.get("PTY_ROWS", "24"))
cols = int(os.environ.get("PTY_COLS", "80"))
shell = os.environ.get("PTY_SHELL", "/bin/zsh")

master, slave = os.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    os.close(master)
    env = dict(os.environ)
    env["TERM"] = env.get("PTY_TERM", "xterm-256color")
    name = "-" + os.path.basename(shell)
    os.execve(shell, [name], env)

os.close(slave)
try:
    while True:
        r, _, _ = select.select([master, sys.stdin], [], [])
        if sys.stdin in r:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(master, data)
        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            while data:
                n = os.write(1, data)
                data = data[n:]
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
`;

let ptyBridgePath = "";

function ensurePtyBridge(): string {
  if (!ptyBridgePath) {
    const dir = DATA_DIR;
    const path = join(dir, "pty-bridge.py");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, PTY_BRIDGE);
    ptyBridgePath = path;
  }
  return ptyBridgePath;
}

const ptys = new Map<string, ReturnType<typeof spawn>>();

ipcMain.handle(
  "pty:open",
  (_e, id: string, cwd: string, rows: number, cols: number) => {
    try {
      const proc = spawn("python3", [ensurePtyBridge()], {
        cwd: existsSync(cwd) && statSync(cwd).isDirectory() ? cwd : homedir(),
        env: {
          ...process.env,
          TERM: "xterm-256color",
          PTY_ROWS: String(Math.max(2, Math.round(rows))),
          PTY_COLS: String(Math.max(2, Math.round(cols))),
          PTY_SHELL: process.env.SHELL || "/bin/zsh"
        }
      });
      ptys.set(id, proc);
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        mainWindow?.webContents.send("pty:data", { id, data: chunk });
      });
      proc.on("exit", () => {
        ptys.delete(id);
        mainWindow?.webContents.send("pty:data", {
          id,
          data: "\r\n\x1b[90m(terminal closed)\x1b[0m\r\n"
        });
      });
      return {};
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
);

ipcMain.handle("pty:input", (_e, id: string, data: string) => {
  ptys.get(id)?.stdin?.write(data);
  return {};
});

ipcMain.handle("pty:resize", (_e, id: string, rows: number, cols: number) => {
  ptys.get(id)?.stdin?.write(`stty rows ${rows} cols ${cols}\n`);
  return {};
});

ipcMain.handle("pty:close", (_e, id: string) => {
  const proc = ptys.get(id);
  if (proc) {
    proc.kill("SIGHUP");
    ptys.delete(id);
  }
  return {};
});

ipcMain.handle("session:transcript", (_e, sessionId: string) => {
  const session = sessions.get(sessionId);
  return session ? session.transcript : [];
});

// Starts one turn. The transcript shows `prompt`; the engine receives
// `enginePrompt` when given, so steer can add context the user never typed.
function startTurn(
  session: Session,
  prompt: string,
  enginePrompt?: string,
  options: { recordUser?: boolean } = {}
): void {
  let toEngine = enginePrompt ?? prompt;
  // switched away and back before sending: nothing changed for the model
  if (session.switchedFrom === session.plan.label) session.switchedFrom = undefined;
  if (session.switchedFrom) {
    // the resumed history has replies written by the previous plan; say who
    // is answering now so the model does not speak as the old one
    const note = `[Note from the app: this chat now runs on the ${session.plan.label} plan (model ${session.model}). Earlier replies in this conversation were written on ${session.switchedFrom}.]`;
    toEngine = `${note}\n\n${toEngine}`;
    session.switchedFrom = undefined;
  }
  if (session.handoff) {
    // recap is built before this turn's message joins the transcript
    const history = recap(session);
    if (history) {
      toEngine = `We are continuing a conversation that started with another assistant. Here it is so far:\n\n${history}\n\n---\n\nMy next message:\n${toEngine}`;
    }
    session.handoff = false;
  }
  const beside = besideContext(session);
  if (beside) toEngine = `${beside}\n\n---\n\nMy message:\n${toEngine}`;
  session.running = true;
  // Auto picks per message, from what you typed rather than the notes above
  const picked = session.effort || (EFFORT_LEVELS[session.plan.engine] ? AUTO : "");
  const effort = picked ? resolveEffort(picked, prompt, engineDefaultEffort(session.plan.engine)) : "";
  if (options.recordUser !== false) {
    pushEvent(session, { kind: "user", text: prompt, ...(picked === AUTO ? { effort } : {}) });
  }
  const turnStart = session.transcript.length;
  // an added account picks up anything new in the main CLI home
  linkShared(session.plan);
  const browser = usesBrowser(session.plan.engine) ? browserServer() : undefined;
  // up well before the chat's first browser step; nothing waits on it
  if (browser) void ensureBrowser();

  session.handle = runEngine(
    session.plan,
    {
      prompt: toEngine,
      resumeId: session.resumeId,
      cwd: session.cwd,
      model: session.model,
      // always explicit, so the effort shown in the chat is the one used
      effort: effort || undefined,
      fullAccess: session.fullAccess,
      browser
    },
    (event) => pushEvent(session, event)
  );

  session.handle.done.then(async () => {
    session.running = false;
    // a steered or edited turn was cut off on purpose: no filter, no
    // notification, and the new turn is already on its way
    if (session.steering) return;
    const turnEnd = session.transcript.length;
    const status = chatStatus(session);
    void refreshAfterTurn(session);

    if (session.filter && loadSettings().replyFilter && turnEnd > turnStart) {
      const joined = session.transcript
        .slice(turnStart, turnEnd)
        .filter((e) => e.kind === "text")
        .map((e) => (e as { text: string }).text)
        .join("\n\n")
        .trim();
      if (joined) {
        // the filter runs silently; a skipped filter logs to the console
        const zai = loadPlans().find((p) => p.env?.ANTHROPIC_AUTH_TOKEN && p.env.ANTHROPIC_BASE_URL?.includes("api.z.ai"));
        const result = await filterText(joined, zai);
        if (result.error) console.warn(`filter skipped (${session.id}): ${result.error}`);
        else if (result.changed) pushEvent(session, { kind: "filtered", text: result.text, original: joined });
      }
    }

    // the next queued message goes out once this reply is fully in (after
    // the filter, so its result lands on the right turn). Only a turn you
    // stopped, or one the engine itself failed, holds the queue for you to
    // look first; a reply that finished with a warning (a blocked tool)
    // still lets it go on.
    const next = session.queue[0];
    const turn = session.transcript.slice(turnStart, turnEnd);
    const stopped = turn.some((e) => e.kind === "status" && e.text === STOPPED);
    const lastDone = [...turn].reverse().find((e) => e.kind === "done");
    const finished = lastDone?.kind === "done" && lastDone.ok;
    if (next !== undefined && finished && !stopped && !session.running) {
      session.queue.shift();
      persistChat(session);
      startTurn(session, next);
      return;
    }
    const title = session.title || "Chat";
    if (status === "done") {
      notify(session, "done", `Done: ${title}`, lastText(session, turnStart, turnEnd));
    } else if (status === "error") {
      const err = [...session.transcript.slice(turnStart, turnEnd)].reverse().find((e) => e.kind === "error");
      notify(
        session,
        "error",
        `Needs attention: ${title}`,
        (err?.kind === "error" ? err.text : "The reply ended with an error.") +
          (session.queue.length ? ` ${session.queue.length} queued message(s) are on hold.` : "")
      );
    }
    sendSessions();
    restartIfWaiting();
  });
}

// Updates: scripts/package.sh replaces the app in /Applications, but the
// running app keeps the old code until it restarts. The app notices the new
// install and offers to restart, now or once no chat is working. The stamp
// is the bundle's Info.plist, rewritten by every build (the dev copy
// watches its build output instead).
const BUILD_STAMP_FILE = app.isPackaged
  ? join(process.resourcesPath, "..", "Info.plist")
  : join(app.getAppPath(), "out", "main", "index.js");
let buildStamp = 0;
let updateReady = false;
let restartWhenIdle = false;

function readBuildStamp(): number {
  try {
    return statSync(BUILD_STAMP_FILE).mtimeMs;
  } catch {
    // mid-install the old bundle is gone for a moment
    return 0;
  }
}

function watchForUpdate(): void {
  buildStamp = readBuildStamp();
  setInterval(() => {
    if (updateReady || !buildStamp) return;
    const now = readBuildStamp();
    if (now && now !== buildStamp) {
      updateReady = true;
      mainWindow?.webContents.send("update:ready");
    }
  }, 5000);
}

function anyRunning(): boolean {
  return [...sessions.values()].some((s) => s.running);
}

function relaunch(): void {
  rememberInterruptedTurns();
  app.relaunch();
  app.exit(0);
}

let interruptedTurnsRemembered = false;

// A Stop is an explicit choice and writes STOPPED before its child is
// signalled. Everything else still running at shutdown was cut off by the
// app, and is safe to offer back to the engine on the next launch.
function rememberInterruptedTurns(): void {
  // output from the last second is on disk before the app goes
  flushSaves();
  if (interruptedTurnsRemembered) return;
  interruptedTurnsRemembered = true;
  for (const session of sessions.values()) {
    if (!session.running) continue;
    const userIndex = session.transcript.map((event) => event.kind).lastIndexOf("user");
    const lastUser = session.transcript[userIndex];
    if (!lastUser || lastUser.kind !== "user") continue;
    const afterUser = session.transcript.slice(userIndex + 1);
    if (afterUser.some((event) => event.kind === "status" && event.text === STOPPED)) continue;
    session.restartTurn = { prompt: lastUser.text };
    persistChat(session);
    // Do not leave a detached CLI doing the same work while the relaunched
    // app resumes it. The saved resume id lets the new process continue.
    session.handle?.cancel();
  }
}

function resumeRestartedTurns(): void {
  for (const session of sessions.values()) {
    const interrupted = session.restartTurn;
    if (!interrupted || session.running) continue;
    session.restartTurn = undefined;
    pushEvent(session, { kind: "status", text: "Resuming after app restart" });
    const prompt = session.resumeId
      ? "The app restarted while you were working. Continue and finish the user's most recent request from where you left off."
      : `The app restarted before this request had a resumable engine conversation. Continue working on the user's request:\n\n${interrupted.prompt}`;
    // The original user message is already in the transcript (and normally
    // the engine history), so do not render a duplicate message in the chat.
    startTurn(session, interrupted.prompt, prompt, { recordUser: false });
  }
}

// the last chat just finished: give its final save and the window a moment
function restartIfWaiting(): void {
  if (restartWhenIdle && !anyRunning()) setTimeout(() => !anyRunning() && relaunch(), 1500);
}

ipcMain.handle("update:status", () => ({ ready: updateReady, waiting: restartWhenIdle }));

// now: restart at once, stopping any running chat. whenIdle: restart the
// moment no chat is working (at once if none is).
ipcMain.handle("update:restart", (_e, whenIdle: boolean) => {
  if (!whenIdle || !anyRunning()) {
    relaunch();
    return { waiting: false };
  }
  restartWhenIdle = true;
  return { waiting: true };
});

ipcMain.handle("update:cancel", () => {
  restartWhenIdle = false;
  return { waiting: false };
});

function lastText(session: Session, from: number, to: number): string {
  const t = [...session.transcript.slice(from, to)].reverse().find((e) => e.kind === "text");
  return t?.kind === "text" ? t.text.replace(/\s+/g, " ").slice(0, 140) : "";
}

// Refresh the signed-in plan's usage after a turn.
async function refreshAfterTurn(session: Session): Promise<void> {
  if (session.plan.engine === "codex") await refreshCodex(session.plan, session.resumeId);
  else await refreshPlanUsage(session.plan);
}

// The chat list changed in the main process (a queued turn started, a turn
// ended); the window refreshes its sidebar from this.
function sendSessions(): void {
  mainWindow?.webContents.send("sessions:changed");
}

ipcMain.handle("session:send", (_e, sessionId: string, prompt: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  if (session.running) return { error: "Session is already running" };
  if (!prompt.trim()) return { error: "Empty prompt" };
  startTurn(session, prompt);
  return {};
});

// Stops the running turn and waits for the engine to exit, so the next
// turn can resume the same conversation. False if it did not stop in time.
async function stopRun(session: Session): Promise<boolean> {
  const handle = session.handle;
  if (!session.running || !handle) return true;
  handle.cancel();
  return Promise.race([
    handle.done.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000))
  ]);
}

// Steer: interrupt the running turn and send a new message into the same
// conversation. The engine is stopped, then resumed with the new message, so
// it keeps everything from the interrupted turn up to the cut.
ipcMain.handle("session:steer", async (_e, sessionId: string, prompt: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  if (!prompt.trim()) return { error: "Empty prompt" };
  if (session.steering) return { error: "Already steering this chat" };
  if (!session.running || !session.handle) {
    startTurn(session, prompt);
    return {};
  }

  session.steering = true;
  try {
    if (!(await stopRun(session))) {
      return { error: "The engine did not stop in time. Try Stop, then send again." };
    }

    // before the engine reports its session id there is nothing to resume,
    // so the interrupted request travels with the new message instead
    const lastUser = [...session.transcript].reverse().find((e) => e.kind === "user");
    const earlier = !session.resumeId && lastUser?.kind === "user" ? lastUser.text : "";
    const enginePrompt = earlier
      ? `My earlier request, which I interrupted:\n${earlier}\n\nNew direction:\n${prompt}`
      : `[I interrupted your previous reply to steer. My new message follows.]\n\n${prompt}`;
    pushEvent(session, { kind: "status", text: "Interrupted to steer" });
    startTurn(session, prompt, enginePrompt);
    return {};
  } finally {
    session.steering = false;
  }
});

// Edit your last message: it stays in history struck out, and the new text
// goes out as the next turn. The engine already saw the old message (it is
// in the resumed conversation), so it is told to set that one aside. If a
// reply to it is still running, that reply stops first.
ipcMain.handle("session:edit-last", async (_e, sessionId: string, text: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  if (!text.trim()) return { error: "Empty message" };
  if (session.steering) return { error: "This chat is already switching messages" };
  const last = [...session.transcript].reverse().find((e) => e.kind === "user");
  if (!last || last.kind !== "user") return { error: "No message to edit" };
  if (last.text === text) return {};

  session.steering = true;
  try {
    if (!(await stopRun(session))) {
      return { error: "The engine did not stop in time. Try Stop, then edit again." };
    }
    last.replaced = true;
    persistChat(session);
    // no engine conversation yet means the old message never registered
    const enginePrompt = session.resumeId
      ? `[I am replacing my previous message, which was:\n"${last.text}"\nSet that message and any reply to it aside. My corrected message follows.]\n\n${text}`
      : undefined;
    startTurn(session, text, enginePrompt);
    return {};
  } finally {
    session.steering = false;
  }
});

// Allow or deny a tool the engine asked about. "Always" also saves the
// engine's suggested allow rule, so the same request will not ask again.
// For one of Claude's questions, answers maps each question to your pick,
// and response carries a reply typed in the message box instead; allowing
// with neither tells Claude you did not answer. gone: nothing is waiting on
// this request any more, so trying again cannot help.
ipcMain.handle(
  "session:permission",
  (
    _e,
    sessionId: string,
    requestId: string,
    allow: boolean,
    always: boolean,
    answers?: Record<string, string>,
    response?: string
  ) => {
    const session = sessions.get(sessionId);
    const req = session?.pending.get(requestId);
    if (!session || !req || !session.handle) {
      return { error: "Claude is no longer waiting on this. Type your answer in the message box instead.", gone: true };
    }
    const reply = allow ? response?.trim() || undefined : undefined;
    const input =
      allow && (answers || reply)
        ? { ...req.input, ...(answers ? { answers } : {}), ...(reply ? { response: reply } : {}) }
        : req.input;
    session.handle.respond(requestId, allow, input, allow && always ? req.suggestions : undefined);
    pushEvent(session, {
      kind: "permission_decision",
      requestId,
      allowed: allow,
      always: allow && always,
      ...(allow && answers ? { answers } : {}),
      ...(reply ? { response: reply } : {})
    });
    sendSessions();
    return {};
  }
);

// Queue: a message typed while a reply runs goes out when it finishes. With
// nothing running it simply sends.
ipcMain.handle("session:queue-add", (_e, sessionId: string, text: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  if (!text.trim()) return { error: "Empty message" };
  if (!session.running && !session.steering) {
    startTurn(session, text);
    return {};
  }
  session.queue.push(text);
  persistChat(session);
  sendSessions();
  return {};
});

ipcMain.handle("session:queue-remove", (_e, sessionId: string, index: number) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  session.queue.splice(index, 1);
  persistChat(session);
  sendSessions();
  return {};
});

// Send a queued message now: it takes over from the running reply the way
// a steer does, or simply sends when nothing is running.
ipcMain.handle("session:queue-send-now", async (_e, sessionId: string, index: number) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  const [text] = session.queue.splice(index, 1);
  if (text === undefined) return { error: "That message is no longer queued" };
  persistChat(session);
  if (!session.running) {
    startTurn(session, text);
    return {};
  }
  session.steering = true;
  try {
    if (!(await stopRun(session))) {
      session.queue.splice(index, 0, text);
      return { error: "The engine did not stop in time. Try Stop, then send again." };
    }
    pushEvent(session, { kind: "status", text: "Interrupted to steer" });
    startTurn(session, text, `[I interrupted your previous reply to steer. My new message follows.]\n\n${text}`);
    return {};
  } finally {
    session.steering = false;
  }
});

ipcMain.handle("usage:get", () => allUsage());

ipcMain.handle("browser:open", () => openBrowser());

ipcMain.handle("browser:checks", () => browserChecks);

ipcMain.handle("browser:show-check", (_e, targetId: string) => showCheck(BROWSER_ENDPOINT, targetId));

ipcMain.handle("browser:downloads", async () => {
  mkdirSync(BROWSER_DOWNLOADS, { recursive: true });
  const error = await shell.openPath(BROWSER_DOWNLOADS);
  return error ? { error } : {};
});

ipcMain.handle("usage:refresh", async () => {
  await Promise.all(loadPlans().filter((p) => p.installed).map((p) => refreshPlanUsage(p)));
  return allUsage();
});

// new chats start on Auto; engineDefaultEffort is the level Auto runs real work at
ipcMain.handle("effort:defaults", () => ({ claude: AUTO, codex: AUTO }));

// The chat on screen, so a finished reply there does not also notify.
let activeChatId: string | null = null;
// the open chat's side conversation, while its tab shows
let activeSideId: string | null = null;
ipcMain.handle("ui:active-chat", (_e, id: string | null, sideId?: string | null) => {
  activeChatId = id;
  activeSideId = sideId ?? null;
});

// A macOS notification when a chat finishes, fails, or needs a permission,
// unless you are already looking at it. Clicking opens the chat. The hidden
// dev copy logs instead of notifying.
function notify(session: Session, kind: "done" | "error" | "permission", title: string, body: string): void {
  if (HIDDEN) {
    console.log(`[notify:${kind}] ${title} | ${body}`);
    return;
  }
  if (mainWindow?.isFocused() && (activeChatId === session.id || activeSideId === session.id)) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body.slice(0, 180) });
  n.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
    // a side conversation opens beside its chat, not as a chat of its own
    if (session.side) mainWindow?.webContents.send("ui:open-chat", session.parentId ?? "", session.id);
    else mainWindow?.webContents.send("ui:open-chat", session.id);
  });
  n.show();
  if (!mainWindow?.isFocused()) app.dock?.bounce(kind === "permission" ? "critical" : "informational");
}

// Pages in the chats' browser waiting on you (browserChecks.ts)
let browserChecks: BrowserCheck[] = [];
let browserNotice: Notification | undefined;

const CHECK_LABEL: Record<BrowserCheck["kind"], string> = {
  captcha: "a CAPTCHA",
  "bot-check": "a bot check",
  "sign-in": "a sign-in"
};

function checkSite(check: BrowserCheck): string {
  try {
    return new URL(check.url).hostname.replace(/^www\./, "");
  } catch {
    return check.title || "a page";
  }
}

// One notification for everything the browser is waiting on, replaced as
// more pages need you, so a run that hits three sites buzzes once per site
// but leaves a single entry. Skipped while the app is in front, where the
// strip above the chat says the same. Clicking brings the first tab up.
function notifyBrowserChecks(): void {
  const checks = browserChecks;
  if (!checks.length) return;
  const lines = checks.map((c) => `${checkSite(c)}: ${CHECK_LABEL[c.kind]}`);
  if (HIDDEN) {
    console.log(`[notify:browser] ${lines.join(" | ")}`);
    return;
  }
  if (mainWindow?.isFocused() || !Notification.isSupported()) return;
  browserNotice?.close();
  const title = checks.length === 1 ? "The chats' browser needs you" : `${checks.length} sites need you in the chats' browser`;
  const n = new Notification({ title, body: lines.join("\n").slice(0, 180) });
  n.on("click", () => void showCheck(BROWSER_ENDPOINT, checks[0].targetId));
  n.show();
  browserNotice = n;
  app.dock?.bounce("informational");
}

// Your usual level: your own Claude Code or Codex default. Auto runs real
// work at it and housekeeping at medium (autoEffort.ts).
const EFFORT_LEVELS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"]
};

function engineDefaultEffort(engine: string): string {
  const levels = EFFORT_LEVELS[engine];
  if (!levels) return "";
  try {
    if (engine === "claude") {
      const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")) as {
        effortLevel?: string;
      };
      if (settings.effortLevel && levels.includes(settings.effortLevel)) return settings.effortLevel;
    } else if (engine === "codex") {
      const toml = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
      const m = /^\s*model_reasoning_effort\s*=\s*"([a-z]+)"/m.exec(toml);
      if (m && levels.includes(m[1])) return m[1];
    }
  } catch {
    // no settings file: fall through to the app's default
  }
  return "high";
}

// Stop is the user's choice, not a failure: the turn is marked so the
// sidebar light goes neutral instead of red.
ipcMain.handle("session:cancel", (_e, sessionId: string) => {
  const session = sessions.get(sessionId);
  if (session?.running && session.handle) {
    pushEvent(session, { kind: "status", text: STOPPED });
    session.handle.cancel();
  }
  return {};
});

ipcMain.handle("pick:folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("pick:files", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
  return result.canceled ? null : result.filePaths;
});
