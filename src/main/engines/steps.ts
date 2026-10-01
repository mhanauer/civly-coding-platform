import type { ToolStep } from "./types.ts";

// Turns one engine tool call into a display step, ZCode-style: reads and
// searches fold into "Explore", shell commands show as "Terminal", file
// changes show as "Edit" with line counts. Pure (no node imports) so the
// renderer can reuse it for chats saved before steps existed.

type Input = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

// Lines added and removed between two snippets, counted as a multiset
// difference: cheap, and exact for the usual replace-a-block edit.
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>();
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after ? after.replace(/\n$/, "").split("\n") : [];
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of b) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  return { added, removed };
}

// Most diff lines kept per step, so a big rewrite cannot bloat a chat file.
const DIFF_LIMIT = 400;

function splitLines(text: string): string[] {
  return text ? text.replace(/\n$/, "").split("\n") : [];
}

// Line diff of one edit as "+added", "-removed", " unchanged" lines, via a
// longest-common-subsequence table. Very large snippets skip the alignment
// and list old then new, which is still readable.
export function diffLines(before: string, after: string): string[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let out: string[];
  if (a.length * b.length > 250000) {
    out = [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)];
  } else {
    const n = a.length;
    const m = b.length;
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push(` ${a[i]}`);
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        out.push(`-${a[i++]}`);
      } else {
        out.push(`+${b[j++]}`);
      }
    }
    while (i < n) out.push(`-${a[i++]}`);
    while (j < m) out.push(`+${b[j++]}`);
  }
  if (out.length > DIFF_LIMIT) {
    out = [...out.slice(0, DIFF_LIMIT), ` … ${out.length - DIFF_LIMIT} more lines`];
  }
  return out;
}

// Codex wraps every command as `/bin/zsh -lc '<cmd>'`; show just <cmd>.
export function unwrapShell(command: string): string {
  const m = /^\S*\/(?:ba|z)?sh\s+-l?c\s+([\s\S]*)$/.exec(command.trim());
  if (!m) return command.trim();
  let inner = m[1].trim();
  const q = inner[0];
  if ((q === "'" || q === '"') && inner.endsWith(q)) inner = inner.slice(1, -1);
  return inner;
}

const EXPLORE_READ = new Set(["read", "readfile", "notebookread", "view", "ls", "list", "listdir"]);
const EXPLORE_SEARCH = new Set(["grep", "glob", "search", "find", "codebase_search", "toolsearch"]);
const TERMINAL = new Set(["bash", "shell", "run", "exec", "command", "monitor"]);
const EDIT = new Set(["edit", "multiedit", "strreplacefile", "str_replace", "notebookedit", "patch", "apply_patch"]);
const WRITE = new Set(["write", "writefile", "create"]);
const WEB = new Set(["websearch", "webfetch", "searchweb", "fetchurl", "fetch", "web_search"]);
const AGENT = new Set(["task", "agent"]);

export function classifyTool(name: string, rawInput: unknown): ToolStep {
  const input: Input = rawInput && typeof rawInput === "object" ? (rawInput as Input) : {};
  const key = name.toLowerCase().replace(/^mcp__.*__/, "");
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path);

  if (key === "todowrite" || key === "todo_list" || key === "settodolist") {
    const raw = Array.isArray(input.todos) ? input.todos : Array.isArray(input.items) ? input.items : [];
    const todos = raw
      .map((t) => {
        const o = (t ?? {}) as Input;
        const text = str(o.activeForm) && str(o.status) === "in_progress" ? str(o.activeForm) : str(o.content) || str(o.text) || str(o.title);
        const status = str(o.status) || (o.completed === true ? "completed" : "pending");
        return { text, status };
      })
      .filter((t) => t.text);
    return { type: "todo", label: "Plan", todos };
  }
  if (EXPLORE_READ.has(key)) {
    return { type: "explore", label: "Read", target: path || str(input.pattern) };
  }
  if (EXPLORE_SEARCH.has(key)) {
    const pattern = str(input.pattern) || str(input.query) || str(input.glob);
    return { type: "explore", label: "Search", target: path ? `${pattern} in ${path}` : pattern, search: true };
  }
  if (TERMINAL.has(key)) {
    const command = unwrapShell(str(input.command) || str(input.cmd));
    return { type: "terminal", label: "Terminal", target: command, note: str(input.description) };
  }
  if (EDIT.has(key)) {
    let added = 0;
    let removed = 0;
    const diff: string[] = [];
    const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [input];
    edits.forEach((e, n) => {
      const before = str(e.old_string) || str(e.old);
      const after = str(e.new_string) || str(e.new) || str(e.new_source);
      const d = lineDelta(before, after);
      added += d.added;
      removed += d.removed;
      if (n > 0) diff.push(" ⋯");
      diff.push(...diffLines(before, after));
    });
    return { type: "edit", label: "Edit", target: path, added, removed, diff: diff.slice(0, DIFF_LIMIT + 1) };
  }
  if (WRITE.has(key)) {
    const content = str(input.content);
    return { type: "edit", label: "Write", target: path, added: lineCount(content), diff: diffLines("", content) };
  }
  if (WEB.has(key)) {
    return { type: "web", label: key.includes("fetch") ? "Fetch" : "Web search", target: str(input.url) || str(input.query) };
  }
  if (AGENT.has(key)) {
    return { type: "agent", label: "Agent", target: str(input.description) || str(input.prompt).slice(0, 120) };
  }
  // anything else (MCP tools, cron, skills): name plus the most telling field
  const hint =
    path ||
    str(input.command) ||
    str(input.query) ||
    str(input.url) ||
    str(input.description) ||
    str(input.name) ||
    str(input.skill);
  return { type: "other", label: name.replace(/^mcp__/, "").replace(/__/g, " · "), target: hint };
}

// Chats saved before steps existed carry only a name and a truncated JSON
// snippet; recover what we can so old history renders the new way too.
export function classifyLegacy(name: string, detail?: string): ToolStep {
  let input: unknown = {};
  if (detail) {
    try {
      input = JSON.parse(detail);
    } catch {
      const grab = (k: string): string => {
        const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(detail);
        return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
      };
      input = {
        file_path: grab("file_path"),
        path: grab("path"),
        command: grab("command"),
        pattern: grab("pattern"),
        query: grab("query"),
        url: grab("url"),
        description: grab("description")
      };
      // plain-text details (codex commands) are the command itself
      if (!/^\s*\{/.test(detail)) input = { command: detail };
    }
  }
  const step = classifyTool(name, input);
  // the snippet cut the edit text short, so its counts and diff would be wrong
  if (step.type === "edit") return { ...step, added: undefined, removed: undefined, diff: undefined };
  return step;
}
