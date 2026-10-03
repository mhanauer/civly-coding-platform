import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { EngineEvent, PlanConfig, UsageWindow } from "../main/engines/types.ts";
import type { BrowserCheck } from "../main/browserChecks.ts";
import type { CodexCredits, CodexResets } from "../main/codexAccountUsage.ts";
import type { Settings } from "../main/settings.ts";
import type { CliStatus } from "../main/cliUpdates.ts";
import type { Tools } from "../main/leanChats.ts";

export interface PlanUsage {
  windows: UsageWindow[];
  credits?: CodexCredits;
  resets?: CodexResets;
  limitedUntil?: number;
  updatedAt: number;
}

interface SessionEventPayload {
  sessionId: string;
  event: EngineEvent;
}

export interface SessionSummary {
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
  // lean chats: what Claude starts with; autoFull once auto took on more
  tools: Tools;
  autoFull: boolean;
  running: boolean;
  title: string;
  // true until the first message: plan and folder can still change freely
  empty: boolean;
  status: "idle" | "running" | "waiting" | "error" | "done";
  queue: string[];
  defaultEffort: string;
  // a side-pane conversation: kept out of the chat list
  side: boolean;
  // the chat a side conversation belongs to; "" is the new-task screen
  parentId?: string;
  createdAt: number;
}

export interface SessionPatch {
  cwd?: string;
  model?: string;
  effort?: string;
  fullAccess?: boolean;
  filter?: boolean;
  tools?: Tools;
  planId?: string;
}

