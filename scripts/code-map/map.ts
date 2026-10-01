// The map builder for the code-map test: every source file in a project with
// its main functions and classes, ranked by how many other files refer to
// them, cut to a fixed size. Parsed with tree-sitter, the way Aider builds its
// repo map; ranked by a plain count of referring files, which is easier to
// check by hand than Aider's graph ranking.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, posix, relative, sep } from "node:path";
import type { Language, Node, Parser, Query } from "@vscode/tree-sitter-wasm";

const require = createRequire(import.meta.url);
const TreeSitter = require("@vscode/tree-sitter-wasm") as typeof import("@vscode/tree-sitter-wasm");
const WASM_DIR = join(dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");

export const DEFAULT_TOKENS = 8000;
// Code and paths run about 3.5 characters a token for the models tested; the
// runs record real token counts, so this only has to be close.
const CHARS_PER_TOKEN = 3.5;
// Bigger files are generated or data, not code anyone reads.
const MAX_FILE_BYTES = 300_000;
const SIGNATURE_MAX = 160;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".venv", "venv", "__pycache__", "vendor"]);
// files that stand for their folder: importing the folder reaches them, and
// through them whatever they import
const FOLDER_FILES = new Set(["index", "__init__", "mod"]);

interface LanguageSpec {
  wasm: string;
  // @def is the whole definition, @name its name
  defs: string;
  // node types that name something: a possible use of a definition
  refs: string[];
  // @src is a module or path the file imports
  imports: string;
  comments: string[];
  // the language's files see their folder's definitions without importing
  // them (one package per folder)
  folderScope?: boolean;
}

const TS_DEFS = `
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(class_declaration name: (type_identifier) @name) @def
(abstract_class_declaration name: (type_identifier) @name) @def
(interface_declaration name: (type_identifier) @name) @def
(type_alias_declaration name: (type_identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(program (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @def)
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @def)
`;
const JS_DEFS = `
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(class_declaration name: (identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(program (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @def)
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @def)
`;
const JS_IMPORTS = `
(import_statement source: (string) @src)
(export_statement source: (string) @src)
(call_expression function: (identifier) @fn arguments: (arguments . (string) @src) (#eq? @fn "require"))
(call_expression function: (import) arguments: (arguments . (string) @src))
`;
const JS_REFS = ["identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"];

const LANGUAGES: Record<string, LanguageSpec> = {
  typescript: {
    wasm: "tree-sitter-typescript.wasm",
    defs: TS_DEFS,
    refs: [...JS_REFS, "type_identifier"],
    imports: JS_IMPORTS,
    comments: ["comment"]
  },
  tsx: {
    wasm: "tree-sitter-tsx.wasm",
    defs: TS_DEFS,
    refs: [...JS_REFS, "type_identifier"],
    imports: JS_IMPORTS,
    comments: ["comment"]
  },
  javascript: { wasm: "tree-sitter-javascript.wasm", defs: JS_DEFS, refs: JS_REFS, imports: JS_IMPORTS, comments: ["comment"] },
  python: {
    wasm: "tree-sitter-python.wasm",
    defs: `
(class_definition name: (identifier) @name) @def
(function_definition name: (identifier) @name) @def
`,
    refs: ["identifier"],
    // from a.b import c: c may be a module of its own (@sub)
    imports: `
(import_statement name: (dotted_name) @src)
(import_statement name: (aliased_import name: (dotted_name) @src))
(import_from_statement module_name: (_) @src)
(import_from_statement module_name: (_) @src name: (dotted_name) @sub)
(import_from_statement module_name: (_) @src name: (aliased_import name: (dotted_name) @sub))
`,
    comments: ["comment"]
  },
  go: {
    wasm: "tree-sitter-go.wasm",
    defs: `
(function_declaration name: (identifier) @name) @def
(method_declaration name: (field_identifier) @name) @def
(type_spec name: (type_identifier) @name) @def
`,
    refs: ["identifier", "type_identifier", "field_identifier"],
    imports: `(import_spec path: (_) @src)`,
    comments: ["comment"],
    folderScope: true
  },
  rust: {
    wasm: "tree-sitter-rust.wasm",
    defs: `
(function_item name: (identifier) @name) @def
(struct_item name: (type_identifier) @name) @def
(enum_item name: (type_identifier) @name) @def
(trait_item name: (type_identifier) @name) @def
`,
    refs: ["identifier", "type_identifier", "field_identifier"],
    imports: `
(use_declaration argument: (_) @src)
(mod_item name: (identifier) @src)
`,
    comments: ["line_comment", "block_comment"]
  },
  java: {
    wasm: "tree-sitter-java.wasm",
    defs: `
(class_declaration name: (identifier) @name) @def
(interface_declaration name: (identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(method_declaration name: (identifier) @name) @def
`,
    refs: ["identifier", "type_identifier"],
    imports: `(import_declaration (_) @src)`,
    comments: ["line_comment", "block_comment"],
    folderScope: true
  }
};

const EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java"
};

export function languageOf(path: string): string | undefined {
  if (/\.d\.ts$|\.min\.js$/.test(path)) return undefined;
  return EXTENSIONS[extname(path).toLowerCase()];
}

interface Loaded {
  language: Language;
  defs: Query;
  refs: Query;
  imports: Query;
}

let parser: Parser | undefined;
const loaded = new Map<string, Promise<Loaded>>();

async function getParser(): Promise<Parser> {
  if (!parser) {
    await TreeSitter.Parser.init({ locateFile: (file: string) => join(WASM_DIR, file) });
    parser = new TreeSitter.Parser();
  }
  return parser;
}

// Compiles a language's queries; a query that does not fit its grammar
// throws here, which the tests check for every language.
export async function loadLanguage(lang: string): Promise<Loaded> {
  let entry = loaded.get(lang);
  if (!entry) {
    const spec = LANGUAGES[lang];
    entry = (async () => {
      // the runtime has to be up before a language can load
      await getParser();
      const language = await TreeSitter.Language.load(join(WASM_DIR, spec.wasm));
      return {
        language,
        defs: new TreeSitter.Query(language, spec.defs),
        refs: new TreeSitter.Query(language, `[${spec.refs.map((t) => `(${t})`).join(" ")}] @ref`),
        imports: new TreeSitter.Query(language, spec.imports)
      };
    })();
    loaded.set(lang, entry);
  }
  return entry;
}

export const LANGUAGE_NAMES = Object.keys(LANGUAGES);

export interface Definition {
  name: string;
  // 1-based
  line: number;
  // the definition up to its body, comments dropped and whitespace folded
  signature: string;
  // leading spaces of its line, so methods sit under their class
  indent: number;
  // the definition it sits in, for methods and nested functions
  parent?: string;
}

export interface ParsedFile {
  path: string;
  lang: string;
  defs: Definition[];
  // every name the file uses, once each
  refs: Set<string>;
  // every module it imports, as a path (importPath)
  imports: Set<string>;
}

