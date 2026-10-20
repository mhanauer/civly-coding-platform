import { spawnSync } from "node:child_process";
import { resolveBin } from "./engines/index.ts";
import type { PlanConfig } from "./engines/types.ts";

// A saved credential can outlive a usable login. Ask the official CLIs
// before showing a subscription as ready, including accounts with their own
// CLI home. API-key plans use their configured key instead.
export function planReady(plan: PlanConfig): boolean {
  if (!plan.installed) return false;
  if (plan.engine === "claude") {
    if (plan.env?.ANTHROPIC_AUTH_TOKEN || plan.env?.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return true;
    const result = spawnSync(resolveBin(plan.bin), ["auth", "status"], {
      encoding: "utf8", timeout: 4000, env: { ...process.env, ...plan.env }
    });
    try { return result.status === 0 && JSON.parse(result.stdout).loggedIn === true; }
    catch { return false; }
  }
  if (plan.engine === "codex") {
    if (plan.env?.OPENAI_API_KEY || process.env.OPENAI_API_KEY) return true;
    return spawnSync(resolveBin(plan.bin), ["login", "status"], {
      encoding: "utf8", timeout: 4000, env: { ...process.env, ...plan.env }
    }).status === 0;
  }
  return Boolean(plan.loggedIn);
}
