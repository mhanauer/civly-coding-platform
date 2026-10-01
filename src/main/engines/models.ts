import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { PlanConfig } from "./types.ts";
import { resolveBin } from "./index.ts";
import { engineHome } from "../accounts.ts";

// Model discovery: each plan's model list refreshes from the catalog its
// own CLI maintains on this machine, so a new version shows up here
// without a code change. Every
// source is best-effort; on any miss the caller falls back to the plan's
// static defaults.

interface Candidate {
  id: string;
  family: string;
  version: number[];
  // release date when the source provides one (z.ai), epoch ms
  date?: number;
  // position in the source catalog, the last tiebreak
  order: number;
  isDefault: boolean;
}

// "claude-opus-5-5" -> family "opus", version [5,5]. Numeric tokens before
// and after the family word both count as version; anything after the family
// word (preview, customtools, ...) is a variant suffix and ignored, so
// variants collapse into their line.
export function parseModel(id: string): { family: string; version: number[] } {
  const body = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const tokens = body.split("-");
  const rest = tokens.slice(1);
  const version: number[] = [];
  let family = tokens[0];
  let i = 0;
  const numeric = (t: string): number | null => (/^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null);
  while (i < rest.length) {
    const n = numeric(rest[i]);
    if (n === null) break;
    version.push(n);
    i++;
  }
  if (i < rest.length) {
    family = rest[i];
    i++;
  }
  while (i < rest.length) {
    const n = numeric(rest[i]);
    if (n === null) break;
    version.push(n);
    i++;
  }
  return { family, version };
}

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

// Newest distinct model lines: sort by version (or release date) with
// current-default and catalog-position tiebreaks, then keep the first pick
// per family.
// exported for tests
export function pickModels(cands: Candidate[], limit = 2): string[] {
  const sorted = [...cands].sort((a, b) => {
    if (a.date !== undefined || b.date !== undefined) {
      const d = (b.date ?? 0) - (a.date ?? 0);
      if (d !== 0) return d;
    }
    const v = cmpVersion(b.version, a.version);
    if (v !== 0) return v;
    const def = Number(b.isDefault) - Number(a.isDefault);
    if (def !== 0) return def;
    return a.order - b.order;
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of sorted) {
    if (seen.has(c.family)) continue;
    seen.add(c.family);
    out.push(c.id);
    if (out.length === limit) break;
  }
  return out;
}

function makeCandidates(ids: string[], defaults: string[]): Candidate[] {
  return ids.map((id, order) => {
    const { family, version } = parseModel(id);
    return { id, family, version, order, isDefault: defaults.includes(id) };
  });
}

// z.ai lists its models with release dates; the token ships with the plan.
function zaiFetch(baseUrl: string, token: string): Candidate[] {
  const r = spawnSync(
    "curl",
    ["-s", "-m", "3", `${baseUrl.replace(/\/$/, "")}/v1/models`, "-H", `Authorization: Bearer ${token}`],
    { encoding: "utf8", timeout: 5000 }
  );
  if (r.status !== 0 || !r.stdout) return [];
  try {
    const data = JSON.parse(r.stdout).data as Array<{ id: string; created_at?: string }>;
    if (!Array.isArray(data)) return [];
    return data.map((m, order) => {
      const { family, version } = parseModel(m.id);
      return {
        id: m.id,
        family,
        version,
        date: m.created_at ? Date.parse(m.created_at) : undefined,
        order,
        isDefault: false
      };
    });
  } catch {
    return [];
  }
}

// Claude Code caches its account's model catalog in its home and refreshes
// it itself; newest cache file wins.
function claudeCatalog(home: string): string[] {
  const dir = join(home, "cache", "model-catalog");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ p: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { p } of files) {
    try {
      const models = JSON.parse(readFileSync(p, "utf8"))?.catalog?.config?.models;
      if (Array.isArray(models)) {
        const ids = models.map((m: { id?: string }) => m?.id).filter((id: unknown): id is string => typeof id === "string");
        if (ids.length > 0) return ids;
      }
    } catch {
      // try the next cache file
    }
  }
  return [];
}

// Codex refreshes this cache in its home from the account's model list.
function codexCatalog(home: string): string[] {
  const f = join(home, "models_cache.json");
  if (!existsSync(f)) return [];
  const ids: string[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      x.forEach(walk);
    } else if (x && typeof x === "object") {
      const slug = (x as { slug?: unknown }).slug;
      if (typeof slug === "string" && slug.startsWith("gpt-") && !ids.includes(slug)) ids.push(slug);
      Object.values(x as Record<string, unknown>).forEach(walk);
    }
  };
  try {
    walk(JSON.parse(readFileSync(f, "utf8")));
  } catch {
    return [];
  }
  return ids;
}

// Kimi defines its lineup in config.toml; the default model is the frontier,
// the next line is the first catalog entry from a different series.
function kimiCatalog(): { models: string[]; defaultModel: string | null } {
  const f = join(homedir(), ".kimi-code", "config.toml");
  if (!existsSync(f)) return { models: [], defaultModel: null };
  try {
    const text = readFileSync(f, "utf8");
    const models = [...text.matchAll(/\[models\.\"([^\"]+)\"\]/g)].map((m) => m[1]);
    const def = text.match(/^default_model\s*=\s*\"([^\"]+)\"/m)?.[1] ?? null;
    return { models, defaultModel: def };
  } catch {
    return { models: [], defaultModel: null };
  }
}

// Gemini's catalog is embedded in its package bundle; the binary is a
// symlink into the package, so follow it to the bundle directory.
function geminiCatalog(): string[] {
  const bin = resolveBin("gemini");
  let bundle = "";
  try {
    const real = realpathSync(bin);
    bundle = join(real, "..");
  } catch {
    return [];
  }
  if (!existsSync(bundle)) return [];
  const ids: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(bundle).filter((f) => f.endsWith(".js"));
  } catch {
    return [];
  }
  for (const f of files) {
    const p = join(bundle, f);
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/gemini-\d[a-z0-9.-]*/g)) {
      if (!ids.includes(m[0])) ids.push(m[0]);
    }
  }
  return ids;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; models: string[] }>();

export function discoverModels(plan: PlanConfig, defaults: string[]): string[] {
  if (plan.engine === "opencode" || plan.engine === "qwen") return [];
  const key = `${plan.id}|${plan.engine}|${plan.env?.ANTHROPIC_BASE_URL ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.models;

  let found: string[] = [];
  if (plan.engine === "claude" && plan.env?.ANTHROPIC_BASE_URL && plan.env?.ANTHROPIC_AUTH_TOKEN) {
    const cands = zaiFetch(plan.env.ANTHROPIC_BASE_URL, plan.env.ANTHROPIC_AUTH_TOKEN);
    found = pickModels(cands.map((c) => ({ ...c, isDefault: defaults.includes(c.id) })));
  } else if (plan.engine === "claude") {
    found = pickModels(makeCandidates(claudeCatalog(engineHome(plan) ?? ""), defaults));
  } else if (plan.engine === "codex") {
    found = pickModels(makeCandidates(codexCatalog(engineHome(plan) ?? ""), defaults), 3);
  } else if (plan.engine === "gemini") {
    found = pickModels(makeCandidates(geminiCatalog(), defaults));
  } else if (plan.engine === "kimi") {
    const { models, defaultModel } = kimiCatalog();
    if (defaultModel && models.length > 0) {
      const series = parseModel(defaultModel).family;
      const next = models.find((m) => parseModel(m).family !== series);
      found = [defaultModel, ...(next ? [next] : [])];
    }
  }
  cache.set(key, { at: Date.now(), models: found });
  return found;
}
