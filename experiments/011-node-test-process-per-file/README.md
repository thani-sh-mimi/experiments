# 011 — What does a child process per test file cost `node --test`?

**Problem.** `bun test` pays 0.18 ms per extra test file (001) because it shares one
process. `node --test` defaults to the opposite model: one child process per file
([Node docs](https://nodejs.org/api/test.html)). If that cost is large, a suite with
hundreds of files burns seconds on process start, and a runner choice that looked like
a style question is a CI budget question. Nobody in this org has the number.

**Hypothesis, stated before measuring.** A forked file costs 25–40 ms, so process
isolation starts to pay for itself once a file does about 40 ms of real work, and a
100-file suite pays about 3 s of pure spawn. The decision it changes: whether to reach
for `--test-isolation=none` on large suites, and whether to split test files.

## Method

`bench.ts` writes synthetic suites of trivial `node:test` files into `tmp/`, then times
whole runner invocations with `Bun.spawn` and `performance.now()`. Four axes:

- interpreter floor: `node -e 0` and `bun -e 0`
- extension: 10 files of `.js` against 10 of `.ts`, same body
- file count: 1, 2, 4, 8, 16, 32 files, `--test-concurrency=1` so per-file cost does
  not hide behind overlap, against `--test-isolation=none` and `bun test`
- work per file: 32 files, each burning 0, 1, 5, 20 or 50 ms, at concurrency 1 and 2

Five runs per point, median, least-squares over the six count points. The container is
CPU-throttled and shared, so the three configs of a point run in the same round.
Noise floor, 7 repeats of the 32-file point: **2.4 %** spread. Raw runs in `results.json`.

Node v26.12.1, Bun 1.4.4, Linux x64, 2-CPU quota (`cpu.max` 200000/100000).

## Results

Milliseconds, serial:

| Files | `--test` (process) | `--test-isolation=none` | `bun test` |
|-------|--------------------|-------------------------|------------|
| 1     | 186                | 97                      | 33         |
| 2     | 263                | 105                     | 34         |
| 4     | 422                | 102                     | 34         |
| 8     | 750                | 110                     | 35         |
| 16    | 1400               | 118                     | 37         |
| 32    | 2685               | 140                     | 40         |

Fitted: **103 ms fixed + 80.7 ms per file** with process isolation, against
**98 ms + 1.3 ms** in-process and **33 ms + 0.21 ms** in `bun test`. At 32 files that is
19× the in-process run and 67× the Bun run. The interpreter floor is 46 ms of the
80.7 ms; module load and the runner's parent–child protocol are the other 35 ms.

TypeScript doubles it. Ten `.ts` files cost 1458 ms against 918 ms for the same ten
`.js` files: **+54 ms per forked file**, but only +6 ms per file in process.

Work per file, 32 files, process against in process, concurrency 1 and 2:

| Work/file | process c1 | process c2 | in process |
|-----------|------------|------------|------------|
| 0 ms      | 2679       | 1548       | 143        |
| 1 ms      | 2680       | 1596       | 171        |
| 5 ms      | 2827       | 1706       | 299        |
| 20 ms     | 3266       | 1905       | 780        |
| 50 ms     | 4250       | 2348       | 1741       |

The spawn cost is additive and does not shrink as files do more work. It stays 61 % of
wall clock even at 50 ms of work per file.

## Verdict: INVALIDATED

### What worked

- The model is exactly linear: 80.7 ms per file, ±2.4 % between runs.
- `--test-concurrency=2` buys 1.73×, all of it from the second core, not from cheaper
  forking.

### What didn't

- The predicted band. I said 25–40 ms per file; the box gives 81. Node's own start is
  46 ms of that, so the prediction was 2–3× low.
- The predicted crossover. There is none: isolation can never be repaid, because the
  80 ms is paid on top of the work, not traded against it. At 5 ms of work per file a
  fork costs 16× the test.

### Surprises

- `.ts` costs 54 ms more per process but almost nothing in process. Type stripping is
  paid once per process, and process isolation pays it once per file.
- In-process isolation is flat to ±20 ms from 1 to 32 files. The 001 result for Bun
  holds to two significant figures: 0.21 against 0.18 ms per file.

### Limits

- One machine, 2-CPU quota, shared and throttled. A warm page cache throughout.
- Files do no I/O and import only `node:test`; a file that opens a database adds its
  own cost on both sides.
- Process spawn cost is operating-system and container specific. The 46 ms floor is
  the part to re-measure elsewhere, not the 80.7.
- `.ts` uses Node's built-in type stripping, not a transpiler cache.

## What I would do

- Treat test-file count as a budget item on `node --test`. 300 files is 24 s of spawn
  against 0.5 s in process; 500 files is 40 s.
- Reach for `--test-isolation=none` on any suite that does not need per-file state.
  Measure first: if the suite is faster in process, the isolation was never used.
- Do not split test files on a fork-per-file runner to "keep them small". Every split
  costs 81 ms, and a `.ts` split costs 135 ms.
- If isolation is required, raise `--test-concurrency` to the core count before adding
  shards (009): the fork cost is CPU-bound and parallelises at 1.73× on two cores.

Sources read: [Node test runner docs](https://nodejs.org/api/test.html) (execution model,
`isolation` option, added v22.8.0), [nodejs/node#47663](https://github.com/nodejs/node/issues/47663)
(child-process overhead on a real suite, and the Mocha-with-`--parallel` comparison).
