import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { runEngine } from "../src/main/engines/index.ts";
import { claudeAdapter } from "../src/main/engines/claude.ts";
import { codexAdapter } from "../src/main/engines/codex.ts";
import { withCodeMap } from "../src/main/engines/codeMap.ts";
import type { EngineEvent, EngineKind, PlanConfig } from "../src/main/engines/types.ts";
import { buildCodeMap, importPath, LANGUAGE_NAMES, listFiles, loadLanguage, parseFile, rank, render } from "./code-map/map.ts";
import type { ParsedFile } from "./code-map/map.ts";
import { compareAll, filesOpened, finalAnswer, grade, keyProblems, loadKey, readRecords, reportMarkdown, runId } from "./code-map/grade.ts";
import type { AnswerKey, RunRecord } from "./code-map/grade.ts";
import { kimiTokens, prepareCopy, promptFor, readOnlyRequest, setupFor, shuffle } from "./code-map/run.ts";

const scratch = mkdtempSync(join(tmpdir(), "code-map-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const write = (root: string, files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

// ---- the map builder

test("every language's queries fit its grammar", async () => {
  for (const lang of LANGUAGE_NAMES) await loadLanguage(lang);
});

test("a TypeScript file gives its definitions, signatures, parents and imports", async () => {
  const f = await parseFile(
    "src/main/engines/index.ts",
    [
      'import { claudeAdapter } from "./claude.ts";',
      'import type { PlanConfig } from "../store";',
      'export * from "@/lib/api";',
      "export function runEngine(",
      "  plan: PlanConfig, // which CLI",
      "  opts: Options",
      "): Handle {",
      "  return claudeAdapter().buildArgs(opts);",
      "}",
      "export const ADAPTERS = { claude: claudeAdapter };",
      "const helper = (x: number) => x + 1;",
      "export class Store {",
      "  get(id: string): string { return id; }",
      "}",
      "interface Options { cwd: string }"
    ].join("\n")
  );
  assert.ok(f);
  assert.deepEqual(
    f.defs.map((d) => [d.name, d.line, d.parent ?? ""]),
    [["runEngine", 4, ""], ["ADAPTERS", 10, ""], ["helper", 11, ""], ["Store", 12, ""], ["get", 13, "Store"], ["Options", 15, ""]]
  );
  // the comment inside the parameters is gone; the body is left out
  assert.equal(f.defs[0].signature, "export function runEngine( plan: PlanConfig, opts: Options ): Handle");
  assert.equal(f.defs[4].signature, "get(id: string): string");
  assert.equal(f.defs[4].indent, 2);
  assert.deepEqual([...f.imports].sort(), ["lib/api", "src/main/engines/claude", "src/main/store"]);
  assert.ok(f.refs.has("claudeAdapter") && f.refs.has("buildArgs") && f.refs.has("PlanConfig"));
  // a definition's own name is not a use of it
  assert.ok(!f.refs.has("runEngine"));
});

test("a Python file gives its definitions and resolves relative imports", async () => {
  const f = await parseFile(
    "backend/app/services/screen.py",
    [
      "import json",
      "from app.models.user import User",
      "from .helpers import clean as tidy",
      "from . import memory",
      "from ..core import db",
      "",
      "class Screener:",
      "    def __init__(self):",
      "        pass",
      "    def run(self, user: User) -> dict:",
      "        def inner():",
      "            return tidy(user)",
      "        return memory.append(inner())"
    ].join("\n")
  );
  assert.ok(f);
  // __init__ is called by the language, not by name, so it is left out
  assert.deepEqual(
    f.defs.map((d) => [d.name, d.parent ?? ""]),
    [["Screener", ""], ["run", "Screener"], ["inner", "run"]]
  );
  assert.equal(f.defs[1].signature, "def run(self, user: User) -> dict");
  assert.deepEqual(
    [...f.imports].sort(),
    [
      "app/models/user",
      "app/models/user/User",
      "backend/app/core",
      "backend/app/core/db",
      "backend/app/services",
      "backend/app/services/helpers",
      "backend/app/services/helpers/clean",
      "backend/app/services/memory",
      "json"
    ]
  );
});

test("import paths resolve the way each language writes them", () => {
  assert.equal(importPath('"./engines/index.ts"', "typescript", "src/main/index.ts"), "src/main/engines/index");
  assert.equal(importPath("'../x/y'", "javascript", "a/b/c.js"), "a/x/y");
  assert.equal(importPath('"@/features/auth/api"', "tsx", "src/app.tsx"), "features/auth/api");
  assert.equal(importPath("app.core.db", "python", "backend/app/x.py"), "app/core/db");
  assert.equal(importPath("...shared", "python", "a/b/c/d.py"), "a/shared");
  assert.equal(importPath("crate::engine::{run, stop}", "rust", "src/main.rs"), "engine");
  assert.equal(importPath("com.civly.Store", "java", "src/A.java"), "com/civly/Store");
});

const parsed = (path: string, defs: Array<[string, string?]>, refs: string[], imports: string[], lang = "typescript"): ParsedFile => ({
  path,
  lang,
  defs: defs.map(([name, parent], i) => ({ name, line: i + 1, signature: `function ${name}()`, indent: parent ? 2 : 0, ...(parent ? { parent } : {}) })),
  refs: new Set(refs),
  imports: new Set(imports)
});

test("ranking counts only files that use a name and import its file", () => {
  const ranking = rank([
    parsed("src/a.ts", [["helper"], ["unused"]], [], []),
    parsed("src/b.ts", [], ["helper"], ["src/a"]),
    parsed("src/c.ts", [], ["helper"], ["src/a"]),
    // uses the name but never imports a.ts: a different helper
    parsed("src/d.ts", [], ["helper"], []),
    // two imported files define it: each gets half
    parsed("src/e.ts", [["helper"]], [], []),
    parsed("src/f.ts", [], ["helper"], ["src/a", "src/e"])
  ]);
  const score = (path: string, name: string): number | undefined =>
    ranking.defs.find((d) => d.path === path && d.name === name)?.score;
  assert.equal(score("src/a.ts", "helper"), 2.5);
  assert.equal(score("src/a.ts", "unused"), 0);
  assert.equal(score("src/e.ts", "helper"), 0.5);
  assert.equal(ranking.files[0].path, "src/a.ts");
  assert.equal(ranking.files[0].score, 2.5);
  assert.equal(ranking.defs[0].name, "helper");
});

test("a method counts only where its class is named too", () => {
  const ranking = rank([
    parsed("store.ts", [["Store"], ["get", "Store"]], [], []),
    // dict-style .get on something else
    parsed("one.ts", [], ["get"], ["store"]),
    parsed("two.ts", [], ["Store", "get"], ["store"])
  ]);
  assert.equal(ranking.defs.find((d) => d.name === "get")?.score, 1);
  assert.equal(ranking.defs.find((d) => d.name === "Store")?.score, 1);
});

test("a package's __init__ passes its imports through, and Go sees its own folder", () => {
  const ranking = rank([
    parsed("app/services/__init__.py", [], [], ["app/services/memory"], "python"),
    parsed("app/services/memory.py", [["append"]], [], [], "python"),
    parsed("app/api.py", [], ["append"], ["app/services"], "python"),
    parsed("pkg/a.go", [["Run"]], [], [], "go"),
    parsed("pkg/b.go", [], ["Run"], [], "go")
  ]);
  assert.equal(ranking.defs.find((d) => d.name === "append")?.score, 1);
  assert.equal(ranking.defs.find((d) => d.name === "Run")?.score, 1);
});

test("the map fills best first and records exactly what it cut", () => {
  const files = [
    parsed("top.ts", [["a"], ["b"]], [], []),
    parsed("mid.ts", [["c"]], [], []),
    parsed("low.ts", [["d"]], [], []),
    parsed("bare.ts", [], ["a", "b", "c"], ["top", "mid"]),
    parsed("bare2.ts", [], ["a", "b"], ["top"])
  ];
  const ranking = rank(files);
  const full = render(ranking, 10_000);
  assert.equal(full.cut.files.length + full.cut.definitions.length, 0);
  assert.equal(full.shownFiles, 5);
  assert.match(full.text, /^top\.ts\n  function a\(\)\n  function b\(\)\nmid\.ts\n  function c\(\)\n/);

  // room for the top file only
  const small = render(ranking, 12);
  assert.ok(small.tokens <= 12);
  assert.equal(small.text, "top.ts\n  function a()\n  function b()\n");
  assert.deepEqual(small.cut.definitions.map((d) => d.name), ["c", "d"]);
  assert.deepEqual(small.cut.files, ["mid.ts", "bare.ts", "bare2.ts", "low.ts"]);
});

test("building a map of a folder skips dependencies and reports its size", async () => {
  const root = join(scratch, "project");
  write(root, {
    "src/util.ts": "export function slugify(s: string): string { return s; }\n",
    "src/page.ts": 'import { slugify } from "./util";\nexport function render() { return slugify("x"); }\n',
    "node_modules/dep/index.js": "function hidden() {}\n",
    "README.md": "# not code\n"
  });
  assert.deepEqual(listFiles(root), ["README.md", "src/page.ts", "src/util.ts"]);
  const map = await buildCodeMap(root, 100);
  assert.equal(map.sourceFiles, 2);
  assert.equal(map.definitions, 2);
  assert.match(map.text, /^src\/util\.ts\n  export function slugify\(s: string\): string\n/);
  assert.deepEqual(map.unreadable, []);
});

// ---- the map switch

test("the map goes in front of a new chat's first message, the same for every engine", async () => {
  const bin = join(scratch, "fake-cli");
  // writes its arguments and first stdin line where OUT says, then exits
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n---arg---\\n" "$@" > "$OUT.args"\nif [ ! -t 0 ]; then head -n 1 > "$OUT.stdin"; fi\nexit 0\n');
  chmodSync(bin, 0o755);
  const map = "src/a.ts\n  export function a()\n";
  const sent = async (engine: EngineKind, resumeId?: string): Promise<string> => {
    const out = join(scratch, `${engine}-${resumeId ?? "new"}`);
    const plan: PlanConfig = { id: engine, label: engine, engine, bin, extraArgs: [], color: "", installed: true, env: { OUT: out } };
    await runEngine(plan, { prompt: "Where is X?", cwd: scratch, codeMap: map, resumeId }, () => {}).done;
    if (engine === "claude") return (JSON.parse(readFileSync(`${out}.stdin`, "utf8")) as { message: { content: string } }).message.content;
    const args = readFileSync(`${out}.args`, "utf8").split("\n---arg---\n");
    return args.find((a) => a.includes("Where is X?")) ?? "";
  };
  const expected = withCodeMap(map, "Where is X?");
  assert.match(expected, /^\[Note from the app: below is a map of this project's code[^\]]*\]\n\nsrc\/a\.ts\n  export function a\(\)\n\n---\n\nMy message:\nWhere is X\?$/);
  for (const engine of ["claude", "codex", "kimi", "gemini"] as const) {
    assert.equal(await sent(engine), expected, engine);
    // a resumed chat already has the map
    assert.equal(await sent(engine, "s1"), "Where is X?", `${engine} resumed`);
  }
});

test("Claude and Codex report the tokens a run used, and Claude its list-price cost", () => {
  const events: EngineEvent[] = [];
  claudeAdapter().parseLine(
    JSON.stringify({
      type: "result",
      is_error: false,
      total_cost_usd: 0.42,
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 2, outputTokens: 30, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 },
        "claude-haiku-4-5": { inputTokens: 5, outputTokens: 1 }
      }
    }),
    (e) => events.push(e)
  );
  codexAdapter().parseLine(
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 9 } }),
    (e) => events.push(e)
  );
  assert.deepEqual(
    events.map((e) => (e.kind === "done" ? e.tokens : undefined)),
    [{ input: 127, output: 31 }, { input: 500, output: 9 }]
  );
  assert.deepEqual(
    events.map((e) => (e.kind === "done" ? e.costUsd : undefined)),
    [0.42, undefined]
  );
});

