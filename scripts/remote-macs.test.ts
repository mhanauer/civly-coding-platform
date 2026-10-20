import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const temp = mkdtempSync(join(tmpdir(), "cph-remote-test-"));
process.env.CPH_DATA_DIR = join(temp, "data");
const remote = await import("../src/main/remoteMacs.ts");
after(() => rmSync(temp, { recursive: true, force: true }));

function git(path: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("host selection is saved without credentials and rejects SSH options", () => {
  assert.equal(remote.validSshHost("mac-studio"), true);
  assert.equal(remote.validSshHost("user@example.com"), true);
  assert.equal(remote.validSshHost("-oProxyCommand=bad"), false);
  assert.equal(remote.validSshHost("host;echo bad"), false);
  remote.saveRemoteMacs([{ id: "studio", label: "Mac Studio", sshHost: "mac-studio" }]);
  assert.deepEqual(remote.listRemoteMacs(), [{ id: "studio", label: "Mac Studio", sshHost: "mac-studio" }]);
  assert.equal(readFileSync(join(temp, "data", "remote-macs.json"), "utf8").includes("token"), false);
});

test("reconnect appends only missed events and a reset replaces stale history", () => {
  const first = [{ kind: "user" as const, text: "build" }];
  const next = [{ kind: "text" as const, text: "done" }];
  const merged = remote.mergeRemoteEvents(first, 1, next);
  assert.equal(merged.length, 2);
  assert.equal(remote.mergeRemoteEvents(merged, 1, next), merged);
  assert.deepEqual(remote.mergeRemoteEvents(merged, 0, first), first);
});

test("cross-Mac continuation blocks dirty or mismatched projects and missing attachments", () => {
  const source = join(temp, "source");
  const destination = join(temp, "destination");
  mkdirSync(source); mkdirSync(destination);
  for (const path of [source, destination]) {
    git(path, "init", "-q");
    git(path, "config", "user.email", "test@example.com");
    git(path, "config", "user.name", "Test");
    writeFileSync(join(path, "file.txt"), "first\n");
    git(path, "add", "file.txt");
    git(path, "commit", "-qm", "first");
  }
  const original = remote.projectState(source);
  assert.equal(original.error, undefined);
  // Independent initial commits may differ. Force the same commit before
  // testing a clean handoff by cloning the source into a fresh checkout.
  rmSync(destination, { recursive: true });
  git(temp, "clone", "-q", source, destination);
  assert.equal(remote.compareProjectStates(original, remote.projectState(destination)), null);
  writeFileSync(join(destination, "untracked.txt"), "work");
  assert.match(remote.compareProjectStates(original, remote.projectState(destination)) ?? "", /local changes/);
  rmSync(join(destination, "untracked.txt"));
  writeFileSync(join(destination, "file.txt"), "different\n");
  assert.match(remote.compareProjectStates(original, remote.projectState(destination)) ?? "", /local changes/);
  git(destination, "add", "file.txt");
  git(destination, "commit", "-qm", "different");
  assert.match(remote.compareProjectStates(original, remote.projectState(destination)) ?? "", /revision differs/);
  assert.match(remote.projectState(destination, [join(destination, "missing.txt")]).error ?? "", /missing/);
  assert.equal(remote.compareFileStates(remote.fileState([join(source, "file.txt")]), remote.fileState([join(source, "file.txt")])), null);
  assert.match(remote.compareFileStates({ files: { "/repo/file.txt": "first" } }, { files: { "/repo/file.txt": "other" } }) ?? "", /differs/);
  assert.deepEqual(remote.attachedPaths([{ kind: "user", text: "Fix this\n\nAttached files:\n- /repo/note.txt" }]), ["/repo/note.txt"]);
});

function call(method: string, args: unknown[], requestId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: remote.HOST_SOCKET, path: "/rpc", method: "POST", agent: false,
      headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ method, args, requestId }));
  });
}

test("the host answers a retried send once, even after its server restarts", async () => {
  let sends = 0;
  const dispatch = (method: string): unknown => {
    if (method === "session:send") { sends++; return { accepted: true }; }
    return {};
  };
  let server = await remote.startRemoteServer(dispatch);
  try {
    assert.deepEqual(await call("session:send", ["chat", "prompt"], "request-1"), { result: { accepted: true } });
    assert.deepEqual(await call("session:send", ["chat", "prompt"], "request-1"), { result: { accepted: true } });
    assert.equal(sends, 1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = await remote.startRemoteServer(dispatch);
    assert.deepEqual(await call("session:send", ["chat", "prompt"], "request-1"), { result: { accepted: true } });
    assert.equal(sends, 1);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
