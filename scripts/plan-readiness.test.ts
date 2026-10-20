import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { planReady } from "../src/main/planReadiness.ts";
import type { PlanConfig } from "../src/main/engines/types.ts";

const temp = mkdtempSync(join(tmpdir(), "cph-plan-readiness-"));
const cli = join(temp, "engine");
writeFileSync(cli, `#!/bin/sh
if [ "$1:$2" = "auth:status" ]; then
  if [ "$TEST_LOGIN_STATE" = "yes" ] && [ "$CLAUDE_CONFIG_DIR" = "$EXPECTED_HOME" ]; then
    printf '{"loggedIn":true}\\n'
  else
    printf '{"loggedIn":false}\\n'
  fi
  exit 0
fi
if [ "$1:$2" = "login:status" ] && [ "$TEST_LOGIN_STATE" = "yes" ] && [ "$CODEX_HOME" = "$EXPECTED_HOME" ]; then
  exit 0
fi
exit 1
`);
chmodSync(cli, 0o700);
const oldKeys = Object.fromEntries(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].map((key) => [key, process.env[key]]));
for (const key of Object.keys(oldKeys)) delete process.env[key];
after(() => {
  for (const [key, value] of Object.entries(oldKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
});

const plan = (engine: "claude" | "codex", env: Record<string, string>, loggedIn: boolean): PlanConfig => ({
  id: "account", label: "Account", engine, bin: cli, extraArgs: [], color: "#000", installed: true, loggedIn, env
});

test("a saved Claude credential does not claim an expired login is ready", () => {
  const home = join(temp, "claude-home");
  assert.equal(planReady(plan("claude", { CLAUDE_CONFIG_DIR: home, EXPECTED_HOME: home, TEST_LOGIN_STATE: "no" }, true)), false);
  assert.equal(planReady(plan("claude", { CLAUDE_CONFIG_DIR: home, EXPECTED_HOME: home, TEST_LOGIN_STATE: "yes" }, false)), true);
  assert.equal(planReady(plan("claude", { CLAUDE_CONFIG_DIR: "wrong", EXPECTED_HOME: home, TEST_LOGIN_STATE: "yes" }, true)), false);
});

test("Codex checks the selected account's own home", () => {
  const home = join(temp, "codex-home");
  assert.equal(planReady(plan("codex", { CODEX_HOME: home, EXPECTED_HOME: home, TEST_LOGIN_STATE: "yes" }, false)), true);
  assert.equal(planReady(plan("codex", { CODEX_HOME: "wrong", EXPECTED_HOME: home, TEST_LOGIN_STATE: "yes" }, true)), false);
});

test("a configured API key works without a subscription login", () => {
  assert.equal(planReady(plan("claude", { ANTHROPIC_AUTH_TOKEN: "test-token" }, false)), true);
  assert.equal(planReady({ ...plan("claude", { ANTHROPIC_AUTH_TOKEN: "test-token" }, true), installed: false }), false);
});
