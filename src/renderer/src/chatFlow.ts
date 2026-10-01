import type { EngineEvent, ToolStep } from "../../main/engines/types.ts";
import { classifyLegacy } from "../../main/engines/steps.ts";

// Collapses a run of streaming deltas into one message. A completed text
// event that starts with the streamed content is the same message finalized,
// so it replaces the run; anything else closes it first. Live reasoning
// (thinking_delta) collapses the same way into one live "thinking" item,
// which the finished "thinking" event then replaces.
export function mergeDeltas(events: EngineEvent[]): EngineEvent[] {
  const out: EngineEvent[] = [];
  let run: string | null = null;
  let thought: { text: string; startedAt?: number } | null = null;
  const closeRun = (streaming: boolean): void => {
    if (run !== null) {
      out.push({ kind: "text", text: run, streaming });
      run = null;
    }
  };
  const closeThought = (): void => {
    if (thought !== null) {
      out.push({ kind: "thinking", text: thought.text, live: true, startedAt: thought.startedAt });
      thought = null;
    }
  };
  for (const ev of events) {
    if (ev.kind === "thinking_delta") {
      closeRun(false);
      // a delta with a start time opens a new stretch of reasoning
      if (thought === null || ev.startedAt !== undefined) {
        closeThought();
        thought = { text: ev.text, startedAt: ev.startedAt };
      } else {
        thought.text += ev.text;
      }
      continue;
    }
    if (ev.kind === "thinking" && thought !== null) {
      out.push({ ...ev, startedAt: thought.startedAt });
      thought = null;
      continue;
    }
    closeThought();
    if (ev.kind === "delta") {
      run = run === null ? ev.text : run + ev.text;
      continue;
    }
    if (ev.kind === "text" && run !== null && ev.text.startsWith(run)) {
      // the finalized version of a message we already streamed: it must not
      // type in again, so it carries fromStream
      out.push({ ...ev, fromStream: true });
      run = null;
      continue;
    }
    closeRun(false);
    out.push(ev);
  }
  closeRun(true);
  closeThought();
  return out;
}

// True while a turn is running and nothing has come back since the last
// user message (status lines do not count, output does).
export function isThinking(events: EngineEvent[]): boolean {
  const lastUser = events.map((e) => e.kind).lastIndexOf("user");
  if (lastUser === -1) return false;
  return !events
    .slice(lastUser + 1)
    .some(
      (e) =>
        e.kind === "text" ||
        e.kind === "delta" ||
        e.kind === "tool" ||
        e.kind === "tool_result" ||
        e.kind === "thinking" ||
        e.kind === "thinking_delta" ||
        e.kind === "error"
    );
}

export interface StepView {
  step: ToolStep;
  // true when the engine reports results for this step (it has an id)
  expectsResult: boolean;
  result?: { ok: boolean; output?: string };
}

export type FlowItem =
  | { type: "event"; ev: EngineEvent; index: number }
  | {
      type: "permission";
      ev: Extract<EngineEvent, { kind: "permission" }>;
      decision?: {
        allowed: boolean;
        always?: boolean;
        answers?: Record<string, string>;
        response?: string;
        withdrawn?: boolean;
      };
      index: number;
    }
  | { type: "thought"; ev: Extract<EngineEvent, { kind: "thinking" }>; index: number }
  | { type: "explore"; steps: StepView[]; index: number }
  | { type: "step"; view: StepView; index: number };

// Groups merged events into what the chat shows, ZCode-style: consecutive
// reads and searches fold into one Explore row, each tool result attaches
// to its step instead of printing on its own, and plan updates feed the
// progress pill rather than the flow.
export function buildFlow(merged: EngineEvent[]): { items: FlowItem[]; todos: TodoState | null } {
  const items: FlowItem[] = [];
  const byId = new Map<string, StepView>();
  const open: StepView[] = [];
  let todos: TodoState | null = null;
  let turn = 0;

  const asks = new Map<string, Extract<FlowItem, { type: "permission" }>>();
  merged.forEach((ev, index) => {
    if (ev.kind === "user") turn += 1;
    if (ev.kind === "done" || ev.kind === "session" || ev.kind === "usage") return;
    if (ev.kind === "permission") {
      const item = { type: "permission" as const, ev, index };
      asks.set(ev.requestId, item);
      items.push(item);
      return;
    }
    if (ev.kind === "permission_decision") {
      const item = asks.get(ev.requestId);
      if (item) {
        item.decision = {
          allowed: ev.allowed,
          always: ev.always,
          answers: ev.answers,
          response: ev.response,
          withdrawn: ev.withdrawn
        };
      }
      return;
    }
    if (ev.kind === "tool_result") {
      const view = (ev.id && byId.get(ev.id)) || open.find((v) => !v.result);
      if (view) view.result = { ok: ev.ok, output: ev.output };
      return;
    }
    if (ev.kind === "tool") {
      // chats saved before tool results existed logged them as a "result" tool
      if (ev.name === "result" && !ev.step) return;
      const step = ev.step ?? classifyLegacy(ev.name, ev.detail);
      if (step.type === "todo") {
        todos = { todos: step.todos ?? [], turn };
        return;
      }
      const view: StepView = { step, expectsResult: Boolean(ev.id) };
      if (ev.id) byId.set(ev.id, view);
      open.push(view);
      const last = items[items.length - 1];
      if (step.type === "explore") {
        if (last?.type === "explore") last.steps.push(view);
        else items.push({ type: "explore", steps: [view], index });
      } else {
        items.push({ type: "step", view, index });
      }
      return;
    }
    if (ev.kind === "thinking") {
      items.push({ type: "thought", ev, index });
      return;
    }
    items.push({ type: "event", ev, index });
  });

  return { items, todos: todos && (todos as TodoState).turn === turn ? todos : null };
}

export interface TodoState {
  todos: Array<{ text: string; status: string }>;
  // the user turn the plan was last updated in; a plan from an earlier
  // turn is stale and not shown
  turn: number;
}

// "a few seconds", "12 seconds", "2m 5s": how ZCode labels a thought.
export function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  const s = Math.round(ms / 1000);
  if (s < 5) return "a few seconds";
  if (s < 60) return `${s} seconds`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
