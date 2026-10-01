// Drives the hidden dev copy (scripts/dev.sh start) through its DevTools port.
//   node scripts/devtools.mjs eval '<js expression>'   print the result
//   node scripts/devtools.mjs shot out.png             save a screenshot
// Expressions run in the app window; async expressions are awaited.
import { writeFileSync } from "node:fs";

const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("dev copy is not running: scripts/dev.sh start");

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  pending.get(d.id)?.(d);
  pending.delete(d.id);
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((resolve) => (ws.onopen = resolve));

if (cmd === "eval") {
  const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails, null, 1));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log(`saved ${arg}`);
} else {
  console.error("usage: node scripts/devtools.mjs eval '<js>' | shot <file.png>");
  process.exitCode = 1;
}
ws.close();
