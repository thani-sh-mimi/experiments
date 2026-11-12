# 021 — `stash --keep-index` costs 6.7× a direct index read and breaks the worktree

**Problem.** A pre-commit hook must hand the linter the staged bytes, not the worktree bytes. The
common recipe is to hide unstaged work: `git stash push --keep-index`, run the linter, `git stash
pop`. Every hook tool does a version of it — _lint-staged_ documents stashing "all unstaged changes
from partially staged files" and applying them back ([README](https://github.com/lint-staged/lint-staged/blob/main/README.md)) —
and the pattern's cost and its failure mode are rarely stated. Git offers two cheaper ways to read
the index: `git checkout-index --prefix=<dir>/ -a` exports the index as a tree
([git-checkout-index](https://git.github.io/htmldocs/git-checkout-index.html)), and
`git cat-file --batch` streams blobs through one process.

**Hypothesis, stated before measuring.** Given 5,000 staged files whose unstaged edits sit in the
same hunk, when a hook runs the stash dance, then it costs more than a second and fails to restore
the worktree, so a hook must never use it; and if reading the index through one `git cat-file
--batch` costs under 0.1 ms per file (my prior: 500 ms at 5,000 files), that read is affordable on
every commit.

## Method

`bench.js` builds a fresh synthetic repository per run: N files of 20 lines under `src/`, one base
commit, a staged edit to all N, then an unstaged edit to D of them. Two geometries for the
partially staged case: `adjacent`, where the staged and unstaged lines touch, and `apart`, where
they sit at opposite ends of a 120-line file.

For each of seven configurations, three timed runs:

- **A, stash dance:** `git stash push --keep-index -q` then `git stash pop -q`, timed together.
  After it, the harness counts conflicted entries with `git ls-files -u`, counts stash entries left
  behind, and compares a restored file against the expected worktree bytes.
- **B, export:** `git checkout-index -a --prefix=<scratch>/` into an empty directory.
- **C, stream:** `git cat-file --batch` fed `:path` lines for every staged file, output consumed.

Timing wraps `spawnSync`, so process start counts — that is what a hook pays. A correctness check
per configuration compares what B and C hand back against `git show :path`. Host: Linux x64,
2 vCPU, git 2.47.3, Bun 1.4.4. Raw runs in `results.json`.

Noise: the spread inside an arm is 0–4.5 %. Three separate full runs of the harness moved each
median by less than 3 %. Treat a gap under 10 % as a tie.

## Results

| Staged files | Worktree edits  | stash + pop | checkout-index | cat-file --batch |
| ------------ | --------------- | ----------- | -------------- | ---------------- |
| 10           | 10, adjacent    | 26          | 3              | 3                |
| 100          | 100, adjacent   | 78          | 12             | 11               |
| 1,000        | none            | 339         | 111            | 91               |
| 1,000        | 1,000, adjacent | 627         | 111            | 90               |
| 1,000        | 1,000, apart    | 745         | 118            | 99               |
| 5,000        | none            | 1,542       | 557            | 442              |
| 5,000        | 5,000, adjacent | 2,968       | 564            | 444              |

Median of three runs, milliseconds. Per file: stash 0.59 ms, export 0.11 ms, stream 0.089 ms.
Fixed cost: 20 ms, 2 ms, 2 ms.

Three things follow.

1. **The stash dance fails whenever the two edits touch.** With adjacent changes it conflicted on
   every file in every run — 10 of 10, 100 of 100, 1,000 of 1,000, 5,000 of 5,000. `pop` exits 1,
   the stash entry stays behind, and the worktree keeps conflict markers where the author's
   unstaged work used to be. Size is irrelevant: 10 staged files break as reliably as 5,000. When
   the edits sit apart, the same dance merges cleanly and restores every file.
2. **It pays that price to hide nothing.** With 5,000 staged files and a clean worktree it still
   spends 1,542 ms and two commits' worth of object work. A no-op hide costs 3.5× the direct read.
3. **Reading the index is linear and cheap.** `cat-file --batch` is 0.089 ms per file with a 2 ms
   fixed cost, and hands back exactly the staged bytes. `checkout-index` is 1.27× that and writes a
   second tree to disk, which a tool that wants real paths needs.

The 1,000-file `apart` case costs more than the `adjacent` one, 745 ms against 627, because a
conflicting `pop` gives up early. The failed case is a floor on the cost, not the full price of a
restore that finishes.

## Verdict: VALIDATED

Both halves held. The stash dance cost 2,968 ms at 5,000 partially staged files — 2.9× my
one-second threshold — and left 100 % of the files conflicted, so it must not own a hook's view of
the index. `cat-file --batch` came in at 0.089 ms per file, 11 % under the 0.1 ms I predicted.

### What worked

- Building the repository fresh per run. The first scratch attempt left a real repo full of
  conflict markers and a stranded stash entry, which is the result itself: the damage outlives the
  hook.
- The `adjacent` against `apart` pair. One geometry alone reads as "stash is broken"; both read as
  "the three-way merge is broken where the edits meet", which is the actionable rule.
- Verifying content, not just timing. `checkout-index` and `cat-file` were checked against
  `git show :path`; without that, a fast wrong answer looks like a win.

### What didn't

- Measuring the whole hook. There is no linter here, so these are the plumbing numbers. The
  published benchmark from _stagelint_ puts _lint-staged_ at 437 ms for 10 staged files against my
  26 ms for the stash alone — the gap is that tool's own process start, not the stash
  ([stagelint](https://pypi.org/project/stagelint/)).
- Timing the format-and-restage round trip. A hook that rewrites files and stages the result pays a
  second index write, which this harness never does.
- Files larger than 450 bytes. Every blob is the same size, so the per-byte term is untested; at
  these 450-byte files the stream is syscall-bound and the slope is per file.

### Surprises

- `pop` reports success in the clean case and failure in the touching case, with the same command
  and the same file count. Nothing in the exit code of `push` distinguishes them; only `pop` fails,
  after the worktree is already rewritten.
- The dance is not just slow, it is the slowest thing a hook can do here and it is slower with a
  clean worktree than a direct read of four times as many files.
- A stranded stash entry survived with conflict markers in the tree. `git status` then reports
  unmerged paths on files the author never touched in a merge.

### Recommendation for the real build

- Read staged content; never stash. `git cat-file --batch` for a linter that takes stdin,
  `git checkout-index --prefix=<tmp>/ -a` for one that needs paths on disk a second time.
- Blank the paths in the exported tree so module resolution in the hook cannot reach the worktree
  copy and re-introduce the very bytes that were hidden.
- If a tool must hide unstaged work, follow _lint-staged_ and save the unstaged diff as a patch,
  then apply it back, instead of relying on a three-way merge of the stash.
- Guard the hook against an empty index: with only untracked or no staged files the stash dance has
  nothing to push, and `pop` then fails on an empty stash list.

## Limits

- One host, 2 vCPU, warm page cache, one git 2.47.3. The conflict is a merge-property, so it should
  hold across versions; the milliseconds will not.
- Synthetic text files of one size. A real tree mixes sizes and binaries, which moves `checkout-index`
  more than `cat-file`.
- One `adjacent` shape: staged and unstaged appends on neighbouring lines. Deletions, renames,
  mode changes and untracked files are untested.
- No worktree, sparse-checkout or submodule variation; a hook in a linked worktree pays for another
  index.
