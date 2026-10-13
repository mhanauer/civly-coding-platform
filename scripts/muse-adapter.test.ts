import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { museAdapter } from "../src/main/engines/muse.ts";
import { museCatalog } from "../src/main/engines/models.ts";
import type { EngineEvent } from "../src/main/engines/types.ts";

const SESSION = "01a132cb-a886-71a2-9d87-ca2fb150b6c0";

// one `muse exec --json` record, as Muse Code 1.4 writes it
const line = (payloadType: string, payload: Record<string, unknown>): string =>
  JSON.stringify({
    schema_version: 1,
    stream: { kind: "session", id: SESSION },
    record_type: "event",
    payload_type: payloadType,
    payload
  });

const run = (lines: string[]): EngineEvent[] => {
  const adapter = museAdapter();
  const events: EngineEvent[] = [];
  for (const l of lines) adapter.parseLine(l, (e) => events.push(e));
  return events;
};

const shell = (command: string, exitCode: number, output: string): string =>
  JSON.stringify({ chunk_id: "exec-1-1", command, description: "", exit_code: exitCode, output });

test("a run's session, tools, todo list and reply become chat events", () => {
  const events = run([
    line("runtime.command.accepted", { kind: "command_accepted" }),
    line("todo.snapshot.updated", {
      facts: { items: [{ text: "Create hello.py", status: "in_progress" }, { text: "Run it", status: "pending" }] }
    }),
    line("tool.result", { call_id: "c0", text: "{\"ok\":true}", correlation_facts: { tool_name: "write_todos", outcome: "success" } }),
    line("tool.result", {
      call_id: "c1",
      text: "wrote 12 bytes to hello.py",
      edit_facts: { tool_name: "write_file", path: "hello.py", added: 1 },
      correlation_facts: { tool_name: "write_file", outcome: "success" }
    }),
    line("tool.result", {
      call_id: "c2",
      text: shell("ls missing-dir", 1, "ls: missing-dir: No such file or directory\n"),
      correlation_facts: { tool_name: "bash", outcome: "failure" }
    }),
    line("run.output.delta", { text: "Done" }),
    line("run.output.delta", { text: " — it prints bye." }),
    line("run.terminal.completed", { terminal: "completed", text: "Done — it prints bye.", reason: null })
  ]);
  assert.deepEqual(events[0], { kind: "session", engineSessionId: SESSION });
  const todo = events.find((e) => e.kind === "tool" && e.step?.type === "todo");
  assert.deepEqual(todo?.kind === "tool" ? todo.step?.todos : undefined, [
    { text: "Create hello.py", status: "in_progress" },
    { text: "Run it", status: "pending" }
  ]);
  // the todo tool's own result is not a second step
  assert.equal(events.filter((e) => e.kind === "tool").length, 3);
  const write = events.find((e) => e.kind === "tool" && e.id === "c1");
  assert.deepEqual(write?.kind === "tool" ? write.step : undefined, {
    type: "edit", label: "Write", target: "hello.py", added: 1, removed: undefined
  });
  const ls = events.find((e) => e.kind === "tool" && e.id === "c2");
  assert.equal(ls?.kind === "tool" ? ls.step?.target : undefined, "ls missing-dir");
  const lsResult = events.find((e) => e.kind === "tool_result" && e.id === "c2");
  assert.deepEqual(lsResult, { kind: "tool_result", id: "c2", ok: false, output: "ls: missing-dir: No such file or directory\n" });
  assert.deepEqual(events.slice(-4), [
    { kind: "delta", text: "Done" },
    { kind: "delta", text: " — it prints bye." },
    { kind: "text", text: "Done — it prints bye." },
    { kind: "done", ok: true }
  ]);
});

test("text streamed before a tool closes as its own message and is not repeated", () => {
  const events = run([
    line("run.output.delta", { text: "Checking the files." }),
    line("tool.result", { call_id: "c1", text: shell("ls", 0, "a\n"), correlation_facts: { tool_name: "bash", outcome: "success" } }),
    line("run.terminal.completed", { terminal: "completed", text: "Checking the files.", reason: null })
  ]);
  assert.deepEqual(events.filter((e) => e.kind === "text"), [{ kind: "text", text: "Checking the files." }]);
  assert.equal(events.at(-1)?.kind, "done");
});

