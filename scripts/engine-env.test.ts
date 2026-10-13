import assert from "node:assert/strict";
import { test } from "node:test";
import { engineEnv } from "../src/main/engines/index.ts";
import type { PlanConfig } from "../src/main/engines/types.ts";

const keyPlan = (base: string, models?: string[], env: Record<string, string> = {}): PlanConfig => ({
  id: "key",
  label: "key",
  engine: "claude",
  bin: "claude",
  extraArgs: [],
  color: "#000",
  installed: true,
  models,
  env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "token", ...env }
});

const ALIASES = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL"
];

test("a Meta key plan sends every Claude Code alias to the chat's model", () => {
  const env = engineEnv(keyPlan("https://api.meta.ai", ["muse-spark-1.3", "muse-spark-1.1"]), "muse-spark-1.1");
  for (const name of ALIASES) assert.equal(env[name], "muse-spark-1.1");
  assert.equal(env.ENABLE_TOOL_SEARCH, "true");
});

test("a Meta chat on the default model uses the plan's first model", () => {
  const env = engineEnv(keyPlan("https://api.meta.ai", ["default", "muse-spark-1.3"]), "default");
  for (const name of ALIASES) assert.equal(env[name], "muse-spark-1.3");
  assert.equal(engineEnv(keyPlan("https://api.meta.ai")).ANTHROPIC_DEFAULT_HAIKU_MODEL, "muse-spark-1.3");
});

test("a Meta plan's own settings win", () => {
  const env = engineEnv(
    keyPlan("https://api.meta.ai", ["muse-spark-1.3"], { ANTHROPIC_DEFAULT_HAIKU_MODEL: "muse-spark-1.1", ENABLE_TOOL_SEARCH: "false" }),
    "muse-spark-1.3"
  );
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "muse-spark-1.1");
  assert.equal(env.ENABLE_TOOL_SEARCH, "false");
});

test("other key plans keep Claude Code's own aliases", () => {
  const zai = engineEnv(keyPlan("https://api.z.ai/api/anthropic", ["glm-5.3"]), "glm-5.3");
  assert.equal(zai.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000");
  for (const name of [...ALIASES, "ENABLE_TOOL_SEARCH"]) assert.equal(zai[name], undefined);
  // a look-alike host is not Meta's
  assert.equal(engineEnv(keyPlan("https://api.meta.ai.example.com"), "x").ENABLE_TOOL_SEARCH, undefined);
});
