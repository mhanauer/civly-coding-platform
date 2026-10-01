import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where the app keeps plans and chats. The dev copy (scripts/dev.sh) points
// this at ~/.coding-plan-hub-dev so testing never touches the real chats.
export const DATA_DIR = process.env.CPH_DATA_DIR || join(homedir(), ".coding-plan-hub");
export const IS_DEV_COPY = Boolean(process.env.CPH_DATA_DIR);

// Plans hold API keys, chats hold your code, and added accounts keep their
// sign-ins here, so only your own user account may open the folder. Other
// accounts on the Mac can otherwise read a home folder's contents.
export function secureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  chmodSync(DATA_DIR, 0o700);
}