// ---- grading

const question = { mustMention: ["runEngine", ["engines/index.ts", "src/main/engines"]], mustNotMention: ["usage.ts"] };

test("an answer is right when it names every required term and no wrong one", () => {
  assert.deepEqual(grade(question, "It is `runEngine` in src/main/engines/index.ts."), { correct: true, missing: [], wrong: [] });
  assert.deepEqual(grade(question, "RUNENGINE, in src\\main\\engines"), { correct: true, missing: [], wrong: [] });
  assert.deepEqual(grade(question, "runEngine somewhere"), {
    correct: false,
    missing: ["engines/index.ts or src/main/engines"],
    wrong: []
  });
  assert.equal(grade(question, "runEngine in engines/index.ts, called from usage.ts").correct, false);
});

test("the answer is what the assistant wrote after its last tool call", () => {
  const events: EngineEvent[] = [
    { kind: "text", text: "Let me look at index.ts." },
    { kind: "tool", name: "Read", step: { type: "explore", label: "Read", target: "src/a.ts" } },
    { kind: "tool_result", ok: true },
    { kind: "text", text: "It is in a.ts." },
    { kind: "text", text: "The caller is b.ts." },
    { kind: "done", ok: true }
  ];
  assert.equal(finalAnswer(events), "It is in a.ts.\n\nThe caller is b.ts.");
  assert.equal(finalAnswer([{ kind: "text", text: "only" }, { kind: "tool", name: "x" }]), "only");
});

