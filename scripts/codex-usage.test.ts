import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodexAccountUsage } from "../src/main/codexAccountUsage.ts";

test("ChatGPT account data keeps used percent separate from credits and earned resets", () => {
  const usage = parseCodexAccountUsage({
    ordinaryUsageAllowed: true,
    rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: 1791104086 },
        credits: { hasCredits: true, unlimited: false, balance: "62500" }
      }
    },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { status: "available", title: "Full reset", expiresAt: 1792701915 },
        { status: "available", title: "Full reset", expiresAt: 1793300477 }
      ]
    }
  });

  assert.deepEqual(usage, {
    windows: [{ label: "Weekly", usedPct: 90, resetsAt: 1791104086000 }],
    credits: { balance: 62500, unlimited: false },
    resets: {
      availableCount: 2,
      details: [
        { title: "Full reset", expiresAt: 1792701915000 },
        { title: "Full reset", expiresAt: 1793300477000 }
      ]
    },
    limited: false
  });
});

test("included usage at 100 percent does not mark a credit-backed account as out", () => {
  const usage = parseCodexAccountUsage({
    ordinaryUsageAllowed: true,
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 10080 },
      credits: { hasCredits: true, unlimited: false, balance: "120" }
    }
  });
  assert.equal(usage?.windows[0].usedPct, 100);
  assert.equal(usage?.limited, false);
});