// The start of a definition up to its body: the signature without the code.
function signatureOf(def: Node, source: string, comments: string[]): string {
  let body = def.childForFieldName("body");
  if (!body) {
    // const f = () => {...}, possibly inside export
    const decl = def.type === "export_statement" ? def.namedChildren.find((c) => c?.type === "lexical_declaration") : def;
    const value = decl?.namedChildren.find((c) => c?.type === "variable_declarator")?.childForFieldName("value");
    body = value?.childForFieldName("body") ?? null;
  }
  const lineStart = source.lastIndexOf("\n", def.startIndex - 1) + 1;
  const firstLineEnd = source.indexOf("\n", def.startIndex);
  const end = body && body.startIndex > def.startIndex ? body.startIndex : firstLineEnd === -1 ? source.length : firstLineEnd;
  let text = "";
  let at = lineStart;
  if (body) {
    for (const c of def.descendantsOfType(comments, def.startPosition, body.startPosition)) {
      if (!c || c.startIndex < at || c.endIndex > end) continue;
      text += source.slice(at, c.startIndex);
      at = c.endIndex;
    }
  }
  text = (text + source.slice(at, end))
    .replace(/\s+/g, " ")
    .replace(/\s*[{:=]?\s*$/, "")
    .trim();
  return text.length > SIGNATURE_MAX ? `${text.slice(0, SIGNATURE_MAX - 1)}…` : text;
}

// A module an import names, as a slash path without extension: resolved
// against the importing file when relative ("./x" in TypeScript, ".x" in
// Python), as written otherwise ("app.models.user" gives app/models/user,
// "@/lib/api" gives lib/api). Matched against the end of file paths, since
// a project's import roots (backend/, src/) are not known.
export function importPath(raw: string, lang: string, from: string): string {
  const text = raw.replace(/^["'`]|["'`]$/g, "").replace(/\s+/g, "");
  const dir = posix.dirname(from);
  const clean = (path: string): string => posix.normalize(path).replace(/^(\.\/)+|\/$/g, "");
  if (lang === "python") {
    const [, dots, rest] = /^(\.*)(.*)$/.exec(text) ?? ["", "", text];
    const tail = rest.split(".").filter(Boolean).join("/");
    if (!dots) return tail;
    let base = dir;
    for (let i = 1; i < dots.length; i++) base = posix.dirname(base);
    return clean(tail ? `${base}/${tail}` : base);
  }
  if (lang === "rust") {
    return text
      .replace(/\{.*$/, "")
      .split("::")
      .filter((p) => p && !["crate", "self", "super"].includes(p))
      .join("/");
  }
  if (lang === "java") return text.replace(/\.\*$/, "").split(".").join("/");
  const path = text.replace(/\.(?:[cm]?[jt]sx?)$/, "");
  if (path.startsWith(".")) return clean(posix.join(dir, path));
  return path.replace(/^[@~#]\//, "");
}

// Every way an import path can name a file: the ends of its path without the
// extension, and of its folder when it stands for the folder (index.ts,
// __init__.py) or shares a package with its folder (Go, Java).
function importNames(path: string, lang: string): string[] {
  const stem = path.replace(/\.[^./]+$/, "");
  const forms = [stem];
  if (FOLDER_FILES.has(basename(stem)) || LANGUAGES[lang].folderScope) forms.push(posix.dirname(path));
  const out: string[] = [];
  for (const form of forms) {
    const parts = form.split("/");
    for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join("/"));
  }
  return out;
}

export async function parseFile(path: string, source: string): Promise<ParsedFile | undefined> {
  const lang = languageOf(path);
  if (!lang) return undefined;
  const p = await getParser();
  const l = await loadLanguage(lang);
  p.setLanguage(l.language);
  const tree = p.parse(source);
  if (!tree) return undefined;
  const found: Array<Definition & { start: number; end: number }> = [];
  const nameNodes = new Set<number>();
  for (const match of l.defs.matches(tree.rootNode)) {
    const def = match.captures.find((c) => c.name === "def")?.node;
    const name = match.captures.find((c) => c.name === "name")?.node;
    if (!def || !name) continue;
    nameNodes.add(name.startIndex);
    // __init__ and friends are called by the language, never by name
    if (/^__\w+__$/.test(name.text)) continue;
    const lineStart = source.lastIndexOf("\n", def.startIndex - 1) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart, def.startIndex))?.[0].replace(/\t/g, "  ").length ?? 0;
    found.push({
      name: name.text,
      line: def.startPosition.row + 1,
      signature: signatureOf(def, source, LANGUAGES[lang].comments),
      indent,
      start: def.startIndex,
      end: def.endIndex
    });
  }
  const defs: Definition[] = found.map(({ start, end, ...d }) => {
    // the innermost definition around this one
    let parent: (typeof found)[number] | undefined;
    for (const o of found) {
      if (o.start <= start && o.end >= end && (o.start !== start || o.end !== end) && (!parent || o.start >= parent.start)) parent = o;
    }
    return parent ? { ...d, parent: parent.name } : d;
  });
  const refs = new Set<string>();
  for (const c of l.refs.captures(tree.rootNode)) {
    if (!nameNodes.has(c.node.startIndex)) refs.add(c.node.text);
  }
  const imports = new Set<string>();
  for (const match of l.imports.matches(tree.rootNode)) {
    const src = match.captures.find((c) => c.name === "src")?.node;
    if (!src) continue;
    const target = importPath(src.text, lang, path);
    const sub = match.captures.find((c) => c.name === "sub")?.node;
    if (sub) imports.add([target, ...sub.text.split(".")].filter(Boolean).join("/"));
    else if (target) imports.add(target);
  }
  tree.delete();
  defs.sort((a, b) => a.line - b.line);
  return { path, lang, defs, refs, imports };
}

// Tracked files when the folder is a git repo (so ignored files stay out),
// otherwise a walk that skips dependency and build folders.
export function listFiles(root: string): string[] {
  const git = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 1 << 28
  });
  if (git.status === 0) return git.stdout.split("\0").filter(Boolean).sort();
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}


export interface RankedDef extends Definition {
  path: string;
  score: number;
}

export interface Ranking {
  // best first
  files: Array<{ path: string; score: number; defs: RankedDef[] }>;
  // best first, across all files
  defs: RankedDef[];
}

// Name matches alone over-count badly in a big project (every file with a
// variable called text "uses" a function called text), so a file counts as
// using a definition only when it uses the name and imports the definition's
// file: directly, through a folder's index or __init__, or by sharing a
// package folder in Go or Java. A method or nested function also needs the
// name of what it sits in (its class), or every dict.get would count for
// every get method. When several imported files define the name, each gets
// an equal share.
//
// A definition's score is the number of files that use it. A file's score is
// the number of other files that use anything it defines.
export function rank(files: readonly ParsedFile[]): Ranking {
  const add = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  const byName = new Map<string, ParsedFile[]>();
  const byFolder = new Map<string, ParsedFile[]>();
  for (const f of files) {
    for (const name of importNames(f.path, f.lang)) add(byName, name, f);
    add(byFolder, posix.dirname(f.path), f);
  }
  const key = (d: Definition): string => `${d.parent ?? ""}.${d.name}`;
  const credit = new Map<ParsedFile, Map<string, number>>();
  const users = new Map<ParsedFile, Map<ParsedFile, number>>();
  for (const g of files) {
    const seen = new Set<ParsedFile>();
    for (const path of g.imports) for (const f of byName.get(path) ?? []) seen.add(f);
    for (const f of [...seen]) {
      if (!FOLDER_FILES.has(basename(f.path, extname(f.path)))) continue;
      for (const path of f.imports) for (const h of byName.get(path) ?? []) seen.add(h);
    }
    if (LANGUAGES[g.lang].folderScope) for (const f of byFolder.get(posix.dirname(g.path)) ?? []) seen.add(f);
    seen.delete(g);
    const definers = new Map<string, ParsedFile[]>();
    for (const f of seen) {
      const used = new Set<string>();
      for (const d of f.defs) {
        if (g.refs.has(d.name) && (!d.parent || g.refs.has(d.parent))) used.add(key(d));
      }
      for (const k of used) add(definers, k, f);
    }
    for (const [k, fs] of definers) {
      const share = 1 / fs.length;
      for (const f of fs) {
        const c = credit.get(f) ?? new Map<string, number>();
        credit.set(f, c.set(k, (c.get(k) ?? 0) + share));
        const u = users.get(f) ?? new Map<ParsedFile, number>();
        users.set(f, u.set(g, Math.max(u.get(g) ?? 0, share)));
      }
    }
  }
  const all: RankedDef[] = [];
  const ranked = files.map((f) => {
    const defs = f.defs.map((d) => {
      const r: RankedDef = { ...d, path: f.path, score: credit.get(f)?.get(key(d)) ?? 0 };
      all.push(r);
      return r;
    });
    let score = 0;
    for (const s of users.get(f)?.values() ?? []) score += s;
    return { path: f.path, score, defs };
  });
  const byScore = <T extends { score: number; path: string }>(a: T, b: T): number =>
    b.score - a.score || a.path.localeCompare(b.path);
  ranked.sort(byScore);
  all.sort((a, b) => byScore(a, b) || a.line - b.line);
  return { files: ranked, defs: all };
}

export interface CodeMap {
  text: string;
  // estimated from its length
  tokens: number;
  budget: number;
  sourceFiles: number;
  definitions: number;
  shownFiles: number;
  shownDefinitions: number;
  // what did not fit, best first
  cut: { files: string[]; definitions: Array<{ path: string; name: string; score: number }> };
  // source files that could not be read or parsed
  unreadable: string[];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const defLine = (d: Definition): string => `  ${" ".repeat(Math.min(d.indent, 8))}${d.signature}\n`;

// Fills the map best first: definitions in score order while they fit (each
// brings its file's name line the first time), then the names of the files
// still missing while those fit. Shown in file rank order, definitions in
// source order. Everything after the first item that does not fit is cut, so
// the cut list is exactly the bottom of the ranking.
export function render(ranking: Ranking, budget: number): Omit<CodeMap, "sourceFiles" | "unreadable"> {
  const limit = budget * CHARS_PER_TOKEN;
  let used = 0;
  const shownFiles = new Set<string>();
  const shownDefs = new Set<RankedDef>();
  const cutDefs: RankedDef[] = [];
  for (const d of ranking.defs) {
    const cost = defLine(d).length + (shownFiles.has(d.path) ? 0 : d.path.length + 1);
    if (cutDefs.length > 0 || used + cost > limit) {
      cutDefs.push(d);
      continue;
    }
    used += cost;
    shownFiles.add(d.path);
    shownDefs.add(d);
  }
  const cutFiles: string[] = [];
  for (const f of ranking.files) {
    if (shownFiles.has(f.path)) continue;
    if (cutFiles.length > 0 || used + f.path.length + 1 > limit) {
      cutFiles.push(f.path);
      continue;
    }
    used += f.path.length + 1;
    shownFiles.add(f.path);
  }
  let text = "";
  for (const f of ranking.files) {
    if (!shownFiles.has(f.path)) continue;
    text += `${f.path}\n`;
    for (const d of f.defs) if (shownDefs.has(d)) text += defLine(d);
  }
  return {
    text,
    tokens: estimateTokens(text),
    budget,
    definitions: ranking.defs.length,
    shownFiles: shownFiles.size,
    shownDefinitions: shownDefs.size,
    cut: {
      files: cutFiles,
      definitions: cutDefs.map((d) => ({ path: d.path, name: d.name, score: Math.round(d.score * 100) / 100 }))
    }
  };
}

export async function buildCodeMap(root: string, budget = DEFAULT_TOKENS): Promise<CodeMap> {
  const parsed: ParsedFile[] = [];
  const unreadable: string[] = [];
  let sourceFiles = 0;
  for (const path of listFiles(root)) {
    if (!languageOf(path)) continue;
    const full = join(root, path);
    try {
      const stat = statSync(full);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      sourceFiles += 1;
      const file = await parseFile(path, readFileSync(full, "utf8"));
      if (file) parsed.push(file);
      else unreadable.push(path);
    } catch {
      unreadable.push(path);
    }
  }
  return { ...render(rank(parsed), budget), sourceFiles, unreadable };
}
