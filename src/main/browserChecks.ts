import { spawn } from "node:child_process";

// Tells you when a chat's tab is stuck on something only you can do: a
// CAPTCHA, a bot check that did not clear by itself, or a sign-in page. The
// chat carries on once the page moves past it. Watched through the DevTools
// port the chats use, and only while a chat that browses is running.

export type CheckKind = "captcha" | "bot-check" | "sign-in";

export interface BrowserCheck {
  targetId: string;
  kind: CheckKind;
  title: string;
  url: string;
}

// Runs in each page. A widget already answered does not count, and neither
// does an invisible CAPTCHA until it shows a picture challenge. A password
// field counts only when every text box on the page belongs to its form, so
// a search page with a small login box in the corner stays quiet. Kept as a
// string: the bundler must not rewrite code that runs in someone's page.
const DETECT = `(() => {
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 20 && r.height > 20 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1;
  };
  const answered = (name) => [...document.querySelectorAll('[name="' + name + '"]')].some((el) => el.value);
  const frames = [...document.querySelectorAll("iframe")].filter(shown).map((f) => f.src || "");
  const has = (sel) => [...document.querySelectorAll(sel)].some(shown);
  if (frames.some((s) => /\\/recaptcha\\/(api2|enterprise)\\/(anchor|bframe)/.test(s) && !/size=invisible/.test(s)) && !answered("g-recaptcha-response"))
    return "captcha";
  if (frames.some((s) => /hcaptcha\\.com/.test(s) && /frame=(checkbox|challenge)/.test(s)) && !answered("h-captcha-response"))
    return "captcha";
  if (has("#px-captcha") || frames.some((s) => /captcha-delivery\\.com|arkoselabs\\.com|funcaptcha\\.com/.test(s)))
    return "captcha";
  if ((has(".cf-turnstile") || document.querySelector('[name="cf-turnstile-response"]')) && !answered("cf-turnstile-response"))
    return "bot-check";
  if (/^just a moment/i.test(document.title) || document.querySelector("#challenge-form, #cf-challenge-running"))
    return "bot-check";
  const pw = [...document.querySelectorAll('input[type="password"]')].find(shown);
  if (pw) {
    const boxes = [...document.querySelectorAll('input:not([type]), input[type="text"], input[type="email"], input[type="search"], input[type="tel"], input[type="number"]')].filter(shown);
    if (boxes.every((el) => el.form && el.form === pw.form)) return "sign-in";
  }
  return "";
})()`;

const TICK_MS = 3000;
// A check has to stay this long before you hear about it: Cloudflare and
// most CAPTCHAs clear by themselves in a few seconds, and a chat signing in
// with a saved password moves on quickly.
const SETTLE_MS = 8000;

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

// One DevTools connection to the whole browser; pages are reached through
// sessions on it, next to the chats' own connection.
class Cdp {
  closed = false;
  private ws: WebSocket;
  private next = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const w = msg.id ? this.waiting.get(msg.id) : undefined;
      if (!w || !msg.id) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const w of this.waiting.values()) w.reject(new Error("closed"));
      this.waiting.clear();
    };
  }

  static async open(endpoint: string): Promise<Cdp | undefined> {
    try {
      const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
      const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
      const ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("no connection"));
      });
      return new Cdp(ws);
    } catch {
      return undefined;
    }
  }

  // a page busy loading can hold an evaluate; the next tick asks again
  send<T>(method: string, params: object = {}, sessionId?: string, timeoutMs = 3000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("closed"));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }
}

export function watchBrowserChecks(opts: {
  endpoint: string;
  // true while a chat that browses is running; nothing is watched otherwise
  active: () => boolean;
  // every check waiting on you, whenever that list changes
  onChange: (checks: BrowserCheck[]) => void;
  // checks you have not been told about yet
  onNew: (checks: BrowserCheck[]) => void;
}): void {
  let cdp: Cdp | undefined;
  const sessions = new Map<string, string>();
  const seen = new Map<string, { kind: CheckKind; since: number }>();
  let shown: BrowserCheck[] = [];

  const publish = (checks: BrowserCheck[]): void => {
    const before = new Set(shown.map((c) => `${c.targetId}:${c.kind}`));
    const fresh = checks.filter((c) => !before.has(`${c.targetId}:${c.kind}`));
    const changed = JSON.stringify(checks) !== JSON.stringify(shown);
    shown = checks;
    if (changed) opts.onChange(checks);
    if (fresh.length) opts.onNew(fresh);
  };

  const detect = async (conn: Cdp, targetId: string): Promise<CheckKind | ""> => {
    try {
      let sessionId = sessions.get(targetId);
      if (!sessionId) {
        sessionId = (await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
        sessions.set(targetId, sessionId);
      }
      const r = await conn.send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: DETECT, returnByValue: true, silent: true },
        sessionId
      );
      const v = r.result?.value;
      return v === "captcha" || v === "bot-check" || v === "sign-in" ? v : "";
    } catch {
      const sessionId = sessions.get(targetId);
      sessions.delete(targetId);
      if (sessionId) conn.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      return "";
    }
  };

  const tick = async (): Promise<void> => {
    if (!opts.active()) {
      if (cdp) cdp.close();
      cdp = undefined;
      sessions.clear();
      seen.clear();
      publish([]);
      return;
    }
    if (!cdp || cdp.closed) {
      sessions.clear();
      cdp = await Cdp.open(opts.endpoint);
      if (!cdp) {
        seen.clear();
        publish([]);
        return;
      }
    }
    const conn = cdp;
    let pages: TargetInfo[];
    try {
      pages = (await conn.send<{ targetInfos: TargetInfo[] }>("Target.getTargets")).targetInfos.filter(
        (t) => t.type === "page" && /^https?:/.test(t.url)
      );
    } catch {
      return;
    }
    const live = new Set(pages.map((p) => p.targetId));
    for (const id of [...sessions.keys()]) if (!live.has(id)) sessions.delete(id);
    for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
    const now = Date.now();
    const checks: BrowserCheck[] = [];
    for (const page of pages) {
      const kind = await detect(conn, page.targetId);
      if (!kind) {
        seen.delete(page.targetId);
        continue;
      }
      const prior = seen.get(page.targetId);
      const since = prior?.kind === kind ? prior.since : now;
      seen.set(page.targetId, { kind, since });
      if (now - since >= SETTLE_MS) checks.push({ targetId: page.targetId, kind, title: page.title, url: page.url });
    }
    publish(checks);
  };

  const loop = (): void => {
    void tick()
      .catch(() => undefined)
      .finally(() => setTimeout(loop, TICK_MS));
  };
  loop();
}

// Brings a check's tab up in front of you: selects the tab, then raises the
// chats' Chrome over your own. macOS sees both as Google Chrome, so the app
// is picked by process id; NSRunningApplication needs no Automation grant.
export async function showCheck(endpoint: string, targetId: string): Promise<{ error?: string }> {
  const cdp = await Cdp.open(endpoint);
  if (!cdp) return { error: "The chats' browser is not running." };
  try {
    await cdp.send("Target.activateTarget", { targetId });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.bringToFront", {}, sessionId);
    const { processInfo } = await cdp.send<{ processInfo: Array<{ type: string; id: number }> }>(
      "SystemInfo.getProcessInfo"
    );
    const pid = processInfo.find((p) => p.type === "browser")?.id;
    if (pid) {
      const script = `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions($.NSApplicationActivateAllWindows)`;
      spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { stdio: "ignore" }).on("error", () => undefined);
    }
    return {};
  } catch {
    return { error: "That tab has closed." };
  } finally {
    cdp.close();
  }
}
