import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, JSX } from "react";
import type { EngineEvent, PlanConfig } from "../../main/engines/types.ts";
import type { Tools } from "../../main/leanChats.ts";
import type { BrowserCheck } from "../../main/browserChecks.ts";
import type { Settings } from "../../main/settings.ts";
import type { CliStatus } from "../../main/cliUpdates.ts";
import markUrl from "../assets/civly-mark.png";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  mergeDeltas,
  isThinking,
  buildFlow,
  formatDuration,
  type FlowItem,
  type StepView,
  type TodoState
} from "./chatFlow.ts";

// Assistant replies arrive as markdown; render it as chat, never as a wall
// of literal ** and #. Links open in Chrome (the main process routes them).
// Memoized: while any chat streams, the open one redraws many times a
// second, and a finished message's text never changes.
const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="chat-md">
      <ReactMarkdown
        // a single line break in a reply stays a line break, as it reads in chat
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node, ...props }) => {
            void node;
            return <a {...props} target="_blank" rel="noreferrer" />;
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Shown in the message flow while the engine works and nothing has come
// back yet: the reply lands where the dots sit.
function ThinkingDots(): JSX.Element {
  return (
    <div className="msg msg-thinking">
      <span>Thinking</span>
      <span className="dots">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

type PaneKind = "chat" | "terminal" | "browser";
// a terminal or browser tab; side conversation tabs come from the open
// chat's side conversations
interface PaneTab {
  id: string;
  kind: Exclude<PaneKind, "chat">;
}
// a tab the pane shows: a side conversation (null until its first
// message), or a terminal or browser tab
type ShownTab = { id: string; kind: "chat"; session: SessionSummary | null } | PaneTab;

interface WebViewLike extends HTMLElement {
  goBack(): void;
  goForward(): void;
  reload(): void;
}

// A real interactive shell in the side pane. The main process bridges the
// shell through macOS `script`, which gives it a true pty: prompt, colors,
// and ctrl-c all behave. Cleanup on unmount closes the shell.
function TerminalPane({ id, cwd }: { id: string; cwd: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      theme: {
        background: "#0c0417",
        foreground: "#e6e0f5",
        cursor: "#c9baf0"
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    void window.hub.ptyOpen(id, cwd, term.rows, term.cols).then((res) => {
      if (res?.error) term.writeln(`\r\n${res.error}`);
    });
    const off = window.hub.onPtyData(id, (data) => term.write(data));
    term.onData((data) => void window.hub.ptyInput(id, data));
    const onResize = (): void => {
      fit.fit();
      void window.hub.ptyResize(id, term.rows, term.cols);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      off();
      void window.hub.ptyClose(id);
      term.dispose();
    };
  }, [id, cwd]);
  return <div className="term-host" ref={hostRef} />;
}

// A small embedded browser: URL bar plus back/forward/reload. Anything that
// is not a URL is searched.
function BrowserPane(): JSX.Element {
  const [url, setUrl] = useState("");
  const [input, setInput] = useState("");
  const wvRef = useRef<WebViewLike | null>(null);
  const go = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const target =
      /^https?:\/\//i.test(trimmed)
        ? trimmed
        : trimmed.includes(".") && !trimmed.includes(" ")
          ? `https://${trimmed}`
          : `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
    setUrl(target);
    setInput(target);
  };
  return (
    <div className="browser-pane">
      <div className="browser-bar">
        <button className="mini-btn" title="Back" onClick={() => wvRef.current?.goBack()}>
          ‹
        </button>
        <button className="mini-btn" title="Forward" onClick={() => wvRef.current?.goForward()}>
          ›
        </button>
        <button className="mini-btn" title="Reload" onClick={() => wvRef.current?.reload()}>
          ⟳
        </button>
        <input
          className="browser-url"
          value={input}
          placeholder="Search or type a URL"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go(input);
          }}
        />
        <button className="mini-btn" onClick={() => go(input)}>
          Go
        </button>
      </div>
      {url ? (
        <webview
          ref={wvRef}
          src={url}
          className="browser-view"
        />
      ) : (
        <div className="side-empty">Type a URL or a search above.</div>
      )}
    </div>
  );
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
  defaultEffort: string;
  // a side-pane conversation: kept out of the chat list
  side: boolean;
  // the chat a side conversation belongs to; "" is the new-task screen
  parentId?: string;
  createdAt: number;
}

type ChatStatus = "idle" | "running" | "waiting" | "error" | "done";

type PlanUsage = Awaited<ReturnType<typeof window.hub.usage>>[string];

// A Claude or ChatGPT subscription added in Accounts signs in on its own.
function accountOwnLogin(f: { engine: string; auth: string }): boolean {
  return f.engine === "codex" || (f.engine === "claude" && f.auth === "login");
}

// An API base URL and token only mean something to a Claude Code key plan.
function accountKeyed(f: { engine: string; auth: string }): boolean {
  return f.engine === "claude" && f.auth === "key";
}

function planKeyed(p: PlanConfig): boolean {
  return p.engine === "claude" && !p.ownLogin;
}

function shortDate(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// One line for a plan's usage: out until a date, or its fullest window.
function usageNote(u?: PlanUsage): string {
  if (!u) return "";
  if (u.limitedUntil !== undefined) return u.limitedUntil ? `out until ${shortDate(u.limitedUntil)}` : "out";
  const top = [...u.windows].sort((a, b) => b.usedPct - a.usedPct)[0];
  if (!top) return "";
  return top.usedPct === 0 && top.label.startsWith("$") ? top.label : `${top.usedPct}% ${top.label.toLowerCase()} used`;
}

// Each usage window as a bar with its reset time; red when the plan is out.
function UsageBars({ usage, codex = false }: { usage?: PlanUsage; codex?: boolean }): JSX.Element | null {
  if (!usage || (usage.windows.length === 0 && usage.limitedUntil === undefined && !usage.credits && !usage.resets)) return null;
  return (
    <div className="usage-bars">
      {usage.limitedUntil !== undefined ? (
        <div className="usage-out">
          Out of quota{usage.limitedUntil ? `, resets ${shortDate(usage.limitedUntil)}` : ""}
        </div>
      ) : null}
      {usage.windows.map((w) => (
        <div className="usage-bar-row" key={w.label}>
          <span className="usage-bar-label">{w.label}</span>
          {w.label.startsWith("$") ? null : (
            <>
              <span className="usage-bar">
                <span
                  className={w.usedPct >= 90 ? "usage-fill high" : w.usedPct >= 70 ? "usage-fill mid" : "usage-fill"}
                  style={{ width: `${Math.min(100, w.usedPct)}%` }}
                />
              </span>
              <span className="usage-bar-pct">{w.usedPct}% used</span>
            </>
          )}
          {w.resetsAt ? <span className="usage-bar-reset">resets {shortDate(w.resetsAt)}</span> : null}
        </div>
      ))}
      {codex ? <CodexExtras usage={usage} /> : null}
    </div>
  );
}

function CodexExtras({ usage }: { usage?: PlanUsage }): JSX.Element | null {
  if (!usage?.credits && !usage?.resets) return null;
  return (
    <div className="codex-usage-extras">
      {usage.credits ? (
        <div>{usage.credits.unlimited
          ? "Credits: unlimited"
          : `Credits: ${usage.credits.balance?.toLocaleString("en-US") ?? "unknown"} remaining`}</div>
      ) : null}
      {usage.resets ? (
        <>
          <div>Resets: {usage.resets.availableCount} available</div>
          {usage.resets.details.map((reset, i) => (
            <div key={`${reset.title}-${reset.expiresAt ?? i}`}>
              {reset.title}{reset.expiresAt ? ` expires ${shortDate(reset.expiresAt)}` : ""}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

function cliNote(c: CliStatus): string {
  const to = c.latest ? ` to ${c.latest}` : "";
  switch (c.state) {
    case "current":
      return "Up to date";
    case "behind":
      return `${c.latest} is out`;
    case "held":
      return `${c.latest} is out. A new major version waits for you, since it can change how the app runs it.`;
    case "manual":
      return `${c.latest} is out. Update it the way you installed it.`;
    case "waiting":
      return `Updates${to} once its chats finish`;
    case "updating":
      return `Updating${to}`;
    case "failed":
      return `Update failed: ${c.error ?? "no reason given"}`;
    case "pinned":
      return c.latest
        ? `Kept at this version on purpose. ${c.latest} is out; raise MCP_PACKAGE in src/main/chromeBrowser.ts to use it.`
        : "Kept at this version on purpose";
    default:
      return "Could not check for a newer version";
  }
}

// Each engine CLI's version, and its update (src/main/cliUpdates.ts)
function CliVersions(): JSX.Element {
  const [clis, setClis] = useState<CliStatus[]>([]);
  useEffect(() => {
    window.hub.cliStatus().then(setClis).catch(() => undefined);
    return window.hub.onCliStatus(setClis);
  }, []);
  if (!clis.length) return <div className="cli-versions cli-note">Checking the CLIs for new versions</div>;
  return (
    <div className="cli-versions">
      {clis.map((c) => (
        <div className="cli-row" key={c.id}>
          <span className="cli-name">{c.label}</span>
          <span className="cli-version">{c.installed}</span>
          <span className="cli-note">{cliNote(c)}</span>
          {c.state === "behind" || c.state === "held" || c.state === "failed" ? (
            <button className="mini-btn" onClick={() => void window.hub.updateCli(c.id).then(setClis)}>
              Update
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// The chat's light: a spinner while it works, red when it needs you (an
// error, a blocked permission, a hit limit), green when it finished. A new
// or stopped chat keeps its plan color.
function StatusLight({ status, color }: { status: ChatStatus; color: string }): JSX.Element {
  if (status === "running") return <span className="status-light running" title="Working" />;
  if (status === "waiting") return <span className="status-light error pulse" title="Waiting for your permission or answer" />;
  if (status === "error")
    return <span className="status-light error" title="Needs attention: an error or a blocked permission" />;
  if (status === "done") return <span className="status-light done" title="Done" />;
  return <span className="dot" style={{ background: color }} />;
}

const STATUS_BADGE: Record<ChatStatus, string> = {
  idle: "",
  running: "Working",
  // a permission request or one of Claude's questions
  waiting: "Needs you",
  error: "Needs attention",
  done: "Done"
};

const EFFORTS: Record<string, string[]> = {
  claude: ["auto", "low", "medium", "high", "xhigh", "max"],
  codex: ["auto", "low", "medium", "high", "xhigh", "max"]
};

function effortsFor(engine: string): string[] {
  return EFFORTS[engine] ?? [];
}

// Filled at startup from the main process: a new chat starts on Auto.
let EFFORT_DEFAULTS: Record<string, string> = {};

function defaultEffort(engine: string): string {
  return EFFORT_DEFAULTS[engine] || (effortsFor(engine)[0] ?? "");
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function EventLine({ event }: { event: EngineEvent }): JSX.Element | null {
  switch (event.kind) {
    case "user":
      return (
        <div className="msg msg-user">
          <div className="bubble">{event.text}</div>
        </div>
      );
    case "text":
      return (
        <div className="msg msg-text">
          <ChatMarkdown text={event.text} />
        </div>
      );
    case "tool":
      return (
        <div className="msg msg-tool">
          <span className="tool-name">{event.name}</span>
          {event.detail ? <span className="tool-detail"> {event.detail}</span> : null}
        </div>
      );
    case "status":
      return <div className="msg msg-status">{event.text}</div>;
    case "error":
      return <div className="msg msg-error">{event.text}</div>;
    case "done":
      // drives busy-state logic upstairs; the turn's own text and errors
      // already say everything, so nothing is printed for it
      return null;
    case "session":
      return null;
    case "filtered":
      return null;
    case "tool_result":
    case "thinking":
    case "thinking_delta":
      return null;
    default:
      return null;
  }
}

// Your message in the chat. The latest one can be edited: the old text
// stays, struck out, and the edit goes out as the next message (a reply
// still running for the old one stops first).
function UserBubble({
  text,
  replaced,
  effort,
  onEdit
}: {
  text: string;
  replaced?: boolean;
  effort?: string;
  onEdit?: (next: string) => Promise<boolean>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const save = async (): Promise<void> => {
    const next = draft.trim();
    if (!onEdit || !next || next === text.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onEdit(next);
    setSaving(false);
    if (ok) setEditing(false);
  };
  if (editing) {
    return (
      <div className="msg msg-user editing">
        <textarea
          className="bubble-edit"
          autoFocus
          value={draft}
          rows={Math.min(10, Math.max(2, draft.split("\n").length))}
          onFocus={(e) => e.currentTarget.setSelectionRange(draft.length, draft.length)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") {
              setDraft(text);
              setEditing(false);
            }
          }}
        />
        <div className="bubble-edit-actions">
          <button
            className="mini-btn"
            onClick={() => {
              setDraft(text);
              setEditing(false);
            }}
          >
            Cancel
          </button>
          <button className="send-btn" disabled={saving || !draft.trim()} onClick={() => void save()}>
            {saving ? "Sending…" : "Send edit"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={replaced ? "msg msg-user replaced" : "msg msg-user"}>
      <div className="bubble">{text}</div>
      {replaced ? <div className="bubble-note">edited</div> : null}
      {effort ? <div className="bubble-note">auto effort: {effort}</div> : null}
      {onEdit && !replaced ? (
        <button
          className="bubble-edit-btn"
          title="Edit this message"
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
        >
          Edit
        </button>
      ) : null}
    </div>
  );
}

function FilteredLine({ text, original }: { text: string; original: string }): JSX.Element {
  const [showOriginal, setShowOriginal] = useState(false);
  return (
    <div className="msg msg-filtered">
      <div className="filtered-tag">Rewritten in plain English</div>
      <div className="msg-text">{text}</div>
      <button className="link-btn" onClick={() => setShowOriginal(!showOriginal)}>
        {showOriginal ? "hide original" : "show original"}
      </button>
      {showOriginal ? <div className="msg-original">{original}</div> : null}
    </div>
  );
}

// Line icons for the step rows, drawn at 14px in the text color.
function StepIcon({ kind }: { kind: string }): JSX.Element {
  const paths: Record<string, JSX.Element> = {
    explore: (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" />
      </>
    ),
    terminal: (
      <>
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
      </>
    ),
    edit: <path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5V10.5Z" />,
    web: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
      </>
    ),
    agent: (
      <>
        <circle cx="8" cy="5.5" r="2.5" />
        <path d="M3 14c0-3 2.2-4.5 5-4.5s5 1.5 5 4.5" />
      </>
    ),
    thought: (
      <>
        <path d="M6 13.5h4M6.5 11.5h3" />
        <path d="M8 1.8a4.4 4.4 0 0 0-2.6 8c.4.3.6.8.6 1.2v.5h4V11c0-.4.2-.9.6-1.2A4.4 4.4 0 0 0 8 1.8Z" />
      </>
    ),
    other: <circle cx="8" cy="8" r="2.5" />
  };
  return (
    <svg
      className="step-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[kind] ?? paths.other}
    </svg>
  );
}

function Spinner(): JSX.Element {
  return <span className="step-spinner" />;
}

// Seconds since a start time, re-rendered once a second.
function useElapsed(startedAt: number | undefined, running: boolean): number | undefined {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return startedAt ? now - startedAt : undefined;
}

// One stretch of reasoning. It streams open while the model thinks and folds
// shut after. Chats from before reasoning summaries were requested have
// blank Claude thoughts, so those rows show only the time.
function ThoughtRow({
  text,
  ms,
  live,
  startedAt
}: {
  text: string;
  ms?: number;
  live: boolean;
  startedAt?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(startedAt, live);
  const liveRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (live && liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [live, text]);
  const hasText = text.trim().length > 0;
  const duration = live ? formatDuration(elapsed) : formatDuration(ms);
  return (
    <div className="step">
      <button
        className={hasText ? "step-row clickable" : "step-row"}
        onClick={() => hasText && !live && setOpen(!open)}
        title={hasText ? undefined : "This engine keeps its reasoning text private; only the time is shown"}
      >
        <StepIcon kind="thought" />
        <span className={live ? "step-label shimmer" : "step-label"}>{live ? "Thinking" : "Thought"}</span>
        {duration ? <span className="step-meta">· {duration}</span> : null}
        {hasText && !live ? <span className="step-chevron">{open ? "▾" : "▸"}</span> : null}
      </button>
      {hasText && (live || open) ? (
        <div className={live ? "step-body thought-text live" : "step-body thought-text"} ref={liveRef}>
          {text.trim()}
        </div>
      ) : null}
    </div>
  );
}

function ExploreRow({ steps, busy }: { steps: StepView[]; busy: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const searches = steps.filter((v) => v.step.search).length;
  const files = steps.length - searches;
  const parts = [
    searches ? `${searches} search${searches === 1 ? "" : "es"}` : "",
    files ? `${files} file${files === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  const pending = busy && steps.some((v) => v.expectsResult && !v.result);
  return (
    <div className="step">
      <button className="step-row clickable" onClick={() => setOpen(!open)}>
        <StepIcon kind="explore" />
        <span className="step-label">Explore</span>
        <span className="step-meta">· {parts.join(", ")}</span>
        {pending ? <Spinner /> : <span className="step-chevron">{open ? "▾" : "▸"}</span>}
      </button>
      {open ? (
        <div className="step-body">
          {steps.map((v, i) => (
            <div key={i} className="explore-item">
              <span className="step-sub">{v.step.label}</span> {v.step.target}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StepRow({ view, busy }: { view: StepView; busy: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { step, result } = view;
  const pending = busy && view.expectsResult && !result;
  const failed = result && !result.ok;
  const output = result?.output?.trim() ?? "";
  const diff = step.type === "edit" ? step.diff ?? [] : [];
  const canOpen =
    step.type === "terminal" ? Boolean(step.target || output) : Boolean(output || diff.length);
  const target = step.target ?? "";
  const fileName = step.type === "edit" ? baseName(target) : "";
  const dir = step.type === "edit" && target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
  return (
    <div className="step">
      <button
        className={canOpen ? "step-row clickable" : "step-row"}
        title={step.note || target}
        onClick={() => canOpen && setOpen(!open)}
      >
        <StepIcon kind={step.type} />
        <span className="step-label">{step.label}</span>
        {step.type === "edit" ? (
          <>
            <span className="step-file">{fileName}</span>
            <span className="step-target">{dir}</span>
            {step.added ? <span className="step-add">+{step.added}</span> : null}
            {step.removed ? <span className="step-del">−{step.removed}</span> : null}
          </>
        ) : (
          <span className={step.type === "terminal" ? "step-target mono" : "step-target"}>{target}</span>
        )}
        {failed ? <span className="step-fail">failed</span> : null}
        {pending ? <Spinner /> : null}
      </button>
      {open ? (
        <div className="step-body">
          {step.type === "terminal" && target ? <pre className="step-cmd">{target}</pre> : null}
          {diff.length ? (
            <pre className="step-diff">
              {diff.map((line, i) => (
                <div
                  key={i}
                  className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "diff-ctx"}
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          ) : null}
          {output && step.type !== "edit" ? (
            <pre className={failed ? "step-out failed" : "step-out"}>{output}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// "in 3h 20m" within a day, a date beyond that.
function resetsIn(ms?: number): string {
  if (!ms) return "";
  const left = ms - Date.now();
  if (left <= 0) return "resetting now";
  if (left < 7 * 24 * 3600 * 1000 && left >= 24 * 3600 * 1000) {
    const d = Math.floor(left / 86400000);
    const h = Math.floor((left % 86400000) / 3600000);
    return `resets in ${d}d ${h}h`;
  }
  if (left < 24 * 3600 * 1000) {
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    return `resets in ${h ? `${h}h ` : ""}${m}m`;
  }
  return `resets ${new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`;
}

function UsageCell({ window: w, out }: {
  window?: { usedPct: number; resetsAt?: number };
  out: boolean;
}): JSX.Element {
  if (!w) return <td className="usage-cell none">—</td>;
  const pct = out ? 100 : w.usedPct;
  return (
    <td className="usage-cell">
      <div className="usage-cell-top">
        <span className="usage-bar">
          <span
            className={pct >= 90 ? "usage-fill high" : pct >= 70 ? "usage-fill mid" : "usage-fill"}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </span>
        <span className="usage-bar-pct">{pct}% used</span>
      </div>
      <div className="usage-cell-reset">{resetsIn(w.resetsAt)}</div>
    </td>
  );
}

// Every plan's hourly (5-hour) and weekly usage on one screen. Claude Max
// reports its numbers with each reply, so it fills in after the next one.
function UsageDashboard({
  plans,
  usage,
  onRefresh,
  onClose
}: {
  plans: PlanConfig[];
  usage: Record<string, PlanUsage>;
  onRefresh: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal usage-dash" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Usage</span>
          <span className="header-spacer" />
          <button className="mini-btn" onClick={onRefresh}>
            Refresh
          </button>
          <button className="mini-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <table className="usage-table">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Hourly (5-hour)</th>
              <th>Weekly</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const u = usage[p.id];
              const hourly = u?.windows.find((w) => /hour/i.test(w.label));
              const weekly = u?.windows.find((w) => /week/i.test(w.label));
              const spend = u?.windows.find((w) => w.label.startsWith("$"));
              const out = u?.limitedUntil !== undefined;
              return (
                <tr key={p.id}>
                  <td className="usage-plan-cell">
                    <div className="usage-plan-name">
                      <span className="dot" style={{ background: p.color }} />
                      {p.label}
                    </div>
                    <div className="usage-plan-sub">
                      {out
                        ? `Out of quota${u?.limitedUntil ? `, back ${resetsIn(u.limitedUntil).replace("resets ", "")}` : ""}`
                        : spend
                          ? spend.label
                          : !u
                            ? p.engine === "claude" && !p.env?.ANTHROPIC_BASE_URL
                              ? "Fills in after its next reply"
                              : "No usage reported"
                            : `Checked ${new Date(u.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
                    </div>
                    {p.engine === "codex" ? <CodexExtras usage={u} /> : null}
                  </td>
                  <UsageCell window={hourly} out={out && Boolean(hourly) && hourly!.usedPct >= 100} />
                  <UsageCell window={weekly} out={out && Boolean(weekly) && weekly!.usedPct >= 100} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// What the main process said about an answer. gone: nothing is waiting on
// the request any more, so sending again cannot help.
interface AnswerResult {
  error?: string;
  gone?: boolean;
}

// Sends an answer from a card. An answer that did not go through gives the
// buttons back (or closes the card when nothing waits on it) and says why,
// so a card never sits there frozen.
function useCardAnswer(): {
  sent: boolean;
  failed: AnswerResult | null;
  send: (answer: () => Promise<AnswerResult>) => void;
} {
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState<AnswerResult | null>(null);
  const send = (answer: () => Promise<AnswerResult>): void => {
    setSent(true);
    setFailed(null);
    void answer().then((res) => {
      if (!res.error) return;
      setFailed(res);
      if (!res.gone) setSent(false);
    });
  };
  return { sent, failed, send };
}

// The engine asking before it runs something: Allow once, Always allow
// (saves the engine's suggested rule), or Deny. The reply waits meanwhile.
function PermissionCard({
  item,
  live,
  onAnswer
}: {
  item: {
    ev: Extract<EngineEvent, { kind: "permission" }>;
    decision?: { allowed: boolean; always?: boolean; withdrawn?: boolean };
  };
  live: boolean;
  onAnswer: (allow: boolean, always: boolean) => Promise<AnswerResult>;
}): JSX.Element {
  const { ev, decision } = item;
  const { sent, failed, send } = useCardAnswer();
  const step = ev.step;
  const what = step?.target || (ev.input ? JSON.stringify(ev.input).slice(0, 200) : "");
  const answered = decision
    ? decision.withdrawn
      ? "No longer waiting"
      : decision.allowed
        ? decision.always
          ? "Allowed, and will be from now on"
          : "Allowed"
        : "Denied"
    : failed?.gone
      ? "No longer waiting"
      : live
        ? ""
        : "Not answered (the reply ended)";
  const resultClass = decision?.allowed
    ? "perm-result ok"
    : decision?.withdrawn || failed?.gone
      ? "perm-result muted"
      : "perm-result";
  return (
    <div className={answered ? "perm-card done" : "perm-card"}>
      <div className="perm-head">
        <StepIcon kind={step?.type ?? "other"} />
        <span className="perm-title">
          {answered ? "Asked to use" : "Wants to use"} {ev.tool}
        </span>
        {answered ? <span className={resultClass}>{answered}</span> : null}
      </div>
      {what ? <pre className="perm-what">{what}</pre> : null}
      {ev.description && ev.description !== what ? <div className="perm-desc">{ev.description}</div> : null}
      {failed?.error ? <div className="perm-error">{failed.error}</div> : null}
      {!answered ? (
        <div className="perm-actions">
          <button className="send-btn" disabled={sent} onClick={() => send(() => onAnswer(true, false))}>
            Allow
          </button>
          {ev.suggestions && ev.suggestions.length > 0 ? (
            <button
              className="mini-btn"
              disabled={sent}
              title="Allow, and save a rule so this is not asked again in this folder"
              onClick={() => send(() => onAnswer(true, true))}
            >
              Always allow
            </button>
          ) : null}
          <button className="mini-btn danger" disabled={sent} onClick={() => send(() => onAnswer(false, false))}>
            Deny
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface AskedQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

// One of Claude's questions: pick an option (or type your own) for each,
// then Send; a single pick-one question sends on the click. Skip tells
// Claude you chose not to answer. The reply waits meanwhile, and a reply
// typed in the message box answers it too.
function QuestionCard({
  item,
  live,
  onAnswer
}: {
  item: {
    ev: Extract<EngineEvent, { kind: "permission" }>;
    decision?: { allowed: boolean; answers?: Record<string, string>; response?: string; withdrawn?: boolean };
  };
  live: boolean;
  // null: skipped
  onAnswer: (answers: Record<string, string> | null) => Promise<AnswerResult>;
}): JSX.Element {
  const { ev, decision } = item;
  const questions = (Array.isArray(ev.input?.questions) ? ev.input.questions : []) as AskedQuestion[];
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ""));
  const card = useCardAnswer();
  const { sent, failed } = card;

  // a typed answer replaces a pick-one choice and joins a pick-many list
  const answerFor = (i: number): string => {
    const own = typed[i]?.trim() ?? "";
    if (!questions[i]?.multiSelect) return own || picked[i]?.[0] || "";
    return [...(picked[i] ?? []), ...(own ? [own] : [])].join(", ");
  };
  const answeredCount = questions.filter((_, i) => answerFor(i)).length;
  const ready = questions.length > 0 && answeredCount === questions.length;
  const send = (answers: Record<string, string> | null): void => card.send(() => onAnswer(answers));
  const choose = (i: number, label: string): void => {
    const q = questions[i];
    if (!q.multiSelect && questions.length === 1) {
      send({ [q.question]: label });
      return;
    }
    setPicked((all) =>
      all.map((p, j) => {
        if (j !== i) return p;
        if (!q.multiSelect) return [label];
        return p.includes(label) ? p.filter((l) => l !== label) : [...p, label];
      })
    );
    if (!q.multiSelect) setTyped((all) => all.map((t, j) => (j === i ? "" : t)));
  };

  const answered = Boolean(decision?.allowed && (decision.answers || decision.response));
  const status = decision
    ? decision.withdrawn
      ? "No longer waiting"
      : answered
        ? "Answered"
        : "Skipped"
    : failed?.gone
      ? "No longer waiting"
      : live
        ? ""
        : "Not answered (the reply ended)";
  if (status) {
    return (
      <div className="perm-card done">
        <div className="perm-head">
          <StepIcon kind="other" />
          <span className="perm-title">Claude asked</span>
          <span className={answered ? "perm-result ok" : decision?.withdrawn || failed?.gone ? "perm-result muted" : "perm-result"}>
            {status}
          </span>
        </div>
        {questions.map((q, i) => (
          <div key={i} className="q-done">
            <span className="q-done-text">{q.question}</span>
            {decision?.answers?.[q.question] ? <span className="q-done-answer">{decision.answers[q.question]}</span> : null}
          </div>
        ))}
        {decision?.response ? (
          <div className="q-done">
            <span className="q-done-text">You replied</span>
            <span className="q-done-answer">{decision.response}</span>
          </div>
        ) : null}
        {failed?.error ? <div className="perm-error">{failed.error}</div> : null}
      </div>
    );
  }
  return (
    <div className="perm-card">
      <div className="perm-head">
        <StepIcon kind="other" />
        <span className="perm-title">Claude has {questions.length > 1 ? `${questions.length} questions` : "a question"}</span>
      </div>
      {questions.map((q, i) => (
        <div key={i} className="q-block">
          {q.header ? <span className="q-header">{q.header}</span> : null}
          <div className="q-text">{q.question}</div>
          <div className="q-options">
            {(q.options ?? []).map((o) => (
              <button
                key={o.label}
                className={picked[i]?.includes(o.label) ? "q-option picked" : "q-option"}
                disabled={sent}
                onClick={() => choose(i, o.label)}
              >
                <span className="q-option-label">{o.label}</span>
                {o.description ? <span className="q-option-desc">{o.description}</span> : null}
              </button>
            ))}
          </div>
          <input
            className="q-other"
            placeholder={q.multiSelect ? "Add your own answer" : "Or type your own answer"}
            value={typed[i] ?? ""}
            disabled={sent}
            onChange={(e) => {
              const value = e.target.value;
              setTyped((all) => all.map((t, j) => (j === i ? value : t)));
              if (!q.multiSelect && value) setPicked((all) => all.map((p, j) => (j === i ? [] : p)));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready && !sent) {
                send(Object.fromEntries(questions.map((qq, j) => [qq.question, answerFor(j)])));
              }
            }}
          />
        </div>
      ))}
      {failed?.error ? <div className="perm-error">{failed.error}</div> : null}
      <div className="perm-actions">
        <button
          className="send-btn"
          disabled={sent || !ready}
          onClick={() => send(Object.fromEntries(questions.map((q, i) => [q.question, answerFor(i)])))}
        >
          Send {questions.length > 1 ? "answers" : "answer"}
        </button>
        <button className="mini-btn danger" disabled={sent} onClick={() => send(null)}>
          Skip
        </button>
        {questions.length > 1 && !ready ? (
          <span className="q-need">
            {answeredCount} of {questions.length} answered
          </span>
        ) : null}
      </div>
    </div>
  );
}

// The engine's current plan step, pinned to the top of a long turn.
function TodoPill({ state }: { state: TodoState }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const { todos } = state;
  if (todos.length === 0 || todos.every((t) => t.status === "completed")) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const current =
    todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status !== "completed");
  return (
    <div className="todo-pill-wrap">
      <button className="todo-pill" onClick={() => setOpen(!open)} title="Show the plan">
        <span className="todo-arrow">→</span>
        <span className="todo-text">{current?.text}</span>
        <span className="todo-count">
          {done}/{todos.length}
        </span>
      </button>
      {open ? (
        <div className="todo-list">
          {todos.map((t, i) => (
            <div key={i} className={`todo-item ${t.status}`}>
              <span className="todo-mark">
                {t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○"}
              </span>
              {t.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// The chat box, ZCode-style: every control is a compact dropdown below the
// input, with a + button to attach files to the message. Draft mode (new
// task) binds to local state. Session mode patches the live session and
// locks while a message is in flight. A running session cannot switch plan,
// since the plan is the engine the conversation lives in.
function Composer({
  plans,
  planId,
  onPlanChange,
  model,
  onModelChange,
  effort,
  onEffortChange,
  fullAccess,
  onFullAccessChange,
  filter,
  onFilterChange,
  tools,
  autoFull,
  onToolsChange,
  attachments,
  onRemoveAttachment,
  input,
  onInputChange,
  onSend,
  busy,
  onCancel,
  onSteer,
  onQueue,
  onAnswerQuestion,
  busyMode,
  onBusyModeChange,
  usage,
  disabled,
  branch,
  onBranchChange
}: {
  plans: PlanConfig[];
  planId: string;
  onPlanChange: (id: string) => void;
  model: string;
  onModelChange: (m: string) => void;
  effort: string;
  onEffortChange: (e: string) => void;
  fullAccess: boolean;
  onFullAccessChange: (b: boolean) => void;
  filter?: boolean;
  onFilterChange?: (b: boolean) => void;
  // lean chats: given for Claude chats when the setting is on
  tools?: Tools;
  autoFull?: boolean;
  onToolsChange?: (t: Tools) => void;
  attachments: string[];
  onRemoveAttachment: (path: string) => void;
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  onCancel: () => void;
  // when given, typing stays open mid-turn and Enter steers the engine, or
  // queues the message for after the reply when the mode is "queue"
  onSteer?: () => void;
  onQueue?: () => void;
  // given while Claude waits on a question: Enter sends the text as the
  // answer, whatever the mode (a queued answer would wait forever)
  onAnswerQuestion?: () => void;
  busyMode?: "steer" | "queue";
  onBusyModeChange?: (m: "steer" | "queue") => void;
  usage?: Record<string, PlanUsage>;
  disabled?: boolean;
  // the folder's git branches; omitted for non-repo folders
  branch?: { current: string; branches: string[] };
  onBranchChange?: (b: string) => void;
}): JSX.Element {
  const plan = plans.find((p) => p.id === planId);
  const models = plan?.models?.length ? plan.models : ["default"];
  const efforts = effortsFor(plan?.engine ?? "");

  // The box grows with what you type so the whole message stays in view,
  // up to 60% of the window; past that it scrolls. Sending shrinks it back.
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = (): void => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.6))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [input]);

  return (
    <div className="composer-card">
      <div className="composer-input-row">
        <textarea
          ref={boxRef}
          className="composer-input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!busy) onSend();
              else if (onAnswerQuestion && input.trim()) onAnswerQuestion();
              else if (busyMode === "queue" && onQueue && input.trim()) onQueue();
              else if (onSteer && input.trim()) onSteer();
            }
          }}
          placeholder={
            busy
              ? onAnswerQuestion
                ? "Claude is waiting on its question: pick above, or type your answer and press Enter"
                : busyMode === "queue" && onQueue
                  ? "Working... press Enter to queue your next message"
                  : onSteer
                    ? "Working... press Enter to redirect it with a new message"
                    : "Working..."
              : "Message (Enter to send, Shift+Enter for newline)"
          }
          disabled={busy && !onSteer && !onAnswerQuestion}
          rows={2}
        />
        {busy ? (
          <button className="stop" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button className="send-btn" onClick={() => onSend()} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
      {attachments.length > 0 ? (
        <div className="attach-row">
          {attachments.map((p) => (
            <span className="attach-chip" key={p} title={p}>
              <span className="attach-name">{baseName(p)}</span>
              <button className="attach-x" title="Remove" onClick={() => onRemoveAttachment(p)}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer-controls">
        <div className="ctl-group">
          <span className="ctl-label">Plan</span>
          <select
            value={planId}
            disabled={disabled}
            title={
              disabled
                ? "Wait for the reply to finish to switch plans"
                : [
                    "Switch plan, e.g. after hitting a limit",
                    ...(usage?.[planId]?.windows ?? []).map(
                      (w) => `${w.label}: ${w.usedPct}%${w.resetsAt ? `, resets ${shortDate(w.resetsAt)}` : ""}`
                    )
                  ].join("\n")
            }
            onChange={(e) => onPlanChange(e.target.value)}
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.installed}>
                {p.label}
                {p.installed ? "" : " (not installed)"}
                {p.installed && usageNote(usage?.[p.id]) ? ` · ${usageNote(usage?.[p.id])}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="ctl-group">
          <span className="ctl-label">Model</span>
          <select
            value={model}
            disabled={disabled}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        {branch && branch.branches.length > 0 && onBranchChange ? (
          <div className="ctl-group">
            <span className="ctl-label">Branch</span>
            <select
              value={branch.current}
              disabled={disabled || busy}
              onChange={(e) => onBranchChange(e.target.value)}
            >
              {branch.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {efforts.length > 0 ? (
          <div className="ctl-group">
            <span className="ctl-label">Effort</span>
            <select
              value={effort}
              disabled={disabled}
              onChange={(e) => onEffortChange(e.target.value)}
            >
              {efforts.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="ctl-group">
          <span className="ctl-label">Access</span>
          <select
            value={fullAccess ? "full" : "standard"}
            disabled={disabled}
            onChange={(e) => onFullAccessChange(e.target.value === "full")}
          >
            <option value="standard">Standard</option>
            <option value="full">Full access</option>
          </select>
        </div>
        {onToolsChange ? (
          <div className="ctl-group">
            <span className="ctl-label">Tools</span>
            <select
              value={tools ?? "auto"}
              disabled={disabled}
              title="Your connectors, skills and slash commands. Lean leaves them out to save plan use; Auto turns them on when a message needs them."
              onChange={(e) => onToolsChange(e.target.value as Tools)}
            >
              <option value="auto">{autoFull ? "Auto (full now)" : "Auto"}</option>
              <option value="lean">Lean</option>
              <option value="full">Full</option>
            </select>
          </div>
        ) : null}
        {onFilterChange ? (
          <div className="ctl-group">
            <span className="ctl-label">Filter</span>
            <select
              value={filter ? "on" : "off"}
              disabled={disabled}
              onChange={(e) => onFilterChange(e.target.value === "on")}
            >
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>
        ) : null}
        {onBusyModeChange ? (
          <div className="ctl-group">
            <span className="ctl-label">While working</span>
            <select
              value={busyMode}
              title="What Enter does while a reply is running"
              onChange={(e) => onBusyModeChange(e.target.value as "steer" | "queue")}
            >
              <option value="steer">Steer</option>
              <option value="queue">Queue</option>
            </select>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const SIDEBAR_DEFAULT = 280;
// transcript rows rendered at once; "Show earlier" adds another page
const ROWS_PAGE = 150;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
// A dragged project's data type, its own so the composer and the file drop
// never take it.
const PROJECT_DRAG = "application/x-cph-project";

type SessionPatch = Parameters<typeof window.hub.updateSession>[1];

// what a side conversation starts on, before it exists
type SidePicks = Pick<SessionSummary, "planId" | "model" | "effort" | "fullAccess" | "filter"> & { tools?: Tools };

// What a chat view sends from and where its errors show: the main chat's
// box and banner, or the side pane's own.
interface ChatBox {
  id: string;
  input: string;
  attachments: string[];
  setInput: (text: string) => void;
  setAttachments: (files: string[]) => void;
  // gives a message that could not go out back to the box it was typed in
  restore: (text: string, files: string[]) => void;
  // "" clears it
  setError: (error: string) => void;
}

// One chat: header, transcript, queued messages and the message box. The
// main area and the side pane both show chats through this, so a side
// conversation looks and works like any other chat.
function ChatView({
  session,
  status,
  events,
  busy,
  emptyText,
  headerExtra,
  plans,
  usage,
  branch,
  onBranchChange,
  busyMode,
  onBusyModeChange,
  input,
  onInputChange,
  attachments,
  onRemoveAttachment,
  onSend,
  onSteer,
  onQueue,
  onEditLast,
  onAnswer,
  onReplyToQuestion,
  onPatch,
  onQueueSendNow,
  onQueueRemove,
  showFilter,
  showTools
}: {
  session: SessionSummary;
  status: ChatStatus;
  events: EngineEvent[];
  busy: boolean;
  emptyText?: string;
  headerExtra?: JSX.Element;
  plans: PlanConfig[];
  usage: Record<string, PlanUsage>;
  branch?: { current: string; branches: string[] };
  onBranchChange: (b: string) => void;
  busyMode: "steer" | "queue";
  onBusyModeChange: (m: "steer" | "queue") => void;
  input: string;
  onInputChange: (v: string) => void;
  attachments: string[];
  onRemoveAttachment: (path: string) => void;
  onSend: () => void;
  // omitted while the chat cannot take a message mid-reply
  onSteer?: () => void;
  onQueue?: () => void;
  onEditLast: (next: string) => Promise<boolean>;
  onAnswer: (
    requestId: string,
    allow: boolean,
    always: boolean,
    answers?: Record<string, string>
  ) => Promise<AnswerResult>;
  // sends what is in the message box as the reply to a waiting question
  onReplyToQuestion?: (requestId: string) => void;
  onPatch: (patch: SessionPatch) => void;
  onQueueSendNow: (index: number) => void;
  onQueueRemove: (index: number) => void;
  showFilter: boolean;
  // lean chats are on: Claude chats get the Tools picker
  showTools: boolean;
}): JSX.Element {
  // The chat follows new text only while you are at the bottom. Scroll up
  // to read and it stays put; "Jump to latest" brings you back down.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  // Only your own scrolling (wheel, keys, a held pointer) lets go of the
  // bottom. The browser also moves the scroll position when the oldest
  // row drops off a long chat, and that must not count as scrolling up.
  const userScrollAtRef = useRef(0);
  const pointerHeldRef = useRef(false);
  useEffect(() => {
    const release = (): void => {
      pointerHeldRef.current = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);
  const markUserScroll = (): void => {
    userScrollAtRef.current = Date.now();
  };
  // long chats render their latest rows; older ones load on request
  const [shownItems, setShownItems] = useState(ROWS_PAGE);

  // also runs on every send, so your message and its reply stay in view
  const scrollToLatest = (): void => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setAwayFromBottom(false);
  };

  // opening a chat starts at its latest message
  useEffect(() => {
    stickRef.current = true;
    setAwayFromBottom(false);
    setShownItems(ROWS_PAGE);
    requestAnimationFrame(() => {
      const el = transcriptRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [session.id]);

  // new text in this chat (not other chats) keeps you at the bottom, but
  // only if you were already there; before paint, so no frame lands short
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, busy]);

  // the box shrinking or the queue list appearing keeps the bottom in view
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // only this chat's own events redo the grouping, not every redraw
  const merged = useMemo(() => mergeDeltas(events), [events]);
  const { items, todos } = useMemo(() => buildFlow(merged), [merged]);
  // Busy flips on before the next user echo arrives. A finished
  // turn must stay static during that gap and after the echo.
  const lastTurnBoundary = merged.findLastIndex((e) => e.kind === "user" || e.kind === "done");
  // Only the running reply can still take an answer; a request left
  // unanswered by an earlier reply stays closed while a later one runs.
  const answerable = (index: number): boolean => busy && index > lastTurnBoundary;
  // the question the running reply waits on; the message box answers it
  const openQuestion = items.findLast(
    (it): it is Extract<FlowItem, { type: "permission" }> =>
      it.type === "permission" && it.ev.tool === "AskUserQuestion" && !it.decision && answerable(it.index)
  );
  const replyToQuestion =
    openQuestion && onReplyToQuestion
      ? () => {
          scrollToLatest();
          onReplyToQuestion(openQuestion.ev.requestId);
        }
      : undefined;

  return (
    <>
      <header className="header">
        <div className="header-row">
          <span className="dot" style={{ background: session.color }} />
          <strong>{session.planLabel}</strong>
          <span className="cwd">{session.cwd}</span>
          <span className="header-spacer" />
          {STATUS_BADGE[status] ? (
            <span className={`run-badge ${status}`}>
              {status === "running" ? <span className="status-light running" /> : null}
              {STATUS_BADGE[status]}
            </span>
          ) : null}
          {headerExtra}
        </div>
      </header>
      <div
        className="transcript"
        ref={transcriptRef}
        onWheel={markUserScroll}
        onKeyDown={markUserScroll}
        onPointerDown={() => {
          pointerHeldRef.current = true;
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (atBottom) stickRef.current = true;
          else if (pointerHeldRef.current || Date.now() - userScrollAtRef.current < 500) stickRef.current = false;
          // the chat moved under you while you were at the bottom
          else if (stickRef.current) el.scrollTop = el.scrollHeight;
          if (stickRef.current === awayFromBottom) setAwayFromBottom(!stickRef.current);
        }}
      >
        {events.length === 0 && !busy ? (
          <div className="empty">{emptyText ?? "Send a message to start this chat."}</div>
        ) : (
          (() => {
            const lastUserIdx = merged.map((e) => e.kind).lastIndexOf("user");
            const showThinking = busy && isThinking(events);
            const lastContentIdx = merged.reduce(
              (acc, ev, i) =>
                ev.kind === "text" ||
                ev.kind === "tool" ||
                ev.kind === "tool_result" ||
                ev.kind === "thinking" ||
                ev.kind === "error"
                  ? i
                  : acc,
              -1
            );
            // something already shows activity: a live thought, a
            // running step, or a reply streaming in
            const lastItem = items[items.length - 1];
            const lastMerged = merged[merged.length - 1];
            const activityShown =
              (lastItem?.type === "thought" && Boolean(lastItem.ev.live)) ||
              (lastItem?.type === "permission" && !lastItem.decision) ||
              (lastItem?.type === "step" &&
                lastItem.view.expectsResult &&
                !lastItem.view.result) ||
              (lastItem?.type === "explore" &&
                lastItem.steps.some((v) => v.expectsResult && !v.result)) ||
              (lastMerged?.kind === "text" && Boolean(lastMerged.streaming));
            const showWorking = busy && !showThinking && !activityShown;
            const turnHasFiltered = new Map<number, string>();
            const turnOriginal = new Map<number, string>();
            const lastTextIndex = new Map<number, number>();
            let turn = 0;
            merged.forEach((ev, i) => {
              if (ev.kind === "user") turn += 1;
              if (ev.kind === "text") lastTextIndex.set(turn, i);
              if (ev.kind === "filtered") {
                turnHasFiltered.set(turn, ev.text);
                turnOriginal.set(turn, ev.original);
              }
            });
            const start = Math.max(0, items.length - shownItems);
            let renderTurn = items
              .slice(0, start)
              .filter((it) => it.type === "event" && it.ev.kind === "user").length;
            return (
              <>
                {todos ? <TodoPill state={todos} /> : null}
                {start > 0 ? (
                  <button className="show-earlier" onClick={() => setShownItems((n) => n + ROWS_PAGE)}>
                    Show earlier ({start} more)
                  </button>
                ) : null}
                {items.slice(start).map((item) => {
                  if (item.type === "permission" && item.ev.tool === "AskUserQuestion") {
                    return (
                      <QuestionCard
                        key={item.index}
                        item={item}
                        live={answerable(item.index)}
                        onAnswer={(answers) =>
                          onAnswer(item.ev.requestId, answers !== null, false, answers ?? undefined)
                        }
                      />
                    );
                  }
                  if (item.type === "permission") {
                    return (
                      <PermissionCard
                        key={item.index}
                        item={item}
                        live={answerable(item.index)}
                        onAnswer={(allow, always) => onAnswer(item.ev.requestId, allow, always)}
                      />
                    );
                  }
                  if (item.type === "thought") {
                    return (
                      <ThoughtRow
                        key={item.index}
                        text={item.ev.text}
                        ms={item.ev.ms}
                        live={Boolean(item.ev.live) && busy}
                        startedAt={item.ev.startedAt}
                      />
                    );
                  }
                  if (item.type === "explore") {
                    return <ExploreRow key={item.index} steps={item.steps} busy={busy} />;
                  }
                  if (item.type === "step") {
                    return <StepRow key={item.index} view={item.view} busy={busy} />;
                  }
                  const ev = item.ev;
                  const i = item.index;
                  if (ev.kind === "user") {
                    renderTurn += 1;
                    return (
                      <UserBubble
                        key={i}
                        text={ev.text}
                        replaced={ev.replaced}
                        effort={ev.effort}
                        onEdit={
                          i === lastUserIdx
                            ? async (next) => {
                                const ok = await onEditLast(next);
                                if (ok) scrollToLatest();
                                return ok;
                              }
                            : undefined
                        }
                      />
                    );
                  }
                  if (ev.kind === "text" && turnHasFiltered.has(renderTurn)) {
                    if (lastTextIndex.get(renderTurn) !== i) return null;
                    return (
                      <FilteredLine
                        key={i}
                        text={turnHasFiltered.get(renderTurn) as string}
                        original={turnOriginal.get(renderTurn) as string}
                      />
                    );
                  }
                  if (ev.kind === "filtered") return null;
                  // Completed messages always render in full. Only actual
                  // engine deltas stream, so opening a chat or sending again
                  // cannot replay a previously received reply.
                  if (ev.kind === "text" && ev.streaming && i === lastContentIdx && i > lastTurnBoundary && busy) {
                    return (
                      <div className="msg msg-text" key={i}>
                        <ChatMarkdown text={ev.text} />
                        <span className="stream-cursor" />
                      </div>
                    );
                  }
                  return <EventLine key={i} event={ev} />;
                })}
                {showThinking ? <ThinkingDots /> : null}
                {showWorking ? (
                  <div className="step working">
                    <Spinner />
                  </div>
                ) : null}
              </>
            );
          })()
        )}
      </div>
      {awayFromBottom ? (
        <div className="jump-anchor">
          <button className="jump-latest" onClick={scrollToLatest}>
            ↓ Jump to latest
          </button>
        </div>
      ) : null}
      <div className="composer-wrap">
        {session.queue.length > 0 ? (
          <div className="queue-list">
            {session.queue.map((q, qi) => (
              <div className="queue-item" key={qi}>
                <span className="queue-tag">
                  {qi === 0 && !session.running ? "On hold" : "Queued"}
                </span>
                <span className="queue-text" title={q}>
                  {q}
                </span>
                <button
                  className="mini-btn"
                  title="Send this now, interrupting the running reply"
                  onClick={() => {
                    scrollToLatest();
                    onQueueSendNow(qi);
                  }}
                >
                  Send now
                </button>
                <button
                  className="attach-x"
                  title="Remove from the queue"
                  onClick={() => onQueueRemove(qi)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <Composer
          plans={plans}
          planId={session.planId}
          onPlanChange={(id) => onPatch({ planId: id })}
          model={session.model}
          onModelChange={(m) => onPatch({ model: m })}
          effort={session.effort || session.defaultEffort || defaultEffort(session.planEngine)}
          onEffortChange={(e) => onPatch({ effort: e })}
          fullAccess={session.fullAccess}
          onFullAccessChange={(b) => onPatch({ fullAccess: b })}
          filter={session.filter}
          onFilterChange={showFilter ? (b) => onPatch({ filter: b }) : undefined}
          tools={session.tools}
          autoFull={session.autoFull}
          onToolsChange={showTools && session.planEngine === "claude" ? (t) => onPatch({ tools: t }) : undefined}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
          input={input}
          onInputChange={onInputChange}
          onSend={() => {
            if (input.trim()) scrollToLatest();
            onSend();
          }}
          busy={busy}
          onCancel={() => void window.hub.cancel(session.id)}
          onSteer={
            onSteer
              ? () => {
                  scrollToLatest();
                  onSteer();
                }
              : undefined
          }
          onQueue={
            onQueue
              ? () => {
                  scrollToLatest();
                  onQueue();
                }
              : undefined
          }
          onAnswerQuestion={replyToQuestion}
          busyMode={busyMode}
          onBusyModeChange={onBusyModeChange}
          usage={usage}
          disabled={busy}
          branch={branch}
          onBranchChange={onBranchChange}
        />
      </div>
    </>
  );
}

// Unsent text and attachments, per chat ("" is the new-task screen), kept
// in localStorage so a draft survives a restart.
interface Draft {
  text: string;
  attachments: string[];
}
const DRAFTS_KEY = "chatDrafts";
// the side pane's box, per chat it sits beside
const SIDE_DRAFTS_KEY = "sideDrafts";

function loadDrafts(key: string): Record<string, Draft> {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown;
    return saved && typeof saved === "object" ? (saved as Record<string, Draft>) : {};
  } catch {
    return {};
  }
}

function storeDrafts(key: string, drafts: Record<string, Draft>): void {
  localStorage.setItem(key, JSON.stringify(drafts));
}

const CHECK_LABEL: Record<BrowserCheck["kind"], string> = {
  captcha: "CAPTCHA",
  "bot-check": "Bot check",
  "sign-in": "Sign-in"
};

function checkSite(check: BrowserCheck): string {
  try {
    return new URL(check.url).hostname.replace(/^www\./, "");
  } catch {
    return check.title || "a page";
  }
}

export default function App() {
  const [plans, setPlans] = useState<PlanConfig[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, EngineEvent[]>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [banner, setBanner] = useState("");
  // pages in the chats' browser waiting on you (src/main/browserChecks.ts)
  const [browserChecks, setBrowserChecks] = useState<BrowserCheck[]>([]);
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<Array<{ path: string; name: string }>>([]);
  const [branchInfo, setBranchInfo] = useState<
    Record<string, { current: string; branches: string[] }>
  >({});
  const [plansOpen, setPlansOpen] = useState(false);
  // auth "login": a subscription with its own sign-in; "key": an API key
  // plan through Claude Code (Z.ai, OpenRouter)
  const [accountForm, setAccountForm] = useState<{
    label: string;
    engine: string;
    auth: "login" | "key";
    baseUrl: string;
    token: string;
    models: string;
    error: string;
  }>({ label: "", engine: "claude", auth: "login", baseUrl: "", token: "", models: "", error: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    label: string;
    baseUrl: string;
    token: string;
    models: string;
  }>({ label: "", baseUrl: "", token: "", models: "" });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [paneTabs, setPaneTabs] = useState<PaneTab[]>([]);
  // the tab showing, per chat ("" is the new-task screen)
  const [activePaneIds, setActivePaneIds] = useState<Record<string, string>>({});
  const [paneChooser, setPaneChooser] = useState(false);
  // Side conversations belong to the chat they were started beside (the
  // main process keeps the link). Unsent text and errors are per tab: a
  // side conversation's id, or new:<chat id> for one not started yet.
  const [sideDrafts, setSideDrafts] = useState<Record<string, Draft>>(() => loadDrafts(SIDE_DRAFTS_KEY));
  useEffect(() => storeDrafts(SIDE_DRAFTS_KEY, sideDrafts), [sideDrafts]);
  const [sideErrors, setSideErrors] = useState<Record<string, string>>({});
  // per chat: a new side conversation's tab is open, what it will start
  // on, and its first message is on its way out
  const [sideNewOpen, setSideNewOpen] = useState<Record<string, boolean>>({});
  const [sidePicks, setSidePicks] = useState<Record<string, SidePicks>>({});
  const [sideStarting, setSideStarting] = useState<Record<string, boolean>>({});

  // Draft config for the next new task, remembered between tasks.
  const [planId, setPlanId] = useState("");
  const [model, setModel] = useState("default");
  const [effort, setEffort] = useState("");
  const [fullAccess, setFullAccess] = useState(true);
  const [cwd, setCwd] = useState("");

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // files dropped on the side conversation go in its box, not the main one
  const dropOnSideRef = useRef<(paths: string[]) => void>(() => undefined);
  const [usageOpen, setUsageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({
    replyFilter: false,
    devBranch: false,
    zcodeProjects: false,
    leanChats: false,
    updateClis: false
  });
  // a newer build is installed; waiting = restart once no chat is working
  const [update, setUpdate] = useState<{ ready: boolean; waiting: boolean }>({ ready: false, waiting: false });
  const [usage, setUsage] = useState<Record<string, PlanUsage>>({});
  // Enter while a reply runs: redirect it now, or queue for after
  const [busyMode, setBusyMode] = useState<"steer" | "queue">(() =>
    localStorage.getItem("busyMode") === "queue" ? "queue" : "steer"
  );

  // What you type belongs to the chat you type it in. Switching chats keeps
  // it with that chat and shows the next chat's own draft, blank if it has
  // none; coming back brings it back.
  const draftsRef = useRef<Record<string, Draft> | null>(null);
  if (!draftsRef.current) draftsRef.current = loadDrafts(DRAFTS_KEY);
  // the chat whose draft the box shows; null until the first one loads
  const draftKeyRef = useRef<string | null>(null);
  // Before the switch below on purpose: when a send also changes chats (a
  // new task's first message), the emptied box clears the draft it left.
  useEffect(() => {
    const key = draftKeyRef.current;
    const drafts = draftsRef.current;
    if (key === null || !drafts) return;
    if (input || attachments.length > 0) drafts[key] = { text: input, attachments };
    else delete drafts[key];
    storeDrafts(DRAFTS_KEY, drafts);
  }, [input, attachments]);
  useEffect(() => {
    const key = activeId ?? "";
    if (key === draftKeyRef.current) return;
    draftKeyRef.current = key;
    const draft = draftsRef.current?.[key];
    setInput(draft?.text ?? "");
    setAttachments(draft?.attachments ?? []);
  }, [activeId]);
  // a message that could not go out returns to the chat it was typed in,
  // even if you have moved to another chat since
  const restoreDraft = (id: string, text: string, files: string[]): void => {
    if (draftKeyRef.current === id) {
      setInput(text);
      setAttachments(files);
    } else if (draftsRef.current) {
      draftsRef.current[id] = { text, attachments: files };
      storeDrafts(DRAFTS_KEY, draftsRef.current);
    }
  };

  const refreshSessions = useCallback(async (): Promise<SessionSummary[]> => {
    const list = await window.hub.listSessions();
    setSessions(list);
    return list;
  }, []);

  useEffect(() => {
    void window.hub.usage().then(setUsage);
    const offUsage = window.hub.onUsageUpdate((all) => setUsage({ ...all }));
    void window.hub.browserChecks().then(setBrowserChecks);
    const offChecks = window.hub.onBrowserChecks(setBrowserChecks);
    // a queued turn starting or a turn ending in the main process
    const offSessions = window.hub.onSessionsChanged(() => void refreshSessions());
    return () => {
      offUsage();
      offChecks();
      offSessions();
    };
  }, [refreshSessions]);

  // With the dev branch setting on, dev is the default branch: on startup
  // and after adding a project, the app creates a dev branch where missing
  // and checks it out. Otherwise this only reads each branch. A refusal
  // (uncommitted changes, detached worktrees) must not become a banner over
  // the whole app; the project's branch field still shows the truth.
  const ensureDevDefaults = useCallback(async (paths: string[]): Promise<void> => {
    const entries = await Promise.all(
      paths.map(async (p) => {
        try {
          const r = await window.hub.ensureDevBranch(p);
          if (r.error) console.warn(`git (${baseName(p)}): ${r.error.split("\n")[0]}`);
          return [p, r.branches] as const;
        } catch {
          return [p, { current: "", branches: [] }] as const;
        }
      })
    );
    const fresh: Record<string, { current: string; branches: string[] }> = Object.fromEntries(entries);
    setBranchInfo((prev) => {
      const merged = { ...prev };
      for (const path of Object.keys(fresh)) {
        const info = fresh[path];
        if (info.branches.length > 0 || !(prev[path]?.branches?.length > 0)) {
          merged[path] = info;
        }
      }
      return merged;
    });
  }, []);

  useEffect(() => {
    const bootstrap = async (): Promise<void> => {
      void window.hub.getSettings().then(setSettings).catch(() => undefined);
      EFFORT_DEFAULTS = await window.hub.effortDefaults();
      const ps = await window.hub.listPlans();
      setPlans(ps);
      const firstInstalled = ps.find((p) => p.installed);
      const start = firstInstalled ?? ps[0];
      if (start) {
        setPlanId(start.id);
        setModel(start.models?.[0] ?? "default");
        setEffort(defaultEffort(start.engine));
      }
      await refreshSessions();
      const projList = await window.hub.listProjects();
      setProjects(projList);
      await ensureDevDefaults(projList.map((p) => p.path));
    };
    void bootstrap();
    return window.hub.onSessionEvent(({ sessionId, event }) => {
      setTranscripts((prev) => {
        const cur = prev[sessionId] ?? [];
        // the first user message is shown optimistically at send time; its
        // echo must land on that bubble, not next to it
        if (event.kind === "user") {
          const last = cur[cur.length - 1];
          if (last?.kind === "user" && last.text === event.text) {
            // the echo carries the level Auto picked
            return event.effort ? { ...prev, [sessionId]: [...cur.slice(0, -1), event] } : prev;
          }
        }
        return { ...prev, [sessionId]: [...cur, event] };
      });
      // a new turn can start without a local send (steer restarts the
      // engine after the old turn's done), so the user echo re-marks busy
      if (event.kind === "user") {
        setBusy((prev) => ({ ...prev, [sessionId]: true }));
      }
      // a permission ask or answer flips the chat's light
      if (event.kind === "permission" || event.kind === "permission_decision") void refreshSessions();
      if (event.kind === "done") {
        setBusy((prev) => ({ ...prev, [sessionId]: false }));
        void refreshSessions();
      }
    });
  }, [refreshSessions]);

  useEffect(() => {
    if (!activeId || transcripts[activeId]) return;
    void window.hub.transcript(activeId).then((t) => {
      setTranscripts((prev) => {
        // never overwrite events that arrived live while the fetch was out
        const cur = prev[activeId];
        if (cur && cur.length > 0) return prev;
        return { ...prev, [activeId]: t };
      });
    });
  }, [activeId, transcripts]);

  // a clicked notification opens its chat; a side conversation's opens the
  // chat it belongs to, showing that side conversation
  useEffect(
    () =>
      window.hub.onOpenChat((id, sideId) => {
        setActiveId(id || null);
        if (sideId) setActivePaneIds((prev) => ({ ...prev, [id]: sideId }));
      }),
    []
  );
  useEffect(() => {
    void window.hub.updateStatus().then(setUpdate);
    return window.hub.onUpdateReady(() => setUpdate((u) => ({ ...u, ready: true })));
  }, []);

  // Drag and drop: any file or folder dropped anywhere in the window becomes
  // an attachment chip. Without the preventDefault calls Electron would
  // navigate the window to the dropped file instead.
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };
    const onDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent): void => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const paths = files
        .map((f) => window.hub.pathForFile(f))
        .filter((p) => Boolean(p));
      if (paths.length === 0) return;
      if (e.target instanceof Element && e.target.closest(".side-chat")) dropOnSideRef.current(paths);
      else setAttachments((prev) => [...new Set([...prev, ...paths])]);
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const busyOf = (id: string): boolean =>
    Boolean(sessions.find((s) => s.id === id)?.running || busy[id]);

  // A chat can run in a folder that is not in the projects sidebar; its
  // branch picker still needs live branch data. Same for the draft folder
  // on the new-task screen, since the sidebar no longer preloads branches.
  useEffect(() => {
    const paths = [activeSession?.cwd, cwd || ""].filter(
      (p): p is string => typeof p === "string" && p !== "" && !branchInfo[p]
    );
    if (paths.length === 0) return;
    void Promise.all(
      paths.map(async (p) => {
        try {
          const fresh = await window.hub.projectBranches(p);
          setBranchInfo((prev) => mergeBranchInfo(prev, p, fresh));
        } catch {
          // not a repo or a git hiccup: the picker just stays hidden
        }
      })
    );
  }, [activeSession, cwd, branchInfo]);

  const onPlanChange = (id: string): void => {
    const plan = plans.find((p) => p.id === id);
    setPlanId(id);
    setModel(plan?.models?.[0] ?? "default");
    setEffort(defaultEffort(plan?.engine ?? ""));
  };

  // Hitting a project (or its +) opens a brand-new chat right under that
  // project immediately, Zed-style: the session exists before the first
  // message, so the sidebar shows it from the first click.
  const startNewTask = (folder: string): void => {
    // the new chat opens with a blank box; the text you were typing stays
    // as the draft of the chat you left
    setCwd(folder);
    void (async () => {
      const res = await window.hub.createSession({
        planId,
        cwd: folder,
        model: model || "default",
        effort,
        fullAccess
      });
      if (res.error || !res.sessionId) {
        setBanner(res.error ?? "Could not start a chat");
        return;
      }
      const id = res.sessionId;
      setTranscripts((prev) => ({ ...prev, [id]: [] }));
      await refreshSessions();
      setActiveId(id);
      inputRef.current?.focus();
    })();
  };

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  // Attachments ride along as paths in the prompt: every engine can open
  // files by absolute path, whatever the type.
  const buildPrompt = (text: string, files: string[]): string => {
    if (files.length === 0) return text;
    return `${text}\n\nAttached files:\n${files.map((p) => `- ${p}`).join("\n")}`;
  };

  const patchSession = async (box: ChatBox, patch: SessionPatch): Promise<void> => {
    const { id } = box;
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const res = await window.hub.updateSession(id, patch);
    if (res.error || !res.summary) {
      box.setError(res.error ?? "Update failed");
      await refreshSessions();
      return;
    }
    const fresh = res.summary;
    setSessions((prev) => prev.map((s) => (s.id === fresh.id ? fresh : s)));
  };

  const sendDraft = async (): Promise<void> => {
    if (!planId || !input.trim()) return;
    const text = buildPrompt(input.trim(), attachments);
    setBanner("");
    const res = await window.hub.createSession({
      planId,
      cwd: cwd.trim(),
      model: model || "default",
      effort,
      fullAccess
    });
    if (res.error || !res.sessionId) {
      setBanner(res.error ?? "Could not create session");
      return;
    }
    const id = res.sessionId;
    // side conversations started on the new-task screen go with the chat
    // that screen just started
    await Promise.all(
      sessions.filter((s) => s.side && s.parentId === "").map((s) => window.hub.setSideParent(s.id, id))
    );
    setActivePaneIds((prev) => ({ ...prev, [id]: prev[""] }));
    // the new chat must be in the list before it becomes active, or the
    // first turn renders on the new-task screen with no bubble or dots
    await refreshSessions();
    setInput("");
    setAttachments([]);
    setActiveId(id);
    // show the sent message immediately; if the echo event races us, the
    // load effect below never overwrites a non-empty transcript
    setTranscripts((prev) => ({ ...prev, [id]: [{ kind: "user", text }] }));
    setBusy((prev) => ({ ...prev, [id]: true }));
    const sendRes = await window.hub.send(id, text);
    if (sendRes.error) {
      setBanner(sendRes.error);
      setBusy((prev) => ({ ...prev, [id]: false }));
    }
    // picks up the title the first message just gave it
    void refreshSessions();
  };

  const sendSession = async (box: ChatBox): Promise<void> => {
    const { id } = box;
    if (!box.input.trim() || busyOf(id)) return;
    const text = buildPrompt(box.input.trim(), box.attachments);
    box.setInput("");
    box.setAttachments([]);
    box.setError("");
    setBusy((prev) => ({ ...prev, [id]: true }));
    const res = await window.hub.send(id, text);
    if (res.error) {
      box.setError(res.error);
      setBusy((prev) => ({ ...prev, [id]: false }));
    }
    // a chat opened from a project's + is named by its first message
    void refreshSessions();
  };

  // Sends an edit of the latest message. The old bubble is struck out right
  // away; the new one arrives as the engine's echo of the next turn.
  const editLastMessage = async (box: ChatBox, next: string): Promise<boolean> => {
    const { id } = box;
    const res = await window.hub.editLast(id, next);
    if (res.error) {
      box.setError(res.error);
      return false;
    }
    box.setError("");
    setTranscripts((prev) => {
      const cur = prev[id] ?? [];
      const at = cur.map((e) => e.kind).lastIndexOf("user");
      // the new message may already have echoed in; strike the one before it
      const target = cur[at]?.kind === "user" && cur[at].text === next ? cur.map((e) => e.kind).lastIndexOf("user", at - 1) : at;
      if (target < 0) return prev;
      const copy = cur.slice();
      const old = copy[target];
      if (old.kind === "user") copy[target] = { ...old, replaced: true };
      return { ...prev, [id]: copy };
    });
    return true;
  };

  // Queue the typed message to go out after the running reply.
  const queueSession = async (box: ChatBox): Promise<void> => {
    if (!box.input.trim()) return;
    const typed = box.input;
    const attached = box.attachments;
    const text = buildPrompt(typed.trim(), attached);
    box.setInput("");
    box.setAttachments([]);
    const res = await window.hub.queueAdd(box.id, text);
    if (res.error) {
      box.setError(res.error);
      box.restore(typed, attached);
    }
    void refreshSessions();
  };

  // The card that sent the answer shows any error itself, so it can offer
  // the answer again.
  const answerPermission = async (
    box: ChatBox,
    requestId: string,
    allow: boolean,
    always: boolean,
    answers?: Record<string, string>
  ): Promise<{ error?: string; gone?: boolean }> => {
    let res: { error?: string; gone?: boolean };
    try {
      res = await window.hub.answerPermission(box.id, requestId, allow, always, answers);
    } catch (err) {
      res = { error: `The answer did not reach the chat: ${err instanceof Error ? err.message : String(err)}` };
    }
    void refreshSessions();
    return res;
  };

  // What is in the message box answers the question Claude is waiting on,
  // instead of restarting the reply or queueing behind it.
  const replyToQuestion = async (box: ChatBox, requestId: string): Promise<void> => {
    if (!box.input.trim()) return;
    const typed = box.input;
    const attached = box.attachments;
    box.setInput("");
    box.setAttachments([]);
    box.setError("");
    let res: { error?: string };
    try {
      const reply = buildPrompt(typed.trim(), attached);
      res = await window.hub.answerPermission(box.id, requestId, true, false, undefined, reply);
    } catch (err) {
      res = { error: `The answer did not reach the chat: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (res.error) {
      // give the answer back so nothing typed is lost
      box.setError(res.error);
      box.restore(typed, attached);
    }
    void refreshSessions();
  };

  const steerSession = async (box: ChatBox): Promise<void> => {
    if (!box.input.trim()) return;
    const typed = box.input;
    const attached = box.attachments;
    const text = buildPrompt(typed.trim(), attached);
    box.setInput("");
    box.setAttachments([]);
    box.setError("");
    const res = await window.hub.steer(box.id, text);
    if (res.error) {
      // give the message back so nothing typed is lost
      box.setError(res.error);
      box.restore(typed, attached);
    }
  };

  // Sidebar width is dragged from its right edge and remembered across
  // restarts in localStorage, like the collapsed projects below.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("sidebarWidth"));
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT;
  });

  const startSidebarResize = (e: { clientX: number; preventDefault(): void }): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let latest = startWidth;
    const onMove = (ev: MouseEvent): void => {
      latest = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
      setSidebarWidth(latest);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      localStorage.setItem("sidebarWidth", String(latest));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.classList.add("resizing");
  };

  // Projects whose chats are folded away in the sidebar; remembered across
  // restarts in localStorage since it is purely a view preference.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("collapsedProjects") ?? "[]") as unknown;
      return new Set(Array.isArray(saved) ? saved.filter((p) => typeof p === "string") : []);
    } catch {
      return new Set();
    }
  });

  const toggleCollapsed = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      localStorage.setItem("collapsedProjects", JSON.stringify([...next]));
      return next;
    });
  };

  // Projects keep the order they are dragged into by name; the Mac saves it.
  // The ⋯ menu (also right-click) moves one without dragging.
  const draggedProject = useRef<string | null>(null);
  const [projectDrop, setProjectDrop] = useState<{ path: string; after: boolean } | null>(null);
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!projectMenu) return;
    // capture phase: a chat row's ⋯ stops its mousedown, and should still
    // close this menu
    const close = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest(".project-menu, .project-more")) return;
      setProjectMenu(null);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [projectMenu]);

  // `to` is the project's index once moved
  const moveProject = async (path: string, to: number): Promise<void> => {
    const before = projects;
    const from = before.findIndex((p) => p.path === path);
    if (from === -1 || from === to) return;
    const next = before.filter((p) => p.path !== path);
    next.splice(to, 0, before[from]);
    setProjects(next);
    try {
      setProjects(await window.hub.reorderProjects(next.map((p) => p.path)));
    } catch {
      setProjects(before);
    }
  };

  // Where a dragged project lands when dropped on `target`, or null when
  // that leaves the order as it is.
  const projectDropIndex = (dragged: string, target: string, after: boolean): number | null => {
    const from = projects.findIndex((p) => p.path === dragged);
    const at = projects.filter((p) => p.path !== dragged).findIndex((p) => p.path === target);
    if (from === -1 || at === -1) return null;
    const to = after ? at + 1 : at;
    return to === from ? null : to;
  };

  // The top half of a project's name row drops above it; lower, below it.
  const dropsAfter = (e: ReactDragEvent<HTMLDivElement>): boolean => {
    const row = e.currentTarget.querySelector(".project-row")?.getBoundingClientRect();
    return row ? e.clientY > row.top + row.height / 2 : true;
  };

  // The ⋯ menu on a chat row (also right-click): rename, or delete with a
  // second click to confirm. Any click elsewhere closes it.
  const [chatMenu, setChatMenu] = useState<{ id: string; confirmDelete: boolean } | null>(null);
  useEffect(() => {
    if (!chatMenu) return;
    const close = (): void => setChatMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [chatMenu]);

  // live busy flags land before the summary refresh, so they win
  // (waiting on a permission answer outranks both)
  const statusOf = (s: SessionSummary): ChatStatus =>
    s.status === "waiting" ? "waiting" : s.running || busy[s.id] ? "running" : s.status;

  // Inline rename in the sidebar. Enter and click-away both save through the
  // input's blur, so a name is only ever committed once; Escape cancels.
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const renameCancelled = useRef(false);

  const commitRename = async (id: string, text: string): Promise<void> => {
    setRenaming(null);
    const title = text.trim();
    const current = sessions.find((s) => s.id === id)?.title ?? "";
    if (!title || title === current) return;
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    const res = await window.hub.renameSession(id, title);
    if (res.error) {
      setBanner(res.error);
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: current } : s)));
    }
  };

  const deleteChat = async (id: string): Promise<void> => {
    await window.hub.deleteChat(id);
    if (draftsRef.current?.[id]) {
      delete draftsRef.current[id];
      storeDrafts(DRAFTS_KEY, draftsRef.current);
    }
    // its side conversations go with it
    const sideTabs = [...sessions.filter((s) => s.parentId === id).map((s) => s.id), `new:${id}`];
    setSessions((prev) => prev.filter((s) => s.id !== id && s.parentId !== id));
    for (const tabId of sideTabs) setSideDraft(tabId, () => ({ text: "", attachments: [] }));
    if (activeId === id) setActiveId(null);
  };

  const addProject = async (): Promise<void> => {
    const res = await window.hub.addProject();
    setProjects(res.projects);
    await ensureDevDefaults(res.projects.map((p) => p.path));
  };

  // ZCode's projects come and go with their setting, and turning on the dev
  // branch puts every project on dev right away
  const changeSetting = async (patch: Partial<Settings>): Promise<void> => {
    setSettings(await window.hub.setSettings(patch));
    if (patch.zcodeProjects === undefined && !patch.devBranch) return;
    const list = await window.hub.listProjects();
    setProjects(list);
    await ensureDevDefaults(list.map((p) => p.path));
  };

  // while Accounts is open, coming back from a Terminal sign-in shows who
  // is logged in now
  useEffect(() => {
    if (!plansOpen) return;
    const refresh = (): void => {
      window.hub.listPlans().then(setPlans).catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [plansOpen]);

  const addAccount = async (): Promise<void> => {
    const models = accountForm.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const ownLogin = accountOwnLogin(accountForm);
    const res = await window.hub.createPlan({
      label: accountForm.label,
      engine: accountForm.engine,
      baseUrl: accountKeyed(accountForm) ? accountForm.baseUrl : "",
      token: accountKeyed(accountForm) ? accountForm.token : "",
      models,
      ownLogin
    });
    if (res.error || !res.plans) {
      setAccountForm((prev) => ({ ...prev, error: res.error ?? "Could not add account" }));
      return;
    }
    const added = res.plans.find((p) => p.engine === accountForm.engine && !plans.some((old) => old.id === p.id));
    setPlans(res.plans);
    setAccountForm({ label: "", engine: "claude", auth: "login", baseUrl: "", token: "", models: "", error: "" });
    // a new subscription's next step is always signing in
    if (ownLogin && added) {
      const login = await window.hub.loginPlan(added.id);
      if (login?.error) setBanner(`${added.label}: ${login.error}`);
    }
  };

  const startEdit = (p: PlanConfig): void => {
    setConfirmDeleteId(null);
    setEditingId(p.id);
    setEditForm({
      label: p.label,
      baseUrl: p.env?.ANTHROPIC_BASE_URL ?? "",
      token: p.env?.ANTHROPIC_AUTH_TOKEN ?? "",
      models: p.models && p.models[0] !== "default" ? p.models.join(", ") : ""
    });
  };

  const saveEdit = async (): Promise<void> => {
    if (!editingId) return;
    if (!editForm.label.trim()) {
      setBanner("Label is required");
      return;
    }
    const models = editForm.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const editing = plans.find((p) => p.id === editingId);
    const keyed = editing ? planKeyed(editing) : true;
    const res = await window.hub.updatePlan(editingId, {
      label: editForm.label,
      baseUrl: keyed ? editForm.baseUrl : undefined,
      token: keyed ? editForm.token : undefined,
      models
    });
    if (res.error || !res.plans) {
      setBanner(res.error ?? "Could not save account");
      return;
    }
    setPlans(res.plans);
    setEditingId(null);
  };

  const deleteAccount = async (id: string): Promise<void> => {
    const res = await window.hub.deletePlan(id);
    if (res.error || !res.plans) {
      setBanner(res.error ?? "Could not delete account");
      setConfirmDeleteId(null);
      return;
    }
    setPlans(res.plans);
    setConfirmDeleteId(null);
    if (editingId === id) setEditingId(null);
    // the deleted plan can no longer be the draft choice for new tasks
    if (planId === id) {
      const fallback = res.plans.find((p) => p.installed) ?? res.plans[0];
      if (fallback) {
        setPlanId(fallback.id);
        setModel(fallback.models?.[0] ?? "default");
        setEffort(defaultEffort(fallback.engine));
      } else {
        setPlanId("");
        setModel("default");
      }
    }
  };

  // Empty branch data (a git hiccup mid-run) must never overwrite a
  // populated list: that is how a repo with 200 branches ended up showing
  // "No matching branches" with the real current branch on the button.
  const mergeBranchInfo = (
    prev: Record<string, { current: string; branches: string[] }>,
    path: string,
    fresh: { current: string; branches: string[] }
  ): Record<string, { current: string; branches: string[] }> => {
    if (fresh.branches.length === 0 && (prev[path]?.branches?.length ?? 0) > 0) {
      return prev;
    }
    return { ...prev, [path]: fresh };
  };

  // ---- side pane: side conversations, terminal, browser tabs ----
  // The pane shows the open chat's own side conversations, never another
  // chat's, next to the terminal and browser tabs.
  const sideKey = activeId ?? "";
  const newTabId = `new:${sideKey}`;
  const shownTabs: ShownTab[] = [
    ...sessions
      .filter((s) => s.side && s.parentId === sideKey)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((session) => ({ id: session.id, kind: "chat" as const, session })),
    ...(sideNewOpen[sideKey] ? [{ id: newTabId, kind: "chat" as const, session: null }] : []),
    ...paneTabs
  ];
  const activePane = shownTabs.find((t) => t.id === activePaneIds[sideKey]) ?? shownTabs[0] ?? null;
  const showPane = (id: string): void => setActivePaneIds((prev) => ({ ...prev, [sideKey]: id }));

  const openPane = (kind: PaneKind): void => {
    setPaneChooser(false);
    // always a new side conversation; one not started yet is reused
    if (kind === "chat") {
      setSideNewOpen((prev) => ({ ...prev, [sideKey]: true }));
      showPane(newTabId);
      return;
    }
    const tab: PaneTab = {
      id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind
    };
    setPaneTabs((prev) => [...prev, tab]);
    showPane(tab.id);
  };

  // what a side tab's box holds; an emptied one is dropped
  const setSideDraft = (tabId: string, change: (d: Draft) => Draft): void =>
    setSideDrafts((prev) => {
      const next = change(prev[tabId] ?? { text: "", attachments: [] });
      const copy = { ...prev };
      if (next.text || next.attachments.length > 0) copy[tabId] = next;
      else delete copy[tabId];
      return copy;
    });

  // Closing a side conversation's tab ends it (a running reply stops):
  // side conversations never show in the chat list, so a closed one could
  // not be opened again. Closing one not started yet drops what was typed.
  const closePane = (tab: ShownTab): void => {
    if (tab.kind !== "chat") {
      setPaneTabs((prev) => prev.filter((t) => t.id !== tab.id));
      return;
    }
    setSideDraft(tab.id, () => ({ text: "", attachments: [] }));
    setSideErrors((prev) => ({ ...prev, [tab.id]: "" }));
    if (!tab.session) {
      setSideNewOpen((prev) => ({ ...prev, [sideKey]: false }));
      return;
    }
    const id = tab.session.id;
    setSessions((prev) => prev.filter((s) => s.id !== id));
    void window.hub.deleteChat(id);
    setTranscripts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const sideId = activePane?.kind === "chat" ? activePane.session?.id ?? null : null;

  // a side conversation from before a restart loads back in
  useEffect(() => {
    if (!sideId || transcripts[sideId]) return;
    void window.hub.transcript(sideId).then((t) => {
      setTranscripts((prev) => (prev[sideId]?.length ? prev : { ...prev, [sideId]: t }));
    });
  }, [sideId, transcripts]);

  // the main process skips notifications for the chats on screen: the open
  // chat, and the side conversation showing beside it
  useEffect(() => {
    void window.hub.setActiveChat(activeId, sideId);
  }, [activeId, sideId]);

  dropOnSideRef.current = (paths) => {
    if (activePane?.kind !== "chat") return;
    setSideDraft(activePane.id, (d) => ({ ...d, attachments: [...new Set([...d.attachments, ...paths])] }));
  };

  // Everything a side tab's box does stays with that tab, even if you
  // switch chats before a message goes out or comes back.
  const sideBoxFor = (tabId: string, id: string): ChatBox => {
    const draft = sideDrafts[tabId];
    return {
      id,
      input: draft?.text ?? "",
      attachments: draft?.attachments ?? [],
      setInput: (text) => setSideDraft(tabId, (d) => ({ ...d, text })),
      setAttachments: (files) => setSideDraft(tabId, (d) => ({ ...d, attachments: files })),
      restore: (text, files) => setSideDraft(tabId, () => ({ text, attachments: files })),
      setError: (error) => setSideErrors((prev) => ({ ...prev, [tabId]: error }))
    };
  };

  // Until its first message a new side conversation does not exist; it
  // shows as an empty chat on its chat's plan and folder (the new-task
  // screen's picks there), and the pickers change what it will start on.
  const sideCwd = activeSession?.cwd ?? cwd;
  const sidePicked: SidePicks =
    sidePicks[sideKey] ??
    (activeSession
      ? {
          planId: activeSession.planId,
          model: activeSession.model,
          effort: activeSession.effort,
          fullAccess: activeSession.fullAccess,
          filter: activeSession.filter
        }
      : { planId, model, effort, fullAccess, filter: true });
  const sidePlan = plans.find((p) => p.id === sidePicked.planId);
  const sideStart: SessionSummary = {
    id: "",
    planId: sidePicked.planId,
    planLabel: sidePlan?.label ?? "",
    planEngine: sidePlan?.engine ?? "claude",
    color: sidePlan?.color ?? "",
    cwd: sideCwd,
    model: sidePicked.model,
    effort: sidePicked.effort,
    fullAccess: sidePicked.fullAccess,
    filter: sidePicked.filter,
    tools: sidePicked.tools ?? "auto",
    autoFull: false,
    running: false,
    title: "",
    empty: true,
    status: "idle",
    queue: [],
    defaultEffort: "",
    side: true,
    parentId: sideKey,
    createdAt: 0
  };
  const pickSide = (patch: SessionPatch): void => {
    const key = sideKey;
    const plan = patch.planId !== undefined ? plans.find((p) => p.id === patch.planId) : undefined;
    // a new plan starts on its own first model and usual effort, as on the
    // new-task screen
    const reset = plan ? { model: plan.models?.[0] ?? "default", effort: defaultEffort(plan.engine) } : {};
    setSidePicks((prev) => ({ ...prev, [key]: { ...sidePicked, ...patch, ...reset } }));
  };

  const startSide = async (): Promise<void> => {
    const key = sideKey;
    const box = sideBoxFor(newTabId, "");
    if (!box.input.trim() || sideStarting[key]) return;
    const typed = box.input;
    const attached = box.attachments;
    const text = buildPrompt(typed.trim(), attached);
    box.setInput("");
    box.setAttachments([]);
    box.setError("");
    setSideStarting((prev) => ({ ...prev, [key]: true }));
    try {
      const created = await window.hub.createSession({
        planId: sidePicked.planId,
        cwd: sideCwd,
        model: sidePicked.model || "default",
        effort: sidePicked.effort,
        fullAccess: sidePicked.fullAccess,
        filter: sidePicked.filter,
        tools: sidePicked.tools,
        side: true,
        parentId: key
      });
      if (created.error || !created.sessionId) {
        box.setError(created.error ?? "Could not start the side conversation");
        box.restore(typed, attached);
        return;
      }
      const sid = created.sessionId;
      // show the message immediately, same as the main chat's first send
      setTranscripts((prev) => ({ ...prev, [sid]: [{ kind: "user", text }] }));
      setBusy((prev) => ({ ...prev, [sid]: true }));
      await refreshSessions();
      // the new tab becomes the side conversation's own
      setSideNewOpen((prev) => ({ ...prev, [key]: false }));
      setActivePaneIds((prev) => ({ ...prev, [key]: sid }));
      const res = await window.hub.send(sid, text);
      const error = res.error;
      if (error) {
        setSideErrors((prev) => ({ ...prev, [sid]: error }));
        setBusy((prev) => ({ ...prev, [sid]: false }));
      }
      void refreshSessions();
    } finally {
      setSideStarting((prev) => ({ ...prev, [key]: false }));
    }
  };

  const mainBox: ChatBox | null = activeId
    ? {
        id: activeId,
        input,
        attachments,
        setInput,
        setAttachments,
        restore: (text, files) => restoreDraft(activeId, text, files),
        setError: setBanner
      }
    : null;

  // the main chat and the side conversation show through the same view
  const renderChat = (session: SessionSummary, box: ChatBox, extra?: Partial<Parameters<typeof ChatView>[0]>): JSX.Element => (
    <ChatView
      key={session.id}
      session={session}
      status={statusOf(session)}
      events={transcripts[session.id] ?? []}
      busy={busyOf(session.id)}
      plans={plans}
      usage={usage}
      branch={branchInfo[session.cwd]}
      onBranchChange={(b) => void switchBranch(session.cwd, b)}
      busyMode={busyMode}
      onBusyModeChange={(m) => {
        setBusyMode(m);
        localStorage.setItem("busyMode", m);
      }}
      input={box.input}
      onInputChange={box.setInput}
      attachments={box.attachments}
      onRemoveAttachment={(path) => box.setAttachments(box.attachments.filter((p) => p !== path))}
      onSend={() => void sendSession(box)}
      onSteer={() => void steerSession(box)}
      onQueue={() => void queueSession(box)}
      onEditLast={(next) => editLastMessage(box, next)}
      onAnswer={(requestId, allow, always, answers) => answerPermission(box, requestId, allow, always, answers)}
      onReplyToQuestion={(requestId) => void replyToQuestion(box, requestId)}
      onPatch={(patch) => void patchSession(box, patch)}
      onQueueSendNow={(index) =>
        void window.hub.queueSendNow(box.id, index).then((r) => {
          if (r.error) box.setError(r.error);
          void refreshSessions();
        })
      }
      onQueueRemove={(index) => void window.hub.queueRemove(box.id, index).then(() => refreshSessions())}
      showFilter={settings.replyFilter}
      showTools={settings.leanChats}
      {...extra}
    />
  );

  const switchBranch = async (path: string, branch: string): Promise<void> => {
    const res = await window.hub.checkoutBranch(path, branch);
    if (res.error) setBanner(`git (${baseName(path)}): ${res.error.split("\n")[0]}`);
    setBranchInfo((prev) => mergeBranchInfo(prev, path, res.branches));
  };

  const q = search.trim().toLowerCase();
  // side-pane conversations live in the side pane, not the chat list
  const listed = sessions.filter((s) => !s.side);
  const filteredSessions = listed.filter((s) => {
    if (!q) return true;
    return [s.title, s.planLabel, s.model, s.cwd].some((v) => v.toLowerCase().includes(q));
  });

  // one chat row, used under its project and in search results
  const renderSessionItem = (s: SessionSummary): JSX.Element => (
    <div
      key={s.id}
      className={s.id === activeId ? "session-item active" : "session-item"}
      onContextMenu={(e) => {
        e.preventDefault();
        setChatMenu({ id: s.id, confirmDelete: false });
      }}
    >
      {renaming?.id === s.id ? (
        <div className="session-open">
          <StatusLight status={statusOf(s)} color={s.color} />
          <input
            className="session-rename"
            autoFocus
            value={renaming.text}
            maxLength={80}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenaming({ id: s.id, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                renameCancelled.current = true;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              if (renameCancelled.current) {
                renameCancelled.current = false;
                setRenaming(null);
                return;
              }
              void commitRename(s.id, e.currentTarget.value);
            }}
          />
        </div>
      ) : (
        <button
          className="session-open"
          onClick={() => setActiveId(s.id)}
          onDoubleClick={() => setRenaming({ id: s.id, text: s.title })}
        >
          <StatusLight status={statusOf(s)} color={s.color} />
          <span className="session-meta">
            <span className="session-title">{s.title || "New chat"}</span>
            <span className="session-sub">
              {s.planLabel} · {s.model}
              {statusOf(s) === "running" ? " · working" : ""}
              {statusOf(s) === "error" ? " · needs attention" : ""}
            </span>
          </span>
        </button>
      )}
      {renaming?.id === s.id ? null : (
        <button
          className={chatMenu?.id === s.id ? "session-more open" : "session-more"}
          title="Edit chat"
          // keep the outside-click listener from closing the menu this toggles
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setChatMenu(chatMenu?.id === s.id ? null : { id: s.id, confirmDelete: false });
          }}
        >
          ⋯
        </button>
      )}
      {chatMenu?.id === s.id ? (
        <div className="chat-menu" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              setChatMenu(null);
              setRenaming({ id: s.id, text: s.title });
            }}
          >
            Rename
          </button>
          <button
            className="danger"
            onClick={() => {
              if (!chatMenu.confirmDelete) {
                setChatMenu({ id: s.id, confirmDelete: true });
                return;
              }
              setChatMenu(null);
              void deleteChat(s.id);
            }}
          >
            {chatMenu.confirmDelete ? "Click again to delete" : "Delete chat"}
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="app">
      <div className="window-drag-region" aria-hidden="true" />
      {usageOpen ? (
        <UsageDashboard
          plans={plans.filter((p) => p.installed)}
          usage={usage}
          onRefresh={() => void window.hub.refreshUsage().then((all) => setUsage({ ...all }))}
          onClose={() => setUsageOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Settings</span>
              <button className="mini-btn" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>
            <label className="setting-row">
              <input
                type="checkbox"
                checked={settings.replyFilter}
                onChange={(e) => void changeSetting({ replyFilter: e.target.checked })}
              />
              <span>
                <strong>Plain-English filter</strong>
                Rewrites replies that use banned phrases (em dashes, "worth noting", and the like) with GLM Flash.
                Needs a Z.ai key plan in Accounts. Each chat can turn it off.
              </span>
            </label>
            <label className="setting-row">
              <input
                type="checkbox"
                checked={settings.devBranch}
                onChange={(e) => void changeSetting({ devBranch: e.target.checked })}
              />
              <span>
                <strong>Work on a dev branch</strong>
                Puts every project on a branch named dev, creating it where missing.
              </span>
            </label>
            <label className="setting-row">
              <input
                type="checkbox"
                checked={settings.zcodeProjects}
                onChange={(e) => void changeSetting({ zcodeProjects: e.target.checked })}
              />
              <span>
                <strong>Show ZCode's projects</strong>
                Lists ZCode's recent projects in the sidebar along with the ones added here.
              </span>
            </label>
            <label className="setting-row">
              <input
                type="checkbox"
                checked={settings.leanChats}
                onChange={(e) => void changeSetting({ leanChats: e.target.checked })}
              />
              <span>
                <strong>Lean Claude chats</strong>
                Claude chats start without your connectors, skills and slash commands, which cut plan use by about 30%
                in testing. On Auto, a chat turns them on when a message needs them. Each chat can also pick Lean or
                Full.
              </span>
            </label>
            <label className="setting-row">
              <input
                type="checkbox"
                checked={settings.updateClis}
                onChange={(e) => void changeSetting({ updateClis: e.target.checked })}
              />
              <span>
                <strong>Keep the CLIs up to date</strong>
                Checks Claude Code, Codex, Gemini and Kimi for new releases at launch and every six hours, and installs
                each one the way it was installed, once no chat on it is working. A new major version waits for you to
                click Update.
              </span>
            </label>
            <CliVersions />
          </div>
        </div>
      ) : null}
      {plansOpen ? (
        <div className="modal-overlay" onClick={() => setPlansOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Accounts</span>
              <button
                className="mini-btn"
                title="Check every plan's usage now"
                onClick={() => void window.hub.refreshUsage().then((all) => setUsage({ ...all }))}
              >
                Refresh usage
              </button>
              <button className="mini-btn" onClick={() => setPlansOpen(false)}>
                Close
              </button>
            </div>
            <div className="plans-hint">
              Log each plan in once. For Claude Max, type /usage inside a Claude
              session for the 5-hour and weekly limits. ChatGPT usage, credits,
              and resets come from its signed-in Codex account. When a plan runs dry
              mid-session, the app switches to the next plan automatically,
              another account of the same kind first. Each Claude or ChatGPT
              subscription you add signs in on its own and uses the same
              instructions, rules, skills and settings as your main account.
            </div>
            {plans.filter((p) => p.installed).length === 0 ? (
              <div className="side-empty">No installed plans</div>
            ) : (
              plans
                .filter((p) => p.installed)
                .map((p) => {
                  const tokenBuiltIn = Boolean(p.env?.ANTHROPIC_AUTH_TOKEN);
                  const loggedIn = tokenBuiltIn || p.loggedIn;
                  const editing = editingId === p.id;
                  const logIn = async (): Promise<void> => {
                    const res = await window.hub.loginPlan(p.id);
                    if (res?.error) setBanner(`${p.label}: ${res.error}`);
                  };
                  return (
                    <div className="usage-plan" key={p.id}>
                      <div className="usage-plan-head">
                        <span className="dot" style={{ background: p.color }} />
                        {p.label}
                        <span className="usage-actions">
                          {editing ? (
                            <span className="usage-note">editing</span>
                          ) : loggedIn ? (
                            <>
                              <span className="usage-note">
                                {tokenBuiltIn
                                  ? "token built in, no login needed"
                                  : p.email
                                    ? `Logged in as ${p.email}`
                                    : "Logged in"}
                              </span>
                              {p.ownLogin ? (
                                <button
                                  className="mini-btn"
                                  title="Sign this plan in to a different account"
                                  onClick={() => void logIn()}
                                >
                                  Log in again
                                </button>
                              ) : null}
                            </>
                          ) : (
                            <button className="mini-btn" onClick={() => void logIn()}>
                              Log in
                            </button>
                          )}
                          <button
                            className="mini-btn"
                            title="Edit this account"
                            disabled={editing}
                            onClick={() => startEdit(p)}
                          >
                            Edit
                          </button>
                          {confirmDeleteId === p.id ? (
                            <>
                              <button
                                className="mini-btn danger"
                                title="Delete this account for real"
                                onClick={() => void deleteAccount(p.id)}
                              >
                                Confirm delete
                              </button>
                              <button
                                className="mini-btn"
                                onClick={() => setConfirmDeleteId(null)}
                              >
                                Keep
                              </button>
                            </>
                          ) : (
                            <button
                              className="mini-btn"
                              title="Delete this account"
                              onClick={() => {
                                setEditingId(null);
                                setConfirmDeleteId(p.id);
                              }}
                            >
                              Delete
                            </button>
                          )}
                        </span>
                      </div>
                      <UsageBars usage={usage[p.id]} codex={p.engine === "codex"} />
                      {editing ? (
                        <div className="account-form edit-form">
                          <label className="form-field">
                            <span>Label</span>
                            <input
                              value={editForm.label}
                              onChange={(e) =>
                                setEditForm((prev) => ({ ...prev, label: e.target.value }))
                              }
                            />
                          </label>
                          {planKeyed(p) ? (
                            <>
                              <label className="form-field">
                                <span>API base URL</span>
                                <input
                                  value={editForm.baseUrl}
                                  placeholder="blank keeps the subscription login"
                                  onChange={(e) =>
                                    setEditForm((prev) => ({ ...prev, baseUrl: e.target.value }))
                                  }
                                />
                              </label>
                              <label className="form-field">
                                <span>API token</span>
                                <input
                                  value={editForm.token}
                                  placeholder="blank clears the token"
                                  onChange={(e) =>
                                    setEditForm((prev) => ({ ...prev, token: e.target.value }))
                                  }
                                />
                              </label>
                            </>
                          ) : null}
                          <label className="form-field">
                            <span>Models (comma separated, blank uses auto)</span>
                            <input
                              value={editForm.models}
                              onChange={(e) =>
                                setEditForm((prev) => ({ ...prev, models: e.target.value }))
                              }
                            />
                          </label>
                          <div className="form-actions">
                            <button className="mini-btn" onClick={() => void saveEdit()}>
                              Save
                            </button>
                            <button className="mini-btn" onClick={() => setEditingId(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })
            )}
            <div className="side-label" style={{ padding: 0 }}>
              Browser
            </div>
            <div className="plans-hint">
              Claude and ChatGPT chats browse in a Chrome of their own, the same
              one whichever account a chat runs on. Open it once and sign in to
              Google and any other sites with the account browser work should
              use; it keeps those logins. Files it downloads, PDFs included, go
              to their own folder rather than your Downloads.
              <div className="form-actions">
                <button
                  className="mini-btn"
                  onClick={() =>
                    void window.hub.openBrowser().then((res) => {
                      if (res?.error) setBanner(res.error);
                    })
                  }
                >
                  Open the chats' browser
                </button>
                <button
                  className="mini-btn"
                  onClick={() =>
                    void window.hub.openBrowserDownloads().then((res) => {
                      if (res.error) setBanner(res.error);
                    })
                  }
                >
                  Its downloads
                </button>
              </div>
            </div>
            <div className="side-label" style={{ padding: 0 }}>
              Add an account
            </div>
            <div className="account-form">
              <label className="form-field">
                <span>Label (optional)</span>
                <input
                  value={accountForm.label}
                  onChange={(e) => setAccountForm((p) => ({ ...p, label: e.target.value }))}
                  placeholder={
                    accountKeyed(accountForm)
                      ? "for example OpenRouter keys"
                      : accountForm.engine === "codex"
                        ? "for example ChatGPT (work)"
                        : accountForm.engine === "claude"
                          ? "for example Claude Max (work)"
                          : "a name for this plan"
                  }
                />
              </label>
              <label className="form-field">
                <span>Engine</span>
                <select
                  value={accountForm.engine}
                  onChange={(e) => setAccountForm((p) => ({ ...p, engine: e.target.value }))}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">ChatGPT (Codex)</option>
                  <option value="kimi">Kimi</option>
                  <option value="gemini">Gemini</option>
                  <option value="opencode">opencode</option>
                </select>
              </label>
              {accountForm.engine === "claude" ? (
                <label className="form-field">
                  <span>Sign in with</span>
                  <select
                    value={accountForm.auth}
                    onChange={(e) =>
                      setAccountForm((p) => ({ ...p, auth: e.target.value === "key" ? "key" : "login" }))
                    }
                  >
                    <option value="login">A Claude subscription (Pro or Max)</option>
                    <option value="key">An API key (Z.ai, OpenRouter)</option>
                  </select>
                </label>
              ) : null}
              {accountOwnLogin(accountForm) ? (
                <div className="plans-hint">
                  Terminal opens to sign in once you add it. It shares your
                  instructions, rules, skills and settings
                  {accountForm.engine === "claude" ? " and your Claude chats and memory" : ""} with
                  your main account.
                </div>
              ) : null}
              {accountKeyed(accountForm) ? (
                <>
                  <label className="form-field">
                    <span>API base URL</span>
                    <input
                      value={accountForm.baseUrl}
                      onChange={(e) => setAccountForm((p) => ({ ...p, baseUrl: e.target.value }))}
                      placeholder="https://api.example.com/api/anthropic"
                    />
                  </label>
                  <label className="form-field">
                    <span>API token (stored in plans.json)</span>
                    <input
                      type="password"
                      value={accountForm.token}
                      onChange={(e) => setAccountForm((p) => ({ ...p, token: e.target.value }))}
                      placeholder="paste the token"
                    />
                  </label>
                </>
              ) : null}
              <label className="form-field">
                <span>Models (comma separated, optional)</span>
                <input
                  value={accountForm.models}
                  onChange={(e) => setAccountForm((p) => ({ ...p, models: e.target.value }))}
                  placeholder="model-a, model-b"
                />
              </label>
              {accountForm.error ? (
                <div className="account-error">{accountForm.error}</div>
              ) : null}
              <button
                className="primary"
                onClick={() => void addAccount()}
              >
                {accountOwnLogin(accountForm) ? "Add and sign in" : "Add account"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {dragOver ? (
        <div className="drop-overlay">
          <div className="drop-hint">Drop files to attach</div>
        </div>
      ) : null}
      <aside className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
        <div className="brand">
          <img className="brand-mark" src={markUrl} alt="" />
          Civly Coding Platform
        </div>

        <div className="sidebar-actions">
          <button
            className="usage-btn"
            onClick={() => {
              setPlansOpen(true);
              // re-read login state, the CLIs may have finished logging in since
              window.hub.listPlans().then(setPlans).catch(() => undefined);
              void window.hub.refreshUsage().then((all) => setUsage({ ...all }));
            }}
          >
            Accounts
          </button>
          <button className="usage-btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button
            className="usage-btn"
            onClick={() => {
              setUsageOpen(true);
              void window.hub.refreshUsage().then((all) => setUsage({ ...all }));
            }}
          >
            Usage
          </button>
        </div>

        <input
          className="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search chats"
        />

        <div className="side-scroll">
          {q ? (
            <>
              <div className="side-label">Matching chats</div>
              <div className="sessions">
                {filteredSessions.length === 0 ? (
                  <div className="side-empty">No matching chats</div>
                ) : (
                  filteredSessions.map((s) => renderSessionItem(s))
                )}
              </div>
            </>
          ) : null}

          <div className="side-head">
            <div className="side-label">Projects</div>
            <button
              className="side-plus"
              title="Add a project folder"
              onClick={() => void addProject()}
            >
              +
            </button>
          </div>
          <div className="projects">
            {projects.length === 0 ? (
              <div className="side-empty">No projects yet</div>
            ) : (
              projects.map((p, i) => {
                const mine = listed.filter((s) => s.cwd === p.path);
                const isCollapsed = collapsed.has(p.path);
                const drop = projectDrop?.path === p.path ? (projectDrop.after ? " drop-after" : " drop-before") : "";
                const moves = [
                  { label: "Move to top", to: 0, show: i > 0 },
                  { label: "Move up", to: i - 1, show: i > 1 },
                  { label: "Move down", to: i + 1, show: i < projects.length - 1 }
                ].filter((m) => m.show);
                return (
                  <div
                    key={p.path}
                    className={`project-item${drop}`}
                    title={p.path}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes(PROJECT_DRAG)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      // the data itself is unreadable until the drop
                      const dragged = draggedProject.current;
                      const after = dropsAfter(e);
                      const next =
                        dragged && projectDropIndex(dragged, p.path, after) !== null ? { path: p.path, after } : null;
                      if (next?.path !== projectDrop?.path || next?.after !== projectDrop?.after) setProjectDrop(next);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setProjectDrop(null);
                    }}
                    onDrop={(e) => {
                      const dragged = e.dataTransfer.getData(PROJECT_DRAG);
                      if (!dragged) return;
                      e.preventDefault();
                      draggedProject.current = null;
                      setProjectDrop(null);
                      const to = projectDropIndex(dragged, p.path, dropsAfter(e));
                      if (to !== null) void moveProject(dragged, to);
                    }}
                  >
                    <div
                      className="project-row"
                      onContextMenu={(e) => {
                        if (moves.length === 0) return;
                        e.preventDefault();
                        setProjectMenu(p.path);
                      }}
                    >
                      <button
                        className="project-toggle"
                        title={isCollapsed ? "Show chats" : "Hide chats"}
                        disabled={mine.length === 0}
                        onClick={() => toggleCollapsed(p.path)}
                      >
                        {mine.length === 0 ? "" : isCollapsed ? "▸" : "▾"}
                      </button>
                      <button
                        className="project-open"
                        draggable
                        onDragStart={(e) => {
                          draggedProject.current = p.path;
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData(PROJECT_DRAG, p.path);
                        }}
                        onDragEnd={() => {
                          draggedProject.current = null;
                          setProjectDrop(null);
                        }}
                        onClick={() => startNewTask(p.path)}
                      >
                        {p.name}
                        {isCollapsed && mine.length > 0 ? (
                          <span className="project-count">{mine.length}</span>
                        ) : null}
                      </button>
                      <span className="project-actions">
                        {moves.length > 0 ? (
                          <button
                            className={projectMenu === p.path ? "project-more open" : "project-more"}
                            title="Move project"
                            onClick={() => setProjectMenu(projectMenu === p.path ? null : p.path)}
                          >
                            ⋯
                          </button>
                        ) : null}
                        <button
                          className="side-plus"
                          title="New session in this folder"
                          onClick={() => startNewTask(p.path)}
                        >
                          +
                        </button>
                      </span>
                      {projectMenu === p.path ? (
                        <div className="chat-menu project-menu">
                          {moves.map((m) => (
                            <button
                              key={m.label}
                              onClick={() => {
                                setProjectMenu(null);
                                void moveProject(p.path, m.to);
                              }}
                            >
                              {m.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {mine.length > 0 && !isCollapsed ? (
                      <div className="project-sessions">
                        {mine.map((s) => renderSessionItem(s))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
            {(() => {
              const known = new Set(projects.map((p) => p.path));
              const others = listed.filter((s) => !known.has(s.cwd));
              if (others.length === 0) return null;
              return (
                <>
                  <div className="side-label" style={{ padding: 0 }}>
                    Other chats
                  </div>
                  <div className="sessions">{others.map((s) => renderSessionItem(s))}</div>
                </>
              );
            })()}
          </div>
        </div>
      </aside>
      <div
        className="sidebar-resizer"
        title="Drag to resize, double-click to reset"
        onMouseDown={startSidebarResize}
        onDoubleClick={() => {
          setSidebarWidth(SIDEBAR_DEFAULT);
          localStorage.setItem("sidebarWidth", String(SIDEBAR_DEFAULT));
        }}
      />

      <main className="main">
        <div className="main-col">
        {update.ready ? (
          <div className="update-bar">
            {update.waiting ? (
              <>
                <span>New version installed. Restarting as soon as no chat is working.</span>
                <button
                  className="mini-btn"
                  onClick={() => void window.hub.cancelRestart().then((r) => setUpdate((u) => ({ ...u, ...r })))}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span>
                  New version installed.
                  {sessions.some((s) => statusOf(s) === "running" || statusOf(s) === "waiting")
                    ? " A chat is working; restarting now would stop it."
                    : ""}
                </span>
                <button
                  className="send-btn"
                  onClick={() => void window.hub.restartForUpdate(true).then((r) => setUpdate((u) => ({ ...u, ...r })))}
                >
                  Restart when chats finish
                </button>
                <button className="mini-btn" onClick={() => void window.hub.restartForUpdate(false)}>
                  Restart now
                </button>
              </>
            )}
          </div>
        ) : null}
        {banner ? <div className="banner">{banner}</div> : null}
        {browserChecks.length ? (
          <div className="update-bar browser-checks">
            <span>
              The chats' browser needs you. The chat carries on once you are past{" "}
              {browserChecks.length === 1 ? "it" : "them"}.
            </span>
            {browserChecks.map((c) => (
              <button
                key={c.targetId}
                className="mini-btn"
                title={c.title}
                onClick={() =>
                  void window.hub.showBrowserCheck(c.targetId).then((res) => {
                    if (res.error) setBanner(res.error);
                  })
                }
              >
                {CHECK_LABEL[c.kind]} on {checkSite(c)}
              </button>
            ))}
          </div>
        ) : null}
        {activeSession && mainBox ? (
          renderChat(activeSession, mainBox)
        ) : (
          <div className="newtask-wrap">
            <div className="welcome">
              <div className="welcome-title">New task</div>
              <div className="welcome-sub">
                Click a project on the left (or its +) to start a task in that
                folder, then pick a plan and access level below.
              </div>
              <div className="welcome-folder" title={cwd || "home folder"}>
                Folder: {cwd || "home folder"}
              </div>
            </div>
            <Composer
              plans={plans}
              planId={planId}
              onPlanChange={onPlanChange}
              model={model}
              onModelChange={setModel}
              effort={effort}
              onEffortChange={setEffort}
              fullAccess={fullAccess}
              onFullAccessChange={setFullAccess}
              attachments={attachments}
              onRemoveAttachment={removeAttachment}
              input={input}
              onInputChange={setInput}
              onSend={() => void sendDraft()}
              busy={false}
              onCancel={() => undefined}
              usage={usage}
              branch={cwd ? branchInfo[cwd] : undefined}
              onBranchChange={(b) => void switchBranch(cwd, b)}
            />
          </div>
        )}
        </div>
        {shownTabs.length > 0 ? (
          <aside className="side-pane">
            <div className="pane-tabs">
              {shownTabs.map((t) => (
                <button
                  key={t.id}
                  className={t.id === activePane?.id ? "pane-tab active" : "pane-tab"}
                  title={t.kind === "chat" ? t.session?.title || "New side conversation" : undefined}
                  onClick={() => showPane(t.id)}
                >
                  {t.kind === "chat" && t.session ? (
                    <StatusLight status={statusOf(t.session)} color={t.session.color} />
                  ) : null}
                  <span className="pane-tab-label">
                    {t.kind === "chat"
                      ? t.session?.title || "New conversation"
                      : t.kind === "terminal"
                        ? "Terminal"
                        : "Browser"}
                  </span>
                  <span
                    className="pane-tab-x"
                    title={t.kind === "chat" && t.session ? "End this side conversation" : "Close tab"}
                    onClick={(e) => {
                      e.stopPropagation();
                      closePane(t);
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
            <div className="pane-body">
              {(() => {
                const tab = activePane;
                if (!tab) return null;
                if (tab.kind !== "chat") {
                  return tab.kind === "terminal" ? (
                    <TerminalPane id={tab.id} cwd={activeSession?.cwd ?? cwd ?? ""} />
                  ) : (
                    <BrowserPane />
                  );
                }
                const error = sideErrors[tab.id] ?? "";
                return (
                  <div className="side-chat">
                    {error ? <div className="banner">{error}</div> : null}
                    {tab.session
                      ? renderChat(tab.session, sideBoxFor(tab.id, tab.session.id))
                      : renderChat(sideStart, sideBoxFor(tab.id, ""), {
                          busy: Boolean(sideStarting[sideKey]),
                          emptyText: activeId
                            ? "Ask a quick question without adding it to this chat. It reads this chat as it goes and stays with it; close its tab to end it."
                            : "Ask a quick question without starting a main chat.",
                          onSend: () => void startSide(),
                          onSteer: undefined,
                          onQueue: undefined,
                          onPatch: pickSide
                        })}
                  </div>
                );
              })()}
            </div>
          </aside>
        ) : null}
        <button
          className={shownTabs.length > 0 ? "pane-add shifted" : "pane-add"}
          title="Open a side tab"
          onClick={() => setPaneChooser(true)}
        >
          +
        </button>
        {paneChooser ? (
          <div className="modal-overlay" onClick={() => setPaneChooser(false)}>
            <div className="modal pane-chooser" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <span>Open tab</span>
                <button className="mini-btn" onClick={() => setPaneChooser(false)}>
                  Close
                </button>
              </div>
              <button className="pane-choice" onClick={() => openPane("chat")}>
                Side conversation
                <span className="pane-choice-sub">
                  a new quick chat that stays with this one
                </span>
              </button>
              <button className="pane-choice" onClick={() => openPane("terminal")}>
                Terminal
                <span className="pane-choice-sub">a shell in this folder</span>
              </button>
              <button className="pane-choice" onClick={() => openPane("browser")}>
                Browser
                <span className="pane-choice-sub">look something up inline</span>
              </button>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
