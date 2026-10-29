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

// The shape ChatGPT returns once a Pro plan's weekly usage runs out.
const outOfIncluded = (credits: Record<string, unknown>, spendControlReached = false) => ({
  ordinaryUsageAllowed: false,
  rateLimitsByLimitId: {
    codex: {
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793774150 },
      credits,
      spendControlReached,
      rateLimitReachedType: "rate_limit_reached"
    }
  }
});

test("an account past its included usage keeps running on purchased credits", () => {
  const usage = parseCodexAccountUsage(outOfIncluded({ hasCredits: true, unlimited: false, balance: "60258.7010000000" }));
  assert.deepEqual(usage?.credits, { balance: 60258.701, unlimited: false });
  assert.equal(usage?.limited, false);
});

test("an account past its included usage is out without credits or at its spend cap", () => {
  assert.equal(parseCodexAccountUsage(outOfIncluded({ hasCredits: false, unlimited: false, balance: "0" }))?.limited, true);
  assert.equal(parseCodexAccountUsage(outOfIncluded({ hasCredits: true, unlimited: false, balance: "50" }, true))?.limited, true);
});
