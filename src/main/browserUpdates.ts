import { spawnSync } from "node:child_process";
import { BROWSER_ENDPOINT, BROWSER_PROFILE, restartBrowser } from "./chromeBrowser.ts";

// Chrome downloads its security fixes by itself but runs them only after a
// restart, and the chats' browser never restarts on its own: in November 2026
// it ran a Chrome with a fixed critical flaw for 17 days. Every fifteen
// minutes the app compares the version the browser is running with the Chrome
// on disk. When they differ and no chat that browses is working, it closes
// the browser and opens it again. Sign-ins live in the profile and survive.
// Open tabs do not, so it waits for them to close, for up to a day.

const CHECK_EVERY = 15 * 60 * 1000;
const FIRST_CHECK = 60 * 1000;
export const TABS_WAIT = 24 * 60 * 60 * 1000;

export interface BrowserProcess {
  pid: number;
  app: string;
}

// The chats' browser in `ps -axo pid=,command=`: the main process on its own
// profile (helpers carry --type=)
export function findBrowserProcess(ps: string, profile: string): BrowserProcess | undefined {
  const flag = `--user-data-dir=${profile}`;
  for (const line of ps.split("\n")) {
    if (line.includes("--type=") || !(line.includes(`${flag} `) || line.endsWith(flag))) continue;
    const m = /^\s*(\d+)\s+(\/.*?\.app)\/Contents\/MacOS\//.exec(line);
    if (m) return { pid: Number(m[1]), app: m[2] };
  }
  return undefined;
}

// "Chrome/156.0.8078.80" from DevTools' /json/version
export function versionOf(browser: string | undefined): string | undefined {
  return /\/(\d+(?:\.\d+){3})$/.exec(browser ?? "")?.[1];
}

export interface UpdateState {
  running?: string;
  installed?: string;
  busy: boolean;
  tabs: number;
  waitingSince: number;
  now: number;
}

export function shouldRestart(s: UpdateState): boolean {
  if (!s.running || !s.installed || s.running === s.installed || s.busy) return false;
  return s.tabs === 0 || s.now - s.waitingSince >= TABS_WAIT;
}

function installedVersion(app: string): string | undefined {
  const plist = `${app}/Contents/Info.plist`;
  const out = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], {
    encoding: "utf8"
  });
  return out.status === 0 ? out.stdout.trim() : undefined;
}

async function devtools<T>(path: string): Promise<T> {
  const res = await fetch(`${BROWSER_ENDPOINT}${path}`, { signal: AbortSignal.timeout(2000) });
  return (await res.json()) as T;
}

export function watchBrowserUpdates(opts: { busy: () => boolean }): void {
  let waitingSince: number | undefined;
  const check = async (): Promise<void> => {
    try {
      const running = versionOf((await devtools<{ Browser?: string }>("/json/version")).Browser);
      const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
      const proc = findBrowserProcess(ps, BROWSER_PROFILE);
      const installed = proc && installedVersion(proc.app);
      if (!proc || !running || !installed || running === installed) {
        waitingSince = undefined;
        return;
      }
      waitingSince ??= Date.now();
      const tabs = (await devtools<{ type: string }[]>("/json/list")).filter((t) => t.type === "page").length;
      const state = { running, installed, busy: opts.busy(), tabs, waitingSince, now: Date.now() };
      if (shouldRestart(state) && (await restartBrowser(proc.pid))) waitingSince = undefined;
    } catch {
      // the browser is not running, so there is nothing to update
    }
  };
  setTimeout(() => void check(), FIRST_CHECK);
  setInterval(() => void check(), CHECK_EVERY);
}
