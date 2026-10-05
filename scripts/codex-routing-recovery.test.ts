import assert from "node:assert/strict";
import { test } from "node:test";
import { codexRoutingTimedOut } from "../src/main/codexRoutingRecovery.ts";
import { codexAdapter } from "../src/main/engines/codex.ts";
import type { EngineEvent } from "../src/main/engines/types.ts";

test("reconnect notices do not become errors, but the final timeout does", () => {
  const events: EngineEvent[] = [];
  const adapter = codexAdapter();
  const emit = (event: EngineEvent): void => { events.push(event); };
  adapter.parseLine(JSON.stringify({ type: "error", message: "Reconnecting... 2/5 (workspace routing discovery timed out)" }), emit);
  assert.equal(events[0]?.kind, "status");
  adapter.parseLine(JSON.stringify({ type: "error", message: "workspace routing discovery timed out" }), emit);
  adapter.parseLine(JSON.stringify({ type: "turn.failed" }), emit);
  assert.deepEqual(events.slice(1), [
    { kind: "error", text: "workspace routing discovery timed out" },
    { kind: "done", ok: false }
  ]);
  assert.equal(codexRoutingTimedOut(events), true);
});

test("a recovered connection or another failure does not trigger routing recovery", () => {
  assert.equal(codexRoutingTimedOut([
    { kind: "status", text: "Reconnecting... 2/5 (workspace routing discovery timed out)" },
    { kind: "done", ok: true }
  ]), false);
  assert.equal(codexRoutingTimedOut([
    { kind: "error", text: "workspace routing discovery timed out" },
    { kind: "done", ok: true }
  ]), false);
  assert.equal(codexRoutingTimedOut([
    { kind: "error", text: "another error" },
    { kind: "done", ok: false }
  ]), false);
});
