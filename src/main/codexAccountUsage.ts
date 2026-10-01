import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { UsageWindow } from "./engines/types.ts";

export interface CodexCredits {
  balance?: number;
  unlimited: boolean;
}

export interface CodexResets {
  availableCount: number;
  details: Array<{ title: string; expiresAt?: number }>;
}

export interface CodexAccountUsage {
  windows: UsageWindow[];
  credits?: CodexCredits;
  resets?: CodexResets;
  limited: boolean;
}

interface RateWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function epochMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
}

export function codexWindowLabel(minutes?: number): string {
  if (!minutes) return "Limit";
  if (minutes === 10080) return "Weekly";
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

// Keep the account endpoint's percent used so bars, labels, and limit decisions
// use the same measure.
export function parseCodexAccountUsage(value: unknown): CodexAccountUsage | null {
  const result = record(value);
  if (!result) return null;
  const buckets = record(result.rateLimitsByLimitId);
  const limit = record(buckets?.codex) ?? record(result.rateLimits);
  const windows: UsageWindow[] = [];
  for (const raw of [limit?.primary, limit?.secondary]) {
    const w = record(raw) as RateWindow | null;
    if (!w || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) continue;
    windows.push({
      label: codexWindowLabel(w.windowDurationMins),
      usedPct: Math.max(0, Math.min(100, Math.round(w.usedPercent))),
      resetsAt: epochMs(w.resetsAt)
    });
  }

  const creditData = record(limit?.credits);
  const rawBalance = creditData?.balance;
  const balance = typeof rawBalance === "string" || typeof rawBalance === "number"
    ? Number(rawBalance)
    : NaN;
  const credits = creditData && (creditData.unlimited === true || Number.isFinite(balance))
    ? { balance: Number.isFinite(balance) ? balance : undefined, unlimited: creditData.unlimited === true }
    : undefined;

  const resetData = record(result.rateLimitResetCredits);
  const resetRows = Array.isArray(resetData?.credits) ? resetData.credits : [];
  const resets = typeof resetData?.availableCount === "number"
    ? {
        availableCount: resetData.availableCount,
        details: resetRows.flatMap((raw) => {
          const row = record(raw);
          if (!row || row.status !== "available") return [];
          return [{
            title: typeof row.title === "string" && row.title ? row.title : "Reset",
            expiresAt: epochMs(row.expiresAt)
          }];
        })
      }
    : undefined;

  if (!windows.length && !credits && !resets) return null;
  // A plan can continue on purchased credits after included usage hits 100%.
  const limited = result.ordinaryUsageAllowed === false ||
    (result.ordinaryUsageAllowed !== true && !credits?.unlimited && !creditData?.hasCredits &&
      windows.some((w) => w.usedPct >= 100));
  return { windows, credits, resets, limited };
}

// Read the signed-in Codex account through its documented, read-only app-server
// method. CODEX_HOME keeps added ChatGPT subscriptions separate.
export function readCodexAccountUsage(bin: string, args: string[], home: string): Promise<CodexAccountUsage | null> {
  return new Promise((resolve) => {
    let settled = false;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, [...args, "app-server"], {
        env: { ...process.env, CODEX_HOME: home },
        stdio: ["pipe", "pipe", "ignore"]
      });
    } catch {
      resolve(null);
      return;
    }
    const input = proc.stdin;
    const output = proc.stdout;
    if (!input || !output) {
      proc.kill();
      resolve(null);
      return;
    }
    const done = (usage: CodexAccountUsage | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.kill();
      resolve(usage);
    };
    const timeout = setTimeout(() => done(null), 10000);
    proc.on("error", () => done(null));
    proc.on("close", () => done(null));
    input.on("error", () => done(null));
    createInterface({ input: output }).on("line", (line) => {
      if (settled) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) return done(null);
        input.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
        input.write(JSON.stringify({ method: "account/rateLimits/read", id: 2 }) + "\n");
      } else if (message.id === 2) {
        done(message.error ? null : parseCodexAccountUsage(message.result));
      }
    });
    input.write(JSON.stringify({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "civly_coding_platform", title: "Civly Coding Platform", version: "0.1.0" } }
    }) + "\n");
  });
}
