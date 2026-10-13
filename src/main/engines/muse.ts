import type { EngineAdapter, EngineEvent, SendOptions, ToolStep } from "./types.ts";
import { unwrapShell } from "./steps.ts";

// Meta's Muse Code CLI. `muse exec --json` writes one record per line; what
// the chat needs is in payload_type and payload.
interface MuseLine {
  stream?: { kind?: string; id?: string };
  payload_type?: string;
  payload?: {
    text?: string;
    reason?: unknown;
    call_id?: string;
    edit_facts?: { tool_name?: string; path?: string; added?: number; removed?: number };
    correlation_facts?: { tool_name?: string; outcome?: string };
    facts?: { items?: Array<{ text?: string; status?: string }> };
    event?: { kind?: string; task_kind?: string; task_id?: string; reason?: string };
  };
}

// A bash result's text is a JSON report of the command
interface ShellReport {
  command?: string;
  description?: string;
  exit_code?: number;
  output?: string;
}

const OUTPUT_LIMIT = 1500;

const EDIT_LABELS: Record<string, string> = {
  write_file: "Write",
  edit_file: "Edit",
  multi_edit: "Edit",
  apply_patch: "Edit",
  delete_file: "Delete"
};

function reasonText(reason: unknown): string {
  if (!reason) return "";
  if (typeof reason === "string") return reason;
  if (typeof reason === "object") {
    const r = reason as { message?: unknown; kind?: unknown };
    if (typeof r.message === "string") return r.message;
    if (typeof r.kind === "string") return r.kind;
  }
  return JSON.stringify(reason);
}

function parseReport(text: string): ShellReport | null {
  try {
    const report = JSON.parse(text) as ShellReport;
    return report && typeof report === "object" ? report : null;
  } catch {
    return null;
  }
}

// A factory: the streamed text and the failure seen so far are per run.
export function museAdapter(): EngineAdapter {
  let sessionSent = false;
  // reply text streamed since the last tool, and the last message closed
  let streamed = "";
  let lastText = "";
  // why a model call failed, for a failed run that gives no reason itself
  const modelTasks = new Set<string>();
  let modelFailure = "";

  const closeText = (emit: (e: EngineEvent) => void): void => {
    if (!streamed) return;
    emit({ kind: "text", text: streamed });
    lastText = streamed;
    streamed = "";
  };

  const toolStep = (p: NonNullable<MuseLine["payload"]>): { name: string; step: ToolStep; ok: boolean; output: string } => {
    const name = p.correlation_facts?.tool_name ?? p.edit_facts?.tool_name ?? "tool";
    const text = p.text ?? "";
    const ok = p.correlation_facts?.outcome !== "failure";
    if (name === "bash" || name === "shell") {
      const report = parseReport(text);
      const command = unwrapShell(report?.command ?? "");
      return {
        name,
        step: { type: "terminal", label: "Terminal", target: command, note: report?.description },
        ok: ok && (report?.exit_code ?? 0) === 0,
        output: report?.output ?? text
      };
    }
    if (p.edit_facts?.path) {
      return {
        name,
        step: {
          type: "edit",
          label: EDIT_LABELS[name] ?? "Edit",
          target: p.edit_facts.path,
          added: p.edit_facts.added,
          removed: p.edit_facts.removed
        },
        ok,
        output: text
      };
    }
    if (/read|view|list_dir|glob|grep|search_files|find/.test(name)) {
      return { name, step: { type: "explore", label: /grep|search|find|glob/.test(name) ? "Search" : "Read", search: /grep|search|find|glob/.test(name) }, ok, output: text };
    }
    if (/web/.test(name)) {
      return { name, step: { type: "web", label: /fetch/.test(name) ? "Fetch" : "Web search" }, ok, output: text };
    }
    if (/agent|subagent|spawn/.test(name)) return { name, step: { type: "agent", label: "Agent" }, ok, output: text };
    return { name, step: { type: "other", label: name.replace(/^mcp__/, "").replace(/__/g, " · ") }, ok, output: text };
  };

  return {
    kind: "muse",

    buildArgs(opts: SendOptions): string[] {
      // contributor mode lets Meta train on the chat; it stays off
      const args = ["exec", "--json", "--contributor-mode", "off"];
      if (opts.model && opts.model !== "default") args.push("--model", opts.model);
      if (opts.effort) args.push("--reasoning-effort", opts.effort);
      if (opts.resumeId) args.push("--session-id", opts.resumeId);
      // a headless run cannot answer approvals: full access drops the
      // sandbox too, otherwise the sandbox stays and approvals are skipped
      if (opts.fullAccess) args.push("--yolo");
      else args.push("--disable-approval", "--trust-workspace");
      if (opts.browser) {
        args.push(
          "-c",
          `mcpServers.browser=${JSON.stringify({ transport: "stdio", command: opts.browser.command, args: opts.browser.args, mode: "optional" })}`
        );
      }
      args.push(opts.prompt);
      return args;
    },

    parseLine(line: string, emit: (e: EngineEvent) => void): void {
      let obj: MuseLine;
      try {
        obj = JSON.parse(line) as MuseLine;
      } catch {
        return;
      }
      if (!sessionSent && obj.stream?.kind === "session" && obj.stream.id) {
        sessionSent = true;
        emit({ kind: "session", engineSessionId: obj.stream.id });
      }
      const p = obj.payload ?? {};
      switch (obj.payload_type) {
        case "run.output.delta":
          if (p.text) {
            streamed += p.text;
            emit({ kind: "delta", text: p.text });
          }
          return;
        case "todo.snapshot.updated": {
          closeText(emit);
          const todos = (p.facts?.items ?? [])
            .filter((t) => t.text)
            .map((t) => ({ text: t.text ?? "", status: t.status ?? "pending" }));
          emit({ kind: "tool", name: "write_todos", step: { type: "todo", label: "Plan", todos } });
          return;
        }
        case "tool.result": {
          const name = p.correlation_facts?.tool_name;
          // the todo snapshot above already shows the list
          if (name === "write_todos") return;
          closeText(emit);
          const tool = toolStep(p);
          emit({ kind: "tool", name: tool.name, id: p.call_id, detail: tool.step.target?.slice(0, 140), step: tool.step });
          emit({ kind: "tool_result", id: p.call_id, ok: tool.ok, output: tool.output.slice(0, OUTPUT_LIMIT) });
          return;
        }
        // only a task's proposal names its kind
        case "task.lifecycle.proposed":
          if (p.event?.task_id && /^model\./.test(p.event.task_kind ?? "")) modelTasks.add(p.event.task_id);
          return;
        case "task.lifecycle.failed":
          if (p.event?.reason && modelTasks.has(p.event.task_id ?? "")) modelFailure = p.event.reason;
          return;
        case "run.terminal.completed": {
          const final = p.text ?? "";
          if (streamed && final.startsWith(streamed)) {
            emit({ kind: "text", text: final });
            streamed = "";
          } else {
            closeText(emit);
            if (final && final !== lastText) emit({ kind: "text", text: final });
          }
          emit({ kind: "done", ok: true });
          return;
        }
        case "run.terminal.failed":
        case "run.terminal.cancelled": {
          closeText(emit);
          const why = reasonText(p.reason) || modelFailure;
          if (obj.payload_type === "run.terminal.failed") emit({ kind: "error", text: why || "Muse Code stopped with an error" });
          emit({ kind: "done", ok: false, summary: why || undefined });
          return;
        }
      }
    }
  };
}
