import type { EngineEvent } from "./engines/types.ts";
import { latestAttempt } from "./limitFallback.ts";

export type ChatStatus = "idle" | "running" | "waiting" | "background" | "error" | "done";

export const STOPPED = "Stopped";

// Background reports describe a live run. They must not be restored as a
// wait after a restart or outrank a question that needs an answer now.
export function chatStatus(s: {
  running: boolean;
  turnActive?: boolean;
  settling?: boolean;
  pending: { size: number };
  background?: Extract<EngineEvent, { kind: "background" }>;
  transcript: EngineEvent[];
}): ChatStatus {
  if (s.running || s.turnActive || s.settling) {
    if (s.pending.size > 0) return "waiting";
    if (s.running && s.background?.idle && s.background.tasks.length > 0) return "background";
    return "running";
  }
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
