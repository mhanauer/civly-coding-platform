import assert from "node:assert/strict";
import { test } from "node:test";
import { museSnapshotWindows, parseMuseSessionLog, resolveMuseSnapshot } from "../src/main/museUsage.ts";

// recorded_at is microseconds since the epoch
const at = (ms: number): number => ms * 1000;

function usageLine(ms: number, id: string, input: number, output: number, reported = true): string {
  return JSON.stringify({
    recorded_at: at(ms),
    payload_type: "runtime.session",
    payload: {
      event: {
        kind: "goal_usage_attribution",
        record: {
          usage_id: id,
          quantity: { unit: "tokens", reported, input_tokens: input, output_tokens: output, cached_tokens: 0, reasoning_tokens: 0 }
        }
      }
    }
  });
}

// the same record nested in a retained frame, as the CLI also writes it
function nestedLine(ms: number, id: string, input: number, output: number): string {
  const inner = JSON.stringify({
    recorded_at: at(ms),
    payload_type: "runtime.session",
    payload: { event: { kind: "goal_usage_attribution", record: { usage_id: id, quantity: { unit: "tokens", reported: true, input_tokens: input, output_tokens: output } } } }
  });
  return JSON.stringify({ retained_frame: "x", children: [{ child_index: 0, record_json: inner }] });
}

const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime();
const TODAY = new Date(2026, 9, 12, 9, 0, 0).getTime();
const THREE_DAYS_AGO = new Date(2026, 9, 9, 9, 0, 0).getTime();
const TEN_DAYS_AGO = new Date(2026, 9, 2, 9, 0, 0).getTime();

test("Muse session log tally buckets by day, dedupes, and skips unreported records", () => {
  const text = [
    usageLine(TODAY, "u1", 1000, 50),
    nestedLine(TODAY, "u1", 1000, 50),
    usageLine(TODAY, "u2", 500, 25, false),
    usageLine(THREE_DAYS_AGO, "u3", 2000, 100),
    usageLine(TEN_DAYS_AGO, "u4", 9000, 900),
    "not json",
    JSON.stringify({ payload_type: "other", payload: {} })
  ].join("\n");

  assert.deepEqual(parseMuseSessionLog(text, NOW), {
    today: { input: 1000, output: 50 },
    last7Days: { input: 3000, output: 150 }
  });
});

test("a pasted /usage snapshot resolves percents and reset times", () => {
  const now = new Date(2026, 9, 13, 12, 0, 0).getTime();
  const snap = resolveMuseSnapshot(
    { text: "Current window: 35% used, resets 2026-10-13T17:30\nWeekly: 12% used, resets 2026-10-19T09:00" },
    now
  );
  assert.equal(snap?.windowUsedPct, 35);
  assert.equal(snap?.weeklyUsedPct, 12);
  assert.equal(snap?.windowResetsAt, new Date("2026-10-13T17:30").getTime());
  assert.equal(snap?.weeklyResetsAt, new Date("2026-10-19T09:00").getTime());
});

test("typed fields win over pasted text, and no percent means no snapshot", () => {
  const now = new Date(2026, 9, 13, 12, 0, 0).getTime();
  const snap = resolveMuseSnapshot({ text: "35% used, 12% used", windowUsedPct: 40 }, now);
  assert.equal(snap?.windowUsedPct, 40);
  assert.equal(snap?.weeklyUsedPct, 12);
  assert.equal(resolveMuseSnapshot({ text: "no numbers here" }, now), null);
  assert.equal(resolveMuseSnapshot({ windowUsedPct: 140 }, now)?.windowUsedPct, 100);
});

test("a snapshot becomes % left windows with reset times", () => {
  const windows = museSnapshotWindows({
    windowUsedPct: 35,
    weeklyUsedPct: 12,
    windowResetsAt: 111,
    weeklyResetsAt: 222,
    windowDurationMins: 300,
    savedAt: 1
  });
  assert.deepEqual(windows, [
    { label: "5-hour", usedPct: 35, resetsAt: 111, displayLeft: true },
    { label: "Weekly", usedPct: 12, resetsAt: 222, displayLeft: true }
  ]);
  assert.deepEqual(museSnapshotWindows({ windowUsedPct: 20, savedAt: 1 }), [
    { label: "Current window", usedPct: 20, resetsAt: undefined, displayLeft: true }
  ]);
});

test("an empty or odd log tallies to zero", () => {
  assert.deepEqual(parseMuseSessionLog("", NOW), {
    today: { input: 0, output: 0 },
    last7Days: { input: 0, output: 0 }
  });
});
