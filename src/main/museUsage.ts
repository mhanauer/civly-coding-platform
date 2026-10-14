import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageWindow } from "./engines/types.ts";

export interface MuseTokens {
  input: number;
  output: number;
}

export interface MuseTokenTally {
  today: MuseTokens;
  last7Days: MuseTokens;
}

interface Quantity {
  reported?: boolean;
  input_tokens?: number;
  output_tokens?: number;
}

// Muse Code records each model call's tokens in its session logs
// (~/.local/share/muse/sessions/YYYY/MM/DD/<id>/session.jsonl), as a
// goal_usage_attribution record. A record can also appear nested in a
// retained frame's children, so usage_id dedupes. Only provider-reported
// records count; recorded_at is microseconds since the epoch.
export function parseMuseSessionLog(text: string, now: number): MuseTokenTally {
  const today: MuseTokens = { input: 0, output: 0 };
  const last7Days: MuseTokens = { input: 0, output: 0 };
  const seen = new Set<string>();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const todayMs = dayStart.getTime();
  const weekMs = now - 7 * 24 * 60 * 60 * 1000;

  const visit = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) {
        const json = (child as { record_json?: unknown })?.record_json;
        if (typeof json === "string") {
          try {
            visit(JSON.parse(json));
          } catch {
            // an odd nested record is skipped, not fatal
          }
        }
      }
    }
    const payload = rec.payload as { event?: { kind?: string; record?: { usage_id?: string; quantity?: Quantity } } } | undefined;
    const event = payload?.event;
    if (event?.kind !== "goal_usage_attribution") return;
    const q = event.record?.quantity;
    const id = event.record?.usage_id;
    if (!q || q.reported !== true || !id || seen.has(id)) return;
    seen.add(id);
    const atMs = typeof rec.recorded_at === "number" ? rec.recorded_at / 1000 : 0;
    const input = typeof q.input_tokens === "number" ? q.input_tokens : 0;
    const output = typeof q.output_tokens === "number" ? q.output_tokens : 0;
    if (atMs >= weekMs) {
      last7Days.input += input;
      last7Days.output += output;
    }
    if (atMs >= todayMs) {
      today.input += input;
      today.output += output;
    }
  };

  for (const line of text.split("\n")) {
    if (!line.includes("goal_usage_attribution")) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      // a partial last line while the CLI is writing is skipped
    }
  }
  return { today, last7Days };
}

// Muse's subscription percent (SubscriptionUsageSnapshot: a short window
// plus a weekly window, each a used_percent with a resets_at) is only ever
// shown live in the Muse TUI's /usage. It is never written to a local file
// and headless `muse exec --json` does not emit it, so the Platform reads
// that panel by opening the TUI (usage.ts) and keeps the result as the
// snapshot below; pasting /usage by hand is the fallback. Windows derived
// from it are marked displayLeft so the usage view shows "% left" instead
// of "% used".
export interface MuseSubscriptionSnapshot {
  windowUsedPct?: number;
  weeklyUsedPct?: number;
  // epoch ms
  windowResetsAt?: number;
  weeklyResetsAt?: number;
  windowDurationMins?: number;
  tier?: string;
  savedAt: number;
}

