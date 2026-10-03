import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCP_PACKAGE } from "./chromeBrowser.ts";
import { holdEngine, resolveBin } from "./engines/index.ts";
import type { EngineKind } from "./engines/types.ts";

// The engine CLIs update themselves only when run by hand in Terminal (a
// native Claude Code install is the exception). The app runs them headless,
// so Codex, Gemini and Kimi fell weeks behind. With the setting on, the app
// checks each installed CLI against its latest release at launch and every
// six hours, and updates it the way it was installed once no chat on it is
// working. A new major version can change the flags the adapters use, so it
// waits for an Update click in Settings.

interface Cli {
  engine: EngineKind;
  label: string;
  bin: string;
  npm?: string;
}

const CLIS: Cli[] = [
  { engine: "claude", label: "Claude Code", bin: "claude", npm: "@anthropic-ai/claude-code" },
  { engine: "codex", label: "Codex", bin: "codex", npm: "@openai/codex" },
  { engine: "gemini", label: "Gemini CLI", bin: "gemini", npm: "@google/gemini-cli" },
  { engine: "kimi", label: "Kimi Code", bin: "kimi" }
];

const CHECK_EVERY = 6 * 60 * 60 * 1000;
// how stale the list may be when Settings opens
const FRESH_FOR = 60 * 60 * 1000;
// a chat on the CLI is working: look again in a minute
const RETRY_BUSY = 60 * 1000;

// How a CLI was installed, read from where its command really lives
export type Install =
  | { via: "native" }
  | { via: "npm"; pkg: string; prefix: string }
  | { via: "brew"; name: string }
  | { via: "kimi" };

export function installOf(realPath: string): Install | undefined {
  // before npm: a Homebrew formula can keep its own node_modules
  const brew = /\/(?:Cellar|Caskroom)\/([^/]+)\//.exec(realPath);
  if (brew) return { via: "brew", name: brew[1] };
  if (realPath.includes("/.local/share/claude/versions/")) return { via: "native" };
  const npm = /^(.*)\/lib\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(realPath);
  if (npm) return { via: "npm", prefix: npm[1], pkg: npm[2] };
  if (realPath.includes("/.kimi-code/")) return { via: "kimi" };
  return undefined;
}

export function updateCommand(install: Install, bin: string, latest?: string): { command: string; args: string[] } {
  switch (install.via) {
    case "native":
      return { command: bin, args: ["update"] };
    // --prefix: into the same place, whatever npm's own prefix is
    case "npm":
      return {
        command: resolveBin("npm"),
        args: ["install", "-g", "--prefix", install.prefix, `${install.pkg}@${latest ?? "latest"}`]
      };
    case "brew":
      return { command: resolveBin("brew"), args: ["upgrade", install.name] };
    case "kimi":
      return { command: bin, args: ["upgrade", "-y"] };
  }
}

export function parseVersion(text: string): string | undefined {
  return /\d+(?:\.\d+)+/.exec(text)?.[0];
}

export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// the app installs a newer version on its own only within the same major
export function updatesOnItsOwn(installed: string, latest: string): boolean {
  return compareVersions(latest, installed) > 0 && installed.split(".")[0] === latest.split(".")[0];
}

export type CliState =
  | "current" // newest there is
  | "behind" // newer one out, same major
  | "held" // newer major out, waits for Update
  | "manual" // newer one out, installed some way the app cannot update
  | "waiting" // update queued until its chats finish
  | "updating"
  | "failed"
  | "pinned" // kept at one version on purpose
  | "unknown"; // could not look up the latest

export interface CliStatus {
  id: string;
  label: string;
  installed: string;
  latest?: string;
  state: CliState;
  error?: string;
}

interface Found {
  cli: Cli;
  bin: string;
  install?: Install;
  installed: string;
  latest?: string;
}

interface Hooks {
  // a chat on this engine is working
  busy: (engine: EngineKind) => boolean;
  // the setting is on
  auto: () => boolean;
  onChange: (list: CliStatus[]) => void;
}

let hooks: Hooks = { busy: () => false, auto: () => false, onChange: () => undefined };
let found = new Map<EngineKind, Found>();
let browserLatest: string | undefined;
const queued = new Set<EngineKind>();
const failures = new Map<EngineKind, string>();
let updating: EngineKind | undefined;
let checkedAt = 0;
let checking: Promise<void> | undefined;
let retry: NodeJS.Timeout | undefined;

