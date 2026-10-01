import type { EngineEvent, EngineKind } from "./engines/types.ts";

// Lean Claude chats (a setting): a chat starts without the user's
// connectors, skills and slash commands, whose lists Claude Code otherwise
// sends again with every step. In the code-map test (scripts/code-map) that
// cut Claude's plan use by about 30% with the same answers. Pure (no
// electron imports) so it can be tested on its own.

// auto: lean until a message needs more, then full for the rest of the chat.
// Switching back would make Claude re-read the whole chat at full price.
export type Tools = "auto" | "lean" | "full";
export const TOOLS: readonly Tools[] = ["auto", "lean", "full"];

export function runsLean(o: { enabled: boolean; engine: EngineKind; tools: Tools; autoFull: boolean }): boolean {
  if (!o.enabled || o.engine !== "claude") return false;
  return o.tools === "lean" || (o.tools === "auto" && !o.autoFull);
}

// "claude.ai Gmail" is Gmail to the user
export function connectorName(server: string): string {
  return server.replace(/^claude\.ai\s+/i, "").trim();
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What a message plainly needs before it is sent, if anything: a slash
// command or skill, or a connector named outright. Anything subtler is
// Claude's call (leanNote).
export function fullToolsReason(message: string, connectors: readonly string[]): string | undefined {
  const slash = /^\s*\/([a-z][\w:-]*)/i.exec(message);
  if (slash) return `/${slash[1]}`;
  const text = message.toLowerCase();
  for (const server of connectors) {
    const name = connectorName(server);
    // a word of its own: part of a file name or path is code, not a request
    if (name.length >= 4 && new RegExp(`(^|[^\\w/.-])${escape(name.toLowerCase())}(?![\\w/-]|\\.\\w)`).test(text)) return name;
  }
  return undefined;
}

// The line Claude answers with when a message needs what a lean chat leaves
// out: [[full tools: Gmail]]
const MARKER = /^\s*\[\[full tools:?\s*([^\]]*)\]\]\s*$/i;
const HEAD = "[[full tools";

export function leanNote(connectors: readonly string[]): string {
  const names = connectors.map(connectorName).filter(Boolean);
  const which = names.length > 0 ? ` (${names.join(", ")})` : "";
  return (
    `[Note from the app: to save plan usage, this chat runs without my connectors${which}, skills and slash commands. ` +
    "If my message needs any of them, reply with only this line, naming what you need: [[full tools: what you need]]. " +
    "The app then turns them all on and asks you to carry on.]"
  );
}

export const CARRY_ON = "[Note from the app: my connectors, skills and slash commands are on now. Carry on with my last message.]";

export function switchedNote(what: string): string {
  return `This chat now has your connectors, skills and slash commands: ${what}. It keeps them for the rest of the chat.`;
}

// Holds back a reply that is only the request for full tools, so the chat
// shows a line about the switch instead; any other reply passes through as
// it streams. asked() is what Claude asked for, once it has.
export function markerFilter(): { feed(e: EngineEvent): EngineEvent[]; asked(): string | undefined } {
  let held: EngineEvent[] = [];
  let streamed = "";
  // passing: this message is not the request, so its pieces go straight on
  let passing = false;
  let asked: string | undefined;
  const candidate = (text: string): boolean => {
    const s = text.trimStart().toLowerCase();
    if (s.length > 300) return false;
    if (s.length <= HEAD.length) return HEAD.startsWith(s);
    if (!s.startsWith(HEAD)) return false;
    const close = s.indexOf("]]");
    return close === -1 || s.slice(close + 2).trim() === "";
  };
  const release = (e: EngineEvent): EngineEvent[] => {
    const out = [...held, e];
    held = [];
    streamed = "";
    passing = false;
    return out;
  };
  return {
    feed(e) {
      if (e.kind === "delta") {
        if (passing) return [e];
        streamed += e.text;
        if (candidate(streamed)) {
          held.push(e);
          return [];
        }
        const out = [...held, e];
        held = [];
        passing = true;
        return out;
      }
      if (e.kind === "text") {
        const m = MARKER.exec(e.text);
        if (!m) return release(e);
        held = [];
        streamed = "";
        passing = false;
        asked = m[1].trim() || "your connectors";
        return [{ kind: "status", text: switchedNote(`Claude asked for ${asked}`) }];
      }
      return release(e);
    },
    asked: () => asked
  };
}