export interface MuseSnapshotInput {
  text?: string;
  windowUsedPct?: number;
  weeklyUsedPct?: number;
  windowResetsAt?: number;
  weeklyResetsAt?: number;
  tier?: string;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function pctField(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? clampPct(v) : undefined;
}

function msField(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

// Pasted /usage text, best effort: the first percent is the current window,
// the second is weekly; ISO reset stamps pair up in the same order. Typed
// fields always win over anything the paste yielded. Null when no percent
// can be found at all.
export function resolveMuseSnapshot(input: MuseSnapshotInput, now = Date.now()): MuseSubscriptionSnapshot | null {
  const text = input.text ?? "";
  const pcts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
  const stamps = [...text.matchAll(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)/g)].map((m) =>
    Date.parse(m[1].replace(" ", "T"))
  );
  const hours = /(\d+(?:\.\d+)?)\s*-?\s*hours?\b/i.exec(text);
  const snap: MuseSubscriptionSnapshot = {
    windowUsedPct: pctField(input.windowUsedPct) ?? (pcts[0] !== undefined ? clampPct(pcts[0]) : undefined),
    weeklyUsedPct: pctField(input.weeklyUsedPct) ?? (pcts[1] !== undefined ? clampPct(pcts[1]) : undefined),
    windowResetsAt: msField(input.windowResetsAt) ?? (Number.isFinite(stamps[0]) ? stamps[0] : undefined),
    weeklyResetsAt: msField(input.weeklyResetsAt) ?? (Number.isFinite(stamps[1]) ? stamps[1] : undefined),
    windowDurationMins: hours ? Math.round(Number(hours[1]) * 60) : undefined,
    tier: input.tier?.trim() || undefined,
    savedAt: now
  };
  return snap.windowUsedPct !== undefined || snap.weeklyUsedPct !== undefined ? snap : null;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

function timeToday(time: string, now: number): number | undefined {
  const m = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(time);
  if (!m) return undefined;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  const d = new Date(now);
  d.setHours(h, Number(m[2]), 0, 0);
  // a same-day time already past at scrape time belongs to the next window
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function monthDayTime(text: string, now: number): number | undefined {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(text);
  if (!m || MONTHS[m[1]] === undefined) return undefined;
  let h = Number(m[3]) % 12;
  if (/pm/i.test(m[5])) h += 12;
  const base = new Date(now);
  const d = new Date(base.getFullYear(), MONTHS[m[1]], Number(m[2]), h, Number(m[4]));
  if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

// The TUI's /usage panel, ANSI and box borders included, e.g.:
//   Subscription · Muse Code Max Usage
//     Current        0% used · Resets at 12:39 PM
//     Weekly         37% used · Resets Oct 18 at 8:00 PM
export function parseMuseUsagePanel(text: string, now = Date.now()): MuseSubscriptionSnapshot | null {
  const clean = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[│┃]/g, " ")
    .replace(/[└┌┐┘├┤]/g, " ")
    .replace(/─+/g, " ");
  const tier = /Subscription\s*·\s*(.+?)(?=\s+(?:Current|Weekly)\s|$)/.exec(clean)?.[1]?.replace(/\s+/g, " ").trim() || undefined;
  const current = /Current\s+(\d+(?:\.\d+)?)%\s*used\s*·\s*Resets\s+at\s+([0-9:]+\s*[AP]M)/i.exec(clean);
  const weekly = /Weekly\s+(\d+(?:\.\d+)?)%\s*used\s*·\s*Resets\s+([A-Z][a-z]{2}\s+\d{1,2}\s+at\s+[0-9:]+\s*[AP]M)/i.exec(clean);
  if (!current && !weekly) return null;
  return {
    windowUsedPct: current ? clampPct(Number(current[1])) : undefined,
    weeklyUsedPct: weekly ? clampPct(Number(weekly[1])) : undefined,
    windowResetsAt: current ? timeToday(current[2], now) : undefined,
    weeklyResetsAt: weekly ? monthDayTime(weekly[2], now) : undefined,
    tier,
    savedAt: now
  };
}

export function museWindowLabel(durationMins?: number): string {
  if (!durationMins) return "Current window";
  if (durationMins % 60 === 0) return `${durationMins / 60}-hour`;
  return `${durationMins}-minute`;
}

export function museSnapshotWindows(snap: MuseSubscriptionSnapshot): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (snap.windowUsedPct !== undefined) {
    windows.push({ label: museWindowLabel(snap.windowDurationMins), usedPct: snap.windowUsedPct, resetsAt: snap.windowResetsAt, displayLeft: true });
  }
  if (snap.weeklyUsedPct !== undefined) {
    windows.push({ label: "Weekly", usedPct: snap.weeklyUsedPct, resetsAt: snap.weeklyResetsAt, displayLeft: true });
  }
  return windows;
}

export function museSessionsRoot(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "muse", "sessions");
}

// Sums the last 7 days across session logs touched in that span. A missing
// folder just means Muse has not run yet.
export function readMuseTokenTally(root: string, now = Date.now()): MuseTokenTally | null {
  if (!existsSync(root)) return null;
  const totals: MuseTokenTally = { today: { input: 0, output: 0 }, last7Days: { input: 0, output: 0 } };
  const since = now - 7 * 24 * 60 * 60 * 1000;
  let found = false;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl") && st.mtimeMs >= since) {
        let tally: MuseTokenTally;
        try {
          tally = parseMuseSessionLog(readFileSync(p, "utf8"), now);
        } catch {
          continue;
        }
        found = true;
        totals.today.input += tally.today.input;
        totals.today.output += tally.today.output;
        totals.last7Days.input += tally.last7Days.input;
        totals.last7Days.output += tally.last7Days.output;
      }
    }
  };
  walk(root);
  return found ? totals : null;
}
