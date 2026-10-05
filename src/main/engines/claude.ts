import { randomUUID } from "node:crypto";
import type { EngineAdapter, EngineEvent, SendOptions, TokenCount } from "./types.ts";
import { classifyTool } from "./steps.ts";
import { denyMessage } from "./claudeDeny.ts";
import { isLimitError } from "../limitFallback.ts";

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface ControlRequest {
  subtype?: string;
  tool_name?: string;
  display_name?: string;
  input?: Record<string, unknown>;
  description?: string;
  permission_suggestions?: Array<{ type?: string }>;
}

interface RateLimitInfo {
  status?: string;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)"
};

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  request_id?: string;
  request?: ControlRequest;
  rate_limit_info?: RateLimitInfo;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  // on a result: set when it answers something other than the message
  // sent (a background job's notice); user_message_uuids lists the
  // messages it does answer
  origin?: { kind?: string };
  user_message_uuids?: string[];
  // command_lifecycle lines: a sent message's progress
  command_uuid?: string;
  state?: string;
  // background_tasks_changed: every background task still running
  tasks?: Array<{ task_type?: string }>;
  // init: the MCP servers this run has and whether each connected
  mcp_servers?: Array<{ name?: string; status?: string }>;
  // api_retry: why a request failed and how long until the next try
  error?: string;
  error_status?: number | null;
  retry_delay_ms?: number;
  permission_denials?: Array<{ tool_name?: string; tool_use_id?: string; tool_input?: Record<string, unknown> }>;
  // on a result: tokens per model, background helpers' included, and their
  // price at API list rates
  modelUsage?: Record<string, ModelUsage>;
  total_cost_usd?: number;
  message?: { content?: ContentBlock[] | string };
  event?: {
    type?: string;
    content_block?: { type?: string };
    delta?: { type?: string; text?: string; thinking?: string };
  };
}

function snippet(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

// tool output kept per step; enough to see what happened, not a log dump
const OUTPUT_LIMIT = 1500;

// A run's tokens across every model it used; undefined when the result
// carries none (older CLI builds)
function resultTokens(models: Record<string, ModelUsage> | undefined): TokenCount | undefined {
  const all = Object.values(models ?? {});
  if (all.length === 0) return undefined;
  const sum = (pick: (m: ModelUsage) => number | undefined): number => all.reduce((n, m) => n + (pick(m) ?? 0), 0);
  return {
    input: sum((m) => m.inputTokens) + sum((m) => m.cacheReadInputTokens) + sum((m) => m.cacheCreationInputTokens),
    output: sum((m) => m.outputTokens)
  };
}

function resultText(block: ContentBlock): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p.text ?? "").join("\n");
  return block.text ?? "";
}