test("files opened come from reads and shell read commands, not searches", () => {
  const cwd = "/work/repo";
  const real = new Set(["src/a.ts", "src/b.ts", "src/c.py", "README.md"]);
  const tool = (name: string, type: "explore" | "terminal", target: string, label = "Read"): EngineEvent => ({
    kind: "tool",
    name,
    step: { type, label, target }
  });
  const events: EngineEvent[] = [
    tool("Read", "explore", "/work/repo/src/a.ts"),
    tool("Grep", "explore", "runEngine in src", "Search"),
    tool("bash", "terminal", "sed -n '1,120p' src/b.ts && nl -ba ./src/c.py | head -40"),
    tool("bash", "terminal", "rg -n helper src/ ; cat README.md missing.ts"),
    tool("bash", "terminal", "cat /etc/hosts"),
    { kind: "tool", name: "x" }
  ];
  assert.deepEqual(filesOpened(events, cwd, (p) => real.has(p)), ["README.md", "src/a.ts", "src/b.ts", "src/c.py"]);
});

test("an answer key is checked for the mistakes a person could make", () => {
  const good: AnswerKey = {
    codebase: "x",
    repo: ".",
    commit: "a".repeat(40),
    questions: [{ id: "find-01", kind: "find", question: "Where?", answer: "In a.ts.", mustMention: ["a.ts"], checked: false }]
  };
  assert.deepEqual(keyProblems(good), []);
  const bad = {
    ...good,
    commit: "abc123",
    questions: [
      { ...good.questions[0], mustMention: [] },
      { ...good.questions[0], kind: "guess" as never, mustMention: [[]] as never },
      // describe questions name their function, so the name proves nothing
      { ...good.questions[0], id: "describe-01", question: "What does BaseTask.run do?", mustMention: [["caller.py", "Task"]] }
    ]
  };
  assert.deepEqual(keyProblems({ ...good, questions: [{ ...good.questions[0], mustMention: ["b.ts"] }] }), [
    "find-01: the key's own answer fails its grading terms"
  ]);
  assert.deepEqual(keyProblems(bad), [
    "commit must be a full 40-character sha",
    "find-01: mustMention needs at least one term",
    "find-01: the id is used twice",
    "find-01: kind must be find, describe or trace",
    "find-01: mustMention has an empty term",
    'describe-01: the question gives away the term "Task"'
  ]);
});

