# 023 — a worktree copy costs 31 ms against 2,284 ms for a clone

**Problem.** An agent needs its own checkout of a repository. Three shapes give it one: a linked worktree on the existing clone, a `git clone --shared`, or a full clone over the file transport. Advice aimed at coding agents promises that a worktree is "10 times faster and 80% less disk" ([WorktreeWise](https://www.worktreewise.com/git-worktree/vs-clone)). That compares a worktree with a clone from a remote, which receives every object over the network. A local clone does not copy it: it hardlinks the objects. A measured comparison on git/git found `worktree add` at 826 ms and 58.7 MB against `clone --shared` at 870 ms and 58.9 MB ([fletch.sh, via daily.dev](https://daily.dev/posts/git-worktrees-are-not-an-isolation-boundary-for-coding-agents-6wtsmkivj)). If the checkout dominates, the difference between the shapes is small, and the number worth knowing is what extra history costs.

**Hypothesis, stated before measuring.** Given a 400-file tree and 20,000 commits, when a second copy is added as a linked worktree instead of a clone over the file transport, then it takes under 8% of the wall time and under 25% of the disk, and its time stays flat in history (slope under 0.01 ms per commit) while the clone's slope is above 0.05. If that holds, parallel agent runs share one clone and add a worktree each.

## Method

`bench.js` builds synthetic repositories with `git fast-import`: 400 files of 600 fixed pseudo-random characters, then one commit per changed file, so every commit touches one file. History is swept at 500, 5,000 and 20,000 commits. A second sweep holds 5,000 commits and varies the file count at 100, 400 and 1,200.

Three shapes, three timed runs each, order rotated per run:

- **worktree** — `git worktree add --detach` on the source clone.
- **clone-shared** — `git clone --shared --single-branch`, which borrows the object store through `alternates`.
- **clone-file** — `git clone --no-local --single-branch`, which packs and transfers the objects like a clone from a server.

Each run measures wall time for the copy, `du -sb` on the new directory, and the time to delete it (`git worktree remove --force` or `rm -rf`). Every copy is checked for a clean `git status`, the same `HEAD` as the source, and 400 tracked files. Host: Linux x64, 6 vCPU, git 2.47.3, Bun 1.4.4. Raw runs in `results.json`.

Noise: the largest spread between runs is 12.1 ms on a 1,425 ms median; most are under 2 ms. Treat a gap under 3% as a tie. The 1,200-file comparison is exactly that close.

## Results

400 files, median of three runs:

| Commits | worktree | clone --shared | clone --no-local | Clone disk |
| ------- | -------- | -------------- | ---------------- | ---------- |
| 500     | 31.8 ms  | 34.7 ms        | 124.3 ms         | 865 KiB    |
| 5,000   | 31.0 ms  | 34.1 ms        | 652.9 ms         | 4,534 KiB  |
| 20,000  | 31.4 ms  | 34.2 ms        | 2,284.0 ms       | 16,748 KiB |

Disk at 20,000 commits: worktree 245 KiB, `--shared` 303 KiB, clone 16,748 KiB. The worktree directory holds a `.git` file of about 100 bytes and the checkout, nothing else.

5,000 commits, file-count sweep:

| Files | worktree | clone --shared | clone --no-local |
| ----- | -------- | -------------- | ---------------- |
| 100   | 12.5 ms  | 17.2 ms        | 348.0 ms         |
| 400   | 31.0 ms  | 34.1 ms        | 652.9 ms         |
| 1,200 | 81.2 ms  | 78.6 ms        | 1,425.2 ms       |

Slope from 500 to 20,000 commits: clone 0.111 ms per commit, worktree −0.00003, `--shared` −0.00003. Worktree time follows the checkout at 0.0625 ms per file.

Four things follow.

1. **The worktree was 1.4% of the clone's time and 1.5% of its disk.** Both clauses of the hypothesis held with room to spare. The worktree did not see the history at all: 31.8 ms at 500 commits, 31.4 ms at 20,000.
2. **The clone pays 0.111 ms and 834 bytes per commit.** That is pack generation and indexing at 7.5 MB/s on this host, not a network transfer: the 20,000-commit clone wrote a 16.4 MiB directory that the worktree never touched.
3. **Against `clone --shared`, the worktree is 1.09× faster and 1.24× smaller.** Not 10× and not 80%. At 1,200 files the shared clone was faster by 3%, inside the noise floor. The marketing number only holds against a clone that moves objects.
4. **Five agents at 20,000 commits:** five clones cost 11.4 s and 82 MiB; one clone plus four worktrees costs 2.4 s and 17 MiB. The saving is real and it grows with history, not with the number of agents.

## Verdict: VALIDATED

All four clauses held: 1.4% of the time, 1.5% of the disk, a worktree slope of −0.00003 ms per commit against 0.111 for the clone. The decision it aimed at stands, with one condition attached. A worktree shares hooks, config, refs and the stash with the parent repository, so an agent that writes outside its own tree writes into every agent's tree ([fletch.sh](https://daily.dev/posts/git-worktrees-are-not-an-isolation-boundary-for-coding-agents-6wtsmkivj)). `clone --shared` costs 9% more time and 24% more disk and keeps those files separate.

### What worked

- The history sweep. One point at 20,000 commits shows a large gap; three points show that the gap is a slope of 0.111 ms per commit and that the worktree is flat.
- Measuring the teardown. A worktree is 11.0 ms to remove against 7.8 ms to `rm -rf` a shared clone, so a create-and-destroy loop is 1.4× slower per cycle than the setup numbers alone suggest.
- The sanity checks after every copy. A `HEAD` mismatch or a stray untracked file would have failed the run instead of flattering a number.

### What didn't

- No network. Both clones ran over a local file transport. A clone from a server adds the transfer of the same 16.4 MiB: 2.7 s at 50 Mbit/s by arithmetic, not measured here.
- No large working tree. Files are 600 bytes each, so a worktree costs 0.167 KiB per file. A monorepo with 58 MB of checkout would make the worktree's disk share much larger.
- No `.git` growth in the source, no LFS, no submodules, no untracked or ignored files in the source tree.

### Surprises

- `git worktree add` was not faster than `git clone --shared` at every size. At 1,200 files it was slower, because a shared clone writes its index without consulting the main worktree's admin files.
- Removing a worktree costs more than deleting a directory: 11.0 ms against 7.8 ms, a 41% tax on the teardown half of an agent's cycle.
- The `--shared` clone's 303 KiB is mostly its own index and config, not objects. Its disk cost does not grow with history either, so the 245 KiB against 303 KiB gap belongs to setup, not to history.

### Recommendation for the real build

- **Parallel agent runs on one machine: one clone, then a worktree per agent.** Setup drops from 2.3 s to 32 ms at 20,000 commits, and each agent adds 245 KiB instead of 16.4 MiB.
- **Use `clone --shared` instead when agents run untrusted code.** It costs 9% more time, isolates hooks, config and the stash, and still ignores history. Add `--dissociate` before deleting the source, or the borrowed objects go with it.
- **Budget the teardown too.** `git worktree remove` costs 11 ms, and a stale worktree stays in `git worktree list` until `git worktree prune` removes it.
- **Do not quote 10×.** Against a local clone the honest number is 1.09× on time and 1.24× on disk.

## Limits

- One host, one filesystem, warm page cache, git 2.47.3. The 0.111 ms per commit belongs to this machine's pack compression.
- Synthetic history: one small text file per commit, 834 stored bytes per commit. A repository with larger diffs scales the clone's time and disk linearly and leaves the worktree where it is.
- Disk is `du -sb` apparent size, so a 400-file checkout reads as 245 KiB where a block-based measurement would report 4 KiB per file.
- The clone arms ran `--single-branch` on a repository with one branch anyway; a repository with many refs pays more.
- Worktrees and clones differ in ways this harness cannot see: a worktree cannot check out a branch that another worktree holds, and a clone keeps its own remotes.
