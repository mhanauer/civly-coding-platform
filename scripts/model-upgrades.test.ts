import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogModels, modelLine, upgradeModels } from "../src/main/engines/models.ts";
import type { PlanConfig } from "../src/main/engines/types.ts";

// the lists Claude Code 2.1, Codex 0.163 and Muse Code 1.4 cached on 2026-10-22
const CLAUDE = [
  "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5-20251001",
  "claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"
];
const CODEX = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const MUSE = ["muse-wonder-1.0", "muse-wonder-full-1.0", "muse-spark-1.3", "muse-spark-1.2"];

test("model lines keep variants apart and read dotted and dashed versions", () => {
  assert.deepEqual(modelLine("gpt-6.1-sol"), { line: "gpt-sol", version: [6, 1] });
  assert.deepEqual(modelLine("claude-opus-5-5"), { line: "claude-opus", version: [5, 5] });
  assert.deepEqual(modelLine("muse-wonder-full-1.0"), { line: "muse-wonder-full", version: [1, 0] });
  assert.notEqual(modelLine("muse-wonder-1.0").line, modelLine("muse-wonder-1.0-contributor").line);
});

test("a ChatGPT plan moves to the newest Sol and keeps Astra", () => {
  assert.deepEqual(upgradeModels(["gpt-6-sol", "gpt-6-astra"], CODEX), ["gpt-6.1-sol", "gpt-6-astra"]);
});

test("a Claude plan keeps Opus and Fable even when a newer-numbered Sonnet ships", () => {
  assert.deepEqual(upgradeModels(["claude-opus-5-5", "claude-fable-5-1"], CLAUDE), ["claude-opus-5-5", "claude-fable-5-1"]);
  assert.deepEqual(upgradeModels(["claude-opus-5", "claude-fable-5"], CLAUDE), ["claude-opus-5-5", "claude-fable-5-1"]);
  assert.deepEqual(
    upgradeModels(["claude-opus-5-5", "claude-fable-5-1"], [...CLAUDE, "claude-fable-5-2", "claude-opus-6"]),
    ["claude-opus-6", "claude-fable-5-2"]
  );
});

test("Muse Wonder and Wonder Full move separately", () => {
  assert.deepEqual(upgradeModels(["muse-wonder-1.0", "muse-wonder-full-1.0"], MUSE), ["muse-wonder-1.0", "muse-wonder-full-1.0"]);
  assert.deepEqual(
    upgradeModels(["muse-wonder-1.0", "muse-wonder-full-1.0"], [...MUSE, "muse-wonder-1.1"]),
    ["muse-wonder-1.1", "muse-wonder-full-1.0"]
  );
});

test("an older catalog never moves a model back, and two versions of one line collapse", () => {
  assert.deepEqual(upgradeModels(["gpt-6.1-sol", "gpt-6-astra"], ["gpt-5.6-sol", "gpt-5.6-terra"]), ["gpt-6.1-sol", "gpt-6-astra"]);
  assert.deepEqual(upgradeModels(["gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra"], CODEX), ["gpt-6.1-sol", "gpt-6-astra"]);
  assert.deepEqual(upgradeModels(["default"], CODEX), ["default"]);
});

test("Codex's catalog skips hidden models", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-catalog-"));
  try {
    writeFileSync(
      join(dir, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-6.1-sol", visibility: "list" },
          { slug: "gpt-6.2-sol", visibility: "hide" },
          { slug: "gpt-6-astra", visibility: "list" }
        ]
      })
    );
    const plan = { id: "codex-test", label: "", engine: "codex", bin: "codex", extraArgs: [], env: { CODEX_HOME: dir } } as unknown as PlanConfig;
    assert.deepEqual(catalogModels(plan), ["gpt-6.1-sol", "gpt-6-astra"]);
    assert.deepEqual(upgradeModels(["gpt-6-sol"], catalogModels(plan)), ["gpt-6.1-sol"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude's catalog is read from the plan's own home; key plans have none", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-catalog-"));
  try {
    mkdirSync(join(dir, "cache", "model-catalog"), { recursive: true });
    writeFileSync(
      join(dir, "cache", "model-catalog", "a.json"),
      JSON.stringify({ catalog: { config: { models: CLAUDE.map((id) => ({ id })) } } })
    );
    const plan = { id: "claude-test", label: "", engine: "claude", bin: "claude", extraArgs: [], env: { CLAUDE_CONFIG_DIR: dir } } as unknown as PlanConfig;
    assert.deepEqual(catalogModels(plan), CLAUDE);
    const keyed = { ...plan, id: "claude-key", env: { ...plan.env, ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } };
    assert.deepEqual(catalogModels(keyed), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
