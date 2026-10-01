import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { userBinDirs } from "../shellPath.ts";
import type { EngineAdapter, EngineEvent, EngineKind, PlanConfig, RunHandle, SendOptions } from "./types.ts";
import { claudeAdapter } from "./claude.ts";
import { kimiAdapter } from "./kimi.ts";
import { codexAdapter } from "./codex.ts";
import { geminiAdapter } from "./gemini.ts";

// Adapters are factories so every run gets fresh parsing state (stream
// offsets, thinking timers) even when two sessions run at once.
export const ADAPTERS: Partial<Record<EngineKind, () => EngineAdapter>> = {
  claude: claudeAdapter,
  kimi: kimiAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter
};

// GUI-launched apps get a minimal PATH that does not include the user-level
// bin dirs where these CLIs install. Resolve to an absolute path so engines
// run no matter how the app was launched.
export function resolveBin(bin: string): string {
  try {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    if (r.status === 0) {
      const first = (r.stdout ?? "").trim().split("\n")[0];
      if (first) return first;
    }
  } catch {
    // fall through to the known dirs
  }
  for (const dir of userBinDirs()) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return bin;
}

export function binaryExists(bin: string): boolean {
  const resolved = resolveBin(bin);
  return existsSync(resolved);
}

// Claude Code caps output at 32k tokens for model names it does not know,
// and GLM's reasoning counts against that cap. Z.ai serves GLM with a 128k
// output limit (the same one ZCode uses), so its plans get the full room.
function engineEnv(plan: PlanConfig): Record<string, string> {
  const env = { ...(plan.env ?? {}) };
  const base = env.ANTHROPIC_BASE_URL ?? "";
  if (plan.engine === "claude" && /\bz\.ai\b|bigmodel\.cn/.test(base) && !env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "128000";
  }
  return env;
}

export function runEngine(
  plan: PlanConfig,
  opts: SendOptions,
  onEvent: (e: EngineEvent) => void
): RunHandle {
  const makeAdapter = ADAPTERS[plan.engine];

  if (!makeAdapter) {
    onEvent({ kind: "error", text: `No adapter yet for engine "${plan.engine}".` });
    onEvent({ kind: "done", ok: false });
    return { done: Promise.resolve(), cancel: () => {}, respond: () => {} };
  }
  const adapter = makeAdapter();
  adapter.beginRun?.();

  const binPath = resolveBin(plan.bin);
  if (!existsSync(binPath)) {
    onEvent({ kind: "error", text: `"${plan.bin}" is not installed on this machine.` });
    onEvent({ kind: "done", ok: false });
    return { done: Promise.resolve(), cancel: () => {}, respond: () => {} };
  }

  const args = [...plan.extraArgs, ...adapter.buildArgs(opts)];
  // stdin stays open for engines that take the prompt there, so permission
  // answers can follow; it closes once the turn is done
  const input = adapter.initialInput?.(opts);
  const proc = spawn(binPath, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...engineEnv(plan) },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });
  if (input !== undefined && proc.stdin) {
    proc.stdin.on("error", () => {
      // the engine exited while an answer was in flight; nothing to do
    });
    proc.stdin.write(input + "\n");
  }

  let settled: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });

  const forward = (e: EngineEvent): void => {
    try {
      onEvent(e);
    } catch {
      // a renderer-side hiccup must never kill the engine stream
    }
  };

  // An engine can report a result and keep working: Claude Code does when a
  // background helper is still running, and picks the turn back up once the
  // helper reports in. A closed stdin lets the engine exit once it is truly
  // finished, but also ends any chance to answer a permission request, so
  // an adapter that knows better (inputDone) decides when; otherwise the
  // first result closes it. The chat's done goes out at exit, with the last
  // result the engine gave.
  let lastResult: EngineEvent | undefined;
  let finished = false;
  // an engine that dies before it says anything (a missing runtime, a crash
  // on launch) only explains itself on stderr; keep the last lines so the
  // chat can show why instead of going quiet
  const stderrTail: string[] = [];
  let errorShown = false;
  const finish = (e: EngineEvent): void => {
    if (finished) return;
    finished = true;
    forward(e);
  };

  const endInput = (): void => {
    if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
  };

  const emit = (e: EngineEvent): void => {
    if (e.kind === "done") {
      lastResult = e;
      if (!adapter.inputDone) endInput();
      return;
    }
    if (e.kind === "error") errorShown = true;
    forward(e);
  };

  const feed = (stream: NodeJS.ReadableStream, isStderr: boolean): void => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (isStderr) {
          stderrTail.push(trimmed.slice(0, 300));
          if (stderrTail.length > 5) stderrTail.shift();
          if (/ERROR|error:|not logged in|unauthorized|401/i.test(trimmed)) {
            emit({ kind: "error", text: trimmed.slice(0, 300) });
          }
          continue;
        }
        try {
          adapter.parseLine(trimmed, emit);
        } catch {
          emit({ kind: "status", text: trimmed.slice(0, 120) });
        }
        if (adapter.inputDone?.()) endInput();
      }
    });
  };

  // both are pipes; the null check only satisfies the mixed stdio typing
  if (proc.stdout) feed(proc.stdout, false);
  if (proc.stderr) feed(proc.stderr, true);

  proc.on("error", (err) => {
    emit({ kind: "error", text: `Failed to start "${plan.bin}": ${err.message}` });
    finish({ kind: "done", ok: false });
    settled();
  });

  proc.on("close", (code) => {
    adapter.endRun?.(emit);
    // a null code means a signal (Stop, a steer), which is not a failure
    if (!lastResult && !errorShown && code !== null && code !== 0) {
      const why = stderrTail.join("\n");
      emit({
        kind: "error",
        text: why ? `"${plan.bin}" stopped: ${why}` : `"${plan.bin}" stopped with exit code ${code} and gave no reason.`
      });
    }
    finish(lastResult ?? { kind: "done", ok: code === 0, summary: `engine exited with code ${code ?? "null"}` });
    settled();
  });

  return {
    done,
    cancel: () => {
      proc.kill("SIGTERM");
    },
    respond: (requestId, allow, toolInput, alwaysRules) => {
      const line = adapter.permissionResponse?.(requestId, allow, toolInput, alwaysRules);
      if (line && proc.stdin && !proc.stdin.destroyed) proc.stdin.write(line + "\n");
    }
  };
}
