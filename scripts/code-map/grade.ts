// The code-map test's answer key, grading, and results table. Pure, so the
// tests can check every rule without running an assistant.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { EngineEvent, TokenCount } from "../../src/main/engines/types.ts";

export const KINDS = ["find", "describe", "trace"] as const;
export type Kind = (typeof KINDS)[number];

// a string has to appear in the answer; a list means any one of them will do
export type Term = string | string[];

export interface Question {
  id: string;
  kind: Kind;
  question: string;
  // the right answer in prose, for the person checking the key and the runs
  answer: string;
  mustMention: Term[];
  // only a common wrong answer would say these
  mustNotMention?: string[];
  // someone read the answer against the code and agrees with it
  checked: boolean;
}

export interface AnswerKey {
  codebase: string;
  // the git repo, absolute or relative to the key file
  repo: string;
  // the commit the answers were checked against; the runs use exactly it
  commit: string;
  // who checked the answers, and how
  checkedBy?: string;
  questions: Question[];
}

const fold = (text: string): string => text.toLowerCase().replace(/\\/g, "/");

export function keyProblems(key: AnswerKey): string[] {
  const problems: string[] = [];
  if (!key.codebase) problems.push("codebase is missing");
  if (!key.repo) problems.push("repo is missing");
  if (!/^[0-9a-f]{40}$/.test(key.commit ?? "")) problems.push("commit must be a full 40-character sha");
  if (!Array.isArray(key.questions) || key.questions.length === 0) return [...problems, "there are no questions"];
  const seen = new Set<string>();
  for (const q of key.questions) {
    const at = q.id || "(no id)";
    if (!q.id) problems.push("a question has no id");
    else if (seen.has(q.id)) problems.push(`${at}: the id is used twice`);
    seen.add(q.id);
    if (!KINDS.includes(q.kind)) problems.push(`${at}: kind must be find, describe or trace`);
    if (!q.question?.trim()) problems.push(`${at}: the question is empty`);
    if (!q.answer?.trim()) problems.push(`${at}: the answer is empty`);
    const terms = Array.isArray(q.mustMention) ? q.mustMention : [];
    if (terms.length === 0) problems.push(`${at}: mustMention needs at least one term`);
    for (const t of terms) {
      const options = Array.isArray(t) ? t : [t];
      if (options.length === 0 || options.some((o) => typeof o !== "string" || !o.trim())) {
        problems.push(`${at}: mustMention has an empty term`);
        continue;
      }
      // a term the question already holds is in every answer that repeats it
      const free = options.find((o) => fold(q.question ?? "").includes(fold(o)));
      if (free) problems.push(`${at}: the question gives away the term "${free}"`);
    }
    if (problems.length === 0 && !grade(q, q.answer).correct) problems.push(`${at}: the key's own answer fails its grading terms`);
    if (typeof q.checked !== "boolean") problems.push(`${at}: checked must be true or false`);
  }
  return problems;
}

export function loadKey(file: string): AnswerKey & { repoPath: string } {
  const key = JSON.parse(readFileSync(file, "utf8")) as AnswerKey;
  const problems = keyProblems(key);
  if (problems.length > 0) throw new Error(`The answer key ${file} has problems:\n- ${problems.join("\n- ")}`);
  const repo = key.repo.replace(/^~(?=\/|$)/, homedir());
  return { ...key, repoPath: isAbsolute(repo) ? repo : resolve(dirname(file), repo) };
}

export interface Grade {
  correct: boolean;
  // terms the answer left out, and wrong-answer terms it used
  missing: string[];
  wrong: string[];
}

export function grade(q: Pick<Question, "mustMention" | "mustNotMention">, answer: string): Grade {
  const text = fold(answer);
  const missing = q.mustMention
    .filter((t) => !(Array.isArray(t) ? t : [t]).some((o) => text.includes(fold(o))))
    .map((t) => (Array.isArray(t) ? t.join(" or ") : t));
  const wrong = (q.mustNotMention ?? []).filter((t) => text.includes(fold(t)));
  return { correct: missing.length === 0 && wrong.length === 0, missing, wrong };
}

