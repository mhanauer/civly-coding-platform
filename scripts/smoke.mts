import { runEngine } from "../src/main/engines/index.ts";
import type { PlanConfig } from "../src/main/engines/types.ts";

async function main(): Promise<number> {
  const engine = process.argv[2] ?? "kimi";
  const bins: Record<string, string> = {
    kimi: "kimi",
    claude: "claude",
    codex: "codex"
  };
  const bin = bins[engine];
  if (!bin) {
    console.error(`Unknown engine "${engine}". Use: kimi | claude | codex`);
    return 1;
  }

  const plan: PlanConfig = {
    id: `smoke-${engine}`,
    label: `smoke ${engine}`,
    engine: engine as PlanConfig["engine"],
    bin,
    extraArgs: [],
    color: "#ffffff",
    installed: true
  };

  let sawText = false;
  let sawDone = false;
  let sawError = false;

  const handle = runEngine(
    plan,
    { prompt: "Reply with exactly: ok", cwd: "/tmp/cph-smoke" },
    (event) => {
      if (event.kind === "text") sawText = true;
      if (event.kind === "done") sawDone = true;
      if (event.kind === "error") sawError = true;
      console.log(event.kind.padEnd(8), JSON.stringify(event).slice(0, 200));
    }
  );

  await handle.done;

  if (sawError && !sawText) {
    console.log(`SMOKE FAIL (${engine}): engine reported an error and produced no text`);
    return 1;
  }
  if (!sawDone) {
    console.log(`SMOKE FAIL (${engine}): no done event`);
    return 1;
  }
  console.log(`SMOKE PASS (${engine})${sawText ? " with text" : ", no text (check login)"}`);
  return 0;
}

main().then((code) => process.exit(code));
