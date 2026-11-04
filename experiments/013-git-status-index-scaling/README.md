# 013 — What `git status` costs a hook as a repo grows to 100,000 files

**Problem.** A pre-commit hook has about one second. 003 priced the formatter inside that
budget; this prices the step every hook runs first, `git status`. Monorepos reach 100,000
tracked files, and the advice online is "use `-uno`" or "turn on the untracked cache"
without a number attached to either. A hook that spends half its budget listing files
that did not change is the wrong hook.

**Hypothesis, stated before measuring.** `git status --porcelain` on a clean, warm tree
costs at most 6 µs per tracked file, so a 50,000-file repo answers under 300 ms and a
hook can call it unmodified. Second clause: with untracked files present, `-uall` costs
at least 3× `-unormal`, because it discards the untracked cache. The decision: if the
first holds, keep `git status` in the hook and drop `-uno` from our templates; if the
second holds, ban `-uall` in tooling.

## Method

`bench.js` builds four synthetic repos of 1k, 10k, 50k and 100k files, each in 100
directories, and commits them. Every mode gets two warm-up calls and five timed calls
of a fresh `git` process, three sessions in total, so each number is the median of 15
timings. `GIT_TRACE2_PERF=1` splits the total into `preload` (the `lstat` of every index
entry), `read_directory` (the untracked walk) and `refresh`.

A fifth repo of 100,000 tracked files also holds 10,000 untracked files in 100
directories, measured with the untracked cache off and on. Host: Linux x64, 6 vCPU,
ext4, warm page cache, git 2.47.3. Raw runs in `results.json`.

Noise: single timings vary up to 38 % on this shared VM, but the 15-sample median moves
at most 4.4 % between sessions. Treat differences under 10 % as equal.

## Results

Milliseconds for one `git` process, medians:

| Tracked files | `status --porcelain` | `-uno` | `-uall` | `diff --cached` | `ls-files -m` |
|---------------|----------------------|--------|---------|-----------------|---------------|
| 1,000         | 6.66                 | 4.81   | 6.67    | 2.55            | 5.05          |
| 10,000        | 19.6                 | 13.9   | 20.8    | 3.90            | 33.1          |
| 50,000        | 103.9                | 94.5   | 110.3   | 7.77            | 156.3         |
| 100,000       | 217.0                | 188.7  | 217.8   | 12.4            | 309.2         |

Above 10,000 files the cost is linear at **2.20 µs per tracked file** (least squares,
intercept −3.6 ms). The `git --version` floor is 1.64 ms.

Where the 217 ms at 100k goes: `preload` 124.7 ms, `read_directory` 74.1 ms, reading
the index 7.7 ms, `refresh` 2.4 ms.

Untracked-heavy repo, 100k tracked plus 10k untracked, milliseconds:

| Untracked cache | `-unormal` | `-uall` | `read_directory` normal | `read_directory` all |
|-----------------|------------|---------|--------------------------|-----------------------|
| off             | 215.8      | 235.3   | 67.6                     | 78.7                  |
| on              | 189.9      | 236.1   | 7.3                      | 129.7                 |

## Verdict: PARTIAL

### What worked

- The first clause held. 2.05 µs per file at 50k is 104 ms, one third of the 300 ms I
  predicted, and 21.7 % of a one-second budget at 100k.
- The untracked cache is real and measurable: it cuts `read_directory` from 67.6 ms to
  7.3 ms, 9.2×, and the whole command by 12 %.

### What didn't

- `-uall` is not 3× slower than `-unormal`; it is 1.09× with the cache off and 1.24×
  with it on. The published 50× figure is a property of `read_directory` alone, in a
  repo where that region dominates.
- `-uno` saved only 13 % at 100k (217.0 → 188.7 ms). It skips the walk but every call
  still `lstat`s all 100,000 index entries, and that is 57 % of the time.

### Surprises

- `git ls-files -m` is 1.42× slower than `git status` at 100k, though it answers a
  smaller question. The "cheaper command" I would have reached for is the costly one.
- `git diff --cached --name-only` costs 12.4 ms at 100k, 17.5× cheaper than `status`,
  and it grows at 0.1 µs per file, not 2.2. It reads the index and compares trees; it
  never touches the worktree.

### Recommendation for the real build

- A pre-commit hook that needs staged paths calls `git diff --cached --name-only
  --diff-filter=ACMR`, never `git status`. 12 ms against 217 ms at 100k.
- Do not use `-uno` as the fix; it buys 13 %. Do not use `ls-files -m`.
- Set `core.untrackedCache=true`: at 100k it takes 12 % off every status call, and
  enabling it is one `git update-index --untracked-cache`. Keep `-uall` for display only.
- A one-second budget breaks at **about 457,000 tracked files** for plain `status`.
  Below 200k, `status` is safe to call once per hook.

## Limits

Synthetic 30-byte files in a 100×N layout, warm page cache, no `node_modules` inside
the repo, no fsmonitor, one host and one filesystem. A cold cache or NFS changes the
`lstat` cost by an order of magnitude; the gist linked below reports 16 s for 19k files
cold against 0.18 s warm. Filenames in one flat directory would make `read_directory`
worse than measured here.

Sources read: [git-status documentation](https://git-scm.com/docs/git-status),
[a 19k-file warm/cold measurement](https://gist.github.com/LucaColonnello/75e82e908d4d0445e55d671b271d01cb),
[a 61k-file field report on `-uall` and the untracked cache](https://github.com/superset-sh/superset/issues/6004).
