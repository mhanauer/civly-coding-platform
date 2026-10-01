import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR } from "./dataDir.ts";
import type { EngineKind, PlanConfig } from "./engines/types.ts";

// Extra Claude and ChatGPT subscriptions. Each one keeps its login in its
// own CLI home (CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex), so
// signing one in never signs another out: Claude Code names its keychain
// entry after the home, Codex keeps auth.json inside it. Everything you set
// up in the main home is linked into each account's home before every run,
// so every account follows the same instructions, rules, skills and settings.

const HOME_VAR: Partial<Record<EngineKind, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME"
};

// What an account shares with the main home. Logins, account caches and org
// policy files stay with the account. Claude accounts also share the
// conversation store (projects holds transcripts and memory), so a chat moves
// between Claude accounts without losing its place. Codex keeps conversations
// in SQLite databases that are not safe to share through links, so each
// ChatGPT account has its own and a move between them carries a recap.
const SHARED: Partial<Record<EngineKind, string[]>> = {
  claude: [
    "CLAUDE.md",
    "rules",
    "skills",
    "agents",
    "commands",
    "output-styles",
    "hooks",
    "settings.json",
    "settings.local.json",
    "keybindings.json",
    "plugins",
    "projects",
    "file-history",
    "todos",
    "plans",
    "session-env",
    "history.jsonl"
  ],
  codex: ["AGENTS.md", "AGENTS.override.md", "config.toml", "rules", "skills", "prompts", "plugins"]
};

const ACCOUNTS_DIR = join(DATA_DIR, "accounts");

export function supportsOwnLogin(engine: EngineKind): boolean {
  return Boolean(HOME_VAR[engine]);
}

function mainHome(engine: EngineKind): string | undefined {
  if (engine === "claude") return join(homedir(), ".claude");
  if (engine === "codex") return join(homedir(), ".codex");
  return undefined;
}

// The plan's own CLI home, when it has one.
export function ownHome(plan: PlanConfig): string | undefined {
  const name = HOME_VAR[plan.engine];
  return (name && plan.env?.[name]?.trim()) || undefined;
}

// Where the plan's CLI keeps its login, caches and sessions.
export function engineHome(plan: PlanConfig): string | undefined {
  return ownHome(plan) ?? mainHome(plan.engine);
}

// The env a new account runs with: its own home, made now and named after
// the plan.
export function newAccountEnv(engine: EngineKind, planId: string): Record<string, string> {
  const name = HOME_VAR[engine];
  if (!name) return {};
  const dir = join(ACCOUNTS_DIR, planId);
  mkdirSync(dir, { recursive: true });
  return { [name]: dir };
}

// The login command for a plan with its own home, run with that home set.
export function ownLoginArgs(plan: PlanConfig): { env: Record<string, string>; args: string[] } | null {
  const name = HOME_VAR[plan.engine];
  const dir = ownHome(plan);
  if (!name || !dir) return null;
  return { env: { [name]: dir }, args: plan.engine === "claude" ? ["auth", "login"] : ["login"] };
}

// Only homes this app made are ever changed: strictly inside its accounts
// folder, and never a main home reached through a link.
function managedHome(plan: PlanConfig): string | undefined {
  const dir = ownHome(plan);
  const main = mainHome(plan.engine);
  if (!dir || !main) return undefined;
  const home = resolve(dir);
  const rel = relative(resolve(ACCOUNTS_DIR), home);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  try {
    if (existsSync(home) && existsSync(main) && realpathSync(home) === realpathSync(main)) return undefined;
  } catch {
    return undefined;
  }
  return home;
}

// Plans that read the same conversation store can resume each other's
// conversations: every Claude plan whose home shares projects, or plans on
// one Codex home.
export function conversationStore(plan: PlanConfig): string {
  if (plan.engine === "claude" && (!ownHome(plan) || managedHome(plan))) return "claude";
  return `${plan.engine}:${engineHome(plan) ?? ""}`;
}

// Whether a plan with its own home is signed in, judged by where its CLI
// stores the login. Claude Code's keychain entry for a home other than
// ~/.claude ends in a short sha256 of the home's path; find without -w never
// touches the secret itself.
export function ownHomeLoggedIn(plan: PlanConfig): boolean | undefined {
  const dir = ownHome(plan);
  if (!dir) return undefined;
  if (plan.engine === "claude") {
    if (existsSync(join(dir, ".credentials.json"))) return true;
    const hash = createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
    return spawnSync("security", ["find-generic-password", "-s", `Claude Code-credentials-${hash}`]).status === 0;
  }
  if (plan.engine === "codex") return existsSync(join(dir, "auth.json"));
  return undefined;
}