test("this repo's answer key is well formed: 30 questions, 10 of each kind", () => {
  const key = loadKey(join(import.meta.dirname, "code-map", "questions", "civly-coding-platform.json"));
  assert.equal(key.repoPath, join(import.meta.dirname, ".."));
  assert.equal(key.questions.length, 30);
  for (const kind of ["find", "describe", "trace"]) assert.equal(key.questions.filter((q) => q.kind === kind).length, 10);
});

// ---- results

// the changed setup of each pair below is slower and bigger: 60s against
// 50s, 12,000 tokens against 10,000, $0.60 against $0.50
const CHANGED = new Set(["map", "lean"]);
const record = (assistant: string, questionId: string, condition: string, repeat: number, correct: boolean, extra: Partial<RunRecord> = {}): RunRecord => ({
  runId: runId("x", questionId, assistant, condition, repeat),
  codebase: "x",
  questionId,
  kind: "find",
  assistant,
  condition,
  withMap: condition === "map",
  repeat,
  startedAt: "",
  ok: true,
  correct,
  missing: [],
  wrong: [],
  ms: CHANGED.has(condition) ? 60_000 : 50_000,
  tokens: { input: CHANGED.has(condition) ? 12_000 : 10_000, output: 0 },
  files: CHANGED.has(condition) ? ["a"] : ["a", "b"],
  steps: 2,
  denied: 0,
  answer: "",
  ...extra
});

