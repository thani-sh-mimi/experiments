# 025 — a 1,001-file move becomes delete+add, five times the diff

## Problem

A refactor moves `src/old/` to `src/new/` and edits every file on the way. A
reviewer needs to see the edits, not the whole tree as new code. Git finds the
renames after the fact, and it stops at a limit. Where is that limit, what does
the reviewer see past it, and what does lifting it cost?

## Hypothesis

Renames survive to 1,000 files and collapse to delete+add at 1,001, because the
inexact pass is capped at 1,000² candidate pairs. The review surface then grows
by the whole moved content, and `-l0` restores the renames for under 2 s at
2,000 files. If the collapse is real, a repo-wide move needs a rule; if the fix
is cheap, the rule is `-l0` in the repo config.

## Method

`bench.js` builds one synthetic repo per case: N TypeScript files of 200 lines
under `src/old/`, one commit, then the same files under `src/new/` with 20% of
the lines touched, and a second commit. Only the diff between the two commits
is measured — repository creation is outside the timings.

Cases: N at 100, 900, 1,000, 1,001, 1,500 and 2,000 with the basename changed
(`f0.ts` → `m0.ts`), so the filename heuristic cannot help. Controls: the same
move at 1,200 and 2,500 files with the basename kept; 5-line files at 1,000 and
1,001; a similarity sweep at 100 files with 30%, 49% and 60% of lines touched.

Each variant ran three times on the same commit. Reported value is the median of
`git diff --numstat` wall time; the largest spread over three runs was 13.7 ms on
the 1,000-file case, so differences under ~15 ms are noise. "Diff lines" is
added + deleted lines — what a reviewer reads. Host: 6 vCPU, Linux 6.12, git
2.47.3, Bun 1.4.4.

## Results

Basename changed, 20% of every file edited:

| files | renames | added files | diff lines | default | `-l0` |
| ----: | ------: | ----------: | ---------: | ------: | ----: |
|   100 |     100 |           0 |      8,000 | 67.5 ms | 67.3 ms |
|   900 |     900 |           0 |     72,000 | 2,567 ms | 2,564 ms |
| 1,000 |   1,000 |           0 |     80,000 | 3,130 ms | 3,122 ms |
| 1,001 |       0 |       1,001 |    400,400 |  208 ms | 3,130 ms |
| 1,500 |       0 |       1,500 |    600,000 |  310 ms | 6,923 ms |
| 2,000 |       0 |       2,000 |    800,000 |  416 ms | 12,148 ms |

Controls:

- Basename kept: 1,200 files gave 1,200 renames (96,000 lines, 3,172 ms) and
  2,500 files gave 2,500 renames (200,000 lines, 3,719 ms). No warning at
  either size.
- 5-line files, basename kept: 1,000 files gave 1,000 renames; 1,001 files gave
  0 renames and 1,001 added files. Same cliff, 1/40th the bytes.
- Similarity: at 100 files, 30% of lines touched still gave 100 renames;
  49% gave none, 40,000 diff lines, and `-l0` did not change it.

Derived:

- The cap is 1,000² pairs, not 1,000 files. 1,001² = 1,002,001 exceeds it by
  0.2%, and that is enough to skip the whole pass and print
  `warning: exhaustive rename detection was skipped`.
- Matching costs 3.1 µs per candidate pair: 1,000² ≈ 3.1 s, 2,000² ≈ 12.1 s.
  The cost follows the square, so files are the wrong unit.
- Past the cliff the diff is 5.0× the surface (80,000 → 400,400 lines) and 15×
  faster to produce. The cheap path is the unreadable one.
- `git log --follow` still crossed the move at 2,000 files with the default
  config: it resolves one path at a time, so it never builds the matrix.
- The filename heuristic explains the folklore. Git pairs files that keep their
  basename before the matrix, with no cap, when similarity is at least ~75%. The
  source comment records 76% of Linux renames, 64% of gcc and 89% of WebKit
  keeping the basename, which is why most large moves still look fine.

Every figure is in `results.json` with all raw samples.

## Verdict: PARTIAL

The cliff is real and lands exactly at 1,001, but the second half was wrong:
`-l0` costs 12.1 s at 2,000 files, six times my 2 s prediction. And the cliff
does not exist for a move that keeps basenames.

### What worked

- The pair-count rule predicted the 1,001 boundary to the file, for 200-line
  and 5-line files alike.
- The 5-line control showed the boundary does not depend on file size.
- `-l0` restored every rename at every size measured.

### What didn't

- My 2 s estimate for `-l0` at 2,000 files: it is 12.1 s, quadratic.
- I assumed the limit counted files. It counts the square.

### Surprises

- A 2,500-file move that keeps basenames is free of the limit entirely.
- A 49% line change drops below git's 50% similarity floor before any count
  matters, and no flag brings those renames back.

### Recommendation for the real build

- Move directories and keep the basenames. That is free at any size measured.
- When a move must also rename files, keep each commit under 1,000 files, or
  split the rename into its own commit and review the edits separately.
- Do not put `-l0` in a repo config as a blanket fix: it turns a 2,000-file
  move into a 12 s wait for every diff of that commit.

## Limits

- Synthetic files, one edit pattern, one git version. Similarity scores depend
  on the content, so the 75% heuristic threshold moves with real code.
- Local git only. GitHub caps a pull request diff at 300 files and 20,000
  lines, so a 1,000-file move is not reviewable there whatever git reports.
- Not measured: `git merge` rename limits, `git status`, `diff.renameLimit` as
  a per-repo setting, and blame across the move.

## Sources

- [git-diff: `-M` default 50%, `-l` exhaustive check is O(N²), 0 is unlimited](https://git-scm.com/docs/git-diff/2.43.1)
- [git source, `find_basename_matches` and `too_many_rename_candidates`](https://raw.githubusercontent.com/git/git/v2.47.3/diffcore-rename.c)
- [GitHub repository limits: 300 files, 20,000 lines per diff](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
- [Exact renames are linear, inexact are quadratic and skipped above the default 1,000](https://stackoverflow.com/questions/7830728/warning-on-diff-renamelimit-variable-when-doing-git-push)
