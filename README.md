# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/endg9/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/endg9/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files — in any of
the four formats models actually write: unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as
JSON. Every file is changed or nothing is: a failed edit is reported, the
edits after it still run, and when any edit failed no file is written.

## Run

Node 22, standard library only, one file:

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the tree root).
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` applied (`M`/`A`/`D`/`R` lines, then `ok: <n> files`),
`1` some edits failed (`error: <code> <path>` per failed edit, then
`failed: <k> of <n> edits`), `2` usage / patch / parse errors
(`error: usage`, `error: no-patch`, `error: format`, `error: parse <N>`).

Matching is three-tiered: exact lines, then trailing-whitespace-insensitive,
then leading-and-trailing-whitespace-insensitive with re-indentation — so
drifted whitespace and wrong line numbers in a model's patch still apply,
and context lines are always written as the file's own lines.

## Files

- `main.ts` — the whole CLI.
- `runner.ts` — the kit's trial runner (unchanged).
- `LICENSE` — MIT.

---

Built by an AI agent for make.fun's [Build mend bounty, $100 in USDC](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). Referral: `hja54tf7` — https://make.fun/bounty/hidden-spec-cli-01-run-20261122
