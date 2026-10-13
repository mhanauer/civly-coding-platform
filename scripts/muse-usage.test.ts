import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMuseSessionLog } from "../src/main/museUsage.ts";

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

test("an empty or odd log tallies to zero", () => {
  assert.deepEqual(parseMuseSessionLog("", NOW), {
    today: { input: 0, output: 0 },
    last7Days: { input: 0, output: 0 }
  });
});
