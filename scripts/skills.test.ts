// The Skills view lists the skills you made with one plain sentence each
// (src/main/skills.ts): personal ones first, then each project's own, each
// skill once, without the ones that came with Codex or a plugin.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSkills, parseSkill, personalSkillDirs, projectSkillDirs, summarize } from "../src/main/skills.ts";

test("a summary is the description's first sentence without its trigger list", () => {
  assert.equal(
    summarize("Quick health check of a K3s cluster — nodes, pods, flux, resource usage"),
    "Quick health check of a K3s cluster."
  );
  assert.equal(
    summarize("Format direct-mail drafts (postcards and flat mail pieces) for a campaign. Use when asked to make a mailer."),
    "Format direct-mail drafts for a campaign."
  );
  assert.equal(
    summarize("Run a case-research package end to end, the way the paid engagement does it - verify the record, build the timeline"),
    "Run a case-research package end to end, the way the paid engagement does it."
  );
  assert.equal(summarize("File a GitHub issue with built-in QC (cross-repo dedup, scope)"), "File a GitHub issue with built-in QC.");
  assert.equal(summarize(""), "");
});

test("a long first sentence stops at its first clause that says what it does", () => {
  assert.equal(
    summarize(
      "Send connection requests to people from a lead list, through the signed-in Chrome on the laptop, without a note, about 45 seconds apart, stopping on any security check."
    ),
    "Send connection requests to people from a lead list, through the signed-in Chrome on the laptop."
  );
  const words = "word ".repeat(60).trim();
  const cut = summarize(words);
  assert.ok(cut.length <= 150 && cut.endsWith("…"), cut);
});

test("frontmatter descriptions may span lines, sit in quotes, or follow >", () => {
  assert.deepEqual(
    parseSkill("---\nname: one\ndescription: First line\n  goes on here.\nuser_invocable: true\n---\n\nBody").description,
    "First line goes on here."
  );
  assert.equal(parseSkill('---\nname: two\ndescription: "Say \\"hi\\" nicely."\n---\n').description, 'Say "hi" nicely.');
  assert.equal(parseSkill("---\nname: three\ndescription: >\n  Folded text\n  over lines.\n---\n").description, "Folded text over lines.");
  assert.deepEqual(parseSkill("No frontmatter at all"), { name: "", description: "", body: "No frontmatter at all" });
});

test("each skill shows once, from its original, without built-in ones", () => {
  const temp = mkdtempSync(join(tmpdir(), "cph-skills-test-"));
  const home = join(temp, "home");
  const project = join(temp, "projects", "team");
  const otherCheckout = join(temp, "elsewhere", "team");
  const skill = (dir: string, name: string, description: string, body = "Steps."): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  };
  const bridge = (dir: string, name: string, target: string): void =>
    skill(dir, name, "A borrowed copy.", `Read the [original skill](<${target}>) in full before acting.`);
  try {
    skill(join(home, ".claude", "skills", "proposal"), "proposal", "Make a proposal. Use when asked.");
    // kept for Codex, borrowed by Claude
    skill(join(home, ".agents", "skills", "etl"), "etl", "Load a dataset the parquet-first way.");
    bridge(join(home, ".claude", "skills", "etl"), "etl", "../../../.agents/skills/etl/SKILL.md");
    // came with Codex
    skill(join(home, ".codex", "skills", ".system", "imagegen"), "imagegen", "Make images.");
    bridge(join(home, ".claude", "skills", "imagegen"), "imagegen", "../../../.codex/skills/.system/imagegen/SKILL.md");
    // a project's skill linked in as a personal one
    skill(join(project, ".claude", "skills", "branding"), "branding", "The brand spec for client documents - palette, logo.");
    symlinkSync(join(project, ".claude", "skills", "branding"), join(home, ".claude", "skills", "branding"));
    skill(join(project, ".claude", "skills", "qc-pass"), "qc-pass", "Fact-check a deliverable before it ships.");
    // the same personal skill in another checkout of a project
    skill(join(otherCheckout, ".claude", "skills", "proposal"), "proposal", "Make a proposal. Use when asked.");
    mkdirSync(join(home, ".claude", "skills", "empty"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills", "synced", "abc"), { recursive: true });

    const skills = listSkills([
      { project: "", dirs: personalSkillDirs(home) },
      { project: "team", dirs: projectSkillDirs(project) },
      { project: "other", dirs: projectSkillDirs(otherCheckout) },
      { project: "missing", dirs: projectSkillDirs(join(temp, "nowhere")) }
    ]);
    assert.deepEqual(
      skills.map((s) => [s.project, s.name, s.summary]),
      [
        ["", "branding", "The brand spec for client documents."],
        ["", "etl", "Load a dataset the parquet-first way."],
        ["", "proposal", "Make a proposal."],
        ["team", "qc-pass", "Fact-check a deliverable before it ships."]
      ]
    );
    assert.match(skills[1].file, /\.agents\/skills\/etl\/SKILL\.md$/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Codex's personal skills follow CODEX_HOME", () => {
  assert.deepEqual(personalSkillDirs("/h", "/c").at(-1), "/c/skills");
  assert.deepEqual(personalSkillDirs("/h").at(-1), "/h/.codex/skills");
});
