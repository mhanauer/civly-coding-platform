import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, IS_DEV_COPY } from "./dataDir.ts";
import { resolveBin } from "./engines/index.ts";
import type { EngineKind, McpServer } from "./engines/types.ts";

// Chats browse in a Chrome of their own: a second Chrome with its own
// profile, signed in once to the accounts browser work should use. Claude
// and ChatGPT chats drive it through Chrome DevTools MCP, so every chat gets
// the same browser and logins whichever subscription it runs on. (Claude in
// Chrome only reaches a Chrome whose extension is signed in to the chat's own
// claude.ai account, so a chat on an added account browsed as someone else.)

export const BROWSER_PROFILE = join(DATA_DIR, "browser");
// the dev copy has its own browser, so testing never touches the real one
const PORT = IS_DEV_COPY ? 9338 : 9337;
export const BROWSER_ENDPOINT = `http://127.0.0.1:${PORT}`;
// Not ~/Downloads: that folder syncs to Google Drive, so every file a chat
// downloaded turned up as a stray Drive copy.
export const BROWSER_DOWNLOADS = join(DATA_DIR, "downloads");
// pinned so a new release never changes chats mid-week; bump by hand
export const MCP_PACKAGE = "chrome-devtools-mcp@1.10.1";

// Engines that take an MCP server on the command line
export function usesBrowser(engine: EngineKind): boolean {
  return engine === "claude" || engine === "codex" || engine === "muse";
}

// Connects to the running browser on first use; never launches one itself.
// Pages are addressed by id, so chats running at once keep to their own tabs.
export function browserServer(): McpServer {
  return {
    command: resolveBin("npx"),
    args: ["-y", MCP_PACKAGE, "--browserUrl", BROWSER_ENDPOINT, "--no-usage-statistics", "--no-performance-crux"]
  };
}

// Fetches the MCP package ahead of the first chat, so that chat does not
// wait on the download.
export function warmBrowserServer(): void {
  const server = browserServer();
  spawn(server.command, [...server.args.slice(0, 2), "--version"], { stdio: "ignore" }).on("error", () => undefined);
}

async function running(): Promise<boolean> {
  try {
    const res = await fetch(`${BROWSER_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Downloads save without asking into BROWSER_DOWNLOADS, and a PDF saves
// there instead of opening in Chrome's viewer, where a chat cannot read it.
// Chrome reads its preferences at startup and rewrites them on quit, so this
// runs only while the browser is closed; a running one picks it up next time.
function setDownloadPrefs(): void {
  const file = join(BROWSER_PROFILE, "Default", "Preferences");
  let prefs: Record<string, Record<string, unknown>> = {};
  try {
    prefs = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    // a file we cannot read is left for Chrome; only a missing one is created
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  const profile = prefs.profile ?? {};
  prefs.download = { ...prefs.download, default_directory: BROWSER_DOWNLOADS, prompt_for_download: false, directory_upgrade: true };
  prefs.plugins = { ...prefs.plugins, always_open_pdf_externally: true };
  // a site saving several files at once would otherwise stop at a prompt
  prefs.profile = {
    ...profile,
    default_content_setting_values: {
      ...(profile.default_content_setting_values as object | undefined),
      automatic_downloads: 1
    }
  };
  mkdirSync(BROWSER_DOWNLOADS, { recursive: true });
  mkdirSync(join(BROWSER_PROFILE, "Default"), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(prefs));
  renameSync(`${file}.tmp`, file);
}

// open -n starts a second Chrome next to yours; when this profile is already
// open, Chrome hands the URL to that window instead. -g keeps it from taking
// focus, and with no URL it runs without a window until a chat opens a page.
// Chats open several sites at once, so tabs out of sight keep running
// instead of being slowed down in the background.
async function launch(url?: string): Promise<boolean> {
  if (!(await running())) {
    try {
      setDownloadPrefs();
    } catch {
      // the browser still opens; downloads go to Chrome's default folder
    }
  }
  const args = [
    "-n",
    ...(url ? [] : ["-g"]),
    "-b",
    "com.google.Chrome",
    "--args",
    `--user-data-dir=${BROWSER_PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    ...(url ? [url] : ["--no-startup-window"])
  ];
  return new Promise((resolve) => {
    const proc = spawn("/usr/bin/open", args, { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
}

let starting: Promise<boolean> | undefined;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startedWithin(tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    await pause(250);
    if (await running()) return true;
  }
  return false;
}

// Starts the browser if it is not running. Called at every turn, so a
// browser you quit comes back with the next message.
export function ensureBrowser(): Promise<boolean> {
  starting ??= (async () => {
    if (await running()) return true;
    if (!(await launch())) return false;
    return startedWithin(40);
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Asks Chrome to quit over DevTools, which saves the profile the normal way,
// and waits for the process to exit so the new one can take the profile. A
// Chrome that does not quit in 20 seconds is sent SIGTERM.
async function closeBrowser(pid: number): Promise<boolean> {
  try {
    const res = await fetch(`${BROWSER_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(2000) });
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    ws.onerror = () => undefined;
  } catch {
    // SIGTERM below
  }
  for (let i = 0; i < 80 && alive(pid); i++) await pause(250);
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    for (let i = 0; i < 40 && alive(pid); i++) await pause(250);
  }
  return !alive(pid);
}

// Closes the browser and opens it again on the Chrome now on disk. Skipped
// while the browser is starting. A chat that starts meanwhile never launches
// a second Chrome to fight over the profile, but a browser step it takes in
// the second or so before the new browser answers fails once.
export function restartBrowser(pid: number): Promise<boolean> {
  if (starting) return Promise.resolve(false);
  starting = (async () => {
    if (!(await closeBrowser(pid))) return false;
    if (!(await launch())) return false;
    return startedWithin(40);
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

// A window on the browser, to sign in to the accounts chats should use
export async function openBrowser(url = "https://accounts.google.com/"): Promise<{ error?: string }> {
  return (await launch(url)) ? {} : { error: "Google Chrome did not open. Is it installed?" };
}

// The binary of the Chrome you use yourself: the one on the default profile,
// started without --user-data-dir (helpers carry --type=).
function yourChrome(): string | undefined {
  const ps = spawnSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^(.*\.app\/Contents\/MacOS\/Google Chrome)(?: |$)/.exec(line);
    if (m && !line.includes("--type=") && !line.includes("--user-data-dir=")) return m[1];
  }
  return undefined;
}

// A link from the app opens in your own Chrome, never the chats' browser.
// macOS sees both as Google Chrome, so open -b can hand a link to either;
// your Chrome's own binary passes it to your Chrome's window and exits. With
// your Chrome closed, open -n starts it.
export function openInYourChrome(url: string, fallback: () => void): void {
  const exe = yourChrome();
  const proc = exe
    ? spawn(exe, [url], { stdio: "ignore", detached: true })
    : spawn("/usr/bin/open", ["-n", "-b", "com.google.Chrome", "--args", url], { stdio: "ignore" });
  proc.on("error", fallback);
  if (!exe) {
    proc.on("exit", (code) => {
      if (code !== 0) fallback();
    });
  }
  proc.unref();
}
