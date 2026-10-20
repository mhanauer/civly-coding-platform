import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { DATA_DIR, IS_DEV_COPY, addPlan, loadPlans, removePlan, updatePlan } from "./store.ts";
import { secureDataDir } from "./dataDir.ts";
import { resolveBin, runEngine } from "./engines/index.ts";
import { planReady } from "./planReadiness.ts";
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
import { checkClis, freshCliStatus, startCliUpdates, updateCli } from "./cliUpdates.ts";
import { handoffContext, sideContext } from "./recap.ts";
import { AUTO, resolveEffort } from "./autoEffort.ts";
import { CARRY_ON, fullToolsReason, leanNote, markerFilter, runsLean, switchedNote, TOOLS, type Tools } from "./leanChats.ts";
import {
  AUTO_RETRY_PREFIX,
  carriesOn,
  hitModelCapacity,
  hitPlanLimit,
  isLimitError,
  latestAttempt,
  nextPlanAfterLimit,
  planIsOut,
  untriedModel
} from "./limitFallback.ts";
import { allUsage, onUsageChange, recordLimitError, recordUsage, refreshCodex, refreshPlanUsage, saveMuseSubscriptionSnapshot } from "./usage.ts";
import { resolveMuseSnapshot, type MuseSnapshotInput } from "./museUsage.ts";
import { codexRoutingTimedOut } from "./codexRoutingRecovery.ts";
import { listSkills, personalSkillDirs, projectSkillDirs } from "./skills.ts";
import {
  attachedPaths, compareFileStates, compareProjectStates, fileState, listRemoteMacs, loadRemoteCache, projectState,
  mergeRemoteEvents, remoteRequest, saveRemoteCache, saveRemoteMacs, startRemoteServer, validSshHost,
  type FileState, type ProjectState, type RemoteMac
} from "./remoteMacs.ts";
import type { Server } from "node:http";
import type { EngineEvent, EngineKind, PlanConfig, RunHandle } from "./engines/types.ts";

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
  // Claude's connectors, skills and slash commands, when lean chats are on
  // (leanChats.ts). autoFull: an auto chat has taken them on for good.
  // leanNoted: the engine has been told how to ask for them.
  tools: Tools;
  autoFull?: boolean;
  leanNoted?: boolean;
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
  // The old record remains on its original Mac after a cross-Mac handoff.
  transferredTo?: string;
  transferLock?: string;
  remoteOwned?: boolean;
  settling?: boolean;
  turnActive?: boolean;
  transcriptVersion?: number;
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
  tools: Tools;
  autoFull: boolean;
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
  updatedAt: number;
  hostId?: string;
  hostLabel?: string;
  hostOnline?: boolean;
  hostMissing?: boolean;
  transferredTo?: string;
}

// What the sidebar light shows: working, waiting on a permission answer,
// needs you (an error, a blocked permission, a hit limit), or finished.
// "idle" is a new or stopped chat.
type ChatStatus = "idle" | "running" | "waiting" | "error" | "done";

const STOPPED = "Stopped";

function chatStatus(s: Session): ChatStatus {
  if (s.running || s.turnActive || s.settling) return s.pending.size > 0 ? "waiting" : "running";
  const t = s.transcript;
  const lastUser = t.map((e) => e.kind).lastIndexOf("user");
  if (lastUser === -1) return "idle";
  const turn = latestAttempt(t.slice(lastUser + 1));
  if (turn.some((e) => e.kind === "status" && e.text === STOPPED)) return "idle";
  if (turn.some((e) => e.kind === "error" || (e.kind === "done" && !e.ok))) return "error";
  // Older chats may have moved plans before automatic continuation existed.
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
    tools: s.tools,
    autoFull: Boolean(s.autoFull),
    running: Boolean(s.running || s.turnActive || s.settling),
    title: s.title,
    // a chat with no messages yet can still switch plan and folder freely
    empty: s.transcript.length === 0,
    status: chatStatus(s),
    queue: s.queue,
    defaultEffort: EFFORT_LEVELS[s.plan.engine] ? AUTO : "",
    side: Boolean(s.side),
    parentId: s.parentId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    transferredTo: s.transferredTo
  };
}

const sessions = new Map<string, Session>();
let mainWindow: BrowserWindow | null = null;
const remoteCache = loadRemoteCache<SessionSummary>();
const remotePolls = new Set<string>();
const REMOTE_PENDING_FILE = join(DATA_DIR, "remote-pending.json");
let remotePending: Record<string, string> = {};
try { remotePending = JSON.parse(readFileSync(REMOTE_PENDING_FILE, "utf8")) as Record<string, string>; } catch { /* no pending calls */ }
const remoteHostOnline = new Map<string, boolean>();
const remoteHostPlans = new Map<string, PlanConfig[]>();
let hostServer: Server | null = null;

