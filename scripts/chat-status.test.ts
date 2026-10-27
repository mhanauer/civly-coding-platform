import assert from "node:assert/strict";
import { test } from "node:test";
import { chatStatus, STOPPED } from "../src/main/chatStatus.ts";
import { claudeAdapter } from "../src/main/engines/claude.ts";
import type { EngineEvent } from "../src/main/engines/types.ts";

const state = () => ({
  running: true,
  turnActive: true,
  settling: false,
  pending: new Map<string, unknown>(),
  background: undefined as Extract<EngineEvent, { kind: "background" }> | undefined,
  transcript: [{ kind: "user", text: "Deploy this" }] as EngineEvent[]
});
const task = { id: "build", type: "local_bash", description: "Wait for the dev build", startedAt: 0 };

test("a real Claude result changes active work to a background wait, then back when the work resumes", () => {
  const session = state();
  const adapter = claudeAdapter();
  const feed = (value: unknown) => adapter.parseLine(JSON.stringify(value), (event) => {
    if (event.kind === "background") session.background = event;
    else if (event.kind !== "done") session.transcript.push(event);
  });
  assert.equal(chatStatus(session), "running");
  feed({ type: "system", subtype: "background_tasks_changed", tasks: [
    { task_id: task.id, task_type: task.type, description: task.description }
  ] });
  assert.equal(chatStatus(session), "running", "a background task alone does not mean the reply has ended");
  feed({ type: "result", subtype: "success", is_error: false, result: "The build is queued." });
  assert.equal(chatStatus(session), "background");
  feed({ type: "assistant", message: { content: [{ type: "text", text: "Checking the build" }] } });
  assert.equal(chatStatus(session), "running");
  feed({ type: "result", subtype: "success", is_error: false, result: "Still queued." });
  assert.equal(chatStatus(session), "background");
  feed({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  assert.equal(chatStatus(session), "running");
  session.running = session.turnActive = false;
  session.transcript.push({ kind: "done", ok: true });
  assert.equal(chatStatus(session), "done");
});

test("unanswered requests outrank background work until every request is settled", () => {
  const session = state();
  session.background = { kind: "background", idle: true, tasks: [task] };
  session.pending.set("question", {});
  session.pending.set("permission", {});
  assert.equal(chatStatus(session), "waiting");
  session.pending.delete("question");
  assert.equal(chatStatus(session), "waiting");
  session.pending.delete("permission");
  assert.equal(chatStatus(session), "background");
  session.background = { kind: "background", idle: false, tasks: [task] };
  assert.equal(chatStatus(session), "running");
});

test("finished and stopped chats ignore stale live wait data", () => {
  const session = state();
  session.running = session.turnActive = false;
  session.background = { kind: "background", idle: true, tasks: [task] };
  session.pending.set("old-question", {});
  session.transcript.push({ kind: "done", ok: true });
  assert.equal(chatStatus(session), "done");
  session.transcript.push({ kind: "status", text: STOPPED });
  assert.equal(chatStatus(session), "idle");
});

test("errors and failed results still need attention, and new chats stay idle", () => {
  const session = state();
  session.running = session.turnActive = false;
  session.transcript.push({ kind: "done", ok: false });
  assert.equal(chatStatus(session), "error");
  session.transcript = [{ kind: "user", text: "Try again" }, { kind: "error", text: "Failed to start" }];
  assert.equal(chatStatus(session), "error");
  session.transcript = [];
  assert.equal(chatStatus(session), "idle");
});