test("a failed run reports why, falling back to the model call's failure", () => {
  const failed = run([
    line("task.lifecycle.proposed", { event: { kind: "proposed", task_id: "m1", task_kind: "model.meta.response" } }),
    line("task.lifecycle.proposed", { event: { kind: "proposed", task_id: "r1", task_kind: "reminder.agent.goal-reminder" } }),
    line("task.lifecycle.failed", { event: { kind: "failed", task_id: "r1", reason: "provider does not support base instructions" } }),
    line("task.lifecycle.failed", { event: { kind: "failed", task_id: "m1", reason: "Subscription usage limit reached. Your usage resets at 3:00 PM" } }),
    line("run.terminal.failed", { terminal: "failed", text: "", reason: null })
  ]);
  assert.deepEqual(failed.slice(-2), [
    { kind: "error", text: "Subscription usage limit reached. Your usage resets at 3:00 PM" },
    { kind: "done", ok: false, summary: "Subscription usage limit reached. Your usage resets at 3:00 PM" }
  ]);
  const cancelled = run([line("run.terminal.cancelled", { terminal: "cancelled", reason: { kind: "interrupted" } })]);
  assert.deepEqual(cancelled.slice(-1), [{ kind: "done", ok: false, summary: "interrupted" }]);
});

test("a chat runs headless with contributor mode off, resuming its session", () => {
  const args = museAdapter().buildArgs({
    prompt: "fix it",
    cwd: "/tmp",
    model: "muse-wonder-1.0",
    effort: "high",
    resumeId: SESSION,
    fullAccess: true,
    browser: { command: "npx", args: ["chrome-devtools-mcp"] }
  });
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "--contributor-mode", "off"]);
  assert.ok(args.join(" ").includes("--model muse-wonder-1.0 --reasoning-effort high --session-id " + SESSION + " --yolo"));
  const browser = args[args.indexOf("-c") + 1];
  assert.match(browser, /^mcpServers\.browser=/);
  assert.deepEqual(JSON.parse(browser.slice(browser.indexOf("=") + 1)), {
    transport: "stdio", command: "npx", args: ["chrome-devtools-mcp"], mode: "optional"
  });
  assert.equal(args.at(-1), "fix it");
  const limited = museAdapter().buildArgs({ prompt: "p", cwd: "/tmp", model: "default", fullAccess: false });
  assert.deepEqual(limited, ["exec", "--json", "--contributor-mode", "off", "--disable-approval", "--trust-workspace", "p"]);
});

test("the model list is the CLI's visible chat models, default first", () => {
  const dir = mkdtempSync(join(tmpdir(), "cph-muse-"));
  try {
    mkdirSync(join(dir, "catalog"));
    const effort = [{ tier: "high" }];
    writeFileSync(join(dir, "catalog", "meta.json"), JSON.stringify({
      rows: [
        { model_id: "muse-spark-1.2", visibility: "visible", release_date: "2026-08-05", reasoning_effort_variants: effort },
        { model_id: "muse-wonder-1.0-contributor", visibility: "hidden", release_date: "2026-10-12", reasoning_effort_variants: effort },
        { model_id: "muse-wonder-full-1.0", visibility: "visible", release_date: "2026-10-12", reasoning_effort_variants: effort },
        { model_id: "muse-wonder-1.0", visibility: "visible", is_default: true, release_date: "2026-10-12", reasoning_effort_variants: effort },
        { model_id: "muse-image-1.0", visibility: "visible", release_date: "2026-10-13", reasoning_effort_variants: null }
      ]
    }));
    assert.deepEqual(museCatalog(join(dir, "catalog")), ["muse-wonder-1.0", "muse-wonder-full-1.0", "muse-spark-1.2"]);
    assert.deepEqual(museCatalog(join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
