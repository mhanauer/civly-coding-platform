import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
