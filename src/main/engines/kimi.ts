import type { EngineAdapter, EngineEvent, SendOptions } from "./types.ts";
import { classifyTool } from "./steps.ts";

interface ContentBlock {
  type?: string;
  text?: string;
  think?: string;
  name?: string;
  input?: unknown;
}

// Kimi reports tool calls in the OpenAI shape: a function name plus its
// arguments as a JSON string, answered by a role "tool" line.
interface KimiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface KimiLine {
  role?: string;
  type?: string;
  content?: string | ContentBlock[];
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
  session_id?: string;
  message?: string;
}

function snippet(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

export const kimiAdapter = (): EngineAdapter => ({
  kind: "kimi",

  buildArgs(opts: SendOptions): string[] {
    const args = ["-p", opts.prompt, "--output-format", "stream-json"];
    if (opts.model && opts.model !== "default") args.push("-m", opts.model);
    if (opts.resumeId) args.push("-r", opts.resumeId);
    return args;
  },

  parseLine(line: string, emit: (e: EngineEvent) => void): void {
    let obj: KimiLine;
    try {
      obj = JSON.parse(line) as KimiLine;
    } catch {
      if (line.trim()) emit({ kind: "status", text: snippet(line, 120) });
      return;
    }

    if (obj.type === "session.resume_hint" && obj.session_id) {
      emit({ kind: "session", engineSessionId: obj.session_id });
      return;
    }

    if (obj.type === "error") {
      emit({ kind: "error", text: obj.message ?? "kimi engine error" });
      return;
    }

    if (obj.role === "tool" && obj.tool_call_id) {
      const out = typeof obj.content === "string" ? obj.content : "";
      emit({ kind: "tool_result", id: obj.tool_call_id, ok: true, output: out.slice(0, 1500) });
      return;
    }

    if (obj.role === "assistant" && (obj.content || obj.tool_calls)) {
      if (typeof obj.content === "string") {
        if (obj.content) emit({ kind: "text", text: obj.content });
      } else if (obj.content) {
        for (const block of obj.content) {
          if (block.type === "think" && block.think) {
            emit({ kind: "thinking", text: block.think });
          } else if (block.type === "text" && block.text) {
            emit({ kind: "text", text: block.text });
          } else if (block.type === "tool_use" && block.name) {
            emit({
              kind: "tool",
              name: block.name,
              detail: snippet(block.input),
              step: classifyTool(block.name, block.input)
            });
          }
        }
      }
      for (const call of obj.tool_calls ?? []) {
        const name = call.function?.name;
        if (!name) continue;
        let input: unknown = {};
        try {
          input = JSON.parse(call.function?.arguments ?? "{}");
        } catch {
          // a malformed argument string still shows the tool by name
        }
        emit({ kind: "tool", name, id: call.id, detail: snippet(input), step: classifyTool(name, input) });
      }
      return;
    }

    if (obj.role === "user" && obj.content) {
      if (typeof obj.content !== "string") {
        for (const block of obj.content) {
          if (block.type === "tool_result") {
            emit({ kind: "tool_result", ok: true, output: (block.text ?? "").slice(0, 1500) });
          }
        }
      }
    }
  }
});
