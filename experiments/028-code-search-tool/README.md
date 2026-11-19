# 028 — `git grep` matches ripgrep on a 20k-file repo, and GNU grep costs 4×

## Problem

An agent searches a repository dozens of times per session: find a symbol, find
a caller, find a config key. Each search is a process that walks a tree and
reads it. The benchmark everyone quotes comes from the Linux kernel, where
`rg` finished in 0.082 s, `git grep -P` in 0.273 s and GNU grep in 0.674 s.
That tree is the Linux kernel after a build, and the numbers say nothing about a
20k-file TypeScript repository that an agent works in.

So: how far apart are `rg`, `git grep` and `grep -r` on a repo-sized tree in
page cache, and does the winning tool earn a new dependency?

## Hypothesis

Written before the first run: on a 20k-file repo in page cache, GNU `grep -r`
costs at least 3× ripgrep's time on a full scan, and `git grep` lands within
1.5× of ripgrep. If so, the search an agent runs should be `rg` or `git grep`
and never a bare `grep -r`, but `git grep` alone is enough — it is already
installed wherever git is, at 65 ms per search either way.

## Method

`bench.js` generates 20,002 TypeScript files under `/tmp/spike-028/repo`
(40 lines each, 69 MiB, nested four levels deep), adds 2,000 more under
`dist/` covered by `.gitignore`, commits the tracked set, and runs `git gc`
once. Four cases:

- **rare** — `ZEBRA_QUARRY` in a comment in 50 files, so no tool exits early.
- **absent** — a token in no file: the full scan with nothing to print.
- **walk** — the directory walk alone, no search.
- **onefile** — one query against one 1.5 KB file, where start-up dominates.

GNU grep runs twice: `grep -rnI --exclude-dir` on the tracked set only ("fair")
and `grep -rnI` over everything including `dist/` ("naive", what an agent types).
A fifth variant gives grep a file list from `git ls-files`, to take the walk out
of its cost. Three runs per command; the table reports medians.

Noise floor: the fastest command repeated ten times spread 63.0–66.2 ms around
a 64.3 ms median, about ±3 %. Whole-harness repeats moved a median by up to
2.3 ms (±4 %). Host: 6 vCPU, Linux 6.12, ext4 in a container, rg 14.1.1, GNU
grep 3.11, git 2.47.3. Every run was warm: `/proc/sys/vm/drop_caches` is
read-only here, so a cold cache could not be tested.

## Results

Median of three runs, milliseconds:

| tool                        | rare (50 hits) | absent | ratio, absent |
| --------------------------- | -------------- | ------ | ------------- |
| `rg -n`                     | 66.1           | 66.7   | 1.00×         |
| `git grep -n`               | 63.4           | 60.9   | 0.91×         |
| `grep -rnI` (fair)          | 251.5          | 266.5  | 4.00×         |
| `grep -rnI` (naive)         | 272.1          | 292.7  | 4.39×         |
| `grep -nI` + `git ls-files` | 221.0          | 237.0  | 3.55×         |

`git grep` printed 50 lines and `rg` 50; the naive grep printed 55, because it
also searched the 2,000 ignored files in `dist/`.

The walk, with nothing searched: `git ls-files -z` 8.0 ms, `rg --files` 26.4 ms,
`find` 71.4 ms. One file only: `grep` 1.73 ms, `rg` 3.54 ms, `git grep` 7.75 ms.
Start-up alone (`--version`) is 1.6–1.9 ms for all three.

Untracked file: one scratch file with the token was visible to `rg` (51 hits),
`grep` (51) and `git grep --untracked` (51), but not to plain `git grep` (50).

## Verdict: VALIDATED

### What worked

- `git grep` came in at 0.91× ripgrep — inside the ±4 % noise, so a dead heat,
  and well inside the 1.5× the hypothesis allowed. It reads the file list from
  the index (8.0 ms) instead of walking the tree, which is the whole reason.
- GNU grep cost 3.6× to 4.4×, above the 3× the hypothesis required.
- The win is real at repo scale, not only on the kernel: 66 ms against 267 ms,
  and 40 searches a session come to 2.7 s against 10.7 s.

### What didn't

- The published gap did not reproduce. The kernel benchmark shows 8.2× for GNU
  grep against rg; here it is 4.0×. Removing the walk from grep only recovered
  11 % (267 → 237 ms), so the cost is its match loop, not the traversal — but a
  20k-file tree of 3 KB files is simply easier on grep than the kernel tree.
- `rg` was not the fastest tool on a single file: 3.54 ms against grep's 1.73 ms,
  since it pays about 2 ms of fixed cost per launch. `git grep` costs 6 ms more
  than grep there, and most of that is finding the repository.

### Surprises

- Walking the tree with `find` costs 71.4 ms, more than ripgrep's entire search
  (66.7 ms). Ripgrep overlaps the walk with matching across threads; GNU grep
  does one, then the other, and pays twice.
- `git grep` silently misses untracked files. That matters for an agent, which
  writes a scratch file and then searches for it: the index is the file list.

### Recommendation for the real build

- Use `rg` as the default search: it respects `.gitignore` by default, sees
  untracked files, and has the type filters. Keep `git grep` for a repo where
  ripgrep is not installed — the time cost is zero.
- Never default to `grep -r`. It costs 4× and it reads `dist/` and `.git`.
- Do not narrow `git grep` to tracked files only when scratch files are in play;
  pass `--untracked` or use `rg`.

## Limits

All runs were warm-cache; a cold first search is unmeasured and would follow
the bytes read rather than these ratios. The corpus is synthetic, uniform, and
ASCII: no long lines, no minified bundles, no binary files, no large files that
favour a memory map. Only literal patterns ran — a regex with alternation or
Unicode classes moves the engines apart differently, and ripgrep's own numbers
show its Unicode advantage growing there. One tree size, one machine, three runs.

## Sources

- [ripgrep README, code search benchmarks](https://github.com/BurntSushi/ripgrep)
  — Linux kernel: rg 0.082 s, `git grep -P` 0.273 s, `git grep -E` (C locale)
  0.727 s, GNU grep 0.674 s.
- [ripgrep is faster than {grep, ag, git grep, ucg, pt, sift}](https://burntsushi.net/ripgrep/)
  — `git grep` skips the directory walk by reading the index; for plain literals
  in large repositories, ucg, `git grep` and `rg` are "pretty evenly matched";
  memory maps make multi-file search slower, not faster.
