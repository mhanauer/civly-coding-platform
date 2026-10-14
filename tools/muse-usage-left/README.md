# Muse — usage left

A one-page local viewer for the question the hub can't answer today: not
"how many tokens did I spend?" but "how much do I have left?"

## Run it

From this folder (Python standard library only — nothing to install):

```bash
python3 server.py
```

Then open http://127.0.0.1:8917 in your browser. Leave the terminal
running; stop it with Ctrl-C. Set `PORT` to use a different port.

## What it shows

- **Current window / Weekly — % left.** `100 − used%` from Muse's own
  subscription snapshot, with a countdown to each reset.
- **Tokens spent.** Today and last 7 days, summed live from
  `~/.local/share/muse/sessions` (provider-reported records only,
  duplicates removed — same rule as `src/main/museUsage.ts`).

## Why you paste once

Muse only publishes the subscription percent live in the TUI
(`/usage` → window + weekly `used_percent` and `resets_at`). It never
writes that percent to a local file — checked in the session logs; it is
not there — and headless `muse exec --json` does not emit it either, so
no local tool can fetch it automatically.

So: run `/usage` in Muse, paste the output into the page (or type the
two percents in), and Save. The snapshot is stored in `snapshot.json`
next to `server.py`, shown with its save time so stale numbers are
obvious. Tokens refresh every 30 seconds on their own; re-paste after a
reset or whenever you check `/usage`.
