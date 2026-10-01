export type EngineKind = "claude" | "kimi" | "codex" | "gemini" | "opencode" | "qwen";

export interface PlanConfig {
  id: string;
  label: string;
  engine: EngineKind;
  bin: string;
  extraArgs: string[];
  color: string;
  installed: boolean;
  // Runtime truth: whether the engine's CLI is authenticated on this machine.
  loggedIn?: boolean;
  // Runtime truth: an added subscription account with its own login
  ownLogin?: boolean;
  // Runtime truth: the Claude account a subscription plan is signed in as
  email?: string;
  env?: Record<string, string>;
  models?: string[];
}

export type EngineEvent =
  // replaced: the user edited this message; it stays in history, struck out.
  // effort: the level Auto picked for this message
  | { kind: "user"; text: string; replaced?: boolean; effort?: string }
  | { kind: "session"; engineSessionId: string }
  | { kind: "status"; text: string }
  | { kind: "text"; text: string; streaming?: boolean; fromStream?: boolean }
  | { kind: "delta"; text: string }
  | { kind: "tool"; name: string; detail?: string; id?: string; step?: ToolStep }
  // a tool's outcome; output is trimmed so long chats stay light on disk
  | { kind: "tool_result"; id?: string; ok: boolean; output?: string }
  // a finished stretch of reasoning: a summary from Claude, the full text
  // from GLM. Blank when the engine withholds it.
  | { kind: "thinking"; text: string; ms?: number; live?: boolean; startedAt?: number }
  // live reasoning while it streams; sent to the window, never saved
  | { kind: "thinking_delta"; text: string; startedAt?: number }
  | { kind: "error"; text: string }
  // the engine asks before running a tool it is not allowed to run on its
  // own; the chat shows Allow / Deny and the run waits for the answer
  | {
      kind: "permission";
      requestId: string;
      tool: string;
      input?: Record<string, unknown>;
      description?: string;
      step?: ToolStep;
      // "always allow" rules the engine offered for this request
      suggestions?: unknown[];
    }
  // answers: what you picked, when the request was one of Claude's questions;
  // response: what you typed in the message box instead. withdrawn: the
  // engine stopped waiting before anyone answered.
  | {
      kind: "permission_decision";
      requestId: string;
      allowed: boolean;
      always?: boolean;
      answers?: Record<string, string>;
      response?: string;
      withdrawn?: boolean;
    }
  // plan usage the engine reported mid-run; updates the usage view, not saved
  | { kind: "usage"; windows: UsageWindow[]; limited?: boolean }
  // tokens: what the run used, when the engine reports it. costUsd: what it
  // would cost at API list prices, by the engine's own estimate (Claude's)
  | { kind: "done"; ok: boolean; summary?: string; tokens?: TokenCount; costUsd?: number }
  | { kind: "filtered"; text: string; original: string };

// input counts cached and cache-written tokens too: everything the model read
export interface TokenCount {
  input: number;
  output: number;
}

export interface UsageWindow {
  label: string;
  // 0 to 100
  usedPct: number;
  // epoch ms
  resetsAt?: number;
}

export interface ToolStep {
  type: "explore" | "terminal" | "edit" | "web" | "agent" | "todo" | "other";
  label: string;
  target?: string;
  note?: string;
  search?: boolean;
  added?: number;
  removed?: number;
  todos?: Array<{ text: string; status: string }>;
  // unified diff lines for edits: "+added", "-removed", " context"
  diff?: string[];
}

export interface SendOptions {
  prompt: string;
  resumeId?: string;
  cwd: string;
  model?: string;
  effort?: string;
  fullAccess?: boolean;
  // the chats' own browser (src/main/chromeBrowser.ts)
  browser?: McpServer;
  // a map of the project's code, put in front of a new chat's first message
  // (withCodeMap); only the code-map test in scripts/code-map sets it
  codeMap?: string;
}

// an MCP server the app starts with a chat: a command and its arguments
export interface McpServer {
  command: string;
  args: string[];
}

export interface EngineAdapter {
  kind: EngineKind;
  buildArgs(opts: SendOptions): string[];
  parseLine(line: string, emit: (e: EngineEvent) => void): void;
  // Optional per-run lifecycle for CLIs whose output is plain text rather
  // than a JSON stream: beginRun resets state, endRun flushes the whole
  // reply as one text event.
  beginRun?(): void;
  endRun?(emit: (e: EngineEvent) => void): void;
  // Engines that take their prompt on stdin (claude, for permission
  // requests): the first stdin line, and how to answer a permission request.
  initialInput?(opts: SendOptions): string;
  permissionResponse?(
    requestId: string,
    allow: boolean,
    input: Record<string, unknown> | undefined,
    alwaysRules?: unknown[]
  ): string;
  // Engines whose runs outlast their first result: true once no more
  // permission answers can be needed, so stdin can close and the engine
  // exit. Checked after every line; without it stdin closes at the first
  // result.
  inputDone?(): boolean;
}

export interface RunHandle {
  done: Promise<void>;
  cancel(): void;
  // answers a permission request; a no-op for engines that cannot ask
  respond(requestId: string, allow: boolean, input?: Record<string, unknown>, alwaysRules?: unknown[]): void;
}
