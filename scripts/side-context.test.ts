import assert from "node:assert/strict";
import { test } from "node:test";
import { SIDE_CONTEXT_LIMIT, newestWithin, recapLines, sideContext } from "../src/main/recap.ts";
import type { SideParent } from "../src/main/recap.ts";
import type { EngineEvent } from "../src/main/engines/types.ts";

const parent = (transcript: EngineEvent[], patch: Partial<SideParent> = {}): SideParent => ({
  title: "Moving data", planLabel: "ChatGPT (Codex)", cwd: "/work/donors", running: true,
  transcript, file: "/data/chats/main.json", ...patch
});

const resize: EngineEvent[] = [
  { kind: "user", text: "Ok let's resize then" },
  { kind: "session", engineSessionId: "t1" },
  { kind: "thinking", text: "checking the backup" },
  { kind: "tool", name: "Bash", step: { type: "terminal", label: "Terminal", target: "doctl databases get eeba --format Size" } },
  { kind: "tool_result", ok: true, output: "so1_5-4vcpu-32gb 1474560" },
  { kind: "delta", text: "I'll request a reduction " },
  { kind: "delta", text: "to 1,370 GiB." },
  { kind: "text", text: "I'll request a reduction to 1,370 GiB, saving about USD 15 per month." }
];

test("a side conversation's first message carries the whole chat", () => {
  const out = sideContext(parent(resize), undefined);
  assert.match(out, /side conversation, opened beside my chat "Moving data" \(ChatGPT \(Codex\), in \/work\/donors\)/);
  assert.match(out, /That chat is still working\./);
  assert.match(out, /full record, including tool output, is at \/data\/chats\/main\.json/);
  assert.match(out, /Me: Ok let's resize then/);
  assert.match(out, /\(tool\) Terminal: doctl databases get eeba --format Size/);
  assert.match(out, /Assistant: I'll request a reduction to 1,370 GiB, saving about USD 15 per month\./);
  // tool output, reasoning and the streamed pieces of a finished reply stay out
  assert.doesNotMatch(out, /1474560|checking the backup|still writing/);
  assert.equal(out.match(/request a reduction/g)?.length, 1);
});

test("later messages carry only what happened in the chat since", () => {
  const more: EngineEvent[] = [...resize, { kind: "text", text: "The resize is still running." }];
  const out = sideContext(parent(more, { running: false }), resize.length);
  assert.match(out, /went on since my last message here\. That chat is not running right now\./);
  assert.match(out, /Assistant: The resize is still running\./);
  assert.doesNotMatch(out, /resize then|1,370/);
  assert.equal(sideContext(parent(more), more.length), "");
});

test("a chat that shrank since is retold from the start", () => {
  assert.match(sideContext(parent(resize), resize.length + 5), /opened beside my chat/);
});

test("a reply still streaming shows as being written", () => {
  const out = sideContext(parent([...resize, { kind: "delta", text: "Checking the provider " }, { kind: "delta", text: "status now" }]), undefined);
  assert.match(out, /Assistant \(still writing\): Checking the provider status now$/);
});

test("a reply cut off mid-stream keeps what was shown", () => {
  const lines = recapLines([
    { kind: "user", text: "Go" },
    { kind: "delta", text: "Half a repl" },
    { kind: "status", text: "Stopped" },
    { kind: "user", text: "Continue" }
  ]);
  assert.deepEqual(lines, ["Me: Go", "Assistant: Half a repl", "Me: Continue"]);
});

test("the handoff recap leaves tool calls out", () => {
  assert.deepEqual(recapLines(resize), [
    "Me: Ok let's resize then",
    "Assistant: I'll request a reduction to 1,370 GiB, saving about USD 15 per month."
  ]);
});

test("only the latest turn's last steps are retold", () => {
  const step = (n: number): EngineEvent => ({ kind: "tool", name: "Bash", step: { type: "terminal", label: "Terminal", target: `cmd ${n}` } });
  const events: EngineEvent[] = [
    { kind: "user", text: "First" }, step(0), { kind: "error", text: "old failure" }, { kind: "text", text: "Done first" },
    { kind: "user", text: "Second" }, ...Array.from({ length: 25 }, (_, n) => step(n + 1)), { kind: "error", text: "timed out" }
  ];
  const lines = recapLines(events, true);
  assert.ok(!lines.some((l) => /cmd 0$|old failure|cmd [1-6]$/.test(l)));
  assert.ok(lines.includes("(tool) Terminal: cmd 7"));
  assert.ok(lines.includes("(tool) Terminal: cmd 25"));
  assert.equal(lines.at(-1), "(error) timed out");
  assert.deepEqual(lines.slice(0, 3), ["Me: First", "Assistant: Done first", "Me: Second"]);
});

test("a long chat keeps its newest part and points to the full record", () => {
  const long: EngineEvent[] = [];
  for (let i = 0; i < 2000; i++) long.push({ kind: "user", text: `message ${i} ${"x".repeat(80)}` });
  const out = sideContext(parent(long), undefined);
  assert.ok(out.length < SIDE_CONTEXT_LIMIT + 1000);
  assert.match(out, /Only the most recent part is below; the rest is in its full record at \/data\/chats\/main\.json/);
  assert.match(out, /message 1999 /);
  assert.doesNotMatch(out, /message 0 /);
});

test("one message longer than the limit still shows its start", () => {
  const { text, cut } = newestWithin(["a".repeat(50)], 20);
  assert.equal(cut, true);
  assert.equal(text, `${"a".repeat(19)}…`);
});

test("a chat with nothing in it yet adds nothing", () => {
  assert.equal(sideContext(parent([]), undefined), "");
});
