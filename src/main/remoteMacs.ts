import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DATA_DIR, IS_DEV_COPY } from "./dataDir.ts";
import type { EngineEvent } from "./engines/types.ts";

export interface RemoteMac {
  id: string;
  label: string;
  sshHost: string;
}

export interface RemoteChatCache<T> {
  hostId: string;
  summary: T;
  transcript: EngineEvent[];
  online: boolean;
  missing?: boolean;
  version?: number;
}

const MACS_FILE = join(DATA_DIR, "remote-macs.json");
const CACHE_FILE = join(DATA_DIR, "remote-chat-cache.json");
const REQUESTS_FILE = join(DATA_DIR, "remote-requests.json");
export const HOST_SOCKET = join(DATA_DIR, "host.sock");

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; }
}

function writePrivate(file: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}

export function listRemoteMacs(): RemoteMac[] {
  const saved = readJson<unknown>(MACS_FILE, []);
  return Array.isArray(saved) ? saved.filter((m): m is RemoteMac =>
    m && typeof m.id === "string" && typeof m.label === "string" && typeof m.sshHost === "string"
  ) : [];
}

export function saveRemoteMacs(macs: RemoteMac[]): void { writePrivate(MACS_FILE, macs); }

export function loadRemoteCache<T>(): Record<string, RemoteChatCache<T>> {
  const saved = readJson<unknown>(CACHE_FILE, {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter(([, chat]) => {
    const value = chat as Partial<RemoteChatCache<T>>;
    return value && typeof value.hostId === "string" && value.summary && Array.isArray(value.transcript);
  })) as Record<string, RemoteChatCache<T>>;
}

export function saveRemoteCache<T>(cache: Record<string, RemoteChatCache<T>>): void {
  // The host is authoritative. This copy lets the MacBook show the last
  // transcript while disconnected and remember which host owns each chat.
  writePrivate(CACHE_FILE, cache);
}

export function mergeRemoteEvents(current: EngineEvent[], offset: number, events: EngineEvent[]): EngineEvent[] {
  if (offset === 0) return events;
  if (offset === current.length) return events.length ? [...current, ...events] : current;
  // A delayed response from an earlier poll cannot rewind or duplicate the
  // local copy. The next poll requests the cursor it actually has.
  return current;
}

export function validSshHost(host: string): boolean {
  // An SSH config alias, hostname, or user@hostname. No shell syntax or
  // command-line options can enter the remote command.
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(host) && host.length <= 200;
}

export function remoteRequest<T>(mac: RemoteMac, method: string, args: unknown[], requestId: string = randomUUID()): Promise<T> {
  if (!validSshHost(mac.sshHost)) return Promise.reject(new Error("Enter an SSH host alias or user@hostname."));
  // The socket is only accessible to the Mac account that owns it. SSH
  // authenticates and encrypts the entire request; there is no listening
  // TCP port and no CLI credential is sent to the MacBook.
  const hostDataFolder = IS_DEV_COPY ? ".coding-plan-hub-dev" : ".coding-plan-hub";
  const command = `curl -fsS --max-time 35 -H "Content-Type: application/json" --unix-socket "$HOME/${hostDataFolder}/host.sock" --data-binary @- http://localhost/rpc`;
  return new Promise<T>((resolve, reject) => {
    const child = spawn("ssh", [
      "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=6", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
      mac.sshHost, command
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 40_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.stdin.on("error", () => { /* SSH failed before it read the request */ });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim().split("\n").at(-1);
        reject(new Error(detail || `SSH connection to ${mac.label} failed`));
        return;
      }
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: T; error?: string };
        if (reply.error) reject(new Error(reply.error));
        else resolve(reply.result as T);
      } catch { reject(new Error(`Invalid reply from ${mac.label}`)); }
    });
    child.stdin.end(JSON.stringify({ method, args, requestId }));
  });
}

type RpcDispatch = (method: string, args: unknown[]) => Promise<unknown> | unknown;

// A request is recorded before a mutating action starts. If the connection
// drops after acceptance, retrying with the same id returns its saved result.
// A host crash at that exact point returns an indeterminate error instead of
// risking a second command execution.
export class RequestLedger {
  private records = readJson<Record<string, { state: "started" | "done"; result?: unknown; at: number }>>(REQUESTS_FILE, {});
  async run(id: string, action: () => Promise<unknown> | unknown): Promise<unknown> {
    const old = this.records[id];
    if (old) {
      if (old.state === "done") return old.result;
      throw new Error("The host accepted this action before a restart. Check the chat before trying again.");
    }
    this.records[id] = { state: "started", at: Date.now() };
    writePrivate(REQUESTS_FILE, this.records);
    let result: unknown;
    try { result = await action(); }
    catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
    this.records[id] = { state: "done", result, at: Date.now() };
    writePrivate(REQUESTS_FILE, this.records);
    return result;
  }
}

