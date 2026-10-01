// The data folder holds API keys, chats, and added accounts' sign-ins, so
// only the user's own account may open it (src/main/dataDir.ts).
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const temp = mkdtempSync(join(tmpdir(), "cph-data-dir-test-"));
process.env.CPH_DATA_DIR = join(temp, "data");
const { secureDataDir } = await import("../src/main/dataDir.ts");
const mode = (path: string): number => statSync(path).mode & 0o777;

test("a new data folder opens only for its owner", () => {
  secureDataDir();
  assert.equal(mode(process.env.CPH_DATA_DIR!), 0o700);
});

test("an existing folder others could read is closed to them", () => {
  chmodSync(process.env.CPH_DATA_DIR!, 0o755);
  secureDataDir();
  assert.equal(mode(process.env.CPH_DATA_DIR!), 0o700);
  rmSync(temp, { recursive: true, force: true });
});
