# Contributing

Thanks for helping. Bug reports, fixes, and new engines are all welcome.

## Ground rules

- **macOS only.** Sign-ins open in Terminal, login checks read the macOS
  keychain, and the built-in terminal uses macOS `script`. Changes must keep
  working on macOS on Apple silicon. Support for other platforms is welcome
  as long as macOS keeps working.
- **Official CLIs only.** The app runs each vendor's own CLI and shows its
  output. It must never read a CLI's login tokens or make its own API calls
  against someone's subscription. Pull requests that do either will not be
  merged.
- **Features for one setup go behind a setting.** If a feature only makes
  sense for some users, add it to `src/main/settings.ts`, off by default.

## Setup

You need Node.js 24 and npm. To try chats by hand you also need at least one
of the CLIs in the README, signed in.

```bash
git clone https://github.com/mhanauer/civly-coding-platform.git
cd civly-coding-platform
npm install
npm run dev
```

`scripts/dev.sh start` runs a second copy with its own data in
`~/.coding-plan-hub-dev`, so your real chats stay untouched. Its chats still
use your real CLI logins and count against your plans.

## Tests

Run these before opening a pull request:

```bash
npm run typecheck
npm run build                # the UI tests load the built app
npm run test:accounts        # unit tests, plain Node
npm run test:side
npm run test:limit-fallback
npm run test:auto-effort
npm run test:data-dir
npm run test:code-map        # the code-map test's tools (scripts/code-map)
npm run test:lean-chats
npm run test:skills
npm run test:chat            # UI tests: the real window with fixture data
npm run test:questions
npm run test:projects
npm run test:accounts-ui
npm run test:browser-checks
npm run test:settings
npm run test:skills-ui
```

The UI tests run in Electron and need no CLI or login. `npm run smoke` talks to
the real kimi CLI and is optional.

A new behavior should come with a test next to the ones above. Name a new
script `test:<something>` in `package.json` and the push checks and the
release build run it automatically.

## Before you push

`npm run setup:hooks` installs a check that runs before every `git push`. It
stops the push if there are uncommitted changes, if the new commits contain
an email address, an IP address, a home folder path, or an API key, or if any
test fails. `npm run push:check` runs the same checks without pushing.

## Style

- Match the code around your change: its naming, comment density, and idiom.
  Comments explain why, not what.
- Text in the app is plain English. Say what happened and what to do next.
- Commit messages follow conventional commits (`feat:`, `fix:`, `docs:`,
  `chore:`) and describe the change from the user's side.

## Releasing (maintainers)

Releases are built on the maintainer's Mac, with the Developer ID certificate
in the keychain and an App Store Connect API key for notarization:

1. Update `version` in `package.json`, commit, and push.
2. Build, sign, and notarize:

   ```bash
   APPLE_API_KEY=<path to the .p8> APPLE_API_KEY_ID=<key id> \
     APPLE_API_ISSUER=<issuer id> npm run release
   ```

3. Tag the commit and publish the DMG:

   ```bash
   git tag v<version> && git push origin v<version>
   gh release create v<version> release/*.dmg release/*.sha256 \
     --verify-tag --generate-notes --title "Civly Coding Platform <version>"
   ```

`.github/workflows/release.yml` can do steps 2 and 3 on GitHub instead. It
stays off until the repository variable `RELEASE_FROM_CI` is `true` and these
secrets are set in the `release` environment:

| Secret | What it holds |
| --- | --- |
| `MAC_CERT_P12` | The Developer ID Application certificate and its private key, exported as a .p12 and base64-encoded |
| `MAC_CERT_PASSWORD` | The .p12's password |
| `APPLE_API_KEY_P8` | The text of an App Store Connect API key (.p8) |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | Its issuer ID |
