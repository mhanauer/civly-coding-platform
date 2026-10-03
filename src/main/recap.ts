import type { EngineEvent } from "./engines/types.ts";

// Chats retold as plain text for a model that was not there: an engine that
// joins a chat midway, and a side conversation that needs the chat it sits
// beside. Pure (no electron imports) so it can be tested on its own.

// Tool calls and errors are retold in one line each; the command or file is
// enough to follow along, and full output would crowd out the conversation.
const STEP_LINE = 200;
// Only the latest turn's last few steps are retold: what the chat is doing
// now. A long chat runs thousands of commands; earlier ones would push its
// conversation out of the recap.
const RECENT_STEPS = 20;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// One entry per thing worth retelling: your messages and the replies, plus
// the latest turn's recent tool calls and errors with steps. A reply still
// streaming (or cut off mid-stream) exists only as deltas, so those count as
// its text.
export function recapLines(events: readonly EngineEvent[]): string[] {
  const lastUser = events.map((e) => e.kind).lastIndexOf("user");
  const stepAt = events.flatMap((e, i) => (i > lastUser && (e.kind === "tool" || e.kind === "error") ? [i] : []));
  const shown = new Set(stepAt.slice(-RECENT_STEPS));
  const lines: string[] = [];
  let partial = "";
  const flush = (label: string): void => {
    if (partial.trim()) lines.push(`${label}: ${partial.trim()}`);
    partial = "";
  };
  for (const [i, e] of events.entries()) {
    if (e.kind === "delta") {
      partial += e.text;
      continue;
    }
    // the finished text repeats what its deltas streamed
    if (e.kind === "text") partial = "";
    else if (e.kind !== "thinking") flush("Assistant");
    if (e.kind === "user") lines.push(e.replaced ? `Me (later replaced): ${e.text}` : `Me: ${e.text}`);
    else if (e.kind === "text") lines.push(`Assistant: ${e.text}`);
    else if (shown.has(i) && e.kind === "tool") {
      const what = e.step ? [e.step.label, e.step.target].filter(Boolean).join(": ") : e.name;
      lines.push(`(tool) ${oneLine(what, STEP_LINE)}`);
    } else if (shown.has(i) && e.kind === "error") lines.push(`(error) ${oneLine(e.text, STEP_LINE)}`);
  }
  flush("Assistant (still writing)");
  return lines;
}

// The newest lines that fit in limit characters, oldest first. cut: older
// lines were left out. A newest line too long to fit on its own keeps its
// start, so a huge last message never leaves the recap empty.
export function newestWithin(lines: readonly string[], limit: number): { text: string; cut: boolean } {
  let out = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = `${lines[i]}\n\n${out}`;
    if (next.length > limit) {
      if (!out) out = `${lines[i].slice(0, limit - 1)}…`;
      return { text: out.trim(), cut: true };
    }
    out = next;
  }
  return { text: out.trim(), cut: false };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// What a chat's next message carries when it moves to an engine that cannot
// resume its conversation. The latest turn's recent steps go along: a turn
// cut off by a usage limit is half done, and the new engine must not redo or
// undo that work. A long chat keeps its newest part plus its first message,
// which usually holds the request the rest of the chat works on.
export const HANDOFF_LIMIT = 24000;
// a first message longer than this keeps its start
const FIRST_LIMIT = 6000;
const LEFT_OUT = "(older messages left out)";

export function handoffContext(transcript: readonly EngineEvent[], file: string): string {
  const lines = recapLines(transcript);
  const newest = newestWithin(lines, HANDOFF_LIMIT);
  if (!newest.text) return "";
  let text = newest.text;
  const firstAt = lines.findIndex((line) => line.startsWith("Me: "));
  if (newest.cut && firstAt >= 0) {
    const first = clip(lines[firstAt], FIRST_LIMIT);
    const rest = newestWithin(lines.slice(firstAt + 1), HANDOFF_LIMIT - first.length - LEFT_OUT.length);
    text = [first, rest.cut ? LEFT_OUT : "", rest.text].filter(Boolean).join("\n\n");
  }
  const record = newest.cut
    ? `Only my first message and the most recent part are below; the rest is in its full record at ${file}.`
    : `Its full record, including tool output, is at ${file}.`;
  return `We are continuing a conversation that started with another assistant. Here it is so far, with the latest turn's last steps. ${record}\n\n${text}`;
}

// The chat a side conversation sits beside, as the side conversation's
// engine is told about it.
export interface SideParent {
  title: string;
  planLabel: string;
  cwd: string;
  running: boolean;
  transcript: readonly EngineEvent[];
  // the chat's saved file: everything, including tool output
  file: string;
}

export const SIDE_CONTEXT_LIMIT = 40000;

// What a side conversation's next message carries about its chat. seen is
// how much of that chat its engine already has (undefined: none of it, so
// the whole chat goes, newest part first when long); otherwise only what
// happened there since. Empty when there is nothing to tell.
export function sideContext(parent: SideParent, seen: number | undefined): string {
  const fresh = seen === undefined || seen > parent.transcript.length;
  const lines = recapLines(parent.transcript.slice(fresh ? 0 : seen));
  const { text, cut } = newestWithin(lines, SIDE_CONTEXT_LIMIT);
  if (!text) return "";
  const name = parent.title ? ` "${oneLine(parent.title, 80)}"` : "";
  const state = parent.running ? "That chat is still working." : "That chat is not running right now.";
  const older = cut ? ` Only the most recent part is below; the rest is in its full record at ${parent.file}.` : "";
  const note = fresh
    ? `[Note from the app: this is a side conversation, opened beside my chat${name} (${parent.planLabel}, in ${parent.cwd}). That chat so far is below, so you can answer my questions about it. ${state}${older || ` Its full record, including tool output, is at ${parent.file}.`}]`
    : `[Note from the app: my chat${name}, which this side conversation sits beside, went on since my last message here. ${state}${older}]`;
  return `${note}\n\n${text}`;
}
