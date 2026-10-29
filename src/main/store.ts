import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { binaryExists } from "./engines/index.ts";
import { catalogModels, discoverModels, upgradeModels } from "./engines/models.ts";
import type { PlanConfig } from "./engines/types.ts";
import { accountEmail, linkShared, newAccountEnv, ownHome, ownHomeLoggedIn, supportsOwnLogin } from "./accounts.ts";
import { DATA_DIR, IS_DEV_COPY } from "./dataDir.ts";

// Whether a saved login exists on this machine. A saved credential can expire;
// planReady asks Claude and Codex directly before the UI calls
// one of their subscription accounts signed in.
export function engineLoggedIn(plan: PlanConfig): boolean {
  // an added subscription account keeps its login in its own home
  const own = ownHomeLoggedIn(plan);
  if (own !== undefined) return own;
  const home = homedir();
  switch (plan.engine) {
    case "claude": {
      if (existsSync(join(home, ".claude", ".credentials.json"))) return true;
      const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"]);
      return r.status === 0;
    }
    case "codex":
      return existsSync(join(home, ".codex", "auth.json"));
    case "kimi":
      return existsSync(join(home, ".kimi-code", "credentials", "kimi-code.json"));
    case "opencode":
      return (
        existsSync(join(home, ".local", "share", "opencode", "auth.json")) ||
        existsSync(join(home, ".config", "opencode", "auth.json"))
      );
    case "gemini":
      return existsSync(join(home, ".gemini", "oauth_creds.json"));
    // muse login or muse auth set; META_API_KEY in the shell works too
    case "muse":
      return (
        existsSync(join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "muse", "auth.json")) ||
        Boolean(process.env.META_API_KEY)
      );
    default:
      return false;
  }
}

export { DATA_DIR, IS_DEV_COPY };
const DIR = DATA_DIR;
const FILE = join(DIR, "plans.json");
const REMOVED_FILE = join(DIR, "removed.json");

// Ids the user deleted. Deleted default plans would otherwise be re-added
// by the missing-defaults merge on every load.
function removedIds(): string[] {
  try {
    const list = JSON.parse(readFileSync(REMOVED_FILE, "utf8"));
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ChatGPT plans start on Sol; Astra is the frontier alternative.
const CHATGPT_MODELS = ["gpt-6.1-sol", "gpt-6-astra"];

// Frontier and next, exact IDs the CLI accepts (verified against the model
// IDs recorded in ~/.claude).
const CLAUDE_MODELS = ["claude-opus-5-5", "claude-fable-5-1"];

const DEFAULT_PLANS: Array<Omit<PlanConfig, "installed">> = [
  {
    id: "claude-max",
    label: "Claude Max",
    engine: "claude",
    bin: "claude",
    extraArgs: [],
    color: "#d97757",
    models: CLAUDE_MODELS
  },
  {
    id: "chatgpt-codex",
    label: "ChatGPT (Codex)",
    engine: "codex",
    bin: "codex",
    extraArgs: [],
    color: "#10a37f",
    models: CHATGPT_MODELS
  },
  {
    id: "kimi",
    label: "Kimi for Coding",
    engine: "kimi",
    bin: "kimi",
    extraArgs: [],
    color: "#7c6ff0",
    // k3-256k is the configured default; kimi-for-coding is the 1M-context model.
    models: ["kimi-code/k3-256k", "kimi-code/kimi-for-coding"]
  },
  {
    id: "opencode-keys",
    label: "Key plans (opencode)",
    engine: "opencode",
    bin: "opencode",
    extraArgs: [],
    color: "#e5c07b",
    // opencode is multi-provider; its models come from its own config.
    models: ["default"]
  },
  {
    id: "gemini",
    label: "Gemini",
    engine: "gemini",
    bin: "gemini",
    extraArgs: [],
    color: "#4285f4",
    // Newest pro preview and the fast tier from the CLI's own model catalog.
    models: ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]
  },
  {
    id: "muse-code",
    label: "Muse Code",
    engine: "muse",
    bin: "muse",
    extraArgs: [],
    color: "#0866ff",
    // the CLI's default model, then the larger one; its catalog refreshes these
    models: ["muse-wonder-1.0", "muse-wonder-full-1.0"]
  }
];

export function loadPlans(): PlanConfig[] {
  let plans: PlanConfig[];
  if (existsSync(FILE)) {
    const saved = JSON.parse(readFileSync(FILE, "utf8")) as PlanConfig[];
    const removed = removedIds();
    const missing = DEFAULT_PLANS.filter(
      (d) => !saved.some((p) => p.id === d.id) && !removed.includes(d.id)
    );
    plans = [...saved, ...missing.map((p) => ({ ...p, installed: false }))];
    plans = plans.map((p) => {
      // an explicit list (not the "default" placeholder) is the user's
      // choice of models; it only moves to newer versions of the same models
      const custom = p.models && p.models.length > 0 && p.models[0] !== "default" ? p.models : null;
      const def = DEFAULT_PLANS.find((d) => d.id === p.id);
      const fallback = def?.models ?? engineModels(p);
      // A subscription CLI's own catalog (Claude, ChatGPT, Muse) moves each
      // model to its newest version: gpt-6-sol to gpt-6.1-sol, and so on.
      const catalog = catalogModels(p);
      if (catalog.length > 0) return { ...p, models: upgradeModels(custom ?? fallback, catalog) };
      if (custom) return p;
      // Other plans take the newest two model lines their source lists. A
      // missing source uses the defaults.
      const discovered = discoverModels(p, fallback);
      return { ...p, models: discovered.length === 2 ? discovered : fallback };
    });
  } else {
    plans = DEFAULT_PLANS.map((p) => ({ ...p, installed: false }));
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(DEFAULT_PLANS, null, 2), { mode: 0o600 });
  }
  // These values come from this Mac, not from the saved plan config. The UI
  // verifies Claude and Codex login status before showing them as signed in.
  return plans.map((p) => ({
    ...p,
    installed: binaryExists(p.bin),
    loggedIn: engineLoggedIn(p),
    ownLogin: Boolean(ownHome(p)),
    email: accountEmail(p)
  }));
}

