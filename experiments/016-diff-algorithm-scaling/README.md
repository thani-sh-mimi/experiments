# 016 — Does a better diff algorithm stay free as the file grows?

**Problem.** `git diff` defaults to Myers. Advice on the web says switch to
`diff.algorithm=histogram` for readable diffs, and the one large study says histogram is the
better diff in 62.6 % of source files against 16.9 % for Myers
([Springer, EMSE 2020](https://link.springer.com/article/10.1007/s10664-019-09772-z)). The
same study's runtime data comes from small real commits: every algorithm under 0.5 ms at the
95th percentile, so time cannot separate them there
([thesis, §6](https://ar5iv.labs.arxiv.org/html/2507.22071)). Git's own perf suite found
histogram "slightly" faster than Myers and patience "much slower"
([commit 85551232](https://github.com/git/git/commit/85551232)). None of that answers the
question a monorepo asks: on a 30,000-line generated file in a pre-commit hook, does a
non-default algorithm cost seconds, and does it buy fewer hunks?

**Hypothesis, stated before measuring.** Given a 96,000-line file, when diffed with
`histogram` or `patience`, then the diff finishes under 120 ms — twice the default — and
shows no more hunks than Myers. The decision: if both hold, the repo sets
`diff.algorithm=histogram` once and stops thinking about it; if the hunk count grows, the
default stays.

## Method

`bench.js` writes pairs of files and runs `git diff --no-index -U3` on them, one algorithm
at a time. Each timing is the median of three runs after one warm-up; the 2.2 ms cost of
spawning git is measured separately and subtracted for the net column.

Three shapes:

- **source** — 2 k, 8 k, 32 k and 96 k lines of TypeScript-like blocks, edited the way a
  branch edits them: 2 % of lines changed in place, 24 blocks of 20 lines moved, 15 runs
  deleted, 30 runs inserted.
- **records** — 8 k and 32 k lines of generated JSON with five repeated line shapes, and a
  minimal edit: one value changed, one line deleted. This is where the algorithms are
  allowed to disagree.
- **probes** — 4 k-line adversarial shapes: one line changed inside 100 identical blocks, a
  200-line block moved 4,000 lines down, one duplicated chunk deleted, JSON with heavy
  brace repetition.

Host: Linux x64, 6 vCPU (i5-9500T), warm page cache, git 2.47.3, Bun 1.4.4. Raw runs in
`results.json`.

Noise: run-to-run spread is 0.9 ms or less on every arm but one (1.9 ms, histogram on the
moved block); treat differences under 1 ms as equal.

## Results

Wall time per diff, median of three. Bold is the default.

| Lines        | Bytes   | Myers       | minimal | histogram | patience |
| ------------ | ------- | ----------- | ------- | --------- | -------- |
| 2 k          | 45 KB   | **5.6 ms**  | 6.1     | 4.1       | 4.0      |
| 8 k          | 174 KB  | **9.2 ms**  | 10.3    | 7.7       | 7.3      |
| 32 k         | 697 KB  | **22.5 ms** | 24.8    | 21.3      | 19.9     |
| 96 k         | 2.09 MB | **60.2 ms** | 68.7    | 60.8      | 54.0     |
| records 8 k  | 102 KB  | **5.9 ms**  | 5.9     | 7.3       | 7.4      |
| records 32 k | 406 KB  | **15.5 ms** | 15.3    | 21.2      | 21.2     |

At 96,000 lines the whole file costs 60 ms, 0.63 µs per line. Every algorithm is inside
1.15× of Myers there, and patience — the one the git commit calls "much slower" — is 10 %
faster. The worst case anywhere is histogram on repeated JSON, 1.37× Myers, 5.7 ms.

Hunks and changed lines, same runs:

| Shape           | hunks: myers / minimal / histogram / patience | churn (added + removed)   |
| --------------- | --------------------------------------------- | ------------------------- |
| source 2 k      | 53 / 54 / 58 / 58                             | 937 / 911 / 955 / 951     |
| source 8 k      | 119 / 119 / 120 / 120                         | 1113 / 1089 / 1099 / 1099 |
| source 32 k     | 236 for all                                   | 1416 / 1374 / 1374 / 1374 |
| source 96 k     | 657 for all                                   | 2268 for all              |
| records, probes | identical across all four                     | identical across all four |

## Verdict: PARTIAL

### What worked

- The time half held with room to spare: 60.8 ms and 54.0 ms at 96,000 lines, against a
  120 ms bound. No algorithm turns a hook into a wait at any size measured.
- Decomposition is clean: cost grows about linearly, 5.6 ms at 2 k to 60 ms at 96 k, of
  which 2.2 ms is the `git` process itself.

### What didn't

- The quality half. Histogram never produced fewer hunks than the default: it produced 58
  against 53 at 2 k lines, 120 against 119 at 8 k, and tied everywhere else. On a
  2,000-line file, switching to histogram adds 5 hunks and 18 changed lines for free.
- The folklore that patience is slow. It was the fastest algorithm at 32 k and 96 k lines,
  and the slowest only on repeated JSON, by 5.7 ms.

### Surprises

- Repetition does not make the algorithms disagree: 32,000 lines of near-identical JSON,
  one value changed, one line deleted, and all four produce the same 2 hunks and 3 changed
  lines. The textbook ambiguous shape was the most boring one.
- `minimal` is not a quality floor worth paying for: it found the smallest churn at 2 k and
  8 k (911 against 937) at the cost of one extra hunk, and cost the most time at 96 k.
- Git does not detect moves, so the 200-line block moved 4,000 lines down is 400 changed
  lines in every algorithm. That is 2 hunks no matter which one you pick.

### Recommendation for the real build

- Leave `diff.algorithm` at the default. This data gives no measured reason to set it, and
  one measured reason not to (five extra hunks at 2 k lines).
- Price a diff by line count, not by algorithm: 0.63 µs per line means a 30 k-line file is
  19 ms, well inside any hook budget.
- If a diff ever needs the faster path, `--diff-algorithm=histogram` is the wrong lever.
  Rendering thousands of hunks, not computing them, is what a reviewer waits on.

## Limits

- Synthetic content. The source generator repeats seven-line blocks, so its ambiguity is not
  real code's; the study's 62.6 % finding is on real repositories and nothing here refutes
  it, only that it did not reproduce on shapes I could generate.
- `--no-index` on plain files: no rename detection, no `.gitattributes` filters, no word
  diff. A real `git diff` in a repository adds index work, which experiment 013 priced.
- Three runs per arm, 6 shared vCPUs, warm cache. Differences under 1 ms are not real.
- One edit shape per probe; a pathological case built on purpose would likely show a
  divergence this set does not.
