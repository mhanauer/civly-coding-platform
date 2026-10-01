# Security

## Reporting a problem

Please report security problems privately, not in a public issue. Use
GitHub's private reporting:
[Report a vulnerability](https://github.com/mhanauer/civly-coding-platform/security/advisories/new)
(the Security tab, then **Report a vulnerability**). Only the maintainers
can see the report, and you will get a reply there.

Include what you found, the steps to reproduce it, and what someone could do
with it. Fixes go into the latest release; older versions are not patched.

## How the app handles your data

These follow from how the app works. Reports that show a way around them are
welcome.

- **Logins stay with each CLI.** The app never reads a CLI's login tokens. An
  added Claude or ChatGPT account signs in to its own CLI home under
  `~/.coding-plan-hub/accounts`.
- **API keys for key plans** (Z.ai, OpenRouter, and other
  Anthropic-compatible services) are saved in `~/.coding-plan-hub/plans.json`.
  The app limits `~/.coding-plan-hub` to your own user account, so other
  accounts on the Mac cannot open it.
- **The chats' browser can be driven by any program on your Mac.** While a
  chat runs, its Chrome listens for DevTools on `127.0.0.1:9337`, which is
  reachable only from this Mac. Any program on the Mac can control that
  browser, and with it every site you signed in to there.
- **Full access**, which new chats start on, lets a CLI run commands and edit
  files without asking. On Standard, Claude asks you in the chat before
  anything its permission rules do not already allow, and Codex keeps to its
  own sandbox settings.
- **The plain-English filter**, when turned on in Settings, sends flagged
  replies to Z.ai to be rewritten. It is off by default.
