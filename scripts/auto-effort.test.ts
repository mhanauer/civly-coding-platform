import assert from "node:assert/strict";
import { test } from "node:test";
import { isHousekeeping, resolveEffort } from "../src/main/autoEffort.ts";

test("housekeeping messages run at medium", () => {
  for (const msg of [
    "thanks",
    "Thank you so much!",
    "commit",
    "Commit and push.",
    "ok, commit and push",
    "Looks good. Commit it",
    "great! open a PR",
    "commit and open the PR please",
    "status?",
    "Is it done?"
  ]) {
    assert.equal(resolveEffort("auto", msg, "xhigh"), "medium", msg);
  }
});

test("approvals and real asks keep the usual level", () => {
  for (const msg of [
    "yes",
    "ok",
    "Great",
    "continue",
    "go ahead",
    "do it",
    "merge it",
    "run the tests",
    "fix the failing test",
    "commit, then refactor the matcher",
    "why did the commit fail?",
    "commit\nand also update the docs",
    ""
  ]) {
    assert.equal(resolveEffort("auto", msg, "xhigh"), "xhigh", msg);
  }
});

test("a picked level is always used as is", () => {
  assert.equal(resolveEffort("max", "thanks", "xhigh"), "max");
  assert.equal(resolveEffort("low", "refactor everything", "xhigh"), "low");
});

test("auto never raises a usual level at or below medium", () => {
  assert.equal(resolveEffort("auto", "commit", "medium"), "medium");
  assert.equal(resolveEffort("auto", "commit", "low"), "low");
  assert.equal(resolveEffort("auto", "push it", "high"), "medium");
  // your Codex default can be max
  assert.equal(resolveEffort("auto", "push it", "max"), "medium");
  assert.equal(resolveEffort("auto", "add a test", "max"), "max");
});

test("long messages are never housekeeping", () => {
  assert.equal(isHousekeeping(`commit ${"x".repeat(90)}`), false);
});
