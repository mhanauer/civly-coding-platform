import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The skills you made, for the Skills view: every folder with a SKILL.md in
// the personal skill folders Claude and Codex read, then in each project's
// own. Pure (no electron imports) so it can be tested on its own.

export interface Skill {
  name: string;
  // one short sentence from its description
  summary: string;
  description: string;
  // "" for a personal skill, else the project it belongs to
  project: string;
  // the SKILL.md that holds its instructions (the original, for a link)
  file: string;
}

export interface SkillSource {
  project: string;
  dirs: string[];
}

// Where Claude and Codex look for personal skills, and a project's own.
export function personalSkillDirs(home: string, codexHome?: string): string[] {
  return [join(home, ".claude", "skills"), join(home, ".agents", "skills"), join(codexHome || join(home, ".codex"), "skills")];
}

export function projectSkillDirs(path: string): string[] {
  return [join(path, ".claude", "skills"), join(path, ".agents", "skills")];
}

// Skills that came with Codex or a plugin rather than from you.
const BUILT_IN = /\/(\.system|plugins)\//;
// how far into a skill's body a link to its original may sit
const LINK_WITHIN = 600;
const SUMMARY_MAX = 150;
const SUMMARY_MIN = 60;

interface Parsed {
  name: string;
  description: string;
  body: string;
}

// The name and description from a SKILL.md's frontmatter. Descriptions may
// run over several indented lines, sit in quotes, or follow > or |.
export function parseSkill(text: string): Parsed {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { name: "", description: "", body: text };
  const lines = match[1].split(/\r?\n/);
  const field = (key: string): string => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at === -1) return "";
    const parts = [lines[at].slice(key.length + 1).trim()];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s/.test(line) && line.trim()) break;
      parts.push(line.trim());
    }
    if (/^[>|][-+]?$/.test(parts[0])) parts.shift();
    const value = parts.join(" ").replace(/\s+/g, " ").trim();
    if (/^".*"$/.test(value)) return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
    return value;
  };
  return { name: field("name"), description: field("description"), body: text.slice(match[0].length) };
}

// A short plain sentence: the description's first sentence, without the
// "Use when ..." trigger list, the detail after a dash, or asides in brackets.
export function summarize(description: string): string {
  let text = description.replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text.split(/(?<=[.!?])\s+(?=[A-Z"])/)[0];
  const dash = text.search(/\s[-–—]\s/);
  if (dash >= 25) text = text.slice(0, dash);
  text = text.replace(/\s*\([^)]*\)/g, "").trim();
  if (text.length > SUMMARY_MAX) {
    // the first clause long enough to say what it does
    const comma = text.indexOf(", ", SUMMARY_MIN);
    const space = text.lastIndexOf(" ", SUMMARY_MAX - 1);
    text = comma !== -1 && comma < SUMMARY_MAX ? text.slice(0, comma) : `${text.slice(0, space > 0 ? space : SUMMARY_MAX - 1)}…`;
  }
  text = text.replace(/[\s,;:]+$/, "");
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

// A skill that only points at another (one assistant borrowing a skill kept
// for another) opens with a link to the original's SKILL.md. Followed so
// each skill shows once, from its original.
function original(file: string, body: string): string | null {
  const link = /\]\(<?([^()<>\s]*SKILL\.md)>?\)/.exec(body.slice(0, LINK_WITHIN));
  if (!link) return null;
  const target = resolve(dirname(file), link[1]);
  return existsSync(target) ? target : null;
}

function read(file: string): { file: string; parsed: Parsed } | null {
  let real: string;
  let parsed: Parsed;
  try {
    real = realpathSync(file);
    parsed = parseSkill(readFileSync(real, "utf8"));
  } catch {
    return null;
  }
  const next = original(real, parsed.body);
  return next ? { file: realpathSync(next), parsed: parseSkill(readFileSync(next, "utf8")) } : { file: real, parsed };
}

export function listSkills(sources: readonly SkillSource[]): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const { project, dirs } of sources) {
    const mine: Skill[] = [];
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (entry.startsWith(".")) continue;
        const found = read(join(dir, entry, "SKILL.md"));
        if (!found || seen.has(found.file) || BUILT_IN.test(found.file)) continue;
        seen.add(found.file);
        const name = found.parsed.name || entry;
        const { description } = found.parsed;
        // a project's copy of a personal skill (another checkout of the
        // same repo) is already listed with your personal ones
        if (project && out.some((s) => !s.project && s.name === name && s.description === description)) continue;
        mine.push({ name, summary: summarize(description), description, project, file: found.file });
      }
    }
    out.push(...mine.sort((a, b) => a.name.localeCompare(b.name)));
  }
  return out;
}
