import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanConfig } from "../src/main/engines/types.ts";

// A throwaway home and data folder, so nothing here touches the real
// ~/.claude, ~/.codex or ~/.coding-plan-hub.
const root = mkdtempSync(join(tmpdir(), "cph-accounts-"));
process.env.HOME = join(root, "home");
process.env.CPH_DATA_DIR = join(root, "data");
const claudeMain = join(root, "home", ".claude");
const codexMain = join(root, "home", ".codex");
mkdirSync(join(claudeMain, "skills", "proposal"), { recursive: true });
mkdirSync(join(claudeMain, "rules"), { recursive: true });
mkdirSync(join(claudeMain, "projects", "-work"), { recursive: true });
mkdirSync(join(claudeMain, "cache"), { recursive: true });
writeFileSync(join(claudeMain, "CLAUDE.md"), "main rules\n");
writeFileSync(join(claudeMain, "settings.json"), '{"effortLevel":"max"}\n');
writeFileSync(join(claudeMain, "skills", "proposal", "SKILL.md"), "skill\n");
writeFileSync(join(claudeMain, "projects", "-work", "s1.jsonl"), "{}\n");
writeFileSync(join(claudeMain, ".credentials.json"), "secret\n");
// Claude Code's own record for the main account
writeFileSync(
  join(root, "home", ".claude.json"),
  JSON.stringify({
    oauthAccount: { emailAddress: "main@example.com" },
    userID: "main-user",
    hasResetAutoModeOptInForDefaultOffer: true,
    migrationVersion: 14,
    unpinFable5LaunchEffort: true,
    autoUpdates: false,
    cachedGrowthBookFeatures: { flag: "on" },
    s1mAccessCache: { org: { hasAccess: true } },
    mcpServers: { notes: { command: "notes-mcp" } },
    projects: {
      "/work": { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["db"], lastCost: 1.2, lastSessionId: "abc" }
    }
  })
);
mkdirSync(join(codexMain, "sessions"), { recursive: true });
writeFileSync(join(codexMain, "AGENTS.md"), "agents\n");
writeFileSync(join(codexMain, "config.toml"), 'model = "gpt-6-sol"\n');
writeFileSync(join(codexMain, "auth.json"), "secret\n");

const accounts = await import("../src/main/accounts.ts");
const store = await import("../src/main/store.ts");
after(() => rmSync(root, { recursive: true, force: true }));

const plan = (engine: "claude" | "codex", env: Record<string, string> = {}): PlanConfig => ({
  id: "p",
  label: "P",
  engine,
  bin: engine,
  extraArgs: [],
  color: "#000",
  installed: true,
  env
});

const isLinkTo = (p: string, target: string): boolean =>
  lstatSync(p).isSymbolicLink() && readlinkSync(p) === target;

test("a new Claude account links what it shares and nothing else", () => {
  const env = accounts.newAccountEnv("claude", "work-1");
  const home = env.CLAUDE_CONFIG_DIR;
  assert.equal(home, join(root, "data", "accounts", "work-1"));
  accounts.linkShared(plan("claude", env));
  for (const name of ["CLAUDE.md", "settings.json", "skills", "rules", "projects"]) {
    assert.ok(isLinkTo(join(home, name), join(claudeMain, name)), name);
  }
  // the login and account caches stay the account's own
  assert.ok(!existsSync(join(home, ".credentials.json")));
  assert.ok(!existsSync(join(home, "cache")));
  // entries the main home does not have are not linked
  assert.ok(!existsSync(join(home, "agents")));
  assert.equal(readFileSync(join(home, "skills", "proposal", "SKILL.md"), "utf8"), "skill\n");
});

test("a new Claude account starts with the main record of finished upgrade steps, not its identity", () => {
  const seed = JSON.parse(readFileSync(join(root, "data", "accounts", "work-1", ".claude.json"), "utf8"));
  // one-time steps already done stay done, so none rewrites shared settings
  assert.equal(seed.hasResetAutoModeOptInForDefaultOffer, true);
  assert.equal(seed.migrationVersion, 14);
  assert.equal(seed.unpinFable5LaunchEffort, true);
  assert.equal(seed.autoUpdates, false);
  assert.deepEqual(seed.mcpServers, { notes: { command: "notes-mcp" } });
  assert.deepEqual(seed.projects, { "/work": { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["db"] } });
  // the login, identity and cached account data are the account's own
  for (const key of ["oauthAccount", "userID", "cachedGrowthBookFeatures", "s1mAccessCache"]) {
    assert.ok(!(key in seed), key);
  }
});

