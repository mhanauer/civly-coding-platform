# Code-map test

Does a map of the code, given to an assistant at the start of a chat, make its
answers to questions about the code more accurate? This folder is the test
from issue #1. It is a test, not a feature: nothing in the app turns the map
on.

## The parts

- **Map builder** (`map.ts`, `build-map.ts`). Parses every source file with
  tree-sitter (TypeScript, JavaScript, Python, Go, Rust, Java) and lists its
  functions and classes, ranked by how many other files use them. A file
  counts as using a definition only when it uses the name and imports the
  definition's file; a method also needs its class named. The map is cut to a
  fixed size (8,000 tokens by default) and the builder reports what it cut.
- **Map switch** (`src/main/engines/codeMap.ts`). `SendOptions.codeMap` puts
  the map in front of a new chat's first message, with the same text for
  Claude, Codex, Kimi and Gemini. Only this test sets it.
- **Answer keys** (`questions/`). Questions with known answers, in three
  kinds: find ("Where is X handled?"), describe ("What does Y do, and what
  calls it?") and trace ("What happens, step by step, when Z?"). Each answer
  lists the terms a right answer has to contain (`mustMention`). Keys for
  private codebases stay outside this repo.
- **Runner** (`run.ts`). Runs every question on every assistant, with and
  without the map, in a fresh chat each time, through the app's own engine
  code. It records right or wrong, time, tokens, and files opened, and writes
  a results table with a go/no-go.

## 1. Check the answer keys

Every answer has to be checked before any run, by someone other than whoever
drafted it. Open the key, read each answer against the code at the key's
`commit`, fix what is wrong, and set `checked` to `true`. Say who checked it,
and how, in `checkedBy`. The runner refuses a key with unchecked answers.

Tips for `mustMention`: name the function and file a right answer cannot
avoid, using the shortest form an assistant would write (`recap.ts`, not
`src/main/recap.ts`). A list inside the list means any one of them will do.

## 2. Look at the map

```bash
npm run code-map -- <project folder> --tokens 8000 --out /tmp/map.txt
```

It prints how many files and definitions the project has, how big the map is,
and the highest-ranked definitions that did not fit.

## 3. Run

```bash
npm run code-map:run -- --key scripts/code-map/questions/civly-coding-platform.json
npm run code-map:run -- --key <private key outside the repo>
```

Defaults: all four assistants, two repeats (to measure run-to-run noise), an
8,000-token map, 15 minutes per run, each CLI's own default model
(`--model claude=claude-opus-5-5` picks one). The assistants run side by side,
one chat at a time each. 30 questions take 480 runs per codebase
(4 assistants, with and without the map, twice).

Each run gets a clean copy of the codebase at the key's commit, with no git
history and no answer key in it. Claude's read requests are allowed and
anything that could change a file is turned down; a run that changes the copy
anyway is undone before the next one and noted in its record.

Results go to `~/.coding-plan-hub/code-map/results/<codebase>-<time>/`:
`runs.jsonl` (one line per run, with the full answer), `map.txt`,
`map-report.json`, `run-info.json`, and `report.md`. Run again with
`--out <that folder>` to continue where it stopped; add `--retry-failed` to
rerun failed runs. An assistant that fails three runs in a row (a plan limit,
a lost login) is stopped.

`--allow-unchecked` runs a key that is not fully checked, for trying the
runner. Those runs are marked as a trial and the report says they do not
count.

## 4. Read the results

The automatic grade only looks for the required terms. Read the answers in
`runs.jsonl`, and where the grade is wrong, record your call in `grades.json`
next to it: `{ "<runId>": true }`. Then rebuild the report, for one codebase
or both together:

```bash
npm run code-map:run -- --report <results folder> [<another results folder>]
```

The table shows, per assistant and with and without the map: wrong answers
(failed runs count as wrong), the wrong-answer rate of each repeat, median
time, median tokens (input including cached reads, plus output), and median
files opened (the Read tool and shell read commands like `cat` and
`sed -n`).

**Go or no-go.** Run-to-run noise is how far the wrong-answer rate moved
between repeats of the same setup. A change is a go when accuracy holds
(wrong answers do not rise by more than that noise) and it costs less. Cost
is Claude's own estimate at API list prices, where a cached token counts a
tenth of a fresh one, so it tracks plan use better than raw tokens; tokens
stand in for engines that report no cost.

## Other setups

`--compare lean` runs the same questions on Claude as the app starts it
against Claude with only the app's browser connected and no skills or slash
commands (`--assistants` defaults to claude). That test is why the app has
lean Claude chats: about 31% cheaper per answer with the same accuracy, on
this repo and a large private codebase.

## Known gaps

- Gemini prints plain text, so its runs have no token count and no files
  opened. Right or wrong and time still count.
- Kimi does not print token counts; the runner reads them from Kimi's session
  log in `~/.kimi-code/sessions`.
- The token count of the map itself is an estimate (3.5 characters a token).
  The runs record the real token use.
