import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, installOf, parseVersion, updateCommand, updatesOnItsOwn } from "../src/main/cliUpdates.ts";
import { holdEngine, runEngine } from "../src/main/engines/index.ts";
import type { EngineEvent, PlanConfig } from "../src/main/engines/types.ts";

test("how a CLI was installed is read from where its command really lives", () => {
  assert.deepEqual(installOf("~/.local/share/claude/versions/2.1.288"), { via: "native" });
  assert.deepEqual(installOf("~/.npm-global/lib/node_modules/@openai/codex/bin/codex.js"), {
    via: "npm",
    prefix: "~/.npm-global",
    pkg: "@openai/codex"
  });
  assert.deepEqual(installOf("/opt/homebrew/lib/node_modules/some-cli/dist/index.js"), {
    via: "npm",
    prefix: "/opt/homebrew",
    pkg: "some-cli"
  });
  // a Homebrew formula keeps its own node_modules, but Homebrew updates it
  assert.deepEqual(
    installOf("/opt/homebrew/Cellar/gemini-cli/0.62.0/libexec/lib/node_modules/@google/gemini-cli/bundle/gemini.js"),
    { via: "brew", name: "gemini-cli" }
  );
  assert.deepEqual(installOf("/opt/homebrew/Caskroom/codex/0.160.0/codex-aarch64-apple-darwin"), {
    via: "brew",
    name: "codex"
  });
  assert.deepEqual(installOf("~/.kimi-code/bin/kimi"), { via: "kimi" });
  assert.equal(installOf("~/bin/claude"), undefined);
});

test("each install updates its own way, an npm one into the same place", () => {
  const npm = updateCommand({ via: "npm", prefix: "~/.npm-global", pkg: "@openai/codex" }, "/x/codex", "0.160.0");
  assert.deepEqual(npm.args, ["install", "-g", "--prefix", "~/.npm-global", "@openai/codex@0.160.0"]);
  assert.deepEqual(updateCommand({ via: "native" }, "/x/claude").args, ["update"]);
  assert.deepEqual(updateCommand({ via: "brew", name: "codex" }, "/x/codex").args, ["upgrade", "codex"]);
  assert.deepEqual(updateCommand({ via: "kimi" }, "/x/kimi").args, ["upgrade", "-y"]);
});

test("versions are read from each CLI's own --version line", () => {
  assert.equal(parseVersion("2.1.288 (Claude Code)"), "2.1.288");
  assert.equal(parseVersion("codex-cli 0.160.0"), "0.160.0");
  assert.equal(parseVersion("0.62.0\n"), "0.62.0");
  assert.equal(parseVersion("no version here"), undefined);
  assert.ok(compareVersions("0.160.0", "0.157.0") > 0);
  assert.ok(compareVersions("2.1.10", "2.1.9") > 0);
  assert.equal(compareVersions("2.1", "2.1.0"), 0);
});

test("only a newer release in the same major installs on its own", () => {
  assert.equal(updatesOnItsOwn("0.157.0", "0.160.0"), true);
  assert.equal(updatesOnItsOwn("2.1.285", "2.1.288"), true);
  // a new major can change the flags the app runs it with
  assert.equal(updatesOnItsOwn("0.43.0", "2.1.1"), false);
  assert.equal(updatesOnItsOwn("2.1.288", "2.1.288"), false);
  assert.equal(updatesOnItsOwn("2.1.288", "2.1.285"), false);
});

const plan: PlanConfig = {
  id: "fixture",
  label: "Fixture",
  engine: "gemini",
  bin: "/bin/echo",
  extraArgs: [],
  color: "#000",
  installed: true
};

function release(): { promise: Promise<void>; done: () => void } {
  let done = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
}

test("a chat on a CLI mid-update starts once the install is done", async () => {
  const install = release();
  holdEngine("gemini", install.promise);
  const events: EngineEvent[] = [];
  const handle = runEngine(plan, { prompt: "hello", cwd: process.cwd(), model: "default" }, (e) => events.push(e));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(events, [{ kind: "status", text: "Waiting for /bin/echo to finish updating" }]);
  install.done();
  await handle.done;
  assert.ok(events.some((e) => e.kind === "text" && e.text.includes("hello")));
  assert.deepEqual(events.at(-1), { kind: "done", ok: true, summary: "engine exited with code 0" });
});

test("a chat stopped while it waits on an update never starts", async () => {
  const install = release();
  holdEngine("gemini", install.promise);
  const events: EngineEvent[] = [];
  const handle = runEngine(plan, { prompt: "hello", cwd: process.cwd(), model: "default" }, (e) => events.push(e));
  handle.cancel();
  install.done();
  await handle.done;
  assert.deepEqual(events.slice(1), [{ kind: "done", ok: false }]);
});

test("a failed install still lets chats start, and the hold ends with it", async () => {
  holdEngine("gemini", Promise.reject(new Error("npm failed")));
  const events: EngineEvent[] = [];
  await runEngine(plan, { prompt: "hi", cwd: process.cwd(), model: "default" }, (e) => events.push(e)).done;
  assert.ok(events.some((e) => e.kind === "text"));
  const after: EngineEvent[] = [];
  await runEngine(plan, { prompt: "again", cwd: process.cwd(), model: "default" }, (e) => after.push(e)).done;
  assert.ok(!after.some((e) => e.kind === "status"));
});
