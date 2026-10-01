import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filterText, scanText } from "../src/main/filter.ts";
import type { PlanConfig } from "../src/main/engines/types.ts";

const plans = JSON.parse(
  readFileSync(join(homedir(), ".coding-plan-hub", "plans.json"), "utf8")
) as PlanConfig[];
const zai = plans.find((p) => p.env?.ANTHROPIC_AUTH_TOKEN && p.env.ANTHROPIC_BASE_URL?.includes("api.z.ai"));

const flagged = [
  "Worth noting: the numbers are in and they tell a sharp story.",
  "One honest caveat surfaced: estimates land around 12 percent.",
  "The key insight: tests are the long pole; the remedy is to pool midterms.",
  "Say the word and I will sweep it."
].join(" ");

const clean = [
  "The deploy finished at 3pm. Two pods restarted.",
  "The memo test moved the number 4 points.",
  "Emails came back at 31 of 500, about 6 percent."
].join(" ");

const codeWithSemicolons = [
  "Run this to list the files:",
  "",
  "```bash",
  "for f in *.txt; do echo $f; done",
  "```",
  "",
  "The loop prints one filename per line."
].join("\n");

const cases: Array<[string, string]> = [
  ["flagged", flagged],
  ["clean", clean],
  ["code-with-semicolons", codeWithSemicolons]
];

let failed = false;
for (const [name, text] of cases) {
  const t0 = Date.now();
  const result = await filterText(text, zai);
  const ms = Date.now() - t0;
  const expectChanged = name === "flagged";
  const ok = result.changed === expectChanged;
  if (!ok) failed = true;
  console.log(`${name} | changed: ${result.changed} (expect ${expectChanged}) | ${ms}ms | hits: ${scanText(text).join(", ") || "none"} | error: ${result.error ?? "none"} | ${ok ? "PASS" : "FAIL"}`);
  if (result.changed) {
    console.log("--- rewrite ---");
    console.log(result.text);
  }
}
process.exit(failed ? 1 : 0);
