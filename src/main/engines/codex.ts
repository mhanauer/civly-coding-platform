import type { EngineAdapter, EngineEvent, SendOptions } from "./types.ts";
import { unwrapShell } from "./steps.ts";

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  exit_code?: number | null;
  aggregated_output?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  query?: string;
  server?: string;
  tool?: string;
  items?: Array<{ text?: string; completed?: boolean }>;
}

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  message?: string;
}

const OUTPUT_LIMIT = 1500;

// A factory: the streamed-length counter is per run, so two codex chats
// running at once never cut each other's replies.
export function codexAdapter(): EngineAdapter {
  // item.updated carries the agent message as growing text; remember how
  // much was already streamed so each update emits only the new part.
  let streamedLen = 0;
  // commands announced on item.started, so completion only adds the result
  const started = new Set<string>();

  const emitStep = (item: CodexItem, emit: (e: EngineEvent) => void): void => {
    if (item.type === "command_execution" && item.command) {
      const command = unwrapShell(item.command);
      emit({
        kind: "tool",
        name: "bash",
        id: item.id,
        detail: command.slice(0, 140),
        step: { type: "terminal", label: "Terminal", target: command }
      });
    } else if (item.type === "file_change") {
      for (const change of item.changes ?? []) {
        emit({
          kind: "tool",
          name: "edit",
          step: {
            type: "edit",
            label: change.kind === "add" ? "Write" : change.kind === "delete" ? "Delete" : "Edit",
            target: change.path
          }
        });
      }
    } else if (item.type === "web_search") {
      emit({ kind: "tool", name: "web_search", step: { type: "web", label: "Web search", target: item.query } });
    } else if (item.type === "mcp_tool_call") {
      emit({
        kind: "tool",
        name: `${item.server ?? "mcp"}.${item.tool ?? ""}`,
        step: { type: "other", label: `${item.server ?? "mcp"} · ${item.tool ?? ""}` }
      });
    } else if (item.type === "todo_list") {
      emit({
        kind: "tool",
        name: "todo_list",
        step: {
          type: "todo",
          label: "Plan",
          todos: (item.items ?? []).map((t) => ({
            text: t.text ?? "",
            status: t.completed ? "completed" : "pending"
          }))
        }
      });
    }
  };

  return {
    kind: "codex",

    buildArgs(opts: SendOptions): string[] {
      const args = opts.resumeId
        ? ["exec", "resume", opts.resumeId, "--json"]
        : ["exec", "--json"];
      args.push("--skip-git-repo-check");
      if (opts.model) args.push("-m", opts.model);
      if (opts.effort) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
      if (opts.fullAccess) args.push("--dangerously-bypass-approvals-and-sandbox");
      // the chats' own browser; the values are TOML, which takes JSON strings
      // and arrays as they are. The first run can wait on the package download.
      if (opts.browser) {
        args.push(
          "-c",
          `mcp_servers.browser.command=${JSON.stringify(opts.browser.command)}`,
          "-c",
          `mcp_servers.browser.args=${JSON.stringify(opts.browser.args)}`,
          "-c",
          "mcp_servers.browser.startup_timeout_sec=60"
        );
      }
      args.push(opts.prompt);
      return args;
    },

    parseLine(line: string, emit: (e: EngineEvent) => void): void {
      let obj: CodexLine;
      try {
        obj = JSON.parse(line) as CodexLine;
      } catch {
        return;
      }

      if (obj.type === "thread.started" && obj.thread_id) {
        emit({ kind: "session", engineSessionId: obj.thread_id });
        return;
      }

      if (obj.type === "error") {
        emit({ kind: "error", text: obj.message ?? "codex engine error" });
        return;
      }

      const item = obj.item;
      if (!item) {
        if (obj.type === "turn.completed") emit({ kind: "done", ok: true });
        else if (obj.type === "turn.failed") emit({ kind: "done", ok: false });
        return;
      }

      // a command shows the moment it starts, like ZCode's live terminal rows
      if (obj.type === "item.started" && item.type === "command_execution" && item.id) {
        started.add(item.id);
        emitStep(item, emit);
        return;
      }

      if (obj.type === "item.updated" && item.type === "agent_message" && item.text) {
        if (item.text.length > streamedLen) {
          emit({ kind: "delta", text: item.text.slice(streamedLen) });
          streamedLen = item.text.length;
        }
        return;
      }

      if (obj.type !== "item.completed") return;
      if (item.type === "agent_message" && item.text) {
        streamedLen = 0;
        emit({ kind: "text", text: item.text });
      } else if (item.type === "reasoning" && item.text) {
        emit({ kind: "thinking", text: item.text });
      } else if (item.type === "command_execution") {
        if (!item.id || !started.has(item.id)) emitStep(item, emit);
        emit({
          kind: "tool_result",
          id: item.id,
          ok: item.exit_code === 0 || item.exit_code === undefined,
          output: (item.aggregated_output ?? "").slice(0, OUTPUT_LIMIT)
        });
      } else {
        emitStep(item, emit);
      }
    }
  };
}
