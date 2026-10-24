import type { BackgroundTask } from "./engines/types.ts";
import { CHECK_IN_MINUTES } from "./engines/claude.ts";

// A reply can end while background work it started still runs: Claude Code
// keeps the chat open and picks it back up when that work exits. A wait
// that can never exit (a loop whose check never matches) would hold the
// chat open with nobody told, so while the chat waits the app shows what on,
// and every CHECK_IN_MINUTES asks it to check directly, for up to an hour.
const MAX_CHECK_INS = 6;

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

function named(tasks: BackgroundTask[]): string {
  return tasks.map((t) => t.description || (t.type === "local_bash" ? "a command" : "a background task")).join("; ");
}

export function checkInNote(tasks: BackgroundTask[], now: number): string {
  const list = tasks
    .map((t) => `"${t.description || t.type || "a task"}" (running ${minutes(now - t.startedAt)} min)`)
    .join(", ");
  return (
    `[Note from the app: your reply has ended, and this chat is still open only for background work: ${list}. ` +
    "Check directly whether what it waits for is done. If it is, or if the wait cannot end on its own, stop it with TaskStop and carry on with my request. " +
    "If it is still rightly waiting, say in one short line what it waits for and when it should end, then end your turn.]"
  );
}

export interface BackgroundWatch {
  // the engine's latest background report
  feed(tasks: BackgroundTask[], idle: boolean): void;
  stop(): void;
}

export function backgroundWatch(opts: {
  // sends the check-in into the running engine; false when it cannot
  say: (text: string) => boolean;
  status: (text: string) => void;
  intervalMs?: number;
  now?: () => number;
}): BackgroundWatch {
  const interval = opts.intervalMs ?? CHECK_IN_MINUTES * 60_000;
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checkIns = 0;
  // the work the chat last said it was waiting on
  let shown = "";
  const clear = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    feed(tasks, idle) {
      clear();
      if (!idle || tasks.length === 0) return;
      const key = tasks.map((t) => t.id).join(",");
      if (key !== shown) {
        shown = key;
        opts.status(`Waiting on background work: ${named(tasks)}. The chat picks up when it ends, and checks on it every ${CHECK_IN_MINUTES} minutes.`);
      }
      if (checkIns >= MAX_CHECK_INS) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!opts.say(checkInNote(tasks, now()))) return;
        checkIns += 1;
        const oldest = Math.min(...tasks.map((t) => t.startedAt));
        opts.status(
          checkIns < MAX_CHECK_INS
            ? `Asked the chat to check on its background work, running ${minutes(now() - oldest)} min.`
            : `Asked the chat to check on its background work, running ${minutes(now() - oldest)} min. That was the last check-in: stop the chat or send a message if it is still waiting.`
        );
      }, interval);
    },
    stop: clear
  };
}
