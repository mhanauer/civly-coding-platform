// The code-map test runner: every question in an answer key, on each
// assistant, with and without the code map, each in a fresh chat. Runs go
// through the app's own engine code (runEngine), so the assistants start
// exactly as they do in a chat. Usage:
//
//   node --experimental-strip-types scripts/code-map/run.ts --key <key.json> [--compare map|lean]
//     [--assistants claude,codex,kimi,gemini] [--repeats 2] [--questions find-01,trace-02]
//     [--tokens 8000] [--model claude=claude-opus-5-5] [--timeout 900] [--out <dir>]
//     [--retry-failed] [--allow-unchecked]
//   node --experimental-strip-types scripts/code-map/run.ts --report <dir> [<dir>...]
//
// --out picks up where an earlier run in that folder stopped. Results go to
// ~/.coding-plan-hub/code-map/results unless --out says otherwise, so a
// private codebase's answers never land in this repo.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { browserServer } from "../../src/main/chromeBrowser.ts";
import { runEngine } from "../../src/main/engines/index.ts";
import type { EngineEvent, EngineKind, McpServer, PlanConfig, RunHandle, TokenCount } from "../../src/main/engines/types.ts";
import { describeMap } from "./build-map.ts";
import { buildCodeMap, DEFAULT_TOKENS } from "./map.ts";
import { COMPARISONS, filesOpened, finalAnswer, grade, loadKey, readRecords, reportMarkdown, runId } from "./grade.ts";
import type { AnswerKey, ComparisonName, Overrides, Question, RunRecord } from "./grade.ts";

const ENGINES: EngineKind[] = ["claude", "codex", "kimi", "gemini"];
const RESULTS = join(homedir(), ".coding-plan-hub", "code-map", "results");
// an assistant that fails this many runs in a row (a plan limit, a lost
// login) is stopped rather than failing the rest of its queue
const STOP_AFTER_FAILURES = 3;

// The same words follow every question, with or without the map. Grading
// looks for function and file names, and an assistant told to write plain
// English for its user leaves them out of a right answer unless asked.
export function promptFor(q: Question): string {
  return `${q.question}\n\nAnswer from this project's code, and name the files and functions involved. This is a question only: do not change any files.`;
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const READ_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "sed", "nl", "grep", "rg", "find", "wc", "tree", "file", "stat", "pwd", "echo", "awk", "sort", "uniq", "cut", "git"
]);

