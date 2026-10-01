import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PlanConfig } from "./engines/types.ts";

const SKILL_PATH = join(homedir(), ".agents", "skills", "no-ai-speak", "SKILL.md");
const SHARED_SCANNER = join(homedir(), ".agents", "skills", "no-ai-speak", "scan.mjs");

// A no-ai-speak skill in ~/.agents/skills, when present, supplies the scanner
// (scan.mjs, loaded at runtime) and the rules, so this filter and any other
// tool reading that skill change together. Without it, the bundled fallback
// below runs, and is deliberately minimal.
const FALLBACK_PATTERNS: Array<[string, RegExp]> = [
  ["worth noting", /(^|[.!?]\s|also,? )worth noting/im],
  ["to be clear", /(^|[.!?]\s)to be clear/im],
  ["honest as a label", /to be honest|\bhonest (answer|gap|caveat|accounting|ledger|assessment|take|read|view|account)\b|(^|[.!?]\s)honestly\b/im],
  ["story framing", /numbers are in[^.\n]{0,60}\btell\b|tells? a sharp story|the plot twist:/i],
  ["say the word dangle", /say the word and (I|we)/i],
  ["the hard truth", /the hard truth (is|first)\b|here'?s the hard truth/i],
  ["em dash", /—/],
  ["semicolon", /;/],
  ["dollar amount", /\$\s?\d/]
];

function localScan(text: string): string[] {
  const prose = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/"[^"\n]{1,400}"/g, " ")
    .replace(/\u201c[^\u201d\n]{1,400}\u201d/g, " ");
  return FALLBACK_PATTERNS.filter(([, re]) => re.test(prose)).map(([label]) => label);
}

let sharedScan: ((text: string) => string[]) | null = null;
let sharedLoaded = false;
async function ensureSharedScanner(): Promise<void> {
  if (sharedLoaded) return;
  sharedLoaded = true;
  try {
    const mod = (await import(pathToFileURL(SHARED_SCANNER).href)) as {
      scanText?: unknown;
    };
    if (typeof mod.scanText === "function") {
      sharedScan = mod.scanText as (text: string) => string[];
    }
  } catch {
    // skills directory missing: localScan stays active
  }
}
void ensureSharedScanner();

export function scanText(text: string): string[] {
  return sharedScan ? sharedScan(text) : localScan(text);
}

// Condensed fallback used only when the skill file is missing.
const FALLBACK_RULES = `Banned patterns: announced facts ("Worth noting:", "The key insight:", "One bug, caught and fixed:"), the word "honest", announcer titles, precision flourishes ("not asserted"), coined labels, metaphors instead of plain statements, semicolon chains, anthropomorphic verbs (estimates "land", caveats "surface"), self-referential meta, clipped fragments, story framing and teasers, dangled follow-ups, rule and provenance narration, inverted Yoda constructions, repair preambles ("You're right. Restating it straight:").
Plain-English rules: first paragraph readable by a non-technical reader, bad news leads with the real number, no em dashes, no shrinking words ("minor", "slight", "just") on real problems.`;

function loadRules(): string {
  try {
    const md = readFileSync(SKILL_PATH, "utf8");
    const start = md.indexOf("## The banned patterns");
    const end = md.indexOf("## Procedure");
    if (start !== -1 && end !== -1 && end > start) {
      return md.slice(start, end).trim();
    }
  } catch {
    // skill file missing, use bundled fallback
  }
  return FALLBACK_RULES;
}

export interface FilterResult {
  text: string;
  changed: boolean;
  hits?: string[];
  error?: string;
}

// The deterministic local scan decides clean versus flagged. Clean text is
// returned untouched without any model call. The model is only ever a
// rewriter for text the scan already flagged (glm-5.3-flash proved
// non-deterministic as a judge on 2026-09-24: the same paragraph came back
// clean in one run and flagged in the next, and it kept polishing already
// clean prose).
export async function filterText(
  text: string,
  zaiPlan: PlanConfig | undefined
): Promise<FilterResult> {
  await ensureSharedScanner();
  const hits = scanText(text);
  if (hits.length === 0) {
    return { text, changed: false };
  }

  const env = zaiPlan?.env;
  const key = env?.ANTHROPIC_AUTH_TOKEN;
  if (!key) {
    return { text, changed: false, hits, error: "filter not configured (Z.ai key missing)" };
  }
  const base = env?.ANTHROPIC_BASE_URL ?? "https://api.z.ai/api/anthropic";

  const system =
    "You are a house-style rewriter. The text contains these banned patterns: " +
    hits.join(", ") +
    ". Return only the full rewritten text with every banned pattern removed and every fact kept. " +
    "Never change code blocks, command lines, file paths, URLs, numbers, dollar amounts, names, direct quotes, or citations. Rewrite prose only. " +
    "Preserve the original structure: headings, lists, paragraph breaks, tables. No code fence around the whole reply. " +
    "No em dashes in rewritten prose. Never add new facts and never remove facts. No commentary.\n" +
    "The rules to enforce:\n" +
    loadRules();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "glm-5.3-flash",
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: text }]
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      return { text, changed: false, hits, error: `filter service returned ${res.status}` };
    }
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const out = (data.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    if (!out) {
      return { text, changed: false, hits, error: "filter returned empty text" };
    }
    return { text: out, changed: true, hits };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text, changed: false, hits, error: `filter call failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}
