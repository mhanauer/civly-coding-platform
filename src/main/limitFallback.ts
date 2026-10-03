import type { EngineEvent, PlanConfig } from "./engines/types.ts";

const LIMIT_PATTERNS =
  /usage limit|rate[ _-]?limit|quota|429|\b\d+[- ]?hour limit|hourly limit|weekly limit|limit reached|exceeded|hit your limit|ran out/i;

export function isLimitError(text: string): boolean {
  return LIMIT_PATTERNS.test(text);
}

export const AUTO_RETRY_PREFIX = "Continuing automatically on ";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function zonedTime(year: number, month: number, day: number, hour: number, minute: number, zone?: string): number {
  if (!zone) return new Date(year, month, day, hour, minute).getTime();
  try {
    const target = Date.UTC(year, month, day, hour, minute);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      hourCycle: "h23"
    });
    let epoch = target;
    // Correct the zone offset at the target date, including daylight saving.
    for (let i = 0; i < 2; i++) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map((part) => [part.type, part.value]));
      const shown = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)
      );
      epoch += target - shown;
    }
    return epoch;
  } catch {
    return new Date(year, month, day, hour, minute).getTime();
  }
}

// Claude may say "resets Oct 7 at 3am (America/New_York)" instead of giving
// an ISO timestamp. Choose the next occurrence when it leaves out the year.
export function resetTimeFromText(text: string, now = Date.now()): number | undefined {
  const match = /resets?\s+(?:on\s+)?([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase());
  const day = Number(match[2]);
  const hour12 = Number(match[4]);
  const minute = Number(match[5] ?? 0);
  if (month < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (match[6].toLowerCase() === "pm" ? 12 : 0);
  const zone = match[7];
  let year = match[3] ? Number(match[3]) : new Date(now).getFullYear();
  let result = zonedTime(year, month, day, hour, minute, zone);
  if (!match[3] && result < now - 60_000) result = zonedTime(++year, month, day, hour, minute, zone);
  return Number.isFinite(result) ? result : undefined;
}

// A failed turn can report a limit as an error, a failed result, or a rejected
// usage event. An error followed by a successful result may be from a tool,
// rather than the subscription running out.
export function hitPlanLimit(events: readonly EngineEvent[]): boolean {
  const done = [...events].reverse().find((event) => event.kind === "done");
  if (!done || done.kind !== "done" || done.ok) return false;
  return events.some((event) => event.kind === "usage" && event.limited) ||
    events.some((event) => event.kind === "error" && isLimitError(event.text)) ||
    Boolean(done.summary && isLimitError(done.summary));
}

// A successful retry should determine the chat's status even though an
// earlier attempt at the same user message ended with a limit error.
export function latestAttempt(events: readonly EngineEvent[]): readonly EngineEvent[] {
  const retry = events.findLastIndex(
    (event) => event.kind === "status" && event.text.startsWith(AUTO_RETRY_PREFIX)
  );
  return retry < 0 ? events : events.slice(retry + 1);
}

// An account with its own quota can take over the chat. Prefer one that can
// resume the engine conversation, and never revisit a plan during one turn.
export function nextPlanAfterLimit(
  current: PlanConfig,
  plans: readonly PlanConfig[],
  unavailable: ReadonlySet<string>,
  conversationStore: (plan: PlanConfig) => string
): PlanConfig | null {
  const store = conversationStore(current);
  const candidates = plans.filter(
    (plan) =>
      plan.installed &&
      plan.id !== current.id &&
      !unavailable.has(plan.id) &&
      (plan.loggedIn || Boolean(plan.env?.ANTHROPIC_AUTH_TOKEN || plan.env?.ANTHROPIC_API_KEY))
  );
  const rank = (plan: PlanConfig): number =>
    conversationStore(plan) === store ? 0 : plan.engine === current.engine ? 1 : 2;
  return candidates.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
