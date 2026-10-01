import assert from "node:assert/strict";
import { test } from "node:test";
import { CARRY_ON, connectorName, fullToolsReason, leanNote, markerFilter, runsLean } from "../src/main/leanChats.ts";
import { claudeAdapter } from "../src/main/engines/claude.ts";
import type { EngineEvent } from "../src/main/engines/types.ts";

const CONNECTORS = ["claude.ai Gmail", "claude.ai Google Calendar", "claude.ai Civly Dev", "civly-command-center"];

test("only Claude chats run lean, and only while the setting is on", () => {
  const on = { enabled: true, engine: "claude" as const, autoFull: false };
  assert.equal(runsLean({ ...on, tools: "auto" }), true);
  assert.equal(runsLean({ ...on, tools: "lean" }), true);
  assert.equal(runsLean({ ...on, tools: "full" }), false);
  // an auto chat that took on the full setup keeps it
  assert.equal(runsLean({ ...on, tools: "auto", autoFull: true }), false);
  // a chat picked lean stays lean, whatever auto did before
  assert.equal(runsLean({ ...on, tools: "lean", autoFull: true }), true);
  assert.equal(runsLean({ ...on, enabled: false, tools: "lean" }), false);
  assert.equal(runsLean({ ...on, engine: "codex", tools: "lean" }), false);
});

test("a slash command or a connector named outright gets the full setup before the message goes out", () => {
  assert.equal(fullToolsReason("/code-review high", CONNECTORS), "/code-review");
  assert.equal(fullToolsReason("  /plugin:skill go", CONNECTORS), "/plugin:skill");
  assert.equal(fullToolsReason("Check my Gmail for the invoice", CONNECTORS), "Gmail");
  assert.equal(fullToolsReason("add it to google calendar", CONNECTORS), "Google Calendar");
  assert.equal(fullToolsReason("pull it from Civly Dev", CONNECTORS), "Civly Dev");
  assert.equal(fullToolsReason("ask civly-command-center", CONNECTORS), "civly-command-center");
  // the word alone, a path, or part of another word is not a request
  assert.equal(fullToolsReason("fix the email regex in src/gmail.ts", ["claude.ai Gmail"]), undefined);
  assert.equal(fullToolsReason("the calendar widget is off by one", CONNECTORS), undefined);
  assert.equal(fullToolsReason("see /work/notes.md and fix it", CONNECTORS), undefined);
  assert.equal(fullToolsReason("Where is the code that handles retries?", CONNECTORS), undefined);
  assert.equal(connectorName("claude.ai Google Drive"), "Google Drive");
});

test("an auto chat is told what is off and how to ask for it", () => {
  const note = leanNote(CONNECTORS);
  assert.match(note, /^\[Note from the app: to save plan usage, this chat runs without my connectors \(Gmail, Google Calendar, Civly Dev, civly-command-center\), skills and slash commands\./);
  assert.match(note, /reply with only this line, naming what you need: \[\[full tools: what you need\]\]/);
  assert.match(leanNote([]), /runs without my connectors, skills and slash commands\./);
  assert.match(CARRY_ON, /are on now\. Carry on with my last message\./);
});

const feedAll = (events: EngineEvent[]): { out: EngineEvent[]; asked?: string } => {
  const f = markerFilter();
  const out = events.flatMap((e) => f.feed(e));
  return { out, asked: f.asked() };
};

test("Claude's request for the full setup shows as a line about the switch", () => {
  const { out, asked } = feedAll([
    { kind: "thinking", text: "needs email" },
    { kind: "delta", text: "[[full" },
    { kind: "delta", text: " tools: Gmail]]" },
    { kind: "text", text: "[[full tools: Gmail]]" },
    { kind: "done", ok: true }
  ]);
  assert.equal(asked, "Gmail");
  assert.deepEqual(out, [
    { kind: "thinking", text: "needs email" },
    { kind: "status", text: "This chat now has your connectors, skills and slash commands: Claude asked for Gmail. It keeps them for the rest of the chat." },
    { kind: "done", ok: true }
  ]);
});

test("any other reply streams through untouched", () => {
  const reply: EngineEvent[] = [
    { kind: "delta", text: "The retry" },
    { kind: "delta", text: " logic is in a.ts." },
    { kind: "text", text: "The retry logic is in a.ts." },
    { kind: "tool", name: "Read" },
    { kind: "done", ok: true }
  ];
  assert.deepEqual(feedAll(reply), { out: reply, asked: undefined });
  // starts like the request, then turns out not to be it: held pieces come
  // out in order, the moment that is clear
  const f = markerFilter();
  assert.deepEqual(f.feed({ kind: "delta", text: "[[" }), []);
  assert.deepEqual(f.feed({ kind: "delta", text: "full tools: Gmail]] and then" }), [
    { kind: "delta", text: "[[" },
    { kind: "delta", text: "full tools: Gmail]] and then" }
  ]);
  assert.deepEqual(f.feed({ kind: "delta", text: " more" }), [{ kind: "delta", text: " more" }]);
  assert.equal(f.asked(), undefined);
  const link = feedAll([
    { kind: "delta", text: "[[wiki link]]" },
    { kind: "text", text: "[[wiki link]]" }
  ]);
  assert.equal(link.out.length, 2);
  assert.equal(link.asked, undefined);
});

test("a lean Claude chat starts without connectors, skills and slash commands, and keeps the browser", () => {
  const browser = { command: "npx", args: ["chrome-devtools-mcp"] };
  const lean = claudeAdapter().buildArgs({ prompt: "x", cwd: "/w", browser, lean: true });
  assert.ok(lean.includes("--strict-mcp-config") && lean.includes("--disable-slash-commands"));
  assert.deepEqual(Object.keys(JSON.parse(lean[lean.indexOf("--mcp-config") + 1]).mcpServers), ["browser"]);
  const full = claudeAdapter().buildArgs({ prompt: "x", cwd: "/w", browser });
  assert.ok(!full.includes("--strict-mcp-config") && !full.includes("--disable-slash-commands"));
});

test("Claude says which connectors a run has, so a lean chat can name them", () => {
  const events: EngineEvent[] = [];
  claudeAdapter().parseLine(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s1",
      mcp_servers: [
        { name: "claude.ai Gmail", status: "connected" },
        { name: "claude.ai Gusto", status: "needs-auth" },
        { name: "browser", status: "connected" }
      ]
    }),
    (e) => events.push(e)
  );
  assert.deepEqual(events, [{ kind: "session", engineSessionId: "s1", servers: ["claude.ai Gmail", "browser"] }]);
});
