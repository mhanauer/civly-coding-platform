import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_RETRY_PREFIX,
  carriesOn,
  hitPlanLimit,
  latestAttempt,
  nextPlanAfterLimit,
  planIsOut,
  resetTimeFromText
} from "../src/main/limitFallback.ts";
import { claudeAdapter } from "../src/main/engines/claude.ts";
import type { EngineEvent, PlanConfig } from "../src/main/engines/types.ts";

const dataDir = mkdtempSync(join(tmpdir(), "cph-limit-"));
process.env.CPH_DATA_DIR = dataDir;
const oldReset = Date.now() + 3_600_000;
writeFileSync(join(dataDir, "usage.json"), JSON.stringify({
  oldClaude: { windows: [{ label: "Weekly", usedPct: 100, resetsAt: oldReset }], limitedUntil: 0, updatedAt: Date.now() },
  resetClaude: { windows: [{ label: "5-hour", usedPct: 100, resetsAt: Date.now() - 1_000 }], limitedUntil: 0, updatedAt: Date.now() }
}));
const usage = await import("../src/main/usage.ts");
after(() => rmSync(dataDir, { recursive: true, force: true }));

const plan = (id: string, engine: PlanConfig["engine"], loggedIn = true): PlanConfig => ({
  id, label: id, engine, bin: engine, extraArgs: [], color: "#000", installed: true, loggedIn
});

test("a failed hourly or weekly limit retries, but a successful tool error does not", () => {
  const error: EngineEvent = { kind: "error", text: "You've hit your weekly limit · resets Oct 7 at 3am" };
  assert.equal(hitPlanLimit([error, { kind: "done", ok: false }]), true);
  assert.equal(hitPlanLimit([{ kind: "done", ok: false, summary: "5-hour usage limit reached" }]), true);
  assert.equal(hitPlanLimit([{ kind: "done", ok: false, summary: "You've hit your 5-hour limit" }]), true);
  assert.equal(hitPlanLimit([
    { kind: "usage", windows: [{ label: "5-hour", usedPct: 100 }], limited: true },
    { kind: "done", ok: false }
  ]), true);
  assert.equal(hitPlanLimit([
    { kind: "usage", windows: [{ label: "5-hour", usedPct: 100 }], limited: true },
    { kind: "done", ok: true }
  ]), false);
  assert.equal(hitPlanLimit([error, { kind: "done", ok: true }]), false);
  assert.equal(hitPlanLimit([{ kind: "error", text: "Command failed" }, { kind: "done", ok: false }]), false);
});

test("a retry can resume on another account and skips every exhausted plan", () => {
  const current = plan("claude-main", "claude");
  const sameStore = plan("claude-second", "claude");
  const other = plan("chatgpt", "codex");
  const plans = [current, other, sameStore, plan("signed-out", "claude", false)];
  const store = (p: PlanConfig): string => p.engine;
  assert.equal(nextPlanAfterLimit(current, plans, new Set([current.id]), store)?.id, sameStore.id);
  assert.equal(nextPlanAfterLimit(current, plans, new Set([current.id, sameStore.id]), store)?.id, other.id);
  assert.equal(nextPlanAfterLimit(current, plans, new Set([current.id, sameStore.id, other.id]), store), null);
});

