# 018 — What does `--coverage` cost `bun test`?

**Problem.** Coverage is the first thing a developer turns off when a suite feels slow. The
published numbers come from Istanbul-style tools that rewrite every file with counters:
on a 285-file Vitest suite, Istanbul coverage added 50 % wall time and 38 % CPU
([TanStack/db #2274](https://github.com/TanStack/db/issues/2274)), and on a 480-test
CommonJS fixture `nyc` went from 1.7 s to 7.4 s (+335 %) while V8-based `c8` went to 4.2 s
(+147 %) ([c8 vs nyc](https://www.shoppercove.com/blog/c8-vs-nyc)). Bun's own docs warn that
"for large projects, coverage collection can slow down tests" and suggest running coverage
only on CI ([Bun docs](https://bun.com/docs/test/code-coverage)). Bun instruments natively
in JavaScriptCore, so the number could be much smaller — but nobody publishes it, and the
Bun docs give no figure.

**Hypothesis, stated before measuring.** Given an 800-file Bun suite, when run with
`--coverage`, then the run takes under 15 % longer than without it — less than a third of
Istanbul's 50 % — so `coverage = true` in `bunfig.toml` is affordable on every local run
instead of CI-only. If it lands over 30 %, coverage moves to CI and the local default stays
off.

## Method

`bench.js` writes a synthetic suite: N modules of about 45 lines each (interfaces, loops,
`switch`, guards) and one test file per module with five tests that call every function.
Sizes 50, 200 and 800 files, 4,000 tests at the top size. Arms:

- `plain` — `bun test`
- `coverage-text` — `--coverage` (the default text table)
- `coverage-text+lcov` — `--coverage-reporter=text --coverage-reporter=lcov`
- `coverage-lcov` — `--coverage-reporter=lcov` only
- `coverage-exclude-src` — `--coverage`, with `coveragePathIgnorePatterns = ["lib/**"]`, so
  the coverage machinery runs and reports nothing: prices the subsystem apart from the files.

A second sweep holds the file count at 200 and multiplies how many times the tests execute
the module code (1×, 10×, 100×, 400×). If coverage costs something per executed statement,
that sweep separates it from a fixed tax.

Arms run interleaved, one pass per round, five timed rounds after one warm-up round, so a
burst of host noise lands on every arm instead of one. Timing is around `Bun.spawnSync`, so
process start is included. Host: Linux x64, 6 vCPU, Bun 1.4.4, reported as `bun -e ""` 1.8 ms.
Raw runs in `results-main.json` and `results-work.json`.

Noise: spreads run 0.6–10.7 %, most under 6 %; the widest belong to the 50-file arms where
the absolute difference is under 1 ms. Treat a gap under 5 % as a tie. The 800-file `plain`
and `coverage-text` arms reproduced inside 0.6 % in a second session, and the first session's
sequential (non-interleaved) medians sat within 1.1 % of these.

## Results

Wall time per run, median of five, milliseconds, with the change against `plain`.

| Files | plain     | coverage (text)  | +lcov            | lcov only        | exclude source   |
| ----- | --------- | ---------------- | ---------------- | ---------------- | ---------------- |
| 50    | **67.1**  | 71.2 (+6.1 %)    | 72.2 (+7.6 %)    | 70.8 (+5.5 %)    | 69.9 (+4.2 %)    |
| 200   | **240.0** | 258.1 (+7.5 %)   | 258.2 (+7.6 %)   | 256.9 (+7.0 %)   | 255.8 (+6.6 %)   |
| 800   | **959.7** | 1,026.9 (+7.0 %) | 1,038.8 (+8.2 %) | 1,030.9 (+7.4 %) | 1,016.3 (+5.9 %) |

The tax is about 0.08 ms per test file and does not shrink as the suite grows: 82 µs at 50
files, 90 µs at 200, 84 µs at 800. Most of it is not the source files. Excluding every source
file from the report still costs 5.9 % at 800 files, so the coverage subsystem's own startup
and per-file bookkeeping are 84 % of the total. Reporting the 800 source files adds 10.6 ms
(1.1 %) for the text table and about 12 ms (1.2 %) for the lcov file.

Work sweep at 200 files, milliseconds:

| Work | plain     | coverage (text) | Δ              |
| ---- | --------- | --------------- | -------------- |
| 1×   | **240.0** | 258.6           | +18.6 (+7.8 %) |
| 10×  | **275.4** | 290.9           | +15.5 (+5.6 %) |
| 100× | **442.5** | 462.5           | +20.0 (+4.5 %) |
| 400× | **803.8** | 826.2           | +22.4 (+2.8 %) |

The suite gets 3.4× slower across the sweep; the coverage delta moves from 18.6 to 22.4 ms
and stays inside the noise band. It is a fixed cost, not a cost per executed statement.

Output: at 800 files the text table adds 30.7 KB to a 127.5 KB report, and `lcov.info` is
263.9 KB. The lcov file grows with the hit counts, not the source: 64.3 KB at 1× execution,
82.3 KB at 400×, because the counters get longer.

Sanity check on accuracy: a hand-written module with two functions where one runs reports
50 % functions, 50 % lines, and lists exactly the two uncovered lines.

## Verdict: VALIDATED

### What worked

- The hypothesis held with room: 7.0 % at 800 files against a 15 % ceiling, and 6.1–7.6 % at
  every size. Coverage stays on for local runs.
- Interleaving the arms fixed the measurement. Consecutive per-arm runs produced spreads up
  to 77 %; interleaved rounds brought the same arms under 5 %.
- The exclude-source arm did its job: it showed the tax belongs to the coverage subsystem,
  not to instrumenting code, which changes what you would optimise.

### What didn't

- The Bun docs' advice to keep coverage on CI does not follow from the cost. 70 ms on a
  960 ms suite is not the reason a developer waits.
- Splitting the cost by reporter did not pay: the lcov file is 1.2 % and the text table 1.1 %,
  both at the edge of the noise floor. There is no reporting mode worth choosing for speed.

### Surprises

- Coverage in Bun is about seven times cheaper than Istanbul on a comparable shape, 7 % against
  50 %. Native instrumentation is the whole difference: no source rewrite, no cached
  instrumented copy.
- The cost does not follow the work. Executing the same code 400 times instead of once adds
  22 ms of coverage. Whatever Bun charges for, it is not the counters firing.
- Excluding files from the report saves almost nothing, 5.9 % against 7.0 %, because the
  excluded files are still loaded and tracked. The axe the docs recommend is blunt.

### Recommendation for the real build

- Leave `coverage = true` in `bunfig.toml`. Price it at 0.08 ms per test file plus a few
  milliseconds, around 7 % of a fast suite and less of a slow one.
- Do not reach for `coveragePathIgnorePatterns` to buy speed; it buys 1 % on this shape. Use
  it for correctness of the report, not for the clock.
- Do not run a second coverage pass in CI and a plain pass locally. One `--coverage` run
  serves both; 70 ms does not justify two configurations.

## Limits

- Synthetic tests: each test asserts on pure functions, so the whole suite is CPU-bound and
  fast. A suite dominated by I/O waits would show a smaller percentage and the same fixed
  milliseconds.
- Bun 1.4.4 only. Bun's coverage is JavaScriptCore-native, so these numbers say nothing about
  Vitest, Jest or `node --test` with `c8`.
- One process, no `--parallel`. Coverage may behave differently when files are sharded across
  workers; 009 and 014 showed the runner changes the shape of these costs.
- The suite is uniform: 45-line modules with five tests each. A repository with a few huge
  files and many tiny ones would price the per-file part differently.
