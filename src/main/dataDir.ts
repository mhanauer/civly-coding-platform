import { homedir } from "node:os";
import { join } from "node:path";

// Where the app keeps plans and chats. The dev copy (scripts/dev.sh) points
// this at ~/.coding-plan-hub-dev so testing never touches the real chats.
export const DATA_DIR = process.env.CPH_DATA_DIR || join(homedir(), ".coding-plan-hub");
export const IS_DEV_COPY = Boolean(process.env.CPH_DATA_DIR);