function saveRemotePending(): void {
  const temp = `${REMOTE_PENDING_FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(remotePending), { mode: 0o600 });
  renameSync(temp, REMOTE_PENDING_FILE);
}

async function remoteAction<T>(mac: RemoteMac, method: string, args: unknown[]): Promise<T> {
  const key = createHash("sha256").update(JSON.stringify([mac.id, method, args])).digest("hex");
  const requestId = remotePending[key] ?? randomUUID();
  remotePending[key] = requestId;
  saveRemotePending();
  // A transport failure keeps the request id. Retrying the same action
  // cannot dispatch a second CLI turn if the first reply was lost.
  const result = await remoteRequest<T>(mac, method, args, requestId);
  delete remotePending[key];
  saveRemotePending();
  return result;
}

function remoteMac(id: string): RemoteMac | undefined { return listRemoteMacs().find((m) => m.id === id); }

function remoteSummary(id: string): SessionSummary | undefined {
  const cache = remoteCache[id];
  if (!cache) return undefined;
  const mac = remoteMac(cache.hostId);
  return { ...cache.summary, hostId: cache.hostId, hostLabel: mac?.label ?? "Removed Mac", hostOnline: cache.online, hostMissing: cache.missing };
}

function allSessionSummaries(): SessionSummary[] {
  return [...[...sessions.values()].map(summary), ...Object.keys(remoteCache).map(remoteSummary).filter((s): s is SessionSummary => Boolean(s))]
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

type SessionHandler = (_e: Electron.IpcMainInvokeEvent | null, ...args: any[]) => unknown;
const localSessionHandlers = new Map<string, SessionHandler>();

function handleSession<T extends (_e: Electron.IpcMainInvokeEvent | null, ...args: any[]) => unknown>(name: string, handler: T): void {
  localSessionHandlers.set(name, handler);
  ipcMain.handle(name, async (event, ...args) => {
    const id = args[0];
    const cache = typeof id === "string" ? remoteCache[id] : undefined;
    if (!cache) return handler(event, ...args);
    const mac = remoteMac(cache.hostId);
    if (!mac) {
      if (name === "chats:delete") {
        delete remoteCache[id];
        saveRemoteCache(remoteCache);
        sendSessions();
        return {};
      }
      return { error: "This Mac was removed. Add it again to reach the chat." };
    }
    try {
      const prompt = ["session:send", "session:steer", "session:queue-add", "session:edit-last"].includes(name)
        ? args[1] : name === "session:permission" ? args[5] : undefined;
      if (typeof prompt === "string") {
        const paths = attachedPaths([{ kind: "user", text: prompt }]);
        if (paths.length) {
          const local = fileState(paths);
          const host = await remoteRequest<FileState>(mac, "host:file-state", [paths]);
          const mismatch = compareFileStates(local, host);
          if (mismatch) return { error: mismatch };
        }
      }
      const result = await remoteAction<unknown>(mac, name, args);
      if (name === "chats:delete" && !(result && typeof result === "object" && "error" in result && result.error)) {
        delete remoteCache[id];
        saveRemoteCache(remoteCache);
      } else void pollRemoteMac(mac);
      return result;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}

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
  tools?: Tools;
  autoFull?: boolean;
  leanNoted?: boolean;
  resumeId?: string;
  handoff?: boolean;
  switchedFrom?: string;
  queue?: string[];
  side?: boolean;
  parentId?: string;
  parentSeen?: number;
  createdAt?: number;
  restartTurn?: { prompt: string };
  transferredTo?: string;
  remoteOwned?: boolean;
  transcriptVersion?: number;
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
      tools: session.tools,
      autoFull: session.autoFull,
      leanNoted: session.leanNoted,
      resumeId: session.resumeId,
      handoff: session.handoff,
      switchedFrom: session.switchedFrom,
      queue: session.queue,
      side: session.side,
      parentId: session.parentId,
      parentSeen: session.parentSeen,
      createdAt: session.createdAt,
      restartTurn: session.restartTurn,
      transferredTo: session.transferredTo,
      remoteOwned: session.remoteOwned,
      transcriptVersion: session.transcriptVersion,
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
          // chats from before lean chats start on auto
          tools: TOOLS.includes(record.tools as Tools) ? (record.tools as Tools) : "auto",
          autoFull: Boolean(record.autoFull),
          leanNoted: Boolean(record.leanNoted),
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
              : undefined,
          transferredTo: record.transferredTo,
          remoteOwned: Boolean(record.remoteOwned),
          transcriptVersion: record.transcriptVersion ?? 0
        });
      } catch {
        // skip a corrupt chat file rather than refusing to start
      }
    }
  } catch {
    // no chats directory yet, start empty
  }
}

interface RemoteSyncChat {
  id: string;
  summary?: SessionSummary;
  offset: number;
  total: number;
  events: EngineEvent[];
  version: number;
}

function transcriptHash(events: EngineEvent[]): string {
  return createHash("sha256").update(JSON.stringify(events)).digest("hex");
}

async function pollRemoteMac(mac: RemoteMac): Promise<void> {
  if (remotePolls.has(mac.id)) return;
  remotePolls.add(mac.id);
  const wasHostOnline = remoteHostOnline.get(mac.id);
  const previousPlans = JSON.stringify(remoteHostPlans.get(mac.id));
  try {
    const offsets = Object.fromEntries(Object.entries(remoteCache)
      .filter(([, chat]) => chat.hostId === mac.id)
      .map(([id, chat]) => [id, { cursor: chat.transcript.length, version: chat.version ?? 0 }]));
    const result = await remoteRequest<{ chats: RemoteSyncChat[]; plans: PlanConfig[] }>(mac, "host:sync", [offsets]);
    remoteHostOnline.set(mac.id, true);
    remoteHostPlans.set(mac.id, result.plans);
    let changed = false;
    for (const item of result.chats) {
      const cache = remoteCache[item.id];
      if (!cache) continue;
      const previous = JSON.stringify(cache.summary);
      const wasOnline = cache.online;
      const wasMissing = cache.missing;
      if (item.summary) cache.summary = item.summary;
      cache.online = Boolean(item.summary);
      cache.missing = !item.summary;
      if (item.summary) {
        cache.transcript = mergeRemoteEvents(cache.transcript, item.offset, item.events);
        cache.version = item.version;
      }
      // A repeated or older response cannot append an event twice.
      if (previous !== JSON.stringify(cache.summary) || item.events.length || wasOnline !== cache.online || wasMissing !== cache.missing) changed = true;
      if (item.summary && item.events.length) {
        mainWindow?.webContents.send("session:snapshot", { sessionId: item.id, offset: item.offset, events: item.events });
      }
    }
    if (changed) saveRemoteCache(remoteCache);
    if (changed) sendSessions();
  } catch {
    remoteHostOnline.set(mac.id, false);
    let changed = false;
    for (const cache of Object.values(remoteCache)) {
      if (cache.hostId !== mac.id || (!cache.online && !cache.missing)) continue;
      cache.online = false;
      cache.missing = false;
      changed = true;
    }
    if (changed) { saveRemoteCache(remoteCache); sendSessions(); }
  } finally {
    remotePolls.delete(mac.id);
    if (wasHostOnline !== remoteHostOnline.get(mac.id) || previousPlans !== JSON.stringify(remoteHostPlans.get(mac.id)))
      mainWindow?.webContents.send("remote:hosts-changed");
  }
}

interface TransferChat {
  id: string;
  planId: string;
  planEngine: EngineKind;
  planLabel: string;
  cwd: string;
  model: string;
  effort: string;
  fullAccess: boolean;
  filter: boolean;
  tools: Tools;
  title: string;
  transcript: EngineEvent[];
  sourceLabel: string;
}

function exportChat(id: string, transferId: string): { chat?: TransferChat; waiting?: boolean; error?: string } {
  const session = sessions.get(id);
  if (!session) return { error: "Chat is missing on its current Mac" };
  if (session.transferredTo) return { error: `This chat already continued on ${session.transferredTo}` };
  if (session.transferLock && session.transferLock !== transferId) return { error: "This chat is already continuing on another Mac." };
  if (session.running || session.turnActive || session.settling) return { waiting: true };
  if (session.queue.length) return { error: "A queued message is on hold. Send or remove it before continuing on another Mac." };
  if (session.side || [...sessions.values()].some((s) => s.side && s.parentId === id))
    return { error: "Close this chat's side conversations before continuing on another Mac." };
  session.transferLock = transferId;
  setTimeout(() => { if (session.transferLock === transferId) session.transferLock = undefined; }, 120_000);
  persistChat(session);
  return { chat: {
    id: session.id, planId: session.plan.id, planEngine: session.plan.engine,
    planLabel: session.plan.label, cwd: session.cwd, model: session.model,
    effort: session.effort, fullAccess: session.fullAccess, filter: session.filter,
    tools: session.tools, title: session.title, transcript: session.transcript,
    sourceLabel: "another Mac"
  } };
}

function importChat(chat: TransferChat, newId: string, expected: ProjectState, fromRemote = false): { sessionId?: string; summary?: SessionSummary; error?: string } {
  const existing = sessions.get(newId);
  if (existing) return { sessionId: newId, summary: summary(existing) };
  const plan = loadPlans().find((p) => p.id === chat.planId);
  if (!plan || !planReady(plan)) return { error: "The destination Mac needs this plan's CLI and sign-in." };
  if (plan.engine !== chat.planEngine || plan.label !== chat.planLabel)
    return { error: "The destination Mac's plan with this ID differs from the source plan." };
  if (plan.models?.length && !plan.models.includes(chat.model))
    return { error: `The destination Mac does not offer ${chat.model} for this plan.` };
  const files = attachedPaths(chat.transcript);
  const error = compareProjectStates(expected, projectState(chat.cwd, files));
  if (error) return { error };
  const now = Date.now();
  const session: Session = {
    id: newId, plan, cwd: chat.cwd, model: chat.model, effort: chat.effort,
    fullAccess: chat.fullAccess, filter: chat.filter, tools: chat.tools,
    running: false, transcript: structuredClone(chat.transcript), title: chat.title,
    queue: [], pending: new Map(), updatedAt: now, createdAt: now,
    handoff: true, resumeId: undefined, remoteOwned: fromRemote
  };
  sessions.set(newId, session);
  pushEvent(session, { kind: "status", text: `Continued from ${chat.sourceLabel}. The next message starts a new CLI session with a recap of this chat.` });
  persistChat(session);
  sendSessions();
  return { sessionId: newId, summary: summary(session) };
}

let remotePlansCachedAt = 0;
let remotePlansCached: PlanConfig[] = [];
function safeRemotePlans(): PlanConfig[] {
  if (Date.now() - remotePlansCachedAt < 30_000) return remotePlansCached;
  remotePlansCached = loadPlans().map((plan) => ({
    id: plan.id, label: plan.label, engine: plan.engine, color: plan.color,
    models: plan.models, installed: plan.installed, loggedIn: planReady(plan),
    bin: "", extraArgs: []
  }));
  remotePlansCachedAt = Date.now();
  return remotePlansCached;
}

async function hostDispatch(method: string, args: unknown[]): Promise<unknown> {
  if (!loadSettings().acceptRemoteChats) throw new Error("Remote chats are off on this Mac.");
  if (method === "host:health") return { name: app.getName(), version: app.getVersion(),
    plans: safeRemotePlans() };
  if (method === "host:sync") {
    const offsets = args[0] as Record<string, { cursor: number; version: number }>;
    if (!offsets || typeof offsets !== "object" || Object.keys(offsets).length > 1000) throw new Error("Invalid sync request");
    return { plans: safeRemotePlans(), chats: Object.entries(offsets).map(([id, checkpoint]) => {
      const session = sessions.get(id);
      const cursor = checkpoint?.cursor;
      const offset = !session || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > session.transcript.length ||
        checkpoint.version !== (session.transcriptVersion ?? 0) ? 0 : cursor;
      return { id, summary: session ? summary(session) : undefined, offset,
        total: session?.transcript.length ?? 0, events: session?.transcript.slice(offset) ?? [], version: session?.transcriptVersion ?? 0 };
    }) };
  }
  if (method === "host:project-state") return projectState(args[0] as string, args[1] as string[] ?? []);
  if (method === "host:file-state") return fileState(args[0] as string[]);
  if (method === "host:export") return exportChat(args[0] as string, args[1] as string);
  if (method === "host:release") {
    const session = sessions.get(args[0] as string);
    if (session && session.transferLock === args[1]) session.transferLock = undefined;
    return {};
  }
  if (method === "host:import") return importChat(args[0] as TransferChat, args[1] as string, args[2] as ProjectState, true);
  if (method === "host:mark-transferred") {
    const session = sessions.get(args[0] as string);
    if (!session) return { error: "Source chat is missing" };
    if (session.transferredTo === args[1]) return {};
    if (session.running || session.turnActive || session.settling) return { error: "The chat started another turn; continuation was stopped." };
    if (session.transferLock && session.transferLock !== args[2]) return { error: "Another continuation is in progress." };
    if (transcriptHash(session.transcript) !== args[3]) return { error: "The source chat changed during continuation. Try again after reviewing it." };
    session.transferredTo = args[1] as string;
    session.transferLock = undefined;
    pushEvent(session, { kind: "status", text: `Continued on ${session.transferredTo}. This original record stays here.` });
    persistChat(session);
    sendSessions();
    return {};
  }
  if (method === "session:create") return createLocalSession(args[0] as CreateSessionOptions, true);
  const handler = localSessionHandlers.get(method);
  if (!handler) throw new Error("Unknown remote action");
  return handler(null, ...args);
}

let hostStarting = false;
async function configureHostServer(): Promise<void> {
  if (!loadSettings().acceptRemoteChats) {
    hostServer?.close();
    hostServer = null;
    return;
  }
  if (hostServer || hostStarting) return;
  hostStarting = true;
  try { hostServer = await startRemoteServer(hostDispatch); }
  catch (error) { console.warn("Remote host could not start:", error); }
  finally { hostStarting = false; }
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
  secureDataDir();
  loadChats();
  for (const cache of Object.values(remoteCache)) cache.online = false;
  void configureHostServer();
  const lastRemoteSync = new Map<string, number>();
  const syncRemoteMacs = (): void => {
    for (const mac of listRemoteMacs()) {
      const running = Object.values(remoteCache).some((chat) => chat.hostId === mac.id && chat.summary.running);
      const interval = running ? 1200 : 7000;
      if (Date.now() - (lastRemoteSync.get(mac.id) ?? 0) < interval) continue;
      lastRemoteSync.set(mac.id, Date.now());
      void pollRemoteMac(mac);
    }
  };
  syncRemoteMacs();
  setInterval(syncRemoteMacs, 1000);
  onUsageChange((all) => mainWindow?.webContents.send("usage:update", all));
  // the plans that can be asked directly, now and every ten minutes
  const pollUsage = (): void => {
    for (const plan of loadPlans().filter((p) => p.installed)) void refreshPlanUsage(plan);
  };
  pollUsage();
  setInterval(pollUsage, 10 * 60 * 1000);
  watchForUpdate();
  startCliUpdates({
    busy: (engine) => [...sessions.values()].some((s) => (s.running || s.turnActive) && s.plan.engine === engine),
    auto: () => loadSettings().updateClis,
    onChange: (list) => mainWindow?.webContents.send("clis:changed", list)
  });
  warmBrowserServer();
  watchBrowserChecks({
    endpoint: BROWSER_ENDPOINT,
    active: () => [...sessions.values()].some((s) => (s.running || s.turnActive) && usesBrowser(s.plan.engine)),
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

ipcMain.handle("plans:list", () => loadPlans().map((plan) => ({ ...plan, loggedIn: planReady(plan) })));

ipcMain.handle(
  "plans:create",
  (
    _e,
    opts: { label: string; engine: string; bin?: string; baseUrl?: string; token?: string; models?: string[]; ownLogin?: boolean }
  ) => {
    const engines = ["claude", "kimi", "codex", "gemini", "muse", "opencode", "qwen"];
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
  const running = [...sessions.values()].some((s) => s.plan.id === planId && (s.running || s.turnActive));
  if (running) {
    return { error: "That plan has a session running right now. Stop it first." };
  }
  // an added subscription account signs out and its own home goes with it
  const plan = loadPlans().find((p) => p.id === planId);
  if (plan?.ownLogin) await forgetAccount(plan, resolveBin(plan.bin));
  return { plans: removePlan(planId) };
});

interface CreateSessionOptions {
  planId: string; cwd: string; model: string; effort: string; fullAccess: boolean;
  filter?: boolean; tools?: Tools; side?: boolean; parentId?: string; hostId?: string;
}

function createLocalSession(opts: CreateSessionOptions, fromRemote = false): { sessionId?: string; summary?: SessionSummary; error?: string } {
  const plan = loadPlans().find((p) => p.id === opts.planId);
  if (!plan) return { error: `Unknown plan: ${opts.planId}` };
  if (fromRemote && !planReady(plan)) return { error: `${plan.label} needs its CLI and sign-in on this Mac.` };
  if (fromRemote && (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory())) return { error: `Project folder is missing on this Mac: ${opts.cwd}` };
  const session: Session = {
    id: randomUUID(),
    plan,
    cwd: opts.cwd || homedir(),
    model: opts.model || plan.models?.[0] || "default",
    effort: opts.effort || "",
    fullAccess: opts.fullAccess !== false,
    filter: opts.filter !== false,
    tools: opts.tools && TOOLS.includes(opts.tools) ? opts.tools : "auto",
    running: false,
    transcript: [],
    title: "",
    queue: [],
    pending: new Map(),
    updatedAt: Date.now(),
    createdAt: Date.now(),
    side: Boolean(opts.side),
    parentId: opts.side ? opts.parentId ?? "" : undefined,
    remoteOwned: fromRemote
  };
  sessions.set(session.id, session);
  persistChat(session);
  sendSessions();
  return { sessionId: session.id, summary: summary(session) };
}

ipcMain.handle("session:create", async (_e, opts: CreateSessionOptions) => {
  if (!opts.hostId) return createLocalSession(opts);
  const mac = remoteMac(opts.hostId);
  if (!mac) return { error: "Choose a paired Mac in Settings." };
  try {
    // The same path must name a clean project at the same commit on both
    // Macs. The app does not silently copy files or use the wrong checkout.
    const source = projectState(opts.cwd);
    const destination = await remoteRequest<ProjectState>(mac, "host:project-state", [opts.cwd, []]);
    const mismatch = compareProjectStates(source, destination);
    if (mismatch) return { error: mismatch };
    const created = await remoteAction<{ sessionId?: string; summary?: SessionSummary; error?: string }>(mac, "session:create", [{ ...opts, hostId: undefined }]);
    if (created.error || !created.sessionId || !created.summary) return created;
    remoteCache[created.sessionId] = { hostId: mac.id, summary: created.summary, transcript: [], online: true, missing: false, version: 0 };
    saveRemoteCache(remoteCache);
    sendSessions();
    void pollRemoteMac(mac);
    return { sessionId: created.sessionId };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
});

// The new-task screen's side conversations go with the chat that screen
// starts. Only the link changes, so it is allowed mid-reply.
handleSession("session:set-parent", (_e, sessionId: string, parentId: string) => {
  const session = sessions.get(sessionId);
  if (!session?.side) return { error: "Unknown session" };
  session.parentId = parentId;
  // its engine has heard nothing of that chat yet
  session.parentSeen = undefined;
  persistChat(session);
  return {};
});

ipcMain.handle("session:list", () => allSessionSummaries());

handleSession(
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
      tools?: Tools;
      planId?: string;
    }
  ) => {
    const session = sessions.get(sessionId);
    if (!session) return { error: "Unknown session" };
    if (session.running || session.turnActive || session.settling || session.transferLock) return { error: "Wait for the current message or Mac transfer to finish before changing settings" };
    if (session.transferredTo) return { error: `This chat continued on ${session.transferredTo}. Open the new chat there.` };
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
    if (patch.tools !== undefined && TOOLS.includes(patch.tools) && patch.tools !== session.tools) {
      session.tools = patch.tools;
      // picking auto again starts it lean again, and it has to be told how
      // to ask for more
      session.autoFull = false;
      session.leanNoted = false;
    }
    persistChat(session);
    return { summary: summary(session) };
  }
);

// Renaming only touches the label, so unlike session:update it is allowed
// while a message is running.
handleSession("session:rename", (_e, sessionId: string, title: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  const next = title.trim().slice(0, TITLE_MAX);
  if (!next) return { error: "A chat name cannot be empty" };
  session.title = next;
  persistChat(session);
  return { summary: summary(session) };
});

handleSession("chats:delete", (_e, sessionId: string) => {
  // a chat's side conversations go with it; nothing could show them again
  const doomed = [...sessions.values()].filter(
    (s) => s.id === sessionId || (s.side && s.parentId === sessionId)
  );
  if (doomed.some((session) => session.transferLock)) return { error: "Wait for this chat's Mac transfer to finish before deleting it." };
  for (const session of doomed) {
    // stopped the way the Stop button does, so no notification follows
    if ((session.running || session.turnActive) && session.handle) {
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
ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
  const saved = saveSettings(patch);
  // turned on: catch up now rather than at the next check
  if (patch?.updateClis === true) void checkClis();
  if (patch?.acceptRemoteChats !== undefined) void configureHostServer();
  return saved;
});

ipcMain.handle("remote:macs", () => listRemoteMacs().map((mac) => ({ ...mac, online: remoteHostOnline.get(mac.id) ?? false, plans: remoteHostPlans.get(mac.id) ?? [] })));

ipcMain.handle("remote:add", async (_e, label: string, sshHost: string) => {
  const host = sshHost?.trim();
  const name = label?.trim();
  if (!host || !validSshHost(host)) return { error: "Enter an SSH host alias or user@hostname." };
  if (!name || name.length > 40) return { error: "Give this Mac a name of 1 to 40 characters." };
  const macs = listRemoteMacs();
  const existing = macs.find((m) => m.sshHost === host);
  const mac: RemoteMac = { id: existing?.id ?? createHash("sha256").update(host).digest("hex").slice(0, 16), label: name, sshHost: host };
  try {
    const health = await remoteRequest<{ plans: PlanConfig[] }>(mac, "host:health", []);
    saveRemoteMacs([...macs.filter((m) => m.id !== mac.id), mac]);
    remoteHostOnline.set(mac.id, true);
    remoteHostPlans.set(mac.id, health.plans);
    void pollRemoteMac(mac);
    mainWindow?.webContents.send("remote:hosts-changed");
    return { mac };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
});

ipcMain.handle("remote:remove", (_e, id: string) => {
  saveRemoteMacs(listRemoteMacs().filter((m) => m.id !== id));
  remoteHostOnline.delete(id);
  remoteHostPlans.delete(id);
  for (const cache of Object.values(remoteCache)) if (cache.hostId === id) { cache.online = false; cache.missing = false; }
  saveRemoteCache(remoteCache);
  sendSessions();
  mainWindow?.webContents.send("remote:hosts-changed");
  return {};
});

ipcMain.handle("remote:continue", async (_e, sourceId: string, destinationId: string) => {
  const sourceCache = remoteCache[sourceId];
  const sourceMac = sourceCache ? remoteMac(sourceCache.hostId) : undefined;
  const destinationMac = destinationId === "local" ? undefined : remoteMac(destinationId);
  if (sourceCache && !sourceMac) return { error: "The current Mac is no longer paired." };
  if (destinationId !== "local" && !destinationMac) return { error: "Choose a paired destination Mac." };
  if ((sourceCache?.hostId ?? "local") === destinationId) return { error: "This chat already runs on that Mac." };
  const sourceLabel = sourceMac?.label ?? "This Mac";
  const destinationLabel = destinationMac?.label ?? "This Mac";
  let exported = false;
  let imported = false;
  const transferId = createHash("sha256").update(`${sourceId}:${destinationId}:transfer`).digest("hex");
  try {
    let transfer: TransferChat | undefined;
    const until = Date.now() + 30 * 60_000;
    while (!transfer) {
      const result = sourceMac
        ? await remoteRequest<{ chat?: TransferChat; waiting?: boolean; error?: string }>(sourceMac, "host:export", [sourceId, transferId])
        : exportChat(sourceId, transferId);
      if (result.error) return { error: result.error };
      if (result.chat) { transfer = result.chat; exported = true; break; }
      if (!result.waiting) return { error: "The source chat could not be exported." };
      if (Date.now() > until) return { error: "The current turn has not finished. Try again when it ends." };
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    transfer.sourceLabel = sourceLabel;
    const transferHash = transcriptHash(transfer.transcript);
    const files = attachedPaths(transfer.transcript);
    const sourceState = sourceMac
      ? await remoteRequest<ProjectState>(sourceMac, "host:project-state", [transfer.cwd, files])
      : projectState(transfer.cwd, files);
    const destinationState = destinationMac
      ? await remoteRequest<ProjectState>(destinationMac, "host:project-state", [transfer.cwd, files])
      : projectState(transfer.cwd, files);
    const mismatch = compareProjectStates(sourceState, destinationState);
    if (mismatch) return { error: mismatch };
    const newId = createHash("sha256").update(`${sourceId}:${destinationId}`).digest("hex").slice(0, 32);
    const created = destinationMac
      ? await remoteAction<{ sessionId?: string; summary?: SessionSummary; error?: string }>(destinationMac, "host:import", [transfer, newId, sourceState])
      : importChat(transfer, newId, sourceState);
    if (created.error || !created.sessionId || !created.summary) return { error: created.error ?? "Destination could not create the chat." };
    imported = true;
    if (destinationMac) {
      remoteCache[newId] = { hostId: destinationMac.id, summary: created.summary, transcript: [], online: true, missing: false, version: 0 };
      saveRemoteCache(remoteCache);
      void pollRemoteMac(destinationMac);
    }
    const marked = sourceMac
      ? await remoteAction<{ error?: string }>(sourceMac, "host:mark-transferred", [sourceId, destinationLabel, transferId, transferHash])
      : hostDispatchLocalMark(sourceId, destinationLabel, transferId, transferHash);
    if (marked.error) return { error: `The new chat was created on ${destinationLabel}, but the old record could not be locked: ${marked.error}`, sessionId: newId };
    if (sourceMac) void pollRemoteMac(sourceMac);
    sendSessions();
    return { sessionId: newId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (exported && !imported) {
      if (sourceMac) void remoteAction(sourceMac, "host:release", [sourceId, transferId]).catch(() => undefined);
      else { const source = sessions.get(sourceId); if (source?.transferLock === transferId) source.transferLock = undefined; }
    }
  }
});

function hostDispatchLocalMark(id: string, label: string, transferId: string, expectedHash: string): { error?: string } {
  const session = sessions.get(id);
  if (!session) return { error: "Source chat is missing" };
  if (session.running || session.turnActive || session.settling) return { error: "The chat started another turn." };
  if (session.transferredTo === label) return {};
  if (session.transferLock && session.transferLock !== transferId) return { error: "Another continuation is in progress." };
  if (transcriptHash(session.transcript) !== expectedHash) return { error: "The source chat changed during continuation. Try again after reviewing it." };
  session.transferredTo = label;
  session.transferLock = undefined;
  pushEvent(session, { kind: "status", text: `Continued on ${label}. This original record stays here.` });
  persistChat(session);
  return {};
}

ipcMain.handle("clis:status", () => freshCliStatus());
ipcMain.handle("clis:update", (_e, engine: EngineKind) => updateCli(engine));

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
  gemini: [],
  muse: ["login"]
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
  if (remoteCache[sessionId]) return remoteCache[sessionId].transcript;
  const session = sessions.get(sessionId);
  return session ? session.transcript : [];
});

// The connectors each plan's Claude had at its last full start, so a lean
// chat can name them to Claude and spot a message that names one. The app's
// own browser is in every chat, lean or not.
const CONNECTORS_FILE = join(DATA_DIR, "connectors.json");

function readConnectors(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONNECTORS_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function knownConnectors(planId: string): string[] {
  const list = readConnectors()[planId];
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
}

function rememberConnectors(planId: string, servers: string[]): void {
  const list = servers.filter((s) => s !== "browser");
  const all = readConnectors();
  if (JSON.stringify(all[planId]) === JSON.stringify(list)) return;
  all[planId] = list;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONNECTORS_FILE, JSON.stringify(all, null, 2));
  } catch {
    // only a lean chat's hints suffer
  }
}

// Plans the app knows are out, and the next plan with quota after `current`.
function nextPlanWithQuota(current: PlanConfig, tried: Iterable<string>): PlanConfig | null {
  const usage = allUsage();
  const unavailable = new Set([...tried, ...Object.keys(usage).filter((id) => planIsOut(usage[id]))]);
  return nextPlanAfterLimit(current, loadPlans(), unavailable, conversationStore);
}

// A run that reports its plan is out but keeps going without a reply is
// stopped after this long, so the chat can move to the next plan. Claude
// Code does this when it waits for the reset, and when a background agent
// or command keeps it open after the turn failed on the limit.
const LIMIT_STALL_MS = 10_000;

// Starts one turn. The transcript shows `prompt`; the engine receives
// `enginePrompt` when given, so steer can add context the user never typed.
function startTurn(
  session: Session,
  prompt: string,
  enginePrompt?: string,
  options: {
    recordUser?: boolean;
    triedPlans?: readonly string[];
    // models that were at capacity earlier in this turn
    triedModels?: readonly string[];
    routingRetries?: number;
  } = {}
): void {
  // A plan already known to be out would fail, or wait for its reset with no
  // reply. The message goes to the next plan with quota instead.
  const outPlan = session.plan;
  const outUsage = allUsage()[outPlan.id];
  const skipTo = planIsOut(outUsage) ? nextPlanWithQuota(outPlan, options.triedPlans ?? []) : null;
  if (skipTo) switchPlan(session, skipTo);
  const runPlan = session.plan;
  const runModel = session.model;
  const triedPlans = new Set(options.triedPlans ?? []);
  triedPlans.add(runPlan.id);
  const limitEvents: EngineEvent[] = [];
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
    // recap is built before this turn's message joins the transcript. The
    // save makes the full record it points to current.
    persistChat(session);
    const history = handoffContext(session.transcript, join(CHATS_DIR, `${session.id}.json`));
    if (history) toEngine = `${history}\n\n---\n\nMy next message:\n${toEngine}`;
    session.handoff = false;
  }
  const beside = besideContext(session);
  if (beside) toEngine = `${beside}\n\n---\n\nMy message:\n${toEngine}`;
  // Lean chats: a message that plainly needs the connectors, skills or slash
  // commands gets them before it goes out. Otherwise an auto chat is told
  // how to ask for them, and asks with its reply (watch).
  const connectors = knownConnectors(session.plan.id);
  let lean = runsLean({
    enabled: loadSettings().leanChats,
    engine: session.plan.engine,
    tools: session.tools,
    autoFull: Boolean(session.autoFull)
  });
  const plainly = lean && session.tools === "auto" && options.recordUser !== false ? fullToolsReason(prompt, connectors) : undefined;
  if (plainly) {
    // the conversation so far says they are off
    if (session.leanNoted) toEngine = `[Note from the app: my connectors, skills and slash commands are on now.]\n\n${toEngine}`;
    session.autoFull = true;
    session.leanNoted = false;
    lean = false;
  }
  const watch = lean && session.tools === "auto" ? markerFilter() : undefined;
  if (watch && !session.leanNoted) {
    toEngine = `${leanNote(connectors)}\n\n${toEngine}`;
    session.leanNoted = true;
  }
  session.running = true;
  // Auto picks per message, from what you typed rather than the notes above
  const picked = session.effort || (EFFORT_LEVELS[session.plan.engine] ? AUTO : "");
  const effort = picked ? resolveEffort(picked, prompt, engineDefaultEffort(session.plan.engine)) : "";
  if (options.recordUser !== false) {
    pushEvent(session, { kind: "user", text: prompt, ...(picked === AUTO ? { effort } : {}) });
  }
  if (skipTo) {
    const outUntil = outUsage?.limitedUntil;
    const until = outUntil ? ` until ${new Date(outUntil).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
    pushEvent(session, { kind: "status", text: `${outPlan.label} is out of quota${until}, so this went to ${skipTo.label}.` });
    sendSessions();
  }
  if (plainly) pushEvent(session, { kind: "status", text: switchedNote(`the message asks for ${plainly}`) });
  const turnStart = session.transcript.length;
  // an added account picks up anything new in the main CLI home
  linkShared(session.plan);
  const browser = usesBrowser(session.plan.engine) ? browserServer() : undefined;
  // up well before the chat's first browser step; nothing waits on it
  if (browser) void ensureBrowser();

  let limitStall: ReturnType<typeof setTimeout> | undefined;
  let repliedSinceLimit = false;
  let stalledOnLimit = false;
  const handle = runEngine(
    runPlan,
    {
      prompt: toEngine,
      resumeId: session.resumeId,
      cwd: session.cwd,
      model: session.model,
      // always explicit, so the effort shown in the chat is the one used
      effort: effort || undefined,
      fullAccess: session.fullAccess,
      browser,
      lean
    },
    (event) => {
      // the stall stop below already explains itself as a limit; the
      // engine's own exit message would only add noise
      if (stalledOnLimit && event.kind === "error") return;
      if (event.kind === "done") clearTimeout(limitStall);
      if (carriesOn(event)) repliedSinceLimit = true;
      if (event.kind === "usage" && event.limited && !limitStall) {
        repliedSinceLimit = false;
        limitStall = setTimeout(() => {
          // a run that carried on may still hit the limit again later
          limitStall = undefined;
          if (repliedSinceLimit || session.handle !== handle || !session.running) return;
          stalledOnLimit = true;
          handle.cancel();
        }, LIMIT_STALL_MS);
      }
      if (event.kind === "usage" || event.kind === "error" || event.kind === "done") limitEvents.push(event);
      if (!lean && event.kind === "session" && event.servers) rememberConnectors(runPlan.id, event.servers);
      for (const e of watch ? watch.feed(event) : [event]) pushEvent(session, e);
    }
  );
  session.handle = handle;
  session.turnActive = true;

  session.handle.done.then(async () => {
    session.settling = true;
    try {
    session.running = false;
    // a steered or edited turn was cut off on purpose: no filter, no
    // notification, and the new turn is already on its way
    if (session.steering) return;
    const stopped = session.transcript.slice(turnStart).some((e) => e.kind === "status" && e.text === STOPPED);
    const hitLimit = hitPlanLimit(limitEvents);
    if (
      runPlan.engine === "codex" && !stopped && !hitLimit &&
      (options.routingRetries ?? 0) < 1 && codexRoutingTimedOut(limitEvents) &&
      session.plan.id === runPlan.id && sessions.get(session.id) === session
    ) {
      pushEvent(session, { kind: "status", text: `${AUTO_RETRY_PREFIX}${runPlan.label} after a connection timeout.` });
      const transcriptLength = session.transcript.length;
      // A new process can resume the saved chat, but its old terminal
      // process IDs cannot be polled. Check the work before rerunning it.
      setTimeout(() => {
        if (sessions.get(session.id) !== session || session.running || session.transcript.length !== transcriptLength) return;
        const continuation = session.resumeId
          ? "[The Codex workspace connection timed out. Continue unfinished work. Old terminal process IDs are no longer valid; start fresh commands. Check the current state before repeating any action.]"
          : `[The Codex workspace connection timed out before a resumable conversation was saved. Continue the user's request below. Check the current state before repeating any action.]\n\n${prompt}`;
        startTurn(session, prompt, continuation, { recordUser: false, routingRetries: 1 });
      }, 3000);
      sendSessions();
      return;
    }
    if (hitLimit && !stopped && session.plan.id === runPlan.id && sessions.get(session.id) === session) {
      const current = runPlan;
      const limitText = [...limitEvents].reverse().find(
        (event) => (event.kind === "error" && isLimitError(event.text)) ||
          (event.kind === "done" && event.summary && isLimitError(event.summary))
      );
      if (limitText?.kind === "error") recordLimitError(current.id, limitText.text);
      else if (limitText?.kind === "done" && limitText.summary) recordLimitError(current.id, limitText.summary);
      const next = nextPlanWithQuota(current, triedPlans);
      if (next) {
        switchPlan(session, next);
        pushEvent(session, {
          kind: "status",
          text: `${AUTO_RETRY_PREFIX}${next.label} after ${current.label} hit its limit.`
        });
        // the stop also ended any background agent or command it had
        const stoppedWork = stalledOnLimit ? " Its background agents and commands were stopped too; restart any that were unfinished." : "";
        const continuation = session.resumeId
          ? `[The previous plan hit its usage limit.${stoppedWork} Continue and finish my most recent request from where you left off. Check the current state before repeating an action.]`
          : `[The previous plan hit its usage limit.${stoppedWork} Continue and finish my request below. Check the current state before repeating an action.]\n\n${prompt}`;
        startTurn(session, prompt, continuation, { recordUser: false, triedPlans: [...triedPlans, next.id] });
        sendSessions();
        return;
      }
      pushEvent(session, {
        kind: "error",
        text: "No other signed-in plan has quota. Add an account or wait for a reset, then send your message again."
      });
    }
    // The model is at capacity. Another model on the same plan keeps the
    // engine conversation, so it goes first; then the next plan with quota,
    // on a model that was not at capacity this turn when it has one.
    if (
      !hitLimit && !stopped && hitModelCapacity(limitEvents) &&
      session.plan.id === runPlan.id && sessions.get(session.id) === session
    ) {
      const triedModels = new Set([...(options.triedModels ?? []), runModel]);
      const was = runModel === "default" ? runPlan.label : runModel;
      const model = untriedModel(runPlan, triedModels);
      const next = model ? null : nextPlanWithQuota(runPlan, triedPlans);
      if (model || next) {
        if (next) {
          switchPlan(session, next);
          session.model = untriedModel(next, triedModels) ?? session.model;
        } else if (model) session.model = model;
        const now = next ? next.label : session.model;
        pushEvent(session, { kind: "status", text: `${AUTO_RETRY_PREFIX}${now} after ${was} was at capacity.` });
        // a plan switch adds its own note about the new plan and model
        const moved = next ? `${was} was at capacity.` : `${was} was at capacity, so this chat now runs on ${session.model}.`;
        const continuation = session.resumeId
          ? `[${moved} Continue and finish my most recent request from where you left off. Check the current state before repeating an action.]`
          : `[${moved} Continue and finish my request below. Check the current state before repeating an action.]\n\n${prompt}`;
        startTurn(session, prompt, continuation, {
          recordUser: false,
          triedPlans: [...triedPlans, ...(next ? [next.id] : [])],
          triedModels: [...triedModels]
        });
        sendSessions();
        return;
      }
      pushEvent(session, {
        kind: "error",
        text: "No other model or signed-in plan is free to take over. Send your message again in a few minutes."
      });
    }
    // Claude asked for the connectors, skills and slash commands: the chat
    // keeps them from now on and carries on with the same message, unless
    // you stopped it
    if (watch?.asked() && !hitLimit) {
      session.autoFull = true;
      session.leanNoted = false;
      persistChat(session);
      if (!stopped) {
        startTurn(session, prompt, CARRY_ON, { recordUser: false });
        return;
      }
    }
    const turnEnd = session.transcript.length;
    const status = chatStatus(session);
    void refreshAfterTurn(runPlan, session.resumeId);

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
    const lastDone = [...turn].reverse().find((e) => e.kind === "done");
    const finished = lastDone?.kind === "done" && lastDone.ok;
    if (next !== undefined && finished && !stopped && !hitLimit && !session.running) {
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
    } finally {
      session.settling = false;
      if (session.handle === handle) session.turnActive = false;
      sendSessions();
      restartIfWaiting();
    }
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
  return [...sessions.values()].some((s) => s.running || s.turnActive || s.settling);
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
    if (session.remoteOwned) {
      // A host restart must never run the same command a second time. The
      // transcript and CLI conversation remain available for a deliberate
      // next message after the user checks the project state.
      const lastUser = session.transcript.map((event) => event.kind).lastIndexOf("user");
      const tail = lastUser >= 0 ? session.transcript.slice(lastUser + 1) : [];
      const finished = tail.some((event) => event.kind === "done" || event.kind === "error" ||
        (event.kind === "status" && event.text === STOPPED));
      if (interrupted || (lastUser >= 0 && !finished)) {
        session.restartTurn = undefined;
        pushEvent(session, { kind: "error", text: "The host restarted during this turn. Check the project before continuing; no command was run again." });
      }
      continue;
    }
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
async function refreshAfterTurn(plan: PlanConfig, threadId?: string): Promise<void> {
  if (plan.engine === "codex") await refreshCodex(plan, threadId);
  else await refreshPlanUsage(plan);
}

// The chat list changed in the main process (a queued turn started, a turn
// ended); the window refreshes its sidebar from this.
function sendSessions(): void {
  mainWindow?.webContents.send("sessions:changed");
}

handleSession("session:send", (_e, sessionId: string, prompt: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  if (session.transferLock) return { error: "This chat is continuing on another Mac. Wait for the transfer to finish." };
  if (session.transferredTo) return { error: `This chat continued on ${session.transferredTo}. Open the new chat there.` };
  if (session.running || session.turnActive || session.settling) return { error: "Session is already running" };
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
handleSession("session:steer", async (_e, sessionId: string, prompt: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  if (session.transferLock || session.transferredTo) return { error: "This chat is moving to another Mac." };
  if (session.turnActive || session.settling) return { error: "The reply is finishing. Send again in a moment." };
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
handleSession("session:edit-last", async (_e, sessionId: string, text: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  if (session.transferLock || session.transferredTo) return { error: "This chat is moving to another Mac." };
  if (session.turnActive || session.settling) return { error: "The reply is finishing. Try the edit in a moment." };
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
    session.transcriptVersion = (session.transcriptVersion ?? 0) + 1;
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
handleSession(
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
handleSession("session:queue-add", (_e, sessionId: string, text: string) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  if (session.transferLock || session.transferredTo) return { error: "This chat is moving to another Mac." };
  if (!text.trim()) return { error: "Empty message" };
  if (!session.running && !session.turnActive && !session.settling && !session.steering) {
    startTurn(session, text);
    return {};
  }
  session.queue.push(text);
  persistChat(session);
  sendSessions();
  return {};
});

handleSession("session:queue-remove", (_e, sessionId: string, index: number) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  session.queue.splice(index, 1);
  persistChat(session);
  sendSessions();
  return {};
});

// Send a queued message now: it takes over from the running reply the way
// a steer does, or simply sends when nothing is running.
handleSession("session:queue-send-now", async (_e, sessionId: string, index: number) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: "Unknown session" };
  if (session.transferLock || session.transferredTo) return { error: "This chat is moving to another Mac." };
  const [text] = session.queue.splice(index, 1);
  if (text === undefined) return { error: "That message is no longer queued" };
  if (session.turnActive || session.settling) {
    session.queue.splice(index, 0, text);
    return { error: "The reply is finishing. Try again in a moment." };
  }
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

// your skills: personal ones first, then each sidebar project's own
ipcMain.handle("skills:list", () =>
  listSkills([
    { project: "", dirs: personalSkillDirs(homedir(), process.env.CODEX_HOME) },
    ...allProjects().map((p) => ({ project: p.name, dirs: projectSkillDirs(p.path) }))
  ])
);

ipcMain.handle("skills:reveal", (_e, file: string) => {
  if (typeof file === "string" && basename(file) === "SKILL.md" && existsSync(file)) shell.showItemInFolder(file);
});

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

// Muse's subscription percent exists only in its TUI's /usage; the user
// pastes it here once and it is stored for every Muse plan.
ipcMain.handle("usage:muse-snapshot", async (_e, input: MuseSnapshotInput) => {
  const snap = resolveMuseSnapshot(input ?? {});
  if (!snap) return { error: "No percent found — paste the /usage output or type a used %." };
  saveMuseSubscriptionSnapshot(snap);
  await Promise.all(
    loadPlans()
      .filter((p) => p.engine === "muse" && p.installed)
      .map((p) => refreshPlanUsage(p))
  );
  return { usage: allUsage() };
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
  codex: ["low", "medium", "high", "xhigh", "max"],
  muse: ["low", "medium", "high", "xhigh", "max"]
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
handleSession("session:cancel", (_e, sessionId: string) => {
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
