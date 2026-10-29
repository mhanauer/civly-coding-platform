import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./dataDir.ts";

// Features that fit one particular setup, each off until turned on in
// Settings. Saved in ~/.coding-plan-hub/settings.json.
export interface Settings {
  // rewrites replies that trip the plain-English scan (filter.ts), through a
  // Z.ai key plan; each chat can still turn it off
  replyFilter: boolean;
  // every project is put on a dev branch, created where missing
  devBranch: boolean;
  // ZCode's recent projects show in the sidebar next to the ones added here
  zcodeProjects: boolean;
  // Claude chats start without connectors, skills and slash commands, and
  // take them on when a message needs them (leanChats.ts)
  leanChats: boolean;
  // the engine CLIs update to their latest release on their own (cliUpdates.ts)
  updateClis: boolean;
}

const FILE = join(DATA_DIR, "settings.json");
const DEFAULTS: Settings = { replyFilter: false, devBranch: false, zcodeProjects: false, leanChats: false, updateClis: false };
const KEYS = Object.keys(DEFAULTS) as Array<keyof Settings>;

export function loadSettings(): Settings {
  const out = { ...DEFAULTS };
  try {
    const saved = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Record<keyof Settings, unknown>>;
    for (const key of KEYS) if (typeof saved[key] === "boolean") out[key] = saved[key];
  } catch {
    // no settings file yet: everything stays off
  }
  return out;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = loadSettings();
  for (const key of KEYS) if (typeof patch?.[key] === "boolean") next[key] = patch[key];
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}