// Models for an added account until its CLI has a catalog of its own: a
// Claude or ChatGPT subscription starts on the same pair as the main plan.
function engineModels(p: Omit<PlanConfig, "installed">): string[] {
  if (p.engine === "codex") return CHATGPT_MODELS;
  if (p.engine === "claude" && !p.env?.ANTHROPIC_BASE_URL) return CLAUDE_MODELS;
  return ["default"];
}

// Adds an account created in the app. It is persisted into plans.json next to
// the defaults, so it survives restarts and shows up in every plan list. A
// Claude or ChatGPT subscription gets its own CLI home (ownLogin), so it
// signs in separately and shares everything else with the main account.
export function addPlan(entry: {
  label: string;
  engine: PlanConfig["engine"];
  bin?: string;
  baseUrl?: string;
  token?: string;
  models?: string[];
  ownLogin?: boolean;
}): PlanConfig[] {
  const DEFAULT_BINS: Record<string, string> = {
    claude: "claude",
    codex: "codex",
    kimi: "kimi",
    gemini: "gemini",
    muse: "muse",
    opencode: "opencode",
    qwen: "qwen"
  };
  const ownLogin = Boolean(entry.ownLogin) && supportsOwnLogin(entry.engine);
  const env: Record<string, string> = {};
  if (!ownLogin && entry.baseUrl?.trim()) env["ANTHROPIC_BASE_URL"] = entry.baseUrl.trim();
  if (!ownLogin && entry.token?.trim()) env["ANTHROPIC_AUTH_TOKEN"] = entry.token.trim();
  const saved = existsSync(FILE)
    ? (JSON.parse(readFileSync(FILE, "utf8")) as Array<Omit<PlanConfig, "installed">>)
    : DEFAULT_PLANS;
  const defaultNames: Record<string, string> = {
    claude: ownLogin ? "Claude Code account" : "Claude API account",
    codex: "ChatGPT account",
    kimi: "Kimi account",
    gemini: "Gemini account",
    muse: "Muse Code account",
    opencode: "opencode account",
    qwen: "Qwen account"
  };
  const baseLabel = defaultNames[entry.engine] ?? "New account";
  let label = entry.label.trim();
  if (!label) {
    label = baseLabel;
    for (let number = 2; saved.some((p) => p.label.toLowerCase() === label.toLowerCase()); number++) {
      label = `${baseLabel} ${number}`;
    }
  }
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "account";
  const id = `${slug}-${Date.now().toString(36).slice(-4)}`;
  if (ownLogin) Object.assign(env, newAccountEnv(entry.engine, id));
  const plan: Omit<PlanConfig, "installed"> = {
    id,
    label,
    engine: entry.engine,
    bin: entry.bin?.trim() || DEFAULT_BINS[entry.engine] || entry.engine,
    extraArgs: [],
    // a subscription account wears its family's color
    color: ownLogin ? (entry.engine === "codex" ? "#10a37f" : "#d97757") : "#38bdf8",
    models: entry.models && entry.models.length > 0 ? entry.models : ["default"],
    ...(Object.keys(env).length > 0 ? { env } : {})
  };
  if (ownLogin) linkShared({ ...plan, installed: false });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify([...saved, plan], null, 2), { mode: 0o600 });
  return loadPlans();
}

// Edits an account in place. Blank baseUrl/token clear those settings; a
// blank models list removes the custom list so auto-discovery takes over.
export function updatePlan(
  planId: string,
  patch: {
    label?: string;
    baseUrl?: string;
    token?: string;
    models?: string[];
    color?: string;
  }
): PlanConfig[] {
  if (!existsSync(FILE)) return loadPlans();
  const saved = JSON.parse(readFileSync(FILE, "utf8")) as Array<
    Omit<PlanConfig, "installed">
  >;
  const next = saved.map((p) => {
    if (p.id !== planId) return p;
    const env = { ...(p.env ?? {}) };
    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl.trim()) env["ANTHROPIC_BASE_URL"] = patch.baseUrl.trim();
      else delete env["ANTHROPIC_BASE_URL"];
    }
    if (patch.token !== undefined) {
      if (patch.token.trim()) env["ANTHROPIC_AUTH_TOKEN"] = patch.token.trim();
      else delete env["ANTHROPIC_AUTH_TOKEN"];
    }
    const out: Omit<PlanConfig, "installed"> = {
      ...p,
      label: patch.label?.trim() || p.label
    };
    if (Object.keys(env).length > 0) out.env = env;
    else delete out.env;
    if (patch.models !== undefined) {
      if (patch.models.length > 0) out.models = patch.models;
      else delete out.models;
    }
    if (patch.color) out.color = patch.color;
    return out;
  });
  writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return loadPlans();
}

export function removePlan(planId: string): PlanConfig[] {
  if (existsSync(FILE)) {
    const saved = JSON.parse(readFileSync(FILE, "utf8")) as Array<
      Omit<PlanConfig, "installed">
    >;
    const next = saved.filter((p) => p.id !== planId);
    if (next.length !== saved.length) {
      writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    }
  }
  // record the deletion even when the plan never lived in the file: default
  // plans exist only through the runtime merge, and without this entry the
  // merge would resurrect them on the next load
  const removed = [...new Set([...removedIds(), planId])];
  writeFileSync(REMOVED_FILE, JSON.stringify(removed, null, 2));
  return loadPlans();
}
