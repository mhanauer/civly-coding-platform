import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAdapter, waitGuide } from "../src/main/engines/claude.ts";
import { backgroundWatch, checkInNote } from "../src/main/backgroundWait.ts";
import type { BackgroundTask, EngineAdapter, EngineEvent } from "../src/main/engines/types.ts";

// stream-json lines as Claude Code 2.1.309 writes them for a background
// command that outlives the reply
const tasksChanged = (tasks: Array<{ id: string; description: string }>): string =>
  JSON.stringify({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((t) => ({ task_id: t.id, task_type: "local_bash", description: t.description }))
  });
const said = (text: string): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = (text: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, ...fields });

const start = (): { adapter: EngineAdapter; events: EngineEvent[]; feed: (...lines: string[]) => void; promptId: string } => {
  const adapter = claudeAdapter();
  const events: EngineEvent[] = [];
  const promptId = JSON.parse(adapter.initialInput!({ prompt: "deploy it", cwd: "/tmp" })).uuid as string;
  return { adapter, events, promptId, feed: (...lines) => lines.forEach((l) => adapter.parseLine(l, (e) => events.push(e))) };
};

const background = (events: EngineEvent[]) =>
  events.filter((e): e is Extract<EngineEvent, { kind: "background" }> => e.kind === "background");

test("a background command keeps the chat's input open until its own turn ends", () => {
  const { adapter, events, feed, promptId } = start();
  feed(tasksChanged([{ id: "b1", description: "Wait for backend CI" }]), said("Waiting on CI."));
  feed(result("Waiting on CI.", { user_message_uuids: [promptId] }));
  assert.equal(adapter.inputDone!(), false, "the command can still bring a turn that asks permission");
  const waiting = background(events).at(-1)!;
  assert.equal(waiting.idle, true);
  assert.deepEqual(waiting.tasks.map((t) => [t.id, t.description]), [["b1", "Wait for backend CI"]]);

  // the command ends: Claude Code drops it and answers its notice in a turn
  feed(tasksChanged([]));
  assert.equal(adapter.inputDone!(), false, "its turn has not come yet");
  feed(said("CI passed."), result("CI passed.", { origin: { kind: "task-notification" } }));
  assert.equal(adapter.inputDone!(), true);
  assert.equal(background(events).at(-1)!.idle, false);
});

test("a check-in keeps the input open until Claude Code answers it", () => {
  const { adapter, events, feed, promptId } = start();
  feed(tasksChanged([{ id: "b1", description: "Wait for backend CI" }]), result("Waiting.", { user_message_uuids: [promptId] }));
  const line = JSON.parse(adapter.userMessage!("[Note from the app: check on it]"));
  assert.equal(line.type, "user");
  feed(said("Still running, about 8 minutes left."));
  assert.equal(background(events).at(-1)!.idle, false, "a turn is under way");
  assert.equal(adapter.inputDone!(), false);
  feed(result("Still running.", { user_message_uuids: [line.uuid] }));
  assert.equal(adapter.inputDone!(), false, "the command still runs");
  assert.equal(background(events).at(-1)!.idle, true);
  feed(tasksChanged([]), said("Done."), result("Done.", { origin: { kind: "task-notification" } }));
  assert.equal(adapter.inputDone!(), true);
});

test("work that ends during the reply does not hold the input open", () => {
  const { adapter, feed, promptId } = start();
  feed(tasksChanged([{ id: "b1", description: "quick" }]), said("..."), tasksChanged([]));
  feed(result("Finished.", { user_message_uuids: [promptId] }));
  assert.equal(adapter.inputDone!(), true);
});

test("an older build's result without a message list still answers the prompt", () => {
  const { adapter, feed } = start();
  feed(said("Hi."), result("Hi."));
  assert.equal(adapter.inputDone!(), true);
});

test("the wait guide warns about zsh word splitting only in zsh", () => {
  assert.match(waitGuide("zsh"), /zsh/);
  assert.match(waitGuide("zsh"), /run ID, not the newest run/);
  assert.doesNotMatch(waitGuide("bash"), /zsh/);
  const args = claudeAdapter().buildArgs({ prompt: "x", cwd: "/tmp" });
  assert.ok(args.includes("--append-system-prompt"));
});

const task = (id: string, startedAt: number): BackgroundTask => ({ id, type: "local_bash", description: `Wait ${id}`, startedAt });

test("the app shows the wait once and checks in each interval while the chat is idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const notes: string[] = [];
  const statuses: string[] = [];
  const watch = backgroundWatch({
    say: (text) => (notes.push(text), true),
    status: (text) => statuses.push(text),
    intervalMs: 1000,
    now: () => now
  });
  const tasks = [task("b1", 0)];
  watch.feed(tasks, true);
  assert.equal(statuses.length, 1);
  assert.match(statuses[0], /Waiting on background work: Wait b1/);

  now = 600_000;
  t.mock.timers.tick(1000);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /"Wait b1" \(running 10 min\)/);
  assert.match(notes[0], /TaskStop/);

  // the check-in's turn runs, then the chat is idle on the same work again
  watch.feed(tasks, false);
  t.mock.timers.tick(5000);
  assert.equal(notes.length, 1, "no check-in while a turn runs");
  watch.feed(tasks, true);
  assert.equal(statuses.filter((s) => s.startsWith("Waiting")).length, 1, "same work, no second waiting line");
  t.mock.timers.tick(1000);
  assert.equal(notes.length, 2);

  // the work ends: no more check-ins
  watch.feed([], false);
  t.mock.timers.tick(10_000);
  assert.equal(notes.length, 2);
});

test("check-ins come every 5 minutes and stop after two hours' worth", (t) => {
  assert.match(waitGuide("zsh"), /every 5 minutes/);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notes: string[] = [];
  const statuses: string[] = [];
  const watch = backgroundWatch({ say: (text) => (notes.push(text), true), status: (s) => statuses.push(s), intervalMs: 1000, now: () => 0 });
  const tasks = [task("b1", 0)];
  for (let i = 0; i < 30; i++) {
    watch.feed(tasks, true);
    t.mock.timers.tick(1000);
    watch.feed(tasks, false);
  }
  assert.equal(notes.length, 24);
  assert.match(statuses.at(-1)!, /last check-in/);
});

test("a check-in the engine cannot take is not counted or shown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: string[] = [];
  const watch = backgroundWatch({ say: () => false, status: (s) => statuses.push(s), intervalMs: 1000, now: () => 0 });
  watch.feed([task("b1", 0)], true);
  t.mock.timers.tick(1000);
  assert.equal(statuses.length, 1);
  watch.stop();
});

test("the check-in note names each task and how long it has run", () => {
  const note = checkInNote([task("a", 0), task("b", 1_800_000)], 3_600_000);
  assert.match(note, /"Wait a" \(running 60 min\), "Wait b" \(running 30 min\)/);
});