// The reply that answers the question: whatever the assistant wrote after
// its last tool call. Narration between tool calls ("let me look at...") is
// not the answer.
export function finalAnswer(events: readonly EngineEvent[]): string {
  const lastTool = events.map((e) => e.kind).lastIndexOf("tool");
  const after = events.slice(lastTool + 1).filter((e) => e.kind === "text");
  if (after.length > 0) return after.map((e) => (e.kind === "text" ? e.text : "")).join("\n\n");
  const last = [...events].reverse().find((e) => e.kind === "text");
  return last?.kind === "text" ? last.text : "";
}

const READERS = new Set(["cat", "sed", "head", "tail", "nl", "less", "more", "bat", "batcat", "view"]);

// Splits a shell command into words, keeping quoted parts whole. Enough for
// the read commands assistants run; not a shell parser.
function words(segment: string): string[] {
  const out: string[] = [];
  for (const m of segment.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

// Files a run opened to read, as paths inside the project: the Read tool,
// and shell read commands (cat, sed -n, head, nl and the like). Searches do
// not count. exists filters out words that only look like paths.
export function filesOpened(events: readonly EngineEvent[], cwd: string, exists: (path: string) => boolean): string[] {
  const found = new Set<string>();
  const note = (raw: string): void => {
    if (!raw) return;
    const path = isAbsolute(raw) ? relative(cwd, raw) : raw.replace(/^\.\//, "");
    if (!path || path.startsWith("..") || isAbsolute(path)) return;
    if (exists(path)) found.add(path);
  };
  for (const e of events) {
    if (e.kind !== "tool" || !e.step) continue;
    if (e.step.type === "explore" && e.step.label === "Read" && e.step.target) note(e.step.target);
    if (e.step.type !== "terminal" || !e.step.target) continue;
    for (const segment of e.step.target.split(/&&|\|\||[;|\n]/)) {
      const [command, ...args] = words(segment.trim());
      if (!command || !READERS.has(command.split("/").pop() ?? "")) continue;
      for (const arg of args) {
        if (!arg.startsWith("-") && /[./]/.test(arg) && !/[,*?{}$<>]/.test(arg)) note(arg);
      }
    }
  }
  return [...found].sort();
}

export interface RunRecord {
  // codebase/question/assistant/condition/repeat
  runId: string;
  codebase: string;
  questionId: string;
  kind: Kind;
  assistant: string;
  // the setup the run used (CONDITIONS); runs from before conditions had
  // names only say whether they had the map
  condition?: string;
  withMap: boolean;
  repeat: number;
  startedAt: string;
  // the run finished with an answer; false for a crash, a refusal or a timeout
  ok: boolean;
  error?: string;
  correct: boolean;
  missing: string[];
  wrong: string[];
  ms: number;
  // not every engine reports these (Gemini's plain text has neither)
  tokens?: TokenCount;
  // what the run would cost at API list prices, as Claude reports it: cached
  // tokens weighted far below fresh ones, output far above
  costUsd?: number;
  files?: string[];
  steps: number;
  // permission requests the runner turned down
  denied: number;
  answer: string;
  // files the run changed in the copy, undone before the next run
  edited?: string[];
  model?: string;
  // the answer key was not fully checked, so this run does not count
  trial?: boolean;
}

// Each comparison sets a changed setup against the usual one.
//   none / map: without and with the code map in front of the first message
//   full / lean: Claude as the app starts it, and with only the app's
//     browser connected and no skills or slash commands
export const COMPARISONS = { map: ["none", "map"], lean: ["full", "lean"] } as const;
export type ComparisonName = keyof typeof COMPARISONS;
const BASELINES = new Set<string>(Object.values(COMPARISONS).map(([base]) => base));
const LABELS: Record<string, string> = { none: "no map", map: "map", full: "full", lean: "lean" };

export function conditionOf(r: Pick<RunRecord, "condition" | "withMap">): string {
  return r.condition ?? (r.withMap ? "map" : "none");
}

export function runId(codebase: string, questionId: string, assistant: string, condition: string, repeat: number): string {
  return `${codebase}/${questionId}/${assistant}/${condition}/${repeat}`;
}

// A person's ruling on a run replaces the automatic grade: runId -> correct.
export type Overrides = Record<string, boolean>;

export function isCorrect(r: RunRecord, overrides: Overrides = {}): boolean {
  return r.ok && (overrides[r.runId] ?? r.correct);
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface ConditionSummary {
  runs: number;
  // runs that ended without an answer count as wrong, and are also listed
  failed: number;
  wrong: number;
  wrongRate: number;
  // the wrong-answer rate of each repeat, in repeat order
  wrongByRepeat: number[];
  medianMs?: number;
  medianTokens?: number;
  medianCost?: number;
  medianFiles?: number;
}

export function summarizeRuns(records: readonly RunRecord[], overrides: Overrides = {}): ConditionSummary {
  const repeats = [...new Set(records.map((r) => r.repeat))].sort((a, b) => a - b);
  const wrongRate = (rs: readonly RunRecord[]): number =>
    rs.length === 0 ? 0 : rs.filter((r) => !isCorrect(r, overrides)).length / rs.length;
  const done = records.filter((r) => r.ok);
  const counted = done.filter((r) => r.tokens);
  return {
    runs: records.length,
    failed: records.length - done.length,
    wrong: records.filter((r) => !isCorrect(r, overrides)).length,
    wrongRate: wrongRate(records),
    wrongByRepeat: repeats.map((n) => wrongRate(records.filter((r) => r.repeat === n))),
    medianMs: median(done.map((r) => r.ms)),
    medianTokens: median(counted.map((r) => (r.tokens?.input ?? 0) + (r.tokens?.output ?? 0))),
    medianCost: median(done.flatMap((r) => (r.costUsd === undefined ? [] : [r.costUsd]))),
    medianFiles: median(done.flatMap((r) => (r.files ? [r.files.length] : [])))
  };
}

export interface Comparison {
  assistant: string;
  // the usual setup and the changed one, by condition name
  baseName: string;
  variantName: string;
  base: ConditionSummary;
  variant: ConditionSummary;
  // how much the wrong-answer rate moved between repeats of the same setup:
  // the larger of the two setups' spreads
  noise: number;
  // wrong-answer rate before minus after; positive means fewer wrong answers
  drop: number;
  // fewer, or more, wrong answers by more than the noise. A change exactly as
  // big as the noise is not more than it; the rates are fractions of whole
  // runs, so they are compared past rounding error.
  helps: boolean;
  hurts: boolean;
  // median cost change as a fraction (-0.2 is 20% cheaper): the list-price
  // cost where the engine reports one, tokens otherwise
  costChange?: number;
}

function compare(assistant: string, records: readonly RunRecord[], overrides: Overrides): Comparison {
  const names = [...new Set(records.map(conditionOf))];
  const baseName = names.find((n) => BASELINES.has(n)) ?? "none";
  const variantName = names.find((n) => n !== baseName) ?? "map";
  const base = summarizeRuns(records.filter((r) => conditionOf(r) === baseName), overrides);
  const variant = summarizeRuns(records.filter((r) => conditionOf(r) === variantName), overrides);
  const spread = (xs: number[]): number => (xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs));
  const noise = Math.max(spread(base.wrongByRepeat), spread(variant.wrongByRepeat));
  const drop = base.wrongRate - variant.wrongRate;
  // with one repeat there is no noise estimate, so no change counts
  const measured = Math.min(base.wrongByRepeat.length, variant.wrongByRepeat.length) >= 2;
  const ratio = (before?: number, after?: number): number | undefined =>
    before === undefined || after === undefined || before === 0 ? undefined : (after - before) / before;
  const costChange = ratio(base.medianCost, variant.medianCost) ?? ratio(base.medianTokens, variant.medianTokens);
  return {
    assistant,
    baseName,
    variantName,
    base,
    variant,
    noise,
    drop,
    helps: measured && drop - noise > 1e-9,
    hurts: measured && -drop - noise > 1e-9,
    costChange
  };
}

export function compareAll(records: readonly RunRecord[], overrides: Overrides = {}): { byAssistant: Comparison[]; all: Comparison } {
  const assistants = [...new Set(records.map((r) => r.assistant))].sort();
  return {
    byAssistant: assistants.map((a) => compare(a, records.filter((r) => r.assistant === a), overrides)),
    all: compare("all", records, overrides)
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const secs = (ms?: number): string => (ms === undefined ? "n/a" : `${Math.round(ms / 1000)}s`);
const num = (n?: number): string => (n === undefined ? "n/a" : Math.round(n).toLocaleString("en-US"));
const usd = (n?: number): string => (n === undefined ? "n/a" : `$${n.toFixed(2)}`);
const change = (before?: number, after?: number): string =>
  before === undefined || after === undefined || before === 0
    ? "n/a"
    : `${after >= before ? "+" : ""}${Math.round(((after - before) / before) * 100)}%`;
const label = (name: string): string => LABELS[name] ?? name;

// The call: go when accuracy holds (wrong answers do not rise by more than
// the run-to-run noise) and the changed setup costs less.
export function reportMarkdown(records: readonly RunRecord[], overrides: Overrides = {}, title = "Code-map test"): string {
  const { byAssistant, all } = compareAll(records, overrides);
  const lines = [`# ${title}`, ""];
  if (records.some((r) => r.trial)) {
    lines.push("**Trial runs: the answer key was not fully checked, so these results do not count.**", "");
  }
  const codebases = [...new Set(records.map((r) => r.codebase))];
  const questions = new Set(records.map((r) => `${r.codebase}/${r.questionId}`)).size;
  const setups = `${label(all.baseName)} and ${label(all.variantName)}`;
  lines.push(
    `${records.length} runs: ${questions} questions on ${codebases.join(" and ")}, each set up two ways: ${setups}.`,
    "",
    "| Assistant | Setup | Runs | Wrong | Wrong by repeat | Failed | Median time | Median tokens | Median cost | Median files opened |",
    "|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const c of [...byAssistant, all]) {
    for (const [name, s] of [[c.baseName, c.base], [c.variantName, c.variant]] as const) {
      lines.push(
        `| ${c.assistant} | ${label(name)} | ${s.runs} | ${s.wrong} (${pct(s.wrongRate)}) | ${s.wrongByRepeat.map(pct).join(", ")} | ${s.failed} | ${secs(s.medianMs)} | ${num(s.medianTokens)} | ${usd(s.medianCost)} | ${num(s.medianFiles)} |`
      );
    }
  }
  lines.push(
    "",
    "Wrong counts failed runs too. Cost is Claude's own estimate at API list prices, where a cached token costs a tenth of a fresh one; it is the fairest measure of plan use the CLIs give. Engines that do not report something show n/a.",
    "",
    "## Go or no-go",
    ""
  );
  for (const c of [...byAssistant, all]) {
    const who = c.assistant === "all" ? "All assistants together" : c.assistant;
    const moved = `Wrong answers went from ${pct(c.base.wrongRate)} to ${pct(c.variant.wrongRate)}`;
    const accuracy =
      c.base.failed === c.base.runs && c.variant.failed === c.variant.runs
        ? "Every run failed, so there is nothing to compare."
        : c.base.wrongByRepeat.length < 2 || c.variant.wrongByRepeat.length < 2
          ? "Only one repeat ran, so there is no measure of run-to-run noise yet."
          : c.hurts
            ? `${moved}, more than the run-to-run noise of ${pct(c.noise)}: accuracy got worse.`
            : c.helps
              ? `${moved}, more than the run-to-run noise of ${pct(c.noise)}: accuracy got better.`
              : `${moved}, within the run-to-run noise of ${pct(c.noise)}: accuracy holds.`;
    const cost = `With ${label(c.variantName)}: median cost ${change(c.base.medianCost, c.variant.medianCost)}, tokens ${change(c.base.medianTokens, c.variant.medianTokens)}, time ${change(c.base.medianMs, c.variant.medianMs)}.`;
    lines.push(`- **${who}:** ${accuracy} ${cost}`);
  }
  const measured = all.base.wrongByRepeat.length >= 2 && all.variant.wrongByRepeat.length >= 2;
  const cheaper = all.costChange !== undefined && all.costChange < 0;
  lines.push(
    "",
    !measured
      ? "**No call yet.** It takes at least two repeats to measure run-to-run noise."
      : all.hurts
        ? `**No-go.** ${label(all.variantName)} gets more answers wrong, by more than the run-to-run noise.`
        : cheaper
          ? `**Go.** Accuracy holds and ${label(all.variantName)} costs ${Math.round(-(all.costChange ?? 0) * 100)}% less.`
          : `**No-go.** Accuracy holds, but ${label(all.variantName)} does not cost less.`,
    ""
  );
  return lines.join("\n");
}

// The file only ever grows, so runners for different assistants can share it.
// A run tried again (--retry-failed) adds a new line; the latest one counts.
export function readRecords(file: string): RunRecord[] {
  if (!existsSync(file)) return [];
  const latest = new Map<string, RunRecord>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as RunRecord;
    latest.delete(r.runId);
    latest.set(r.runId, r);
  }
  return [...latest.values()];
}
