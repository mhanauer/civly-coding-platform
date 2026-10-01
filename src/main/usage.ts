import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./store.ts";
import type { PlanConfig, UsageWindow } from "./engines/types.ts";
import { engineHome } from "./accounts.ts";
import { resolveBin } from "./engines/index.ts";
import {
  codexWindowLabel,
  readCodexAccountUsage,
  type CodexCredits,
  type CodexResets
} from "./codexAccountUsage.ts";

// How much of each plan is used, and when it resets. Sources, all read-only:
// - Claude Max: the usage report Claude Code streams with every reply
// - Z.ai: its quota endpoint, called with the plan's own API key
// - OpenRouter: its key endpoint (spend against the key's limit)
// - Codex: its read-only app-server account endpoint, or its latest session file
// - any engine: a limit error's "resets at" time
// Nothing here reads login tokens or spends quota.

export interface PlanUsage {
  windows: UsageWindow[];
  credits?: CodexCredits;
  resets?: CodexResets;
  // set when the plan is out; epoch ms, or 0 when the reset time is unknown
  limitedUntil?: number;
  updatedAt: number;
}

const FILE = join(DATA_DIR, "usage.json");
let usage: Record<string, PlanUsage> = load();
let onChange: (all: Record<string, PlanUsage>) => void = () => {};

function load(): Record<string, PlanUsage> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, PlanUsage>;
  } catch {
    return {};
  }
}

function save(): void {
  try {
    writeFileSync(FILE, JSON.stringify(usage, null, 2));
  } catch {
    // usage is a convenience; a failed save never blocks a chat
  }
  onChange(allUsage());
}

// Drops limits whose reset time has passed.
export function allUsage(): Record<string, PlanUsage> {
  const now = Date.now();
  for (const u of Object.values(usage)) {
    if (u.limitedUntil && u.limitedUntil < now) u.limitedUntil = undefined;
  }
  return usage;
}

export function onUsageChange(cb: (all: Record<string, PlanUsage>) => void): void {
  onChange = cb;
}

export function recordUsage(planId: string, windows: UsageWindow[], limited?: boolean): void {
  const prev = usage[planId];
  const out = limited ? Math.max(...windows.map((w) => (w.usedPct >= 100 ? w.resetsAt ?? 0 : 0)), 0) : undefined;
  usage[planId] = {
    windows: windows.length ? windows : prev?.windows ?? [],
    limitedUntil: limited ? out || prev?.limitedUntil || 0 : undefined,
    updatedAt: Date.now()
  };
  save();
}

// Limit errors name their reset time in a few shapes; take whichever parses.
export function recordLimitError(planId: string, text: string): void {
  let until = 0;
  const stamp = /reset (?:at|on)\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/i.exec(text);
  if (stamp) {
    // Z.ai ("Limit Exhausted") states its reset in Beijing time, UTC+8;
    // checked against the reset time its quota endpoint returns
    const zone = /Limit Exhausted/i.test(text) ? "+08:00" : "";
    until = new Date(stamp[1].replace(" ", "T") + zone).getTime() || 0;
  }
  const inMin = /try again in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(text);
  if (!until && inMin && (inMin[1] || inMin[2])) {
    until = Date.now() + ((Number(inMin[1] ?? 0) * 60 + Number(inMin[2] ?? 0)) * 60000);
  }
  const prev = usage[planId];
  usage[planId] = { windows: prev?.windows ?? [], limitedUntil: until, updatedAt: Date.now() };
  save();
}

// Z.ai quota windows come as a count of units; unit 3 is hours, 6 is weeks
// (checked against the reset times the API returns).
const ZAI_UNITS: Record<number, string> = { 1: "minute", 2: "minute", 3: "hour", 4: "day", 5: "day", 6: "week", 7: "month" };

