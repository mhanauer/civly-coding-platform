import type { EngineEvent } from "./engines/types.ts";

// Retry only after Codex has exhausted its own reconnect attempts. A
// reconnect notice during an otherwise successful turn is not a failure.
export function codexRoutingTimedOut(events: readonly EngineEvent[]): boolean {
  const done = [...events].reverse().find((event) => event.kind === "done");
  return done?.kind === "done" && !done.ok && events.some(
    (event) => event.kind === "error" && event.text.trim() === "workspace routing discovery timed out"
  );
}