// Claude asks before tools it may not run alone. Reading is the job, so reads
// go through; anything that could change the copy is turned down.
export function readOnlyRequest(tool: string, input: Record<string, unknown> | undefined): boolean {
  if (READ_TOOLS.has(tool)) return true;
  if (tool !== "Bash") return false;
  const command = String(input?.command ?? "").replace(/2>\/dev\/null|2>&1/g, "");
  if (/[>`]|\$\(|\bsed\s+-i|-delete\b|-exec\b/.test(command)) return false;
  return command.split(/&&|\|\||[;|\n]/).every((segment) => {
    const [word = ""] = segment.trim().split(/\s+/);
    if (!word) return true;
    if (word === "git") return /^\s*git\s+(log|show|grep|diff|status|ls-files|blame)\b/.test(segment);
    return READ_COMMANDS.has(word);
  });
}

// Kimi prints no token counts; its session log has one usage record per step.
export function kimiTokens(sessionId: string, home = join(homedir(), ".kimi-code")): TokenCount | undefined {
  const sessions = join(home, "sessions");
  if (!existsSync(sessions)) return undefined;
  let total: TokenCount | undefined;
  for (const folder of readdirSync(sessions)) {
    const agents = join(sessions, folder, sessionId, "agents");
    if (!existsSync(agents)) continue;
    for (const agent of readdirSync(agents)) {
      const wire = join(agents, agent, "wire.jsonl");
      if (!existsSync(wire)) continue;
      for (const line of readFileSync(wire, "utf8").split("\n")) {
        if (!line.includes('"usage.record"')) continue;
        try {
          const u = (JSON.parse(line) as { usage?: Record<string, number> }).usage ?? {};
          total ??= { input: 0, output: 0 };
          total.input += (u.inputOther ?? 0) + (u.inputCacheRead ?? 0) + (u.inputCacheCreation ?? 0);
          total.output += u.output ?? 0;
        } catch {
          // a half-written last line
        }
      }
    }
  }
  return total;
}

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};

// A clean copy of the codebase at the key's commit, in its own one-commit
// repo: no history and no answer key for an assistant to find, and an edit
// shows up in git status so it can be undone before the next run. The path
// is the real one (macOS's temp folder is a link into /private), since that
// is the path the assistants report back.
export function prepareCopy(key: AnswerKey & { repoPath: string }, keyFile: string, base = join(tmpdir(), "code-map")): string {
  const slug = key.codebase.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  mkdirSync(base, { recursive: true });
  const dir = join(realpathSync(base), `${slug}-${key.commit.slice(0, 12)}`);
  if (existsSync(join(dir, ".git")) && git(dir, "status", "--porcelain") === "") return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", key.repoPath, key.commit, dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Could not copy ${key.repoPath} at ${key.commit}: ${r.stderr}`);
  const inside = relative(key.repoPath, resolve(keyFile));
  if (!inside.startsWith("..") && !isAbsolute(inside)) rmSync(join(dir, inside), { force: true });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=code-map", "-c", "user.email=code-map@example.com", "commit", "-q", "--no-verify", "-m", `${key.codebase} at ${key.commit}`);
  return dir;
}

// Undoes anything a run changed in the copy; returns what it changed.
function restoreCopy(dir: string): string[] {
  const dirty = git(dir, "status", "--porcelain", "--untracked-files=all");
  if (!dirty) return [];
  git(dir, "reset", "-q", "--hard");
  git(dir, "clean", "-qfdx");
  return dirty.split("\n").map((l) => l.slice(3));
}

// Claude as the app starts it, minus what a code question does not need: MCP
// servers other than those given on the command line (the app's browser),
// and skills and slash commands. Their tool lists and descriptions are sent
// again with every step of a chat.
export const LEAN_ARGS = ["--strict-mcp-config", "--disable-slash-commands"];

// How a run in the given setup starts its engine. The lean test sets Claude
// against Claude as the app runs it, so both of its setups get the app's
// browser; the map test's runs never had it.
export function setupFor(engine: EngineKind, condition: string, map: string): { plan: PlanConfig; codeMap?: string; browser?: McpServer } {
  const plan: PlanConfig = {
    id: engine,
    label: engine,
    engine,
    bin: engine,
    extraArgs: condition === "lean" ? LEAN_ARGS : [],
    color: "",
    installed: true
  };
  const browser = condition === "full" || condition === "lean" ? browserServer() : undefined;
  return { plan, ...(condition === "map" ? { codeMap: map } : {}), ...(browser ? { browser } : {}) };
}

interface RunInput {
  codebase: string;
  question: Question;
  assistant: EngineKind;
  condition: string;
  repeat: number;
}

async function runOne(
  input: RunInput,
  ctx: { cwd: string; map: string; model?: string; timeoutMs: number; trial: boolean }
): Promise<RunRecord> {
  const { question: q, assistant, condition } = input;
  const setup = setupFor(assistant, condition, ctx.map);
  const events: EngineEvent[] = [];
  let denied = 0;
  let handle: RunHandle | undefined;
  let timedOut = false;
  const startedAt = new Date();
  handle = runEngine(
    setup.plan,
    { prompt: promptFor(q), cwd: ctx.cwd, model: ctx.model, codeMap: setup.codeMap, browser: setup.browser },
    (e) => {
      // live reasoning and streamed pieces are not needed afterwards
      if (e.kind === "thinking_delta" || e.kind === "delta") return;
      events.push(e);
      if (e.kind === "permission") {
        const allow = readOnlyRequest(e.tool, e.input);
        if (!allow) denied += 1;
        handle?.respond(e.requestId, allow, e.input);
      }
    }
  );
  const timer = setTimeout(() => {
    timedOut = true;
    handle?.cancel();
  }, ctx.timeoutMs);
  await handle.done;
  clearTimeout(timer);
  const ms = Date.now() - startedAt.getTime();
  const done = [...events].reverse().find((e) => e.kind === "done");
  const session = events.find((e) => e.kind === "session");
  const answer = finalAnswer(events);
  const firstError = events.find((e) => e.kind === "error");
  const ok = !timedOut && done?.kind === "done" && done.ok && answer.trim() !== "";
  const error = timedOut
    ? `timed out after ${Math.round(ctx.timeoutMs / 1000)}s`
    : ok
      ? undefined
      : firstError?.kind === "error"
        ? firstError.text
        : answer.trim()
          ? "the engine reported a failure"
          : "no answer";
  let tokens = done?.kind === "done" ? done.tokens : undefined;
  const costUsd = done?.kind === "done" ? done.costUsd : undefined;
  if (!tokens && assistant === "kimi" && session?.kind === "session") tokens = kimiTokens(session.engineSessionId);
  const g = grade(q, answer);
  const exists = (p: string): boolean => {
    try {
      return statSync(join(ctx.cwd, p)).isFile();
    } catch {
      return false;
    }
  };
  return {
    runId: runId(input.codebase, q.id, assistant, condition, input.repeat),
    codebase: input.codebase,
    questionId: q.id,
    kind: q.kind,
    assistant,
    condition,
    withMap: condition === "map",
    repeat: input.repeat,
    startedAt: startedAt.toISOString(),
    ok,
    ...(error ? { error } : {}),
    correct: ok && g.correct,
    missing: g.missing,
    wrong: g.wrong,
    ms,
    ...(tokens ? { tokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    // Gemini's plain-text output shows no tool calls at all
    ...(assistant === "gemini" ? {} : { files: filesOpened(events, ctx.cwd, exists) }),
    steps: events.filter((e) => e.kind === "tool").length,
    denied,
    answer,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.trial ? { trial: true } : {})
  };
}

// A fixed shuffle, so the two setups' runs interleave and a rerun with the
// same seed goes in the same order.
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0 || 1;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function readOverrides(dir: string): Overrides {
  const file = join(dir, "grades.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Overrides) : {};
}

function writeReport(dirs: string[]): string {
  const records = dirs.flatMap((d) => readRecords(join(d, "runs.jsonl")));
  const overrides = Object.assign({}, ...dirs.map(readOverrides)) as Overrides;
  const report = reportMarkdown(records, overrides);
  if (dirs.length === 1) writeFileSync(join(dirs[0], "report.md"), report);
  return report;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      key: { type: "string" },
      report: { type: "boolean" },
      compare: { type: "string", default: "map" },
      assistants: { type: "string" },
      repeats: { type: "string", default: "2" },
      questions: { type: "string" },
      tokens: { type: "string", default: String(DEFAULT_TOKENS) },
      model: { type: "string", multiple: true },
      timeout: { type: "string", default: "900" },
      out: { type: "string" },
      seed: { type: "string" },
      "retry-failed": { type: "boolean" },
      "allow-unchecked": { type: "boolean" }
    }
  });

  if (values.report) {
    if (positionals.length === 0) throw new Error("--report needs one or more results folders.");
    console.log(writeReport(positionals.map((p) => resolve(p))));
    return;
  }
  if (!values.key) throw new Error("--key <answer key file> is required.");

  const keyFile = resolve(values.key);
  const key = loadKey(keyFile);
  const unchecked = key.questions.filter((q) => !q.checked);
  if (unchecked.length > 0 && !values["allow-unchecked"]) {
    throw new Error(
      `${unchecked.length} of ${key.questions.length} answers in ${keyFile} have not been checked ` +
        `(${unchecked.slice(0, 5).map((q) => q.id).join(", ")}${unchecked.length > 5 ? ", ..." : ""}). ` +
        "Check each answer against the code and set checked to true before any run. " +
        "--allow-unchecked runs anyway, marked as a trial that does not count."
    );
  }
  const trial = unchecked.length > 0;
  const compare = values.compare as ComparisonName;
  if (!(compare in COMPARISONS)) throw new Error(`--compare takes ${Object.keys(COMPARISONS).join(" or ")}, not "${values.compare}".`);
  const assistants = (values.assistants ?? (compare === "lean" ? "claude" : ENGINES.join(","))).split(",").map((a) => a.trim()) as EngineKind[];
  for (const a of assistants) if (!ENGINES.includes(a)) throw new Error(`Unknown assistant "${a}". Use ${ENGINES.join(", ")}.`);
  if (compare === "lean" && assistants.some((a) => a !== "claude")) throw new Error("The lean setup is Claude's; run it with --assistants claude.");
  const models: Partial<Record<EngineKind, string>> = {};
  for (const m of values.model ?? []) {
    const [engine, model] = m.split("=");
    if (!ENGINES.includes(engine as EngineKind) || !model) throw new Error(`--model takes assistant=model, not "${m}".`);
    models[engine as EngineKind] = model;
  }
  const wanted = values.questions ? new Set(values.questions.split(",").map((q) => q.trim())) : undefined;
  const questions = key.questions.filter((q) => !wanted || wanted.has(q.id));
  if (wanted && questions.length !== wanted.size) throw new Error("Some --questions ids are not in the answer key.");
  const repeats = Number(values.repeats);
  const timeoutMs = Number(values.timeout) * 1000;

  const slug = key.codebase.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const out = resolve(values.out ?? join(RESULTS, `${slug}-${compare}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`));
  mkdirSync(out, { recursive: true });
  const infoFile = join(out, "run-info.json");
  const info = existsSync(infoFile) ? (JSON.parse(readFileSync(infoFile, "utf8")) as { seed: number }) : undefined;
  const seed = Number(values.seed ?? info?.seed ?? Date.now() % 1_000_000);

  console.log(`Copying ${key.repoPath} at ${key.commit.slice(0, 12)}...`);
  const cwd = prepareCopy(key, keyFile);
  let mapText = "";
  let mapTokens: number | undefined;
  if (compare === "map") {
    console.log(`Building the code map of ${cwd}...`);
    const map = await buildCodeMap(cwd, Number(values.tokens));
    writeFileSync(join(out, "map.txt"), map.text);
    const { text: _text, ...mapReport } = map;
    writeFileSync(join(out, "map-report.json"), JSON.stringify(mapReport, null, 2));
    console.log(describeMap(map));
    mapText = map.text;
    mapTokens = map.tokens;
  } else {
    // fetch the browser's MCP package now, so the first run does not wait on it
    const server = browserServer();
    spawnSync(server.command, [...server.args.slice(0, 2), "--version"], { stdio: "ignore" });
  }
  writeFileSync(
    infoFile,
    JSON.stringify(
      {
        keyFile,
        compare,
        codebase: key.codebase,
        commit: key.commit,
        checkedBy: key.checkedBy,
        assistants,
        models,
        repeats,
        seed,
        mapTokens,
        prompt: promptFor({ id: "", kind: "find", question: "<question>", answer: "", mustMention: [], checked: true }),
        trial
      },
      null,
      2
    )
  );

  const runsFile = join(out, "runs.jsonl");
  // a failed run tried again adds a newer line; nothing is rewritten, since
  // another runner may be adding to the same file
  const records = readRecords(runsFile);
  const done = new Set(records.filter((r) => r.ok || !values["retry-failed"]).map((r) => r.runId));
  const todo: RunInput[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const question of questions) {
      for (const assistant of assistants) {
        for (const condition of COMPARISONS[compare]) {
          if (!done.has(runId(key.codebase, question.id, assistant, condition, repeat))) {
            todo.push({ codebase: key.codebase, question, assistant, condition, repeat });
          }
        }
      }
    }
  }
  console.log(`${todo.length} runs to go (${done.size} already in ${runsFile}).${trial ? " Trial: the key is not fully checked, so these runs do not count." : ""}`);

  // each assistant works through its own queue; the assistants run side by side
  const order = shuffle(todo, seed);
  let finished = 0;
  await Promise.all(
    assistants.map(async (assistant) => {
      let failures = 0;
      for (const input of order.filter((r) => r.assistant === assistant)) {
        const record = await runOne(input, { cwd, map: mapText, model: models[assistant], timeoutMs, trial });
        const edited = restoreCopy(cwd);
        if (edited.length > 0) record.edited = edited;
        appendFileSync(runsFile, JSON.stringify(record) + "\n");
        finished += 1;
        const verdict = !record.ok ? `failed: ${record.error}` : record.correct ? "right" : `wrong (missing ${record.missing.join(", ")})`;
        console.log(`[${finished}/${todo.length}] ${record.runId}: ${verdict}, ${Math.round(record.ms / 1000)}s`);
        failures = record.ok ? 0 : failures + 1;
        if (failures >= STOP_AFTER_FAILURES) {
          console.log(`Stopped ${assistant} after ${failures} failed runs in a row. Fix it, then run again with --out ${out} --retry-failed.`);
          return;
        }
      }
    })
  );
  console.log(`\n${writeReport([out])}\nResults: ${out}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