// ten questions, two repeats; wrong answers per repeat as given
const runs = (assistant: string, wrongBase: [number, number], wrongChanged: [number, number], [base, changed] = ["none", "map"]): RunRecord[] =>
  [1, 2].flatMap((repeat) =>
    Array.from({ length: 10 }, (_, i) => [
      record(assistant, `q${i}`, base, repeat, i >= wrongBase[repeat - 1]),
      record(assistant, `q${i}`, changed, repeat, i >= wrongChanged[repeat - 1])
    ]).flat()
  );
const lean = (wrongFull: [number, number], wrongLean: [number, number], leanCost = 0.4): RunRecord[] =>
  runs("claude", wrongFull, wrongLean, ["full", "lean"]).map((r) => ({ ...r, costUsd: r.condition === "lean" ? leanCost : 0.5 }));

test("accuracy changes only when wrong answers move by more than the repeat-to-repeat noise", () => {
  const records = [...runs("claude", [5, 4], [1, 1]), ...runs("codex", [3, 1], [2, 2]), ...runs("kimi", [1, 1], [5, 4])];
  const { byAssistant, all } = compareAll(records);
  const [claude, codex, kimi] = byAssistant;
  assert.equal(claude.baseName, "none");
  assert.equal(claude.variantName, "map");
  assert.equal(claude.base.wrongRate, 0.45);
  assert.equal(claude.variant.wrongRate, 0.1);
  assert.ok(Math.abs(claude.noise - 0.1) < 1e-9);
  assert.deepEqual([claude.helps, claude.hurts], [true, false]);
  // codex: 20% to 20%, with 20 points of noise
  assert.deepEqual([codex.helps, codex.hurts], [false, false]);
  assert.deepEqual([kimi.helps, kimi.hurts], [false, true]);
  assert.equal(all.hurts, false);
  assert.equal(claude.base.medianMs, 50_000);
  assert.equal(claude.variant.medianTokens, 12_000);
  assert.equal(claude.base.medianFiles, 2);
  // a run that answered without opening anything counts as zero files; an
  // engine that cannot say is left out
  const quiet = compareAll([
    record("kimi", "q1", "map", 1, true, { files: [], steps: 0 }),
    record("kimi", "q2", "map", 1, true, { files: [] }),
    record("kimi", "q3", "map", 1, true, { files: ["a", "b", "c"] }),
    record("gemini", "q1", "map", 1, true, { files: undefined, steps: 0 })
  ]);
  assert.equal(quiet.byAssistant[1].variant.medianFiles, 0);
  assert.equal(quiet.byAssistant[0].variant.medianFiles, undefined);
});

test("a change the same size as the noise is not a clear difference", () => {
  // 5% to about 1.7% wrong, with repeats 3.3 points apart: 3.3 is not more than 3.3
  const records = [...runs("claude", [2, 1], [0, 1]), ...runs("claude", [0, 0], [0, 0]).map((r) => ({ ...r, questionId: `x${r.questionId}`, runId: `${r.runId}x` })), ...runs("claude", [0, 0], [0, 0]).map((r) => ({ ...r, questionId: `y${r.questionId}`, runId: `${r.runId}y` }))];
  const [claude] = compareAll(records).byAssistant;
  assert.ok(Math.abs(claude.drop - claude.noise) < 1e-9);
  assert.equal(claude.helps, false);
});

test("cost compares Claude's list-price estimate, or tokens where there is none", () => {
  assert.ok(Math.abs((compareAll(lean([1, 1], [1, 1])).all.costChange ?? 0) + 0.2) < 1e-9);
  assert.ok(Math.abs((compareAll(runs("codex", [1, 1], [1, 1])).all.costChange ?? 0) - 0.2) < 1e-9);
});

test("runs saved before setups had names still read as map or no map", () => {
  const old = runs("claude", [1, 1], [1, 1]).map(({ condition: _c, ...r }) => r as RunRecord);
  const [claude] = compareAll(old).byAssistant;
  assert.deepEqual([claude.baseName, claude.variantName, claude.base.runs, claude.variant.runs], ["none", "map", 20, 20]);
});