function spawnPiped(command: string, args: string[]) {
  return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let proc: ReturnType<typeof spawnPiped>;
    try {
      proc = spawnPiped(command, args);
    } catch (err) {
      resolve({ code: -1, out: (err as Error).message });
      return;
    }
    const keep = (chunk: Buffer): void => {
      out = (out + chunk.toString("utf8")).slice(-4000);
    };
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function npmLatest(pkg: string, tag = "latest"): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/-/package/${pkg}/dist-tags`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return undefined;
    const tags = (await res.json()) as Record<string, string>;
    return tags[tag] ?? tags.latest;
  } catch {
    return undefined;
  }
}

// a native install follows the channel picked in Claude Code's settings
function claudeChannel(): string {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")) as {
      autoUpdatesChannel?: string;
    };
    return settings.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}

// Kimi keeps the newest release it has seen; there is no npm package to ask
function kimiLatest(): string | undefined {
  try {
    const seen = JSON.parse(readFileSync(join(homedir(), ".kimi-code", "updates", "latest.json"), "utf8")) as {
      latest?: unknown;
    };
    return typeof seen.latest === "string" ? parseVersion(seen.latest) : undefined;
  } catch {
    return undefined;
  }
}

async function inspect(cli: Cli): Promise<Found | undefined> {
  const bin = resolveBin(cli.bin);
  if (!existsSync(bin)) return undefined;
  let install: Install | undefined;
  try {
    install = installOf(realpathSync(bin));
  } catch {
    install = undefined;
  }
  const { out } = await run(bin, ["--version"], 20_000);
  const installed = parseVersion(out);
  if (!installed) return undefined;
  let latest: string | undefined;
  if (install?.via === "npm") latest = await npmLatest(install.pkg);
  else if (cli.engine === "claude" && install?.via === "native") latest = await npmLatest(cli.npm!, claudeChannel());
  else if (cli.engine === "kimi") latest = kimiLatest();
  else if (cli.npm) latest = await npmLatest(cli.npm);
  return { cli, bin, install, installed, latest };
}

function stateOf(f: Found): CliState {
  const engine = f.cli.engine;
  if (updating === engine) return "updating";
  if (queued.has(engine)) return "waiting";
  if (failures.has(engine)) return "failed";
  if (!f.latest) return "unknown";
  if (compareVersions(f.latest, f.installed) <= 0) return "current";
  if (!f.install) return "manual";
  return updatesOnItsOwn(f.installed, f.latest) ? "behind" : "held";
}

export function cliStatus(): CliStatus[] {
  const list: CliStatus[] = [];
  for (const cli of CLIS) {
    const f = found.get(cli.engine);
    if (!f) continue;
    list.push({
      id: cli.engine,
      label: cli.label,
      installed: f.installed,
      latest: f.latest,
      state: stateOf(f),
      ...(failures.has(cli.engine) ? { error: failures.get(cli.engine) } : {})
    });
  }
  const pinned = parseVersion(MCP_PACKAGE.split("@").pop() ?? "");
  if (pinned && checkedAt) {
    // latest only when it is newer, for the note that says so
    const newer = browserLatest && compareVersions(browserLatest, pinned) > 0 ? browserLatest : undefined;
    list.push({ id: "browser", label: "Chrome DevTools MCP", installed: pinned, latest: newer, state: "pinned" });
  }
  return list;
}

function changed(): void {
  hooks.onChange(cliStatus());
}

export function checkClis(): Promise<void> {
  checking ??= (async () => {
    const [list, browser] = await Promise.all([
      Promise.all(CLIS.map((cli) => inspect(cli))),
      npmLatest(MCP_PACKAGE.slice(0, MCP_PACKAGE.lastIndexOf("@")))
    ]);
    found = new Map(list.filter((f): f is Found => !!f).map((f) => [f.cli.engine, f]));
    browserLatest = browser;
    checkedAt = Date.now();
    if (hooks.auto()) {
      for (const f of found.values()) {
        const due = f.install && f.latest && updatesOnItsOwn(f.installed, f.latest);
        if (due && updating !== f.cli.engine) queued.add(f.cli.engine);
      }
    }
    changed();
    void pump();
  })().finally(() => {
    checking = undefined;
  });
  return checking;
}

// what Settings shows; looks again when the last check is old
export function freshCliStatus(): CliStatus[] {
  if (!checking && Date.now() - checkedAt > FRESH_FOR) void checkClis();
  return cliStatus();
}

// the Update button: now, or once the CLI's chats finish
export function updateCli(engine: EngineKind): CliStatus[] {
  const f = found.get(engine);
  if (f?.install && updating !== engine) {
    failures.delete(engine);
    queued.add(engine);
    void pump();
  }
  return cliStatus();
}

// One install at a time: two npm installs into one prefix can trip over
// each other.
async function pump(): Promise<void> {
  if (updating || !queued.size) return;
  const engine = [...queued].find((e) => !hooks.busy(e));
  if (!engine) {
    retry ??= setTimeout(() => {
      retry = undefined;
      void pump();
    }, RETRY_BUSY);
    changed();
    return;
  }
  queued.delete(engine);
  const f = found.get(engine);
  if (!f?.install) return void pump();
  updating = engine;
  failures.delete(engine);
  changed();
  const { command, args } = updateCommand(f.install, f.bin, f.latest);
  const install = run(command, args, 10 * 60 * 1000);
  holdEngine(engine, install);
  const { code, out } = await install;
  const after = await inspect(f.cli);
  if (after) found.set(engine, after);
  const now = after?.installed ?? f.installed;
  if (code !== 0) {
    const lines = out.trim().split("\n").filter(Boolean);
    failures.set(engine, lines.slice(-2).join(" ").slice(0, 300) || `exit code ${code}`);
  } else if (f.latest && compareVersions(f.latest, now) > 0) {
    failures.set(engine, `The update finished, but it is still on ${now}.`);
  }
  updating = undefined;
  changed();
  void pump();
}

export function startCliUpdates(given: Hooks): void {
  hooks = given;
  // after launch settles; nothing waits on it
  setTimeout(() => {
    if (hooks.auto()) void checkClis();
  }, 30_000);
  setInterval(() => {
    if (hooks.auto()) void checkClis();
  }, CHECK_EVERY);
}