test("an account's own record is never replaced", () => {
  const home = join(root, "data", "accounts", "work-1");
  const record = join(home, ".claude.json");
  const mine = JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } });
  writeFileSync(record, mine);
  accounts.linkShared(plan("claude", { CLAUDE_CONFIG_DIR: home }));
  assert.equal(readFileSync(record, "utf8"), mine);
  rmSync(record);
});

test("something new in the main home reaches the account on the next run", () => {
  const p = plan("claude", { CLAUDE_CONFIG_DIR: join(root, "data", "accounts", "work-1") });
  mkdirSync(join(claudeMain, "agents"));
  accounts.linkShared(p);
  assert.ok(isLinkTo(join(root, "data", "accounts", "work-1", "agents"), join(claudeMain, "agents")));
});

test("a file a CLI saved over its link goes back to the main home", () => {
  const home = join(root, "data", "accounts", "work-1");
  const p = plan("claude", { CLAUDE_CONFIG_DIR: home });
  const link = join(home, "settings.json");
  // the CLI wrote a whole new file where the link was
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(claudeMain, "settings.json"), past, past);
  unlinkSync(link);
  writeFileSync(link, '{"effortLevel":"high"}\n');
  accounts.linkShared(p);
  assert.ok(isLinkTo(link, join(claudeMain, "settings.json")));
  assert.equal(readFileSync(join(claudeMain, "settings.json"), "utf8"), '{"effortLevel":"high"}\n');
});

test("an older replaced copy is set aside, the main file wins", () => {
  const home = join(root, "data", "accounts", "work-1");
  const p = plan("claude", { CLAUDE_CONFIG_DIR: home });
  const link = join(home, "CLAUDE.md");
  unlinkSync(link);
  writeFileSync(link, "stale copy\n");
  const past = new Date(Date.now() - 60_000);
  utimesSync(link, past, past);
  accounts.linkShared(p);
  assert.ok(isLinkTo(link, join(claudeMain, "CLAUDE.md")));
  assert.equal(readFileSync(join(claudeMain, "CLAUDE.md"), "utf8"), "main rules\n");
  const aside = readdirSync(home).filter((n) => n.startsWith("CLAUDE.md.unlinked-"));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(home, aside[0]), "utf8"), "stale copy\n");
});

test("a folder made in the account merges into the main home", () => {
  const home = join(root, "data", "accounts", "work-1");
  const p = plan("claude", { CLAUDE_CONFIG_DIR: home });
  // the account made plans/ before the main home had one
  mkdirSync(join(home, "plans"));
  writeFileSync(join(home, "plans", "a.md"), "plan a\n");
  mkdirSync(join(claudeMain, "plans"));
  accounts.linkShared(p);
  assert.ok(isLinkTo(join(home, "plans"), join(claudeMain, "plans")));
  assert.equal(readFileSync(join(claudeMain, "plans", "a.md"), "utf8"), "plan a\n");
});

test("a clashing folder is set aside, never merged over the main one", () => {
  const home = join(root, "data", "accounts", "work-1");
  const p = plan("claude", { CLAUDE_CONFIG_DIR: home });
  unlinkSync(join(home, "plans"));
  mkdirSync(join(home, "plans"));
  writeFileSync(join(home, "plans", "a.md"), "other plan a\n");
  accounts.linkShared(p);
  assert.ok(isLinkTo(join(home, "plans"), join(claudeMain, "plans")));
  assert.equal(readFileSync(join(claudeMain, "plans", "a.md"), "utf8"), "plan a\n");
  assert.ok(readdirSync(home).some((n) => n.startsWith("plans.unlinked-")));
});

test("an entry gone from the main home drops its link", () => {
  const home = join(root, "data", "accounts", "work-1");
  const p = plan("claude", { CLAUDE_CONFIG_DIR: home });
  rmSync(join(claudeMain, "agents"), { recursive: true });
  accounts.linkShared(p);
  assert.ok(!existsSync(join(home, "agents")));
  assert.throws(() => lstatSync(join(home, "agents")));
});

test("homes the app did not make are never changed", () => {
  // a hand-set home, and the main home itself
  const own = join(root, "home", ".claude-2");
  mkdirSync(own);
  writeFileSync(join(own, "CLAUDE.md"), "mine\n");
  accounts.linkShared(plan("claude", { CLAUDE_CONFIG_DIR: own }));
  assert.equal(readFileSync(join(own, "CLAUDE.md"), "utf8"), "mine\n");
  assert.ok(!lstatSync(join(own, "CLAUDE.md")).isSymbolicLink());
  assert.deepEqual(readdirSync(own), ["CLAUDE.md"]);
  accounts.linkShared(plan("claude", { CLAUDE_CONFIG_DIR: claudeMain }));
  assert.ok(!lstatSync(join(claudeMain, "CLAUDE.md")).isSymbolicLink());
  // the accounts folder itself is not an account
  accounts.linkShared(plan("claude", { CLAUDE_CONFIG_DIR: join(root, "data", "accounts") }));
  assert.ok(!existsSync(join(root, "data", "accounts", "CLAUDE.md")));
});