test("a person's ruling replaces the automatic grade, and failed runs count as wrong", () => {
  const records = runs("kimi", [0, 0], [0, 0]);
  records[0] = { ...records[0], ok: false, error: "timed out" };
  const { byAssistant } = compareAll(records, { [records[2].runId]: false });
  assert.equal(byAssistant[0].base.wrong, 2);
  assert.equal(byAssistant[0].base.failed, 1);
});

test("the report gives a table per assistant and a plain go or no-go", () => {
  const go = reportMarkdown(lean([2, 1], [1, 2]), {}, "Lean test");
  assert.match(go, /each set up two ways: full and lean\./);
  assert.match(go, /\| claude \| full \| 20 \| 3 \(15%\) \| 20%, 10% \| 0 \| 50s \| 10,000 \| \$0\.50 \| 2 \|/);
  assert.match(go, /\| claude \| lean \| 20 \| 3 \(15%\) \| 10%, 20% \| 0 \| 60s \| 12,000 \| \$0\.40 \| 1 \|/);
  assert.match(go, /Wrong answers went from 15% to 15%, within the run-to-run noise of 10%: accuracy holds\. With lean: median cost -20%, tokens \+20%, time \+20%\./);
  assert.match(go, /\*\*Go\.\*\* Accuracy holds and lean costs 20% less\./);
  const worse = reportMarkdown(lean([1, 1], [5, 4]));
  assert.match(worse, /more than the run-to-run noise of 10%: accuracy got worse\./);
  assert.match(worse, /\*\*No-go\.\*\* lean gets more answers wrong/);
  assert.match(reportMarkdown(lean([1, 1], [1, 1], 0.6)), /\*\*No-go\.\*\* Accuracy holds, but lean does not cost less\./);
  assert.match(reportMarkdown(runs("claude", [5, 4], [1, 1])), /more than the run-to-run noise of 10%: accuracy got better\. With map: median cost n\/a, tokens \+20%/);
  const trial = reportMarkdown(lean([1, 1], [1, 1]).map((r) => ({ ...r, trial: true })));
  assert.match(trial, /Trial runs: the answer key was not fully checked/);
  const once = reportMarkdown(lean([3, 1], [2, 2]).filter((r) => r.repeat === 1));
  assert.match(once, /Only one repeat ran/);
  assert.match(once, /\*\*No call yet\.\*\* It takes at least two repeats/);
  const failed = reportMarkdown(runs("gemini", [0, 0], [0, 0]).map((r) => ({ ...r, ok: false, error: "not signed in" })));
  assert.match(failed, /\*\*gemini:\*\* Every run failed, so there is nothing to compare\./);
});

test("a run tried again counts once, as its latest result", () => {
  const file = join(scratch, "runs.jsonl");
  const first = record("kimi", "q1", "map", 1, false, { ok: false, error: "limit" });
  const other = record("codex", "q1", "map", 1, true);
  writeFileSync(file, [first, other, { ...first, ok: true, correct: true }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const records = readRecords(file);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => [r.assistant, r.ok]), [["codex", true], ["kimi", true]]);
});

// ---- the runner

test("the runner lets reads through and turns down anything that could change the copy", () => {
  assert.equal(readOnlyRequest("Read", { file_path: "a.ts" }), true);
  assert.equal(readOnlyRequest("Bash", { command: "grep -rn foo src 2>/dev/null | head -20" }), true);
  assert.equal(readOnlyRequest("Bash", { command: "git log --oneline -5 && ls src" }), true);
  assert.equal(readOnlyRequest("Bash", { command: "echo x > a.ts" }), false);
  assert.equal(readOnlyRequest("Bash", { command: "sed -i 's/a/b/' a.ts" }), false);
  assert.equal(readOnlyRequest("Bash", { command: "find . -name '*.pyc' -delete" }), false);
  assert.equal(readOnlyRequest("Bash", { command: "git checkout main" }), false);
  assert.equal(readOnlyRequest("Bash", { command: "npm install" }), false);
  assert.equal(readOnlyRequest("Edit", { file_path: "a.ts" }), false);
});

