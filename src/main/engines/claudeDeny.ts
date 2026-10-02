import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DenyHit {
  rule: string;
  // where the rule lives, with the home folder shown as ~
  file: string;
}

// Every file Claude Code reads permission rules from. Project files come
// only from the folder the chat runs in: Claude Code does not look in
// parent folders, so a chat in a repo's subfolder skips the repo's rules.
// A chat in the home folder reads ~/.claude/settings.json once, not twice.
export function settingsFiles(cwd: string): string[] {
  return [
    ...new Set([
      join(homedir(), ".claude", "settings.json"),
      join(cwd, ".claude", "settings.json"),
      join(cwd, ".claude", "settings.local.json"),
      "/Library/Application Support/ClaudeCode/managed-settings.json"
    ])
  ];
}

export function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

function denyRules(file: string): string[] {
  try {
    const deny = (JSON.parse(readFileSync(file, "utf8")) as { permissions?: { deny?: unknown } }).permissions?.deny;
    return Array.isArray(deny) ? deny.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

// A Bash rule's pattern as a regex: * is any run of characters, and a
// trailing " *" (or the older ":*") also matches the bare command, so
// "rm -rf *" matches "rm -rf" and "rm -rf $D" but not "rm -r x".
function wildcard(pattern: string): RegExp {
  const p = pattern.endsWith(":*") ? pattern.slice(0, -2) + " *" : pattern;
  const tail = p.endsWith(" *");
  const body = (tail ? p.slice(0, -2) : p)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${tail ? "(?: .*)?" : ""}$`, "s");
}

// Claude Code checks each piece of a compound command on its own, so
// "D=x && rm -rf $D" is caught by "rm -rf *". The whole command stays in
// the list for rules like "*DROP TABLE*" that can match anywhere in it.
function commandParts(command: string): string[] {
  const parts = command
    .split(/&&|\|\||[;|&\n]/)
    .map((p) =>
      p
        .trim()
        .replace(/^(?:(?:do|then|else)\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "")
        .trim()
    )
    .filter(Boolean);
  return [command.trim(), ...parts];
}

function ruleMatches(rule: string, tool: string, input: Record<string, unknown>): boolean {
  const m = /^([^(]+?)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m) return false;
  const [, ruleTool, pattern] = m;
  if (ruleTool !== tool && !(ruleTool.startsWith("mcp__") && tool.startsWith(ruleTool + "__"))) return false;
  if (!pattern || pattern === "*") return true;
  // path and domain rules for other tools are counted as the likely match:
  // the tool was refused and this file limits it
  if (tool !== "Bash") return true;
  const re = wildcard(pattern);
  return commandParts(String(input.command ?? "")).some((part) => re.test(part));
}

// The deny rules that refused a tool call, and the files they live in.
// Empty when none match, e.g. a rule shape this does not read.
export function findDenyRules(cwd: string, tool: string, input: Record<string, unknown>): DenyHit[] {
  const hits: DenyHit[] = [];
  for (const file of settingsFiles(cwd)) {
    for (const rule of denyRules(file)) {
      if (ruleMatches(rule, tool, input)) hits.push({ rule, file: tildify(file) });
    }
  }
  return hits;
}

// The chat's error for a call Claude Code refused on its own, naming the
// rule and the file to change. what is the tool and its command, as shown.
export function denyMessage(cwd: string, tool: string, input: Record<string, unknown>, what: string): string {
  const hits = findDenyRules(cwd, tool, input);
  if (!hits.length) {
    const project = tildify(join(cwd, ".claude"));
    return `Blocked by your Claude Code settings: ${what}. Look under permissions.deny in ~/.claude/settings.json, ${project}/settings.json and ${project}/settings.local.json. Full access does not override a deny rule.`;
  }
  const rules = hits.map((h) => `${h.rule} in ${h.file}`).join(", and ");
  const where = new Set(hits.map((h) => h.file)).size > 1 ? "those files" : "that file";
  return `Blocked by the deny rule${hits.length > 1 ? "s" : ""} ${rules}: ${what}. Full access does not override a deny rule. Usually the fix is to ask Claude to do that step without this command. If you do want it allowed, move the rule to "ask" in ${where} to approve these from the chat, or remove it, then send again.`;
}
