#!/usr/bin/env node
// Every push to the public repo publishes, so this runs before each one
// (installed in .git/hooks by npm run setup:hooks) and stops the push:
//   1. on uncommitted changes, so the tests below run on exactly what goes out
//   2. when the pushed commit is not the checked-out one, for the same reason
//   3. when the pushed history does not start where the remote's does
//   4. when a new commit's added lines or message hold an email address, an IP
//      address, a home folder path, a key or token, or anything in your
//      private blocklist
//   5. when typecheck, the build, or any test:* script fails
// The private blocklist is a file outside the repo, one case-insensitive
// regular expression per line, so the list itself is never published. Point
// to it with: git config cph.blocklist <file>. Once set, a missing file stops
// every push.
// Try it without pushing: npm run push:check
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 30 }).trimEnd();
const lines = (text) => text.split("\n").filter(Boolean);
const stop = (message) => {
  console.error(`\nPush stopped: ${message}\n`);
  process.exit(1);
};

const dryRun = process.argv.includes("--dry-run");
const remote = dryRun ? "origin" : process.argv[2] || "origin";
const head = git("rev-parse", "HEAD");
// git hands the hook one line per ref: <local ref> <local sha> <remote ref> <remote sha>
const pushed = dryRun
  ? [head]
  : lines(readFileSync(0, "utf8"))
      .map((line) => line.split(" ")[1])
      // a deleted ref publishes nothing
      .filter((sha) => !/^0+$/.test(sha));
if (pushed.length === 0) process.exit(0);

// 1
const dirty = git("status", "--porcelain");
if (dirty) stop(`there are uncommitted changes. Commit or stash them first.\n${dirty}`);

// 2
for (const sha of pushed) {
  if (git("rev-parse", `${sha}^{commit}`) !== head) {
    stop(`${sha.slice(0, 7)} is not the checked-out commit. Check it out and push from there.`);
  }
}

// 3
const roots = (rev) => lines(git("rev-list", "--max-parents=0", rev));
const remoteTips = lines(git("for-each-ref", "--format=%(objectname)", `refs/remotes/${remote}`));
if (remoteTips.length > 0) {
  const known = new Set(remoteTips.flatMap(roots));
  const strange = roots(head).filter((r) => !known.has(r));
  if (strange.length > 0) {
    stop(`this history does not start where ${remote}'s does (first commit ${strange[0].slice(0, 7)}). It may be a different repo's history.`);
  }
}

// 4
const GENERIC = [
  {
    label: "email address",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allow: (m) => /^(noreply@|git@github\.com$)|@users\.noreply\.github\.com$|@example\.(com|org|net)$/i.test(m)
  },
  // not part of a longer dotted run, like SVG path data or a version number
  { label: "IP address", re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g, allow: (m) => m === "127.0.0.1" || m === "0.0.0.0" },
  { label: "home folder path", re: /\/(?:Users|home)\/[A-Za-z][\w.-]*/g },
  {
    label: "key or token",
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|xox[abprs]-[\w-]{10,}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}|[0-9a-f]{32}\.[A-Za-z0-9]{16})/g
  },
  { label: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
];

const rules = [...GENERIC];
const blocklist = (() => {
  try {
    return git("config", "--get", "cph.blocklist");
  } catch {
    return "";
  }
})();
if (blocklist) {
  if (!existsSync(blocklist)) stop(`the private blocklist ${blocklist} (git config cph.blocklist) is missing.`);
  for (const line of lines(readFileSync(blocklist, "utf8"))) {
    const pattern = line.trim();
    if (!pattern || pattern.startsWith("#")) continue;
    rules.push({ label: "private blocklist", re: new RegExp(pattern, "gi") });
  }
} else {
  console.log("No private blocklist set (git config cph.blocklist); checking the general patterns only.");
}

// the commits this push adds: everything not already on the remote
const fresh = lines(git("rev-list", head, "--not", `--remotes=${remote}`));
const hits = [];
for (const sha of fresh) {
  const show = git("show", "--format=%B%x00", "--unified=0", "--no-color", "--no-ext-diff", sha);
  const [message, diff = ""] = show.split("\0");
  const scan = (where, text) => {
    for (const rule of rules) {
      for (const m of text.matchAll(rule.re)) {
        if (rule.allow?.(m[0])) continue;
        hits.push(`${sha.slice(0, 7)} ${where}: ${rule.label}: ${m[0]}`);
      }
    }
  };
  for (const line of lines(message)) scan("commit message", line);
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.replace(/^\+\+\+ (b\/)?/, "");
      scan("file name", file);
    } else if (line.startsWith("+")) {
      scan(file, line.slice(1));
    }
  }
}
if (hits.length > 0) {
  const shown = hits.slice(0, 30).join("\n");
  const more = hits.length > 30 ? `\n...and ${hits.length - 30} more` : "";
  stop(`${hits.length} line${hits.length === 1 ? "" : "s"} in the new commits should not be published:\n${shown}${more}`);
}
console.log(`Scanned ${fresh.length} new commit${fresh.length === 1 ? "" : "s"}: nothing personal or secret.`);

// 5: build before the test:* scripts, since the UI tests load out/
const scripts = Object.keys(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts ?? {});
const steps = ["typecheck", "build", ...scripts.filter((s) => s.startsWith("test:"))];
for (const step of steps) {
  const r = spawnSync("npm", ["run", "-s", step], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    process.stderr.write(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    stop(`npm run ${step} failed.`);
  }
  console.log(`passed: ${step}`);
}
console.log(dryRun ? "\nAll checks passed. A push would go through." : "\nAll checks passed. Pushing.");