test("each setup starts the engine its own way", () => {
  const none = setupFor("claude", "none", "MAP");
  assert.deepEqual([none.plan.extraArgs, none.codeMap, none.browser], [[], undefined, undefined]);
  const map = setupFor("codex", "map", "MAP");
  assert.deepEqual([map.plan.extraArgs, map.codeMap, map.browser], [[], "MAP", undefined]);
  // Claude as the app starts it, with the app's browser, against the same
  // with nothing else connected and no skills
  const full = setupFor("claude", "full", "MAP");
  assert.deepEqual([full.plan.extraArgs, full.codeMap], [[], undefined]);
  assert.match(full.browser?.args.join(" ") ?? "", /chrome-devtools-mcp/);
  const lean = setupFor("claude", "lean", "MAP");
  assert.deepEqual(lean.plan.extraArgs, ["--strict-mcp-config", "--disable-slash-commands"]);
  assert.deepEqual(lean.browser, full.browser);
});

test("a lean Claude chat keeps only the browser it is given", async () => {
  const bin = join(scratch, "fake-claude");
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$OUT"\nexit 0\n');
  chmodSync(bin, 0o755);
  const out = join(scratch, "lean-args");
  const { plan, browser } = setupFor("claude", "lean", "");
  await runEngine({ ...plan, bin, env: { OUT: out } }, { prompt: "Where?", cwd: scratch, browser }, () => {}).done;
  const args = readFileSync(out, "utf8").split("\n");
  assert.deepEqual(args.slice(0, 2), ["--strict-mcp-config", "--disable-slash-commands"]);
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(config.mcpServers), ["browser"]);
});

test("Kimi's tokens come from its session log", () => {
  const home = join(scratch, "kimi-home");
  const usage = (inputOther: number, output: number, inputCacheRead: number): string =>
    JSON.stringify({ type: "usage.record", usage: { inputOther, output, inputCacheRead, inputCacheCreation: 0 } });
  write(home, {
    "sessions/wd_x/session_1/agents/main/wire.jsonl": [usage(100, 10, 1000), '{"type":"turn.ended"}', usage(50, 5, 2000)].join("\n"),
    "sessions/wd_x/session_1/agents/helper/wire.jsonl": usage(1, 1, 0),
    "sessions/wd_y/session_2/agents/main/wire.jsonl": usage(9, 9, 9)
  });
  assert.deepEqual(kimiTokens("session_1", home), { input: 3151, output: 16 });
  assert.equal(kimiTokens("session_3", home), undefined);
});

test("runs interleave in a fixed order for a given seed", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(shuffle(items, 42), shuffle(items, 42));
  assert.notDeepEqual(shuffle(items, 42), items);
  assert.deepEqual([...shuffle(items, 7)].sort((a, b) => a - b), items);
});

test("every question gets the same words around it, map or not", () => {
  assert.equal(
    promptFor({ id: "f", kind: "find", question: "Where is X?", answer: "", mustMention: ["x"], checked: true }),
    "Where is X?\n\nAnswer from this project's code, and name the files and functions involved. This is a question only: do not change any files."
  );
});

test("assistants work in a clean copy at the key's commit, without the answer key", () => {
  const repo = join(scratch, "repo");
  write(repo, { "src/a.ts": "export const a = 1;\n", "questions/key.json": "{}" });
  const g = (...args: string[]): string =>
    spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).stdout.trim();
  g("init", "-q");
  g("add", "-A");
  g("commit", "-q", "-m", "one");
  const commit = g("rev-parse", "HEAD");
  // later work is not part of the copy
  write(repo, { "src/a.ts": "export const a = 2;\n" });
  const key = { codebase: "My Repo", repo, repoPath: repo, commit, questions: [] };
  const copy = prepareCopy(key, join(repo, "questions", "key.json"), join(scratch, "copies"));
  // the real path, not the /var link macOS's temp folder sits behind
  assert.equal(copy, realpathSync(copy));
  assert.equal(readFileSync(join(copy, "src", "a.ts"), "utf8"), "export const a = 1;\n");
  assert.equal(existsSync(join(copy, "questions", "key.json")), false);
  const log = spawnSync("git", ["-C", copy, "log", "--oneline"], { encoding: "utf8" }).stdout.trim().split("\n");
  assert.equal(log.length, 1);
  // a second call reuses the clean copy
  assert.equal(prepareCopy(key, join(repo, "questions", "key.json"), join(scratch, "copies")), copy);
});