export async function startRemoteServer(dispatch: RpcDispatch, ledger = new RequestLedger()): Promise<Server> {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(HOST_SOCKET)) {
    // Never unlink a socket belonging to a second running app. A stale
    // socket from a crash is removed only after a connection fails.
    const { connect } = await import("node:net");
    const live = await new Promise<boolean>((resolve) => {
      const socket = connect(HOST_SOCKET);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (live) throw new Error("Another Coding Platform host is already running.");
    rmSync(HOST_SOCKET, { force: true });
  }
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/rpc") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method?: string; args?: unknown[]; requestId?: string };
          if (!body.method || !Array.isArray(body.args) || typeof body.requestId !== "string") throw new Error("Invalid request");
          const readonly = new Set(["host:health", "host:sync", "host:project-state", "host:file-state", "host:export", "host:release"]);
          const run = () => dispatch(body.method as string, body.args as unknown[]);
          const result = readonly.has(body.method) ? await run() : await ledger.run(body.requestId, run);
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
        } catch (error) {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(HOST_SOCKET, () => { server.off("error", reject); resolve(); });
  });
  // Node uses the caller's umask for sockets; enforce account-only access.
  const { chmodSync } = await import("node:fs");
  chmodSync(HOST_SOCKET, 0o600);
  server.on("close", () => rmSync(HOST_SOCKET, { force: true }));
  return server;
}

export interface ProjectState {
  path: string;
  revision?: string;
  branch?: string;
  error?: string;
  files: Record<string, string>;
}

export interface FileState { files: Record<string, string>; error?: string }

function sha256File(file: string): string {
  const hash = createHash("sha256");
  const bytes = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(file, "r");
  try {
    let count: number;
    while ((count = readSync(fd, bytes, 0, bytes.length, null)) > 0) hash.update(bytes.subarray(0, count));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

export function fileState(files: string[]): FileState {
  const state: FileState = { files: {} };
  for (const file of files) {
    try {
      if (!statSync(file).isFile()) return { ...state, error: `Attachment is not a file: ${file}` };
      state.files[file] = sha256File(file);
    } catch { return { ...state, error: `Attachment is missing: ${file}` }; }
  }
  return state;
}

export function compareFileStates(source: FileState, destination: FileState): string | null {
  if (source.error) return `This Mac: ${source.error}`;
  if (destination.error) return `Host Mac: ${destination.error}`;
  for (const [file, hash] of Object.entries(source.files))
    if (destination.files[file] !== hash) return `Attachment differs on the host Mac: ${file}`;
  return null;
}

function git(path: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function attachedPaths(transcript: EngineEvent[]): string[] {
  const paths = new Set<string>();
  for (const event of transcript) {
    if (event.kind !== "user") continue;
    const block = event.text.split("Attached files:\n")[1];
    if (!block) continue;
    for (const line of block.split("\n")) {
      const path = line.match(/^- (\/[^\n]+)$/)?.[1];
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

export function projectState(path: string, files: string[] = []): ProjectState {
  const state: ProjectState = { path, files: {} };
  try {
    if (!statSync(path).isDirectory()) return { ...state, error: "Project folder is not a directory" };
  } catch { return { ...state, error: "Project folder is missing" }; }
  const root = git(path, ["rev-parse", "--show-toplevel"]);
  if (!root) return { ...state, error: "Project is not a Git repository; a safe cross-Mac revision check is unavailable" };
  if (realpathSync(root) !== realpathSync(path)) return { ...state, error: "Open the Git project root to compare it across Macs" };
  state.revision = git(path, ["rev-parse", "HEAD"]) ?? undefined;
  const branch = git(path, ["branch", "--show-current"]);
  if (branch === null) return { ...state, error: "Could not check the project branch" };
  state.branch = branch;
  if (!state.revision) return { ...state, error: "Project has no committed revision" };
  const changes = git(path, ["status", "--porcelain", "--untracked-files=all"]);
  if (changes === null) return { ...state, error: "Could not check project changes" };
  if (changes) return { ...state, error: "Project has local changes or untracked files" };
  for (const file of files) {
    try {
      if (!file.startsWith(`${path}/`) && file !== path) return { ...state, error: `Attachment is outside the project: ${file}` };
      if (!statSync(file).isFile()) return { ...state, error: `Attachment is not a file: ${file}` };
      state.files[file] = sha256File(file);
    } catch { return { ...state, error: `Required file is missing: ${file}` }; }
  }
  return state;
}

export function compareProjectStates(source: ProjectState, destination: ProjectState): string | null {
  if (source.error) return `Source Mac: ${source.error}`;
  if (destination.error) return `Destination Mac: ${destination.error}`;
  if (!source.revision || !destination.revision) return "Could not verify both project revisions";
  if (source.revision !== destination.revision || source.branch !== destination.branch)
    return "The project branch or revision differs between Macs";
  for (const [path, hash] of Object.entries(source.files)) {
    if (destination.files[path] !== hash) return `Required file differs on the destination: ${path}`;
  }
  return null;
}
