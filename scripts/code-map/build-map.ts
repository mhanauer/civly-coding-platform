// Builds the code map for one project and says how big it is and what was
// cut. Usage:
//   node --experimental-strip-types scripts/code-map/build-map.ts <folder> [--tokens 8000] [--out map.txt] [--report cut.json]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildCodeMap, DEFAULT_TOKENS } from "./map.ts";
import type { CodeMap } from "./map.ts";

export function describeMap(map: CodeMap): string {
  const lines = [
    `${map.sourceFiles} source files, ${map.definitions} functions and classes.`,
    `The map is about ${map.tokens} tokens (limit ${map.budget}): ${map.shownFiles} files and ${map.shownDefinitions} functions and classes.`,
    `Left out: ${map.cut.files.length} files and ${map.cut.definitions.length} functions and classes.`
  ];
  const top = map.cut.definitions.slice(0, 5).map((d) => `${d.path} ${d.name} (${d.score})`);
  if (top.length > 0) lines.push(`Highest ranked left out: ${top.join(", ")}.`);
  if (map.unreadable.length > 0) lines.push(`Could not read: ${map.unreadable.slice(0, 10).join(", ")}.`);
  return lines.join("\n");
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { tokens: { type: "string" }, out: { type: "string" }, report: { type: "string" } }
  });
  const root = resolve(positionals[0] ?? ".");
  const map = await buildCodeMap(root, Number(values.tokens ?? DEFAULT_TOKENS));
  if (values.out) writeFileSync(values.out, map.text);
  else process.stdout.write(map.text);
  if (values.report) {
    const { text: _text, ...report } = map;
    writeFileSync(values.report, JSON.stringify({ root, ...report }, null, 2));
  }
  console.error(`\n${root}\n${describeMap(map)}`);
}
