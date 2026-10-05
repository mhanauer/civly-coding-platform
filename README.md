# Civly Coding Platform

A Mac desktop app that runs your AI coding subscriptions side by side: Claude
Code, ChatGPT (Codex), Kimi, Gemini, and key-based plans such as Z.ai or
OpenRouter. Each chat is bound to one plan, chats run in parallel, and
switching one chat never touches another.

Made by [Civly](https://civly.ai). MIT licensed.

## How it works

The app is an orchestrator, not an API client. It runs each vendor's official
CLI headless (`claude -p --output-format stream-json`, `codex exec --json`,
`kimi -p --output-format stream-json`) and shows the stream. Every login stays
in its own CLI's credential store. The app never reads login tokens and never
makes its own API calls against a subscription quota.

## Install

1. Download `Civly-Coding-Platform-<version>-arm64.dmg` from the
   [latest release](https://github.com/mhanauer/civly-coding-platform/releases/latest).
2. Open it and drag **Civly Coding Platform** onto **Applications**.
3. Install and sign in to at least one of the CLIs below. The app finds them
   on your shell's PATH.

It needs macOS on Apple silicon. Sign-ins open in Terminal and login checks
read the macOS keychain, so other platforms do not work yet.

Each release is signed with a Developer ID and notarized by Apple. To check a
download against the `.sha256` file published beside it:

```bash
shasum -a 256 -c Civly-Coding-Platform-<version>-arm64.dmg.sha256
```

To update, install the newer DMG the same way. The running app notices and
offers to restart once no chat is working.

## Build from source

You need Node.js 24 and npm.

```bash
git clone https://github.com/mhanauer/civly-coding-platform.git
cd civly-coding-platform
npm install
npm run dev          # opens the app window
```

To install your build as a regular app:

```bash
npm run package:app  # builds, signs, and copies it to /Applications
```

The package script creates a self-signed code signing key the first time it
runs, kept in `~/.coding-plan-hub/signing` in a keychain of its own. Every
build is signed with that key, so macOS keeps the app's privacy permissions
(folders, Full Disk Access) across rebuilds.

## Signing in to each plan

Each CLI signs in once, on its own. Accounts → **Log in** opens Terminal with
the right command, or run it yourself:

| Plan | CLI | Sign in |
| --- | --- | --- |
| Claude subscription | `claude` | run `claude`, then `/login` |
| ChatGPT | `codex` | `codex login` |
| Kimi for Coding | `kimi` | run `kimi` and follow its login |
| Gemini | `gemini` | run `gemini` and follow its login |
| Z.ai, OpenRouter, other Anthropic-compatible keys | `claude` | Accounts → Add an account → An API key |

A key plan runs through the Claude Code CLI with `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN` set for that plan. The app shows a CLI's "not logged
in" errors as the CLI wrote them.

Engines get your login shell's environment, read once when the app starts
(`src/main/shellPath.ts`), so they run as they do from Terminal. After
exporting a new variable in your shell, restart the app.

## More than one Claude or ChatGPT subscription

Accounts → Add an account → Claude Code or ChatGPT (Codex), then **Add and sign
in**. Terminal opens to sign the new account in. Each added account gets its
own CLI home under `~/.coding-plan-hub/accounts/<plan id>` (set as
`CLAUDE_CONFIG_DIR` or `CODEX_HOME`), so its login never replaces another one.

Before every sign-in and every turn, the app links what the main home holds
into the account's home, so all accounts share it:

- Claude: `CLAUDE.md`, `rules`, `skills`, `agents`, `commands`,
  `output-styles`, `hooks`, `settings.json`, `settings.local.json`,
  `keybindings.json`, `plugins`, and the conversation store (`projects` with
  memory, `file-history`, `todos`, `plans`, `session-env`, `history.jsonl`).
  A chat moves between Claude accounts and keeps its place.
- Codex: `AGENTS.md`, `AGENTS.override.md`, `config.toml`, `rules`, `skills`,
  `prompts`, `plugins`. Codex keeps chats in SQLite databases that are not
  safe to share through links, so a chat moved to another ChatGPT account
  continues from a recap.

A new Claude home also starts with a copy of the main account's finished
one-time setup steps, its MCP servers, and each folder's trust settings (from
`~/.claude.json`, never its login or identity). When a CLI saves a shared file
whole and replaces its link, the next run puts the newer copy back in the main
home and relinks it. An older copy is kept beside it as
`<name>.unlinked-<time>`.

When a plan hits its session, hourly or weekly limit, the chat continues the request
automatically on another signed-in account of the same kind if one has quota.
Otherwise it uses another available plan and passes along the conversation:
your first message, the most recent part of the chat, the last steps of the
turn the limit cut off, and where the chat's full record is saved. Switching a
chat to another kind of plan yourself passes it along the same way.
A message sent to a plan the app already knows is out goes straight to the next
plan with quota, and the chat says so. If an engine reports its plan is out but
waits for the reset instead of failing, the app stops it after 10 seconds and
moves on the same way. That includes a Claude chat whose turn failed on the
limit while a background agent or command kept it open.
If every signed-in plan is out, add an account or send the request again after
a reset.
When a model is at capacity ("Selected model is at capacity", or an overloaded
error), the chat continues on the plan's other model, then on the next plan
with quota. A model at capacity is not counted against its plan's quota.
Deleting an added account signs it out and removes its home.

## Usage

The Usage and Accounts views show each ChatGPT account's limits through
Codex's read-only account endpoint: percent used, the next reset, remaining
credits, and available full resets. Usage refreshes on launch, every ten
minutes, after a Codex turn, and when either view opens.

## Browser

Claude and ChatGPT chats browse in a Chrome of their own, with its own profile
in `~/.coding-plan-hub/browser`, driven through
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(pinned in `src/main/chromeBrowser.ts`). Every account uses the same browser
and the same site logins. Sign it in to sites once with Accounts → Open the
chats' browser. When a page needs you (a CAPTCHA, a sign-in), the app says so.

It starts with each turn, in the background and without a window, listening
for DevTools on `127.0.0.1:9337`. Any program on your Mac can drive it through
that port while it runs. Links you click in the app open in your own browser.

## Settings

Features built for one setup are off until you turn them on in
Settings. They are saved in `~/.coding-plan-hub/settings.json`.

- **Plain-English filter.** After each reply, a local scan looks for banned
  phrases (em dashes, "worth noting", and similar). A flagged reply is
  rewritten by GLM Flash through your Z.ai key plan, and the original stays
  one click away. Each chat can turn it off. A `no-ai-speak` skill in
  `~/.agents/skills` replaces the bundled rules when present.
- **Work on a dev branch.** Puts every project on a branch named `dev`,
  creating it where missing.
- **Show ZCode's projects.** Lists ZCode's recent projects in the sidebar.
- **Lean Claude chats.** Starts Claude without connectors, skills, or slash
  commands to use less of your plan. On Auto, a chat turns them on when a
  message needs them. This option is still in testing.
- **Keep the CLIs up to date.** The CLIs update themselves only when you run
  them in Terminal, and the app runs them headless. With this on, the app
  checks Claude Code, Codex, Gemini and Kimi for new releases at launch and
  every six hours, and updates each the way it was installed (npm, Homebrew,
  Claude Code's native installer, or `kimi upgrade`) once no chat on it is
  working. A new major version waits for an Update click, since it can change
  the flags the app runs it with. Settings lists every CLI's version either
  way.

## Projects

Add a folder with **+** in the sidebar. Drag a project by its name to move it,
or use its ⋯ menu (also right-click). The list and its order are saved in
`~/.coding-plan-hub/projects.json` and `project-order.json`.

## Your data

Everything the app keeps is in `~/.coding-plan-hub`, which only your user
account can open: plans (`plans.json`, created with defaults on first run),
chats, added accounts' homes, the browser profile, usage, and settings.
`installed` in `plans.json` is checked at runtime, so editing it by hand has
no effect.

## Development

```bash
npm run typecheck          # both TypeScript projects
npm run test:accounts      # account homes and shared links
npm run test:side          # side conversations and plan hand-offs
npm run test:limit-fallback # automatic continuation at usage limits and model capacity
npm run test:auto-effort   # Auto effort
npm run test:data-dir      # the data folder is private to you
npm run test:cli-updates   # CLI version checks and updates
npm run test:chat          # UI smoke tests, run in Electron
npm run test:questions
npm run test:projects
npm run test:accounts-ui
npm run test:browser-checks
npm run test:settings
npm run smoke              # engine layer against the real kimi CLI
```

### Checks before every push

`npm run setup:hooks` installs a pre-push check (`scripts/push-guard.mjs`)
that stops a push when:

- there are uncommitted changes, or the pushed commit is not the checked-out one
- the pushed history does not start where the remote's does
- a new commit's added lines or message hold an email address, an IP address,
  a home folder path, an API key or token, or a private key
- typecheck, the build, or any `test:*` script fails

To block words of your own (names, internal project names) without
publishing the list, put one case-insensitive regular expression per line in
a file outside the repo and run `git config cph.blocklist <file>`. Once set,
a missing file stops every push. `npm run push:check` runs the same checks
without pushing.

`scripts/dev.sh start` runs a second copy of the app with its own data in
`~/.coding-plan-hub-dev`, so testing never touches your chats. Its engines use
your real logins, so messages it sends count against your plans.

## Known limits

- macOS only.
- Only Claude asks for permission in the app, and only on Standard access.
  The other CLIs follow their own non-interactive rules, so edits may be
  accepted without asking and risky commands may be refused by the CLI
  itself.
- opencode and qwen are not implemented yet. Their plans appear in the config
  but cannot run.
- Chats persist across restarts. If a restart cuts off a running turn, the app
  resumes it on next launch. Turns you stopped stay stopped.
- If Codex exhausts its connection retries while finding the ChatGPT workspace,
  the app makes one new attempt in the saved chat. It asks Codex to check the
  current state before repeating commands. If that attempt fails, the chat
  waits for you to continue it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and how releases are
built. Report security problems privately, as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