test("an OpenRouter key is the last resort behind every subscription", () => {
  const current = plan("claude-main", "claude");
  const openrouter: PlanConfig = {
    ...plan("openrouter", "claude", false),
    env: { ANTHROPIC_AUTH_TOKEN: "sk-or", ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1" }
  };
  const zai: PlanConfig = {
    ...plan("zai", "claude", false),
    env: { ANTHROPIC_AUTH_TOKEN: "sk-zai", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" }
  };
  const store = (p: PlanConfig): string => p.engine;
  // even a resumable OpenRouter conversation loses to a subscription
  const resumable = [current, openrouter, plan("chatgpt", "codex")];
  assert.equal(nextPlanAfterLimit(current, resumable, new Set([current.id]), store)?.id, "chatgpt");
  // and it is still picked when nothing else is left
  assert.equal(nextPlanAfterLimit(current, [current, openrouter, zai], new Set([current.id, "zai"]), store)?.id, "openrouter");
});

test("a successful retry determines status without the previous limit error", () => {
  const events: EngineEvent[] = [
    { kind: "error", text: "weekly limit reached" },
    { kind: "done", ok: false },
    { kind: "status", text: `${AUTO_RETRY_PREFIX}ChatGPT after Claude hit its limit.` },
    { kind: "text", text: "Finished the request" },
    { kind: "done", ok: true }
  ];
  assert.deepEqual(latestAttempt(events), events.slice(3));
  assert.deepEqual(latestAttempt(events.slice(0, 2)), events.slice(0, 2));
});

test("Claude's reset date includes the named time zone and rolls to next year", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  assert.equal(
    resetTimeFromText("You've hit your weekly limit · resets Oct 7 at 3am (America/New_York)", now),
    Date.parse("2026-10-07T07:00:00Z")
  );
  assert.equal(
    resetTimeFromText("resets Jan 2 at 9:30pm (America/New_York)", Date.parse("2026-12-30T12:00:00Z")),
    Date.parse("2027-01-03T02:30:00Z")
  );
  assert.equal(resetTimeFromText("no reset time", now), undefined);
});

test("a later error does not erase a reset time from Claude's usage event", () => {
  const resetsAt = Date.now() + 3_600_000;
  usage.recordUsage("claude", [{ label: "5-hour", usedPct: 100, resetsAt }], true);
  usage.recordLimitError("claude", "weekly limit reached");
  assert.equal(usage.allUsage().claude.limitedUntil, resetsAt);
});

test("an older saved limit recovers its reset time from the usage window", () => {
  assert.equal(usage.allUsage().oldClaude.limitedUntil, oldReset);
  assert.equal(usage.allUsage().resetClaude.limitedUntil, undefined);
});

test("a plan counts as out until its reset, or for 5 hours when the reset is unknown", () => {
  const now = Date.parse("2026-10-04T09:00:00Z");
  assert.equal(planIsOut(undefined, now), false);
  assert.equal(planIsOut({ updatedAt: now }, now), false);
  assert.equal(planIsOut({ limitedUntil: now + 60_000, updatedAt: now - 86_400_000 }, now), true);
  assert.equal(planIsOut({ limitedUntil: now - 60_000, updatedAt: now - 120_000 }, now), false);
  assert.equal(planIsOut({ limitedUntil: 0, updatedAt: now - 3_600_000 }, now), true);
  assert.equal(planIsOut({ limitedUntil: 0, updatedAt: now - 6 * 3_600_000 }, now), false);
});

test("Claude Code waiting out a usage limit reports the plan as out", () => {
  const events: EngineEvent[] = [];
  const adapter = claudeAdapter();
  const emit = (event: EngineEvent): void => { events.push(event); };
  const retry = (delay: number): string => JSON.stringify({
    type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: delay, error_status: 429, error: "rate_limit"
  });
  // ordinary backoff is not a limit
  adapter.parseLine(retry(4_000), emit);
  assert.deepEqual(events, []);
  adapter.parseLine(retry(3 * 86_400_000), emit);
  assert.deepEqual(events, [{ kind: "usage", windows: [], limited: true }]);
});

test("a session limit with only a reset time counts, and resets at the next such time", () => {
  const text = "You've hit your session limit · resets 1:20pm (America/New_York)";
  assert.equal(hitPlanLimit([{ kind: "text", text }, { kind: "done", ok: false, summary: text }]), true);
  // 11:31 in New York: later today
  assert.equal(resetTimeFromText(text, Date.parse("2026-10-05T15:31:00Z")), Date.parse("2026-10-05T17:20:00Z"));
  // 14:00 in New York: tomorrow
  assert.equal(resetTimeFromText(text, Date.parse("2026-10-05T18:00:00Z")), Date.parse("2026-10-06T17:20:00Z"));
  // 22:00 in New York is already the next day in UTC
  assert.equal(resetTimeFromText("resets 11pm (America/New_York)", Date.parse("2026-10-06T02:00:00Z")), Date.parse("2026-10-06T03:00:00Z"));
});

test("a turn that failed on the limit reports the plan as out, and the notice is not the run carrying on", () => {
  const text = "You've hit your session limit · resets 1:20pm (America/New_York)";
  const events: EngineEvent[] = [];
  const adapter = claudeAdapter();
  adapter.parseLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text }), (event) => { events.push(event); });
  assert.deepEqual(events.slice(0, 2), [{ kind: "usage", windows: [], limited: true }, { kind: "done", ok: false, summary: text, tokens: undefined, costUsd: undefined }]);
  assert.equal(carriesOn({ kind: "text", text }), false);
  assert.equal(carriesOn({ kind: "tool_result", id: "t", ok: true, output: "moved to the background" }), false);
  assert.equal(carriesOn({ kind: "text", text: "Done." }), true);
  assert.equal(carriesOn({ kind: "delta", text: "D" }), true);
});
