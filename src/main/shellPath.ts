import { spawnSync } from "node:child_process";
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
  const fromShell: Record<string, string> = {};
  try {
    const r = spawnSync(process.env.SHELL || "/bin/zsh", ["-ilc", `printf '${MARK}'; env -0; printf '${MARK}'`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    // markers skip anything the shell's startup files print
    const block = new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(r.stdout ?? "")?.[1] ?? "";
    for (const entry of block.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) fromShell[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } catch {
    // no readable shell: the known dirs below still cover the engines
  }
  for (const [name, value] of Object.entries(fromShell)) {
    if (name === "PATH" || SHELL_OWN.has(name) || name in process.env) continue;
    process.env[name] = value;
  }
  const parts = [...(fromShell.PATH ?? "").split(":"), ...(process.env.PATH ?? "").split(":"), ...userBinDirs()];
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(":");
}
