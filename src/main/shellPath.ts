import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// User-level bin dirs where the engine CLIs (and the node that runs codex)
// install. Used when the login shell cannot be read.
export function userBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".kimi-code", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
}

const MARK = "__CPH_ENV__";
const READ_ENV = ["-ilc", `printf '${MARK}'; env -0; printf '${MARK}'`];

// set by the shell about itself, not by the user's startup files
const SHELL_OWN = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

// An app opened from the Dock or Finder gets launchd's bare environment:
// PATH is /usr/bin:/bin:/usr/sbin:/sbin and nothing the user exports is set.
// codex is a node script, so under that PATH `#!/usr/bin/env node` fails
// before it prints a line, and every command an engine runs misses the
// user's own tools. A project .mcp.json that reads ${SOME_API_KEY} gets the
// literal text, the server refuses it, and mcp-remote asks for a browser
// sign-in on every chat that can never stick, since the refused header
// outranks the token it signed in for. Take the environment the
// user's login shell builds, once, at startup, so engines run the same as
// they do from Terminal. What the app already has stays; PATH is merged.
export function adoptShellEnv(): void {
  let stdout = "";
  try {
    stdout = spawnSync(shell(), READ_ENV, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "";
  } catch {
    // no readable shell: the known dirs below still cover the engines
  }
  const fromShell = parseEnv(stdout);
  merge(fromShell ?? {});
  // A busy launch can push the shell past 5s (seen on 2026-10-05: zsh still
  // starting 3s in), and a missed read used to leave every chat that session
  // without the user's variables. Keep waiting off the main thread; chats
  // started after it lands get the full environment.
  if (!fromShell) readLater();
}

function shell(): string {
  return process.env.SHELL || "/bin/zsh";
}

function readLater(): void {
  let stdout = "";
  try {
    const proc = spawn(shell(), READ_ENV, { timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    proc.on("error", () => undefined);
    proc.on("close", () => {
      const fromShell = parseEnv(stdout);
      if (fromShell) merge(fromShell);
    });
  } catch {
    // no readable shell
  }
}

// markers skip anything the shell's startup files print; no closing marker
// means the shell never finished
function parseEnv(stdout: string): Record<string, string> | undefined {
  const block = new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(stdout)?.[1];
  if (block === undefined) return undefined;
  const fromShell: Record<string, string> = {};
  for (const entry of block.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) fromShell[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return fromShell;
}

function merge(fromShell: Record<string, string>): void {
  for (const [name, value] of Object.entries(fromShell)) {
    if (name === "PATH" || SHELL_OWN.has(name) || name in process.env) continue;
    process.env[name] = value;
  }
  const parts = [...(fromShell.PATH ?? "").split(":"), ...(process.env.PATH ?? "").split(":"), ...userBinDirs()];
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(":");
}