// A factory: timing state is per run, so parallel chats never share it.
export function claudeAdapter(): EngineAdapter {
  let thinkingStart = 0;
  // requests you answered in the chat; a "no" there is your call, not a
  // blocked tool, so it is left out of the needs-permission errors
  const asked = new Set<string>();
  const askKey = (tool?: string, input?: unknown): string => `${tool}:${JSON.stringify(input ?? {})}`;
  // requests still waiting on you, by request id
  const open = new Set<string>();
  // failed tool results by tool id: a blocked call's result says whether a
  // safety hook or the deny list stopped it
  const failed = new Map<string, string>();
  // the chat's folder: its .claude settings hold the project deny rules
  let cwd = "";
  // Claude Code refuses every permission request and question once stdin
  // closes ("Stream closed"), so stdin stays open until the message sent
  // this run is answered and no background agent can come back to ask.
  // A result alone is not enough: a resumed chat first reports a result for
  // the notice about a background job the last run stopped, before it reads
  // your message at all.
  const promptId = randomUUID();
  let promptDone = false;
  // background agents running; Claude Code waits for these after stdin
  // closes and picks the turn back up when each reports in. Background
  // shells are left out: Claude Code stops those when stdin closes.
  let agents = 0;
  // the last thing seen was a result, with no work since
  let settled = false;

  return {
    kind: "claude",

    buildArgs(opts: SendOptions): string[] {
      cwd = opts.cwd;
      // the prompt goes in on stdin (initialInput) so stdin can stay open
      // for permission answers
      const args = [
        "-p",
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // without this, headless runs return Claude's reasoning blank; with
        // it the API streams a summary (GLM plans send their full text either
        // way). Verified on Claude Max, Z.ai, and OpenRouter.
        "--thinking-display",
        "summarized"
      ];
      if (opts.model) args.push("--model", opts.model);
      if (opts.effort) args.push("--effort", opts.effort);
      if (opts.fullAccess) args.push("--dangerously-skip-permissions");
      if (opts.resumeId) args.push("--resume", opts.resumeId);
      // the chats' own browser, whichever account this is. Claude in Chrome
      // stays off (it is on by default in ~/.claude.json): it reaches only a
      // Chrome signed in to this account's claude.ai login.
      if (opts.browser) args.push("--mcp-config", JSON.stringify({ mcpServers: { browser: opts.browser } }));
      args.push("--no-chrome");
      // a lean chat keeps only the servers given here, and no skills or
      // slash commands; their lists ride along with every step otherwise
      if (opts.lean) args.push("--strict-mcp-config", "--disable-slash-commands");
      return args;
    },

    initialInput(opts: SendOptions): string {
      // the id comes back on the result that answers this message
      return JSON.stringify({ type: "user", uuid: promptId, message: { role: "user", content: opts.prompt } });
    },

    // A question's answers ride in updatedInput.answers, keyed by question
    // text, or updatedInput.response for a reply typed instead of a pick;
    // that is where Claude Code reads them back from.
    permissionResponse(requestId, allow, input, alwaysRules): string {
      open.delete(requestId);
      const skipped = Array.isArray(input?.questions);
      const response = allow
        ? { behavior: "allow", updatedInput: input ?? {}, ...(alwaysRules?.length ? { updatedPermissions: alwaysRules } : {}) }
        : {
            behavior: "deny",
            message: skipped
              ? "The user skipped these questions in the Civly Coding Platform."
              : "The user denied this in the Civly Coding Platform."
          };
      return JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response }
      });
    },

    parseLine(line: string, emit: (e: EngineEvent) => void): void {
      let obj: StreamLine;
      try {
        obj = JSON.parse(line) as StreamLine;
      } catch {
        return;
      }

      if (obj.type === "assistant" || obj.type === "user" || obj.type === "stream_event" || obj.type === "control_request") {
        settled = false;
      }

      if (obj.type === "command_lifecycle") {
        if (obj.command_uuid === promptId && obj.state !== "queued" && obj.state !== "started") promptDone = true;
        return;
      }

      if (obj.type === "control_request" && obj.request_id && obj.request?.subtype === "can_use_tool") {
        const req = obj.request;
        const tool = req.tool_name ?? "a tool";
        asked.add(askKey(req.tool_name, req.input));
        open.add(obj.request_id);
        emit({
          kind: "permission",
          requestId: obj.request_id,
          tool,
          input: req.input,
          description: req.description,
          step: classifyTool(tool, req.input),
          suggestions: (req.permission_suggestions ?? []).filter((s) => s.type === "addRules")
        });
        return;
      }

      // Claude Code stopped waiting on a request (the call was interrupted,
      // or settled some other way). An answer sent now would go nowhere, so
      // the chat closes the request instead of offering it.
      if (obj.type === "control_cancel_request" && obj.request_id && open.has(obj.request_id)) {
        open.delete(obj.request_id);
        emit({ kind: "permission_decision", requestId: obj.request_id, allowed: false, withdrawn: true });
        return;
      }

      if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
        const info = obj.rate_limit_info;
        const windows = Object.entries(info.unifiedWindows ?? {}).map(([key, w]) => ({
          label: WINDOW_LABELS[key] ?? key.replace(/_/g, " "),
          usedPct: Math.round((w.utilization ?? 0) * 100),
          resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined
        }));
        emit({ kind: "usage", windows, limited: info.status === "rejected" });
        return;
      }

      if (obj.type === "stream_event") {
        const ev = obj.event;
        if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking") {
          thinkingStart = Date.now();
          emit({ kind: "thinking_delta", text: "", startedAt: thinkingStart });
        } else if (ev?.type === "content_block_delta") {
          if (ev.delta?.type === "thinking_delta") {
            if (ev.delta.thinking) emit({ kind: "thinking_delta", text: ev.delta.thinking });
          } else if (ev.delta?.text) {
            // partial-message chunks: the reply streams in as it is written
            emit({ kind: "delta", text: ev.delta.text });
          }
        }
        return;
      }

      if (obj.type === "system") {
        if (obj.subtype === "init" && obj.session_id) {
          const servers = (obj.mcp_servers ?? []).filter((s) => s.status === "connected" && s.name).map((s) => s.name as string);
          emit({ kind: "session", engineSessionId: obj.session_id, ...(obj.mcp_servers ? { servers } : {}) });
        }
        // Claude Code can wait out a usage limit instead of failing: it
        // retries at the reset and says so here. A wait that long means the
        // plan is out, and the chat moves on (index.ts) rather than sit idle.
        // Short waits are ordinary rate-limit backoff.
        if (
          obj.subtype === "api_retry" &&
          (obj.error === "rate_limit" || obj.error_status === 429) &&
          (obj.retry_delay_ms ?? 0) >= 60_000
        ) {
          emit({ kind: "usage", windows: [], limited: true });
        }
        if (obj.subtype === "background_tasks_changed" && Array.isArray(obj.tasks)) {
          const running = obj.tasks.filter((t) => t.task_type !== "local_bash").length;
          // an agent that just finished brings its own turn; wait for its result
          if (running < agents) settled = false;
          agents = running;
        }
        return;
      }

      if (obj.type === "assistant" && obj.message?.content) {
        const content = obj.message.content;
        const blocks = Array.isArray(content) ? content : [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            emit({ kind: "text", text: block.text });
          } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            const ms = thinkingStart ? Date.now() - thinkingStart : undefined;
            thinkingStart = 0;
            emit({ kind: "thinking", text: block.thinking ?? "", ms });
          } else if (block.type === "tool_use" && block.name) {
            emit({
              kind: "tool",
              name: block.name,
              id: block.id,
              detail: snippet(block.input),
              step: classifyTool(block.name, block.input)
            });
          }
        }
        return;
      }

      if (obj.type === "user" && obj.message?.content) {
        const content = obj.message.content;
        const blocks = Array.isArray(content) ? content : [];
        for (const block of blocks) {
          if (block.type === "tool_result") {
            if (block.is_error && block.tool_use_id) failed.set(block.tool_use_id, resultText(block));
            emit({
              kind: "tool_result",
              id: block.tool_use_id,
              ok: !block.is_error,
              output: resultText(block).slice(0, OUTPUT_LIMIT)
            });
          }
        }
        return;
      }

      if (obj.type === "result") {
        // a blocked tool does not fail the turn in the engine's eyes, but the
        // work did not happen: surface it so the chat shows it needs you.
        // Anything that needs approval comes to the chat as a request, so a
        // denial nobody was asked about is Claude Code's own settings: a
        // deny rule (in your settings or the project's; the message names
        // which), or a PreToolUse safety hook (its reason is the end of the
        // blocked call's result). Full access overrides neither. The end of
        // a long command stays in view, since that is often what matched.
        for (const d of obj.permission_denials ?? []) {
          if (asked.has(askKey(d.tool_name, d.tool_input))) continue;
          const input = d.tool_input ?? {};
          const raw = String(input.command ?? input.file_path ?? input.path ?? input.url ?? "").replace(/\s+/g, " ");
          const what = `${d.tool_name ?? "a tool"}${raw ? ` (${raw.length > 200 ? `${raw.slice(0, 90)} … ${raw.slice(-90)}` : raw})` : ""}`;
          const why = (d.tool_use_id && failed.get(d.tool_use_id)) || "";
          const hookReason = /hook error/i.test(why) ? (why.split("]: ").pop() ?? "").trim() : "";
          emit({
            kind: "error",
            text: /hook error/i.test(why)
              ? `Blocked by a safety hook in your Claude Code settings: ${what}.${hookReason ? ` The hook says: ${hookReason.slice(0, 200)}` : ""} Full access does not override it.`
              : /stream closed/i.test(why)
                ? `${d.tool_name === "AskUserQuestion" ? "Claude's question" : `The request to use ${what}`} never reached you: this reply had already stopped taking answers. Send your message again to retry.`
                : denyMessage(cwd, d.tool_name ?? "", input, what)
          });
        }
        if (!obj.origin || obj.user_message_uuids?.includes(promptId)) promptDone = true;
        settled = true;
        // The turn failed on the plan's limit. Claude Code stays open while
        // a background agent or command runs, and those are on the same
        // plan, so the chat moves on (index.ts) instead of waiting for them.
        if (obj.is_error && obj.result && isLimitError(obj.result)) emit({ kind: "usage", windows: [], limited: true });
        emit({
          kind: "done",
          ok: !obj.is_error,
          summary: obj.result ? snippet(obj.result, 300) : undefined,
          tokens: resultTokens(obj.modelUsage),
          costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined
        });
      }
    },

    inputDone(): boolean {
      return promptDone && agents === 0 && settled;
    }
  };
}