const api = {
  listPlans: (): Promise<PlanConfig[]> => ipcRenderer.invoke("plans:list"),
  createPlan: (opts: {
    label: string;
    engine: string;
    bin?: string;
    baseUrl?: string;
    token?: string;
    models?: string[];
    ownLogin?: boolean;
  }): Promise<{ plans?: PlanConfig[]; error?: string }> =>
    ipcRenderer.invoke("plans:create", opts),
  updatePlan: (
    planId: string,
    patch: { label?: string; baseUrl?: string; token?: string; models?: string[] }
  ): Promise<{ plans?: PlanConfig[]; error?: string }> =>
    ipcRenderer.invoke("plans:update", planId, patch),
  deletePlan: (planId: string): Promise<{ plans?: PlanConfig[]; error?: string }> =>
    ipcRenderer.invoke("plans:delete", planId),
  createSession: (opts: {
    planId: string;
    cwd: string;
    model: string;
    effort: string;
    fullAccess: boolean;
    filter?: boolean;
    tools?: Tools;
    side?: boolean;
    parentId?: string;
  }): Promise<{ sessionId?: string; error?: string }> =>
    ipcRenderer.invoke("session:create", opts),
  setSideParent: (sessionId: string, parentId: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke("session:set-parent", sessionId, parentId),
  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke("session:list"),
  updateSession: (
    sessionId: string,
    patch: SessionPatch
  ): Promise<{ summary?: SessionSummary; error?: string }> =>
    ipcRenderer.invoke("session:update", sessionId, patch),
  renameSession: (
    sessionId: string,
    title: string
  ): Promise<{ summary?: SessionSummary; error?: string }> =>
    ipcRenderer.invoke("session:rename", sessionId, title),
  transcript: (sessionId: string): Promise<EngineEvent[]> =>
    ipcRenderer.invoke("session:transcript", sessionId),
  send: (sessionId: string, prompt: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke("session:send", sessionId, prompt),
  answerPermission: (
    sessionId: string,
    requestId: string,
    allow: boolean,
    always: boolean,
    answers?: Record<string, string>,
    response?: string
  ): Promise<{ error?: string; gone?: boolean }> =>
    ipcRenderer.invoke("session:permission", sessionId, requestId, allow, always, answers, response),
  queueAdd: (sessionId: string, text: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke("session:queue-add", sessionId, text),
  queueRemove: (sessionId: string, index: number): Promise<{ error?: string }> =>
    ipcRenderer.invoke("session:queue-remove", sessionId, index),
  queueSendNow: (sessionId: string, index: number): Promise<{ error?: string }> =>
    ipcRenderer.invoke("session:queue-send-now", sessionId, index),
  usage: (): Promise<Record<string, PlanUsage>> => ipcRenderer.invoke("usage:get"),
  updateStatus: (): Promise<{ ready: boolean; waiting: boolean }> => ipcRenderer.invoke("update:status"),
  restartForUpdate: (whenIdle: boolean): Promise<{ waiting: boolean }> =>
    ipcRenderer.invoke("update:restart", whenIdle),
  cancelRestart: (): Promise<{ waiting: boolean }> => ipcRenderer.invoke("update:cancel"),
  onUpdateReady: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("update:ready", listener);
    return () => ipcRenderer.removeListener("update:ready", listener);
  },
  refreshUsage: (): Promise<Record<string, PlanUsage>> => ipcRenderer.invoke("usage:refresh"),
  effortDefaults: (): Promise<Record<string, string>> => ipcRenderer.invoke("effort:defaults"),
  // the open chat, and its side conversation when that tab shows
  setActiveChat: (id: string | null, sideId: string | null): Promise<void> =>
    ipcRenderer.invoke("ui:active-chat", id, sideId),
  onUsageUpdate: (cb: (all: Record<string, PlanUsage>) => void): (() => void) => {
    const listener = (_e: unknown, all: Record<string, PlanUsage>): void => cb(all);
    ipcRenderer.on("usage:update", listener);
    return () => ipcRenderer.removeListener("usage:update", listener);
  },
  // sideId: a side conversation, opened beside its chat ("" is the new-task screen)
  onOpenChat: (cb: (id: string, sideId?: string) => void): (() => void) => {
    const listener = (_e: unknown, id: string, sideId?: string): void => cb(id, sideId);
    ipcRenderer.on("ui:open-chat", listener);
    return () => ipcRenderer.removeListener("ui:open-chat", listener);
  },
  onSessionsChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("sessions:changed", listener);
    return () => ipcRenderer.removeListener("sessions:changed", listener);
  },
  editLast: (sessionId: string, text: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke("session:edit-last", sessionId, text),
  steer: (sessionId: string, prompt: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke("session:steer", sessionId, prompt),
  cancel: (sessionId: string): Promise<void> => ipcRenderer.invoke("session:cancel", sessionId),
  deleteChat: (sessionId: string): Promise<void> => ipcRenderer.invoke("chats:delete", sessionId),
  listProjects: (): Promise<Array<{ path: string; name: string }>> =>
    ipcRenderer.invoke("projects:list"),
  addProject: (): Promise<{ projects: Array<{ path: string; name: string }> }> =>
    ipcRenderer.invoke("projects:add"),
  reorderProjects: (paths: string[]): Promise<Array<{ path: string; name: string }>> =>
    ipcRenderer.invoke("projects:reorder", paths),
  projectBranches: (path: string): Promise<{ current: string; branches: string[] }> =>
    ipcRenderer.invoke("projects:branches", path),
  ensureDevBranch: (
    path: string
  ): Promise<{ error?: string | null; branches: { current: string; branches: string[] } }> =>
    ipcRenderer.invoke("projects:ensure-dev", path),
  checkoutBranch: (
    path: string,
    branch: string
  ): Promise<{ error?: string | null; branches: { current: string; branches: string[] } }> =>
    ipcRenderer.invoke("projects:checkout", path, branch),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke("settings:set", patch),
  // the engine CLIs' versions and updates (src/main/cliUpdates.ts)
  cliStatus: (): Promise<CliStatus[]> => ipcRenderer.invoke("clis:status"),
  updateCli: (engine: string): Promise<CliStatus[]> => ipcRenderer.invoke("clis:update", engine),
  onCliStatus: (cb: (list: CliStatus[]) => void): (() => void) => {
    const listener = (_e: unknown, list: CliStatus[]): void => cb(list);
    ipcRenderer.on("clis:changed", listener);
    return () => ipcRenderer.removeListener("clis:changed", listener);
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pick:folder"),
  pickFiles: (): Promise<string[] | null> => ipcRenderer.invoke("pick:files"),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  loginPlan: (planId: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke("plan:login", planId),
  // a window on the chats' own browser, to sign it in (src/main/chromeBrowser.ts)
  openBrowser: (): Promise<{ error?: string }> => ipcRenderer.invoke("browser:open"),
  // the folder its downloads save to
  openBrowserDownloads: (): Promise<{ error?: string }> => ipcRenderer.invoke("browser:downloads"),
  // pages there waiting on you: a CAPTCHA, bot check or sign-in (src/main/browserChecks.ts)
  browserChecks: (): Promise<BrowserCheck[]> => ipcRenderer.invoke("browser:checks"),
  onBrowserChecks: (cb: (checks: BrowserCheck[]) => void): (() => void) => {
    const listener = (_e: unknown, checks: BrowserCheck[]): void => cb(checks);
    ipcRenderer.on("browser:checks", listener);
    return () => ipcRenderer.removeListener("browser:checks", listener);
  },
  showBrowserCheck: (targetId: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke("browser:show-check", targetId),
  ptyOpen: (id: string, cwd: string, rows: number, cols: number): Promise<{ error?: string }> =>
    ipcRenderer.invoke("pty:open", id, cwd, rows, cols),
  ptyInput: (id: string, data: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke("pty:input", id, data),
  ptyResize: (id: string, rows: number, cols: number): Promise<{ error?: string }> =>
    ipcRenderer.invoke("pty:resize", id, rows, cols),
  ptyClose: (id: string): Promise<{ error?: string }> => ipcRenderer.invoke("pty:close", id),
  onPtyData: (id: string, cb: (data: string) => void): (() => void) => {
    const listener = (_e: unknown, payload: { id: string; data: string }): void => {
      if (payload.id === id) cb(payload.data);
    };
    ipcRenderer.on("pty:data", listener);
    return () => ipcRenderer.removeListener("pty:data", listener);
  },
  onSessionEvent: (cb: (payload: SessionEventPayload) => void): (() => void) => {
    const listener = (_e: unknown, payload: SessionEventPayload): void => cb(payload);
    ipcRenderer.on("session:event", listener);
    return () => ipcRenderer.removeListener("session:event", listener);
  }
};

contextBridge.exposeInMainWorld("hub", api);
export type HubApi = typeof api;
