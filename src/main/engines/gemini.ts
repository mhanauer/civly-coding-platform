import type { EngineAdapter, EngineEvent, SendOptions } from "./types.ts";

// The gemini CLI prints plain text, not a JSON stream. The adapter buffers
// stdout lines for the run and flushes them as a single text event, so a
// multi-line answer renders as one message instead of many fragments.
export function geminiAdapter(): EngineAdapter {
  let buffer: string[] = [];
  return {
    kind: "gemini",
    beginRun(): void {
      buffer = [];
    },
    buildArgs(opts: SendOptions): string[] {
      const args = ["-p", opts.prompt];
      if (opts.model && opts.model !== "default") args.push("--model", opts.model);
      return args;
    },
    parseLine(line: string): void {
      buffer.push(line);
    },
    endRun(emit: (e: EngineEvent) => void): void {
      const text = buffer.join("\n").trim();
      if (text) emit({ kind: "text", text });
      buffer = [];
    }
  };
}
