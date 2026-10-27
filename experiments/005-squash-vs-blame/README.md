# 005: what a squash merge costs `git blame`

## Problem

Squash-and-merge is the default in most organisations because it keeps `main` readable. The known price is attribution: GitHub's own discussion of the request says a squash "discards the original commits", so blame shows the squashing commit rather than the original one ([community#38240](https://github.com/orgs/community/discussions/38240)). Every write-up stops there, at "you lose the history", and leaves the question that decides a policy: what does it cost in seconds, and on which lines?

The published numbers are for big repositories only — Homebrew's 150k commits, 4,000 files, `git blame` taking 45 s on one file ([Stack Overflow](https://stackoverflow.com/questions/57837986/speed-up-git-blame-on-repository-with-many-commits)) — which says blame walks commits that touch the path, and says nothing about what collapse does to that walk.

## Hypothesis

Collapsing 25 commits per branch will make a full-file `git blame` at least 3× faster, because blame walks commits that touched the path and those fall from ~650 to ~27. It will also make each blamed commit's diff 5× larger, so any line whose story is inside a branch answers "which commit" correctly and "which change" not at all — and that second loss is where the cost of squash lives.

Decision it changes: whether a repository that merges squash-only has a reason to switch, and what to say when someone asks "won't this ruin blame?".

## Method

Two synthetic histories, same final tree, built with `git fast-import` and checked equal by tree hash: 8 files of 400 lines, 5,000 commits.

- **linear** — 5,001 commits, one per change, one changed line each.
- **squashed** — 201 commits: an `init` plus 200 branches of 25 changes each, one commit per branch.

Two distributions, because a single shape would make the granularity number true by construction:

- **block** — every branch re-edits the same 5 lines (a 25-commit iteration on one function), so each of those lines has 5 changes inside one commit.
- **mixed** — every second branch touches 25 distinct lines instead, so half the branches hide repeated edits and half hide nothing.

Both repos are packed (`git gc`) and given a commit-graph, so blame uses the changed-path Bloom filters git 2.27 added for it. Measured per repo: full-file `git blame --line-porcelain` on `src/mod00.ts`, one-line blame at the same fixed line in both histories, commits touching that path, lines changed per commit, `.git` size, and — from the generator's own record of every revision — how many lines now resolve to a commit that changed that line more than once.

Three rounds of five runs each, alternating order (15 timings per cell). Host: 6 vCPU sandbox, git 2.47.3.

## Results

Medians, 15 runs; spread is max−min.

| | linear | squashed | ratio |
|---|---:|---:|---:|
| Commits | 5,001 | 201 | 25× fewer |
| Commits touching `src/mod00.ts` | 651 | 27 | 24× fewer |
| Blame, whole file (block) | 63.06 ms (62.54–65.02) | 9.54 ms (9.34–10.69) | **6.61× faster** |
| Blame, whole file (mixed) | 71.37 ms (70.88–72.08) | 12.03 ms (11.92–12.23) | **5.93× faster** |
| Blame, one line (block) | 4.21 ms | 3.95 ms | 1.07× — inside noise |
| Blame, one line (mixed) | 4.37 ms | 4.32 ms | 1.01× — inside noise |
| Lines changed per blamed commit | 2 | 10 (block) / 50 (scattered) | 5× / 25× |
| `.git` size | 2,368 KB | 280 KB | 8.5× smaller |
| Lines whose origin is a multi-change commit | 0 | 50 of 50 (block), 45 of 70 (mixed) | — |

- Noise floor: block-mode spread is 2.5 ms on a 63 ms median (3.9%); single-line spread is 0.27 ms on a 4.2 ms median (6.4%). The 53 ms blame gap is 21× the spread. The single-line difference (0.26 ms) is smaller than the 0.29 ms spread of the same command, so it is not a result.
- One-line blame is 4 ms in both histories because that is git's own startup: the walk is not the cost at that size.
- Blame never named the wrong commit in either repo — 0 mismatches against the generator's record in both linear and squashed. The loss is coarseness, not error: the commit is right, its diff covers 5 or 25 changes.
- The whole-file speedup comes from the walk, not the packfile: both repos are packed and commit-graphed. The ratio is sublinear — 24× fewer path commits, 6.6× less time — and part of that gap is the ~4 ms floor of starting git, which shows up as the one-line cell.

## Verdict: PARTIAL

The 3× prediction was beaten — 6.6× — and the mechanism was the predicted one. What I got wrong is where the cost sits. I expected squash to hurt the latency of the question "who changed this line"; it does not, because at one line git spends 4 ms starting up whether the history is 27 commits deep or 651. Squash makes blame *faster and cheaper*, and moves the cost to a question blame cannot answer at all: which of the five changes inside that commit is this line.

### What worked

- The prediction that blame scales with commits touching the path, not total commits, held: 651 → 27 path commits, 24× fewer, 6.6× less time.
- Checking tree equality turned a silent bug into a finding: the squashed history was imported from a stale stream file, so the mixed-mode repo held block-mode content. The tree hashes disagreed and the run stopped being trustworthy before any number was written down.
- Building both distributions was necessary. Block mode reports 100% of lines hidden, which is the design, not a finding; mixed mode reports 64%, which is a number a repository could plausibly have.

### What didn't

- My framing of the cost as latency was wrong, and the harness proves it: the one-line cells showed no difference in either mode.
- The 8.5× smaller `.git` is real but inflated by the fixture — 5,000 near-identical blobs of one file compress well, and a real repository's pack would not shrink that much.
- One file of eight is the sample. A branch that touches one file per commit would look different from a branch that touches ten, and the ratio here depends entirely on 25 commits collapsing into one path-touching commit.

### Surprises

- Squashing is the *cheap* option for blame, not the expensive one. The trade is legibility of history against speed of reading it, and at these sizes nobody would notice either.
- 651 path commits give 63 ms — about 0.1 ms per commit walked, which is the number to extrapolate with. Homebrew's 45 s is a different regime, where 150k commits touch one path.

### Recommendation for the real build

- Do not argue squash vs rebase on blame latency. At 651 commits touching a file it is 63 ms vs 10 ms, and at 27 commits the difference is under a tenth of a second.
- Argue it on the diff you have to read: a squashed commit hides 5 changes per line in an iterating branch. Keep the pull-request number in the commit body, because that is the only pointer back to which change did what.
- Rebase-only buys one commit per change and leaves blame 6× slower on a whole file — the price of the granularity, not a defect.