function zaiLabel(unit: number, number: number): string {
  const name = ZAI_UNITS[unit] ?? "period";
  if (name === "week" && number === 1) return "Weekly";
  if (name === "month" && number === 1) return "Monthly";
  return `${number}-${name}`;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refreshZai(plan: PlanConfig): Promise<void> {
  const token = plan.env?.ANTHROPIC_AUTH_TOKEN;
  if (!token) return;
  const body = (await fetchJson("https://api.z.ai/api/monitor/usage/quota/limit", {
    Authorization: token,
    "Accept-Language": "en-US,en"
  })) as { data?: { limits?: Array<{ unit: number; number: number; percentage: number; nextResetTime?: number }> } };
  const limits = body.data?.limits ?? [];
  const windows = limits.map((l) => ({
    label: zaiLabel(l.unit, l.number),
    usedPct: l.percentage,
    resetsAt: l.nextResetTime
  }));
  recordUsage(plan.id, windows, windows.some((w) => w.usedPct >= 100));
}

function dollars(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
}

async function refreshOpenRouter(plan: PlanConfig): Promise<void> {
  const key = plan.env?.ANTHROPIC_AUTH_TOKEN || plan.env?.ANTHROPIC_API_KEY;
  if (!key) return;
  const body = (await fetchJson("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${key}` })) as {
    data?: { usage?: number; limit?: number | null };
  };
  const spent = body.data?.usage ?? 0;
  const limit = body.data?.limit;
  // no limit on the key: show spend only, as a window that never fills
  const windows = [
    {
      label: limit ? `${dollars(spent)} of ${dollars(limit)}` : `${dollars(spent)} spent, no limit`,
      usedPct: limit ? Math.round((spent / limit) * 100) : 0
    }
  ];
  recordUsage(plan.id, windows, Boolean(limit && spent >= limit));
}

interface CodexRateLimits {
  primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
}

// Codex records its rate limits in each session's rollout file; the newest
// file (or the one for this thread) carries the latest numbers. Each ChatGPT
// account has its own home, so its files carry only its own limits.
function refreshCodexFromSession(plan: PlanConfig, threadId?: string): void {
  try {
    const root = join(engineHome(plan) ?? join(homedir(), ".codex"), "sessions");
    if (!existsSync(root)) return;
    const files: Array<{ path: string; mtime: number }> = [];
    const walk = (dir: string, depth: number): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (depth < 3) {
          if (statSync(p).isDirectory()) walk(p, depth + 1);
        } else if (name.endsWith(".jsonl") && (!threadId || name.includes(threadId))) {
          files.push({ path: p, mtime: statSync(p).mtimeMs });
        }
      }
    };
    walk(root, 0);
    const newest = files.sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) return;
    // the last line that mentions rate limits holds the newest numbers
    const line = readFileSync(newest.path, "utf8")
      .split("\n")
      .reverse()
      .find((l) => l.includes('"rate_limits"'));
    const limits = line ? findRateLimits(JSON.parse(line)) : null;
    if (!limits) return;
    const windows = [limits.primary, limits.secondary]
      .filter((w): w is NonNullable<CodexRateLimits["primary"]> => Boolean(w))
      .map((w) => ({
        label: codexWindowLabel(w.window_minutes),
        usedPct: Math.round(w.used_percent ?? 0),
        resetsAt: w.resets_at ? w.resets_at * 1000 : undefined
      }));
    recordUsage(plan.id, windows, windows.some((w) => w.usedPct >= 100));
  } catch {
    // a missing or odd session file just leaves the last known numbers
  }
}

// Account data is fresher and also includes purchased credits and earned
// resets. Older Codex builds can still use the local session-file fallback.
export async function refreshCodex(plan: PlanConfig, threadId?: string): Promise<void> {
  const home = engineHome(plan) ?? join(homedir(), ".codex");
  const account = await readCodexAccountUsage(resolveBin(plan.bin), plan.extraArgs, home);
  if (!account) {
    refreshCodexFromSession(plan, threadId);
    return;
  }
  const out = account.limited
    ? Math.max(...account.windows.map((w) => w.usedPct >= 100 ? w.resetsAt ?? 0 : 0), 0)
    : undefined;
  usage[plan.id] = {
    windows: account.windows,
    credits: account.credits,
    resets: account.resets,
    limitedUntil: account.limited ? out : undefined,
    updatedAt: Date.now()
  };
  save();
}

function findRateLimits(obj: unknown): CodexRateLimits | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (rec.rate_limits && typeof rec.rate_limits === "object") return rec.rate_limits as CodexRateLimits;
  for (const v of Object.values(rec)) {
    const hit = findRateLimits(v);
    if (hit) return hit;
  }
  return null;
}

// Polls the plans that can be asked directly. Claude Max updates itself
// from each reply; Codex uses its account endpoint with a session fallback.
export async function refreshPlanUsage(plan: PlanConfig): Promise<void> {
  const base = plan.env?.ANTHROPIC_BASE_URL ?? "";
  try {
    if (plan.engine === "claude" && /api\.z\.ai/.test(base)) await refreshZai(plan);
    else if (plan.engine === "claude" && /openrouter\.ai/.test(base)) await refreshOpenRouter(plan);
    else if (plan.engine === "codex") await refreshCodex(plan);
  } catch {
    // offline or a rejected key: keep the last known numbers
  }
}