test("a ChatGPT account shares config and keeps its own login and sessions", () => {
  const env = accounts.newAccountEnv("codex", "gpt-2");
  const home = env.CODEX_HOME;
  const p = plan("codex", env);
  accounts.linkShared(p);
  assert.ok(isLinkTo(join(home, "AGENTS.md"), join(codexMain, "AGENTS.md")));
  assert.ok(isLinkTo(join(home, "config.toml"), join(codexMain, "config.toml")));
  assert.ok(!existsSync(join(home, "auth.json")));
  assert.ok(!existsSync(join(home, "sessions")));
  assert.equal(accounts.ownHomeLoggedIn(p), false);
  writeFileSync(join(home, "auth.json"), "{}");
  assert.equal(accounts.ownHomeLoggedIn(p), true);
  assert.equal(accounts.engineHome(p), home);
  assert.equal(accounts.engineHome(plan("codex")), codexMain);
});

test("Claude plans share one conversation store, ChatGPT accounts each have their own", () => {
  const claudeAccount = plan("claude", { CLAUDE_CONFIG_DIR: join(root, "data", "accounts", "work-1") });
  assert.equal(accounts.conversationStore(plan("claude")), accounts.conversationStore(claudeAccount));
  assert.notEqual(
    accounts.conversationStore(plan("claude")),
    accounts.conversationStore(plan("claude", { CLAUDE_CONFIG_DIR: join(root, "home", ".claude-2") }))
  );
  const gptAccount = plan("codex", { CODEX_HOME: join(root, "data", "accounts", "gpt-2") });
  assert.notEqual(accounts.conversationStore(plan("codex")), accounts.conversationStore(gptAccount));
  assert.equal(accounts.conversationStore(plan("codex")), accounts.conversationStore(plan("codex")));
});

test("a Claude account shows the email it signed in as", () => {
  const home = join(root, "data", "accounts", "work-1");
  const p = plan("claude", { CLAUDE_CONFIG_DIR: home });
  assert.equal(accounts.accountEmail(p), undefined);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
  assert.equal(accounts.accountEmail(p), "work@example.com");
  // key plans have no account
  assert.equal(accounts.accountEmail(plan("claude", { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" })), undefined);
});

test("deleting an account removes its home and leaves the main home whole", async () => {
  const home = join(root, "data", "accounts", "work-1");
  const p = plan("claude", { CLAUDE_CONFIG_DIR: home });
  // /usr/bin/true stands in for the CLI's logout
  await accounts.forgetAccount(p, "/usr/bin/true");
  assert.ok(!existsSync(home));
  assert.equal(readFileSync(join(claudeMain, "CLAUDE.md"), "utf8"), "main rules\n");
  assert.equal(readFileSync(join(claudeMain, "skills", "proposal", "SKILL.md"), "utf8"), "skill\n");
  assert.equal(readFileSync(join(claudeMain, "projects", "-work", "s1.jsonl"), "utf8"), "{}\n");
  assert.equal(readFileSync(join(claudeMain, "plans", "a.md"), "utf8"), "plan a\n");
  assert.ok(existsSync(join(claudeMain, ".credentials.json")));
  // a home the app did not make is never removed
  await accounts.forgetAccount(plan("claude", { CLAUDE_CONFIG_DIR: join(root, "home", ".claude-2") }), "/usr/bin/true");
  assert.ok(existsSync(join(root, "home", ".claude-2", "CLAUDE.md")));
  await accounts.forgetAccount(plan("claude", { CLAUDE_CONFIG_DIR: claudeMain }), "/usr/bin/true");
  assert.ok(existsSync(join(claudeMain, "CLAUDE.md")));
});

test("blank account labels get distinct names and keep their own sign-in homes", () => {
  const first = store.addPlan({ label: "", engine: "codex", ownLogin: true });
  const addedFirst = first.find((p) => p.label === "ChatGPT account");
  assert.ok(addedFirst);
  assert.ok(addedFirst.env?.CODEX_HOME);
  const second = store.addPlan({ label: "  ", engine: "codex", ownLogin: true });
  const addedSecond = second.find((p) => p.label === "ChatGPT account 2");
  assert.ok(addedSecond);
  assert.notEqual(addedFirst.id, addedSecond.id);
  assert.notEqual(addedFirst.env?.CODEX_HOME, addedSecond.env?.CODEX_HOME);
});