// The Claude account a subscription plan is signed in as, from Claude Code's
// own account record. Key plans have none.
export function accountEmail(plan: PlanConfig): string | undefined {
  if (plan.engine !== "claude" || plan.env?.ANTHROPIC_BASE_URL || plan.env?.ANTHROPIC_AUTH_TOKEN) return undefined;
  const dir = ownHome(plan);
  try {
    const record = JSON.parse(readFileSync(dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json"), "utf8"));
    const email = record?.oauthAccount?.emailAddress;
    return typeof email === "string" && email ? email : undefined;
  } catch {
    return undefined;
  }
}

// Claude Code runs one-time upgrade steps the first time it starts in a home,
// and some rewrite settings.json, which an account shares with the main home
// (one removed skipAutoPermissionPrompt). So a new account starts from the
// main home's record: its flags, counters and MCP servers, and each folder's
// trust and approvals, never its identity, login or cached account data.
const NOT_SEEDED = /cache|^(oauthAccount|userID|anonymousId|machineID|primaryApiKey|customApiKeyResponses|claudeCodeFirstTokenDate|firstStartTime|hasAvailableSubscription|penguinModeOrgEnabled|hasRemoteEnvironment|subscriptionNoticeCount)$/i;
const PROJECT_SEED = [
  "hasTrustDialogAccepted",
  "hasClaudeMdExternalIncludesApproved",
  "hasClaudeMdExternalIncludesWarningShown",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "mcpServers",
  "mcpContextUris",
  "allowedTools"
];

function seedClaudeState(home: string): void {
  const file = join(home, ".claude.json");
  if (existsSync(file)) return;
  let main: Record<string, unknown>;
  try {
    main = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
  } catch {
    return;
  }
  const seed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(main)) {
    if (NOT_SEEDED.test(key)) continue;
    if (["boolean", "number", "string"].includes(typeof value)) seed[key] = value;
  }
  if (main.mcpServers && typeof main.mcpServers === "object") seed.mcpServers = main.mcpServers;
  const projects: Record<string, Record<string, unknown>> = {};
  for (const [path, entry] of Object.entries((main.projects ?? {}) as Record<string, Record<string, unknown>>)) {
    const kept = Object.fromEntries(PROJECT_SEED.filter((k) => k in (entry ?? {})).map((k) => [k, entry[k]]));
    if (Object.keys(kept).length > 0) projects[path] = kept;
  }
  seed.projects = projects;
  // wx: never over a record the CLI wrote first
  writeFileSync(file, JSON.stringify(seed, null, 2), { mode: 0o600, flag: "wx" });
}

// Links everything an account shares into its home. Runs before every login
// and every turn, so something new in the main home reaches every account,
// and a link a CLI replaced with its own copy of the file is put back.
export function linkShared(plan: PlanConfig): void {
  const home = managedHome(plan);
  const main = mainHome(plan.engine);
  const names = SHARED[plan.engine];
  if (!home || !main || !names) return;
  mkdirSync(home, { recursive: true });
  if (plan.engine === "claude") {
    try {
      seedClaudeState(home);
    } catch {
      // without a seed the CLI starts its record fresh
    }
  }
  for (const name of names) {
    try {
      linkOne(join(main, name), join(home, name));
    } catch {
      // one entry that cannot be linked leaves the rest in place
    }
  }
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function setAside(p: string): void {
  renameSync(p, `${p}.unlinked-${Date.now()}`);
}

function linkOne(src: string, dst: string): void {
  const have = lstatOrNull(dst);
  if (!existsSync(src)) {
    // gone from the main home: drop the link to it, keep anything else
    if (have?.isSymbolicLink() && readlinkSync(dst) === src) unlinkSync(dst);
    return;
  }
  if (have?.isSymbolicLink()) {
    if (readlinkSync(dst) === src) return;
    unlinkSync(dst);
  } else if (have?.isFile() && statSync(src).isFile()) {
    // A CLI saved the file whole and replaced the link. Its copy is the
    // newest edit unless the main file changed since; then the account's
    // copy is set aside instead of lost.
    const mine = readFileSync(dst);
    if (!mine.equals(readFileSync(src))) {
      if (have.mtimeMs > statSync(src).mtimeMs) writeFileSync(src, mine);
      else setAside(dst);
    }
    if (lstatOrNull(dst)) unlinkSync(dst);
  } else if (have?.isDirectory() && statSync(src).isDirectory()) {
    // made here before the main home had one: what the main home lacks
    // moves over, and a folder with clashes is set aside
    for (const name of readdirSync(dst)) {
      if (!lstatOrNull(join(src, name))) renameSync(join(dst, name), join(src, name));
    }
    if (readdirSync(dst).length === 0) rmdirSync(dst);
    else setAside(dst);
  } else if (have) {
    setAside(dst);
  }
  symlinkSync(src, dst);
}

// A deleted account signs out through its own CLI, which clears its keychain
// entry or auth file, and the home this app made for it goes. The links are
// removed one by one first, so nothing they point at can be touched.
export async function forgetAccount(plan: PlanConfig, bin: string): Promise<void> {
  const home = managedHome(plan);
  const login = ownLoginArgs(plan);
  if (!home || !login) return;
  await new Promise<void>((done) => {
    const args = plan.engine === "claude" ? ["auth", "logout"] : ["logout"];
    const proc = spawn(bin, args, { env: { ...process.env, ...login.env }, stdio: "ignore" });
    const timer = setTimeout(() => proc.kill(), 15000);
    const finish = (): void => {
      clearTimeout(timer);
      done();
    };
    proc.on("exit", finish);
    proc.on("error", finish);
  });
  try {
    for (const name of readdirSync(home)) {
      if (lstatOrNull(join(home, name))?.isSymbolicLink()) unlinkSync(join(home, name));
    }
    rmSync(home, { recursive: true, force: true });
  } catch {
    // a leftover folder holds no login
  }
}
