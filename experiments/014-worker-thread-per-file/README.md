# 014 — What does a fresh worker thread cost per test file?

**Problem.** 011 measured a forked process per test file at 81 ms in `node --test`.
That cost is the whole argument for `--test-isolation=none` and for a thread-based
runner pool, which trades process start for a V8 isolate inside one process
([Node.js](https://nodejs.org/learn/concurrency/comparing-nodejs-concurrency-models)).
A thread shares the process, so it skips the interpreter start — but it still builds
an isolate. Nobody here has the number, or knows what a reused worker really saves.

**Hypothesis, stated before measuring.** A fresh `worker_threads` worker per file
costs about 20 ms against 81 ms for a forked file, so a 32-file suite lands near
0.9 s instead of 2.7 s. If it holds, a threads pool is worth its state-leak risk
on any suite over 50 files.

## Method

`bench.ts` (Bun) drives `driver.mjs` (Node) once per point and times it. The driver
runs N copies of `unit.mjs`, a synthetic test file that asserts and exits:

- **fork**: `child_process.fork` per file, fresh process and fresh module graph
- **thread**: `new Worker` per file, fresh isolate and fresh module graph
- **pool**: 2 long-lived workers, each importing files one at a time

Counts 1, 4, 8, 16, 32 at 0 ms of work per file; then 32 files with 0, 1, 5, 20,
50 ms of busy work; then 7 repeats of the 32-file thread point for the noise floor.
Three runs per point, median, raw runs in `results.json`. Nothing runs in parallel,
so the 2-CPU quota does not shape the numbers.

Node v26.12.1, Bun 1.4.4, Linux x64, 2-CPU quota. Noise floor: **0.5 %** spread.

## Results

Milliseconds, 0 ms of work per file:

| Files | fork | thread | `node --test` (011) |
| ----- | ---- | ------ | ------------------- |
| 1     | 52   | 28     | 186                 |
| 4     | 207  | 93     | 422                 |
| 8     | 420  | 180    | 750                 |
| 16    | 838  | 351    | 1400                |
| 32    | 1630 | 695    | 2685                |

Fitted: **8 ms fixed + 50.9 ms per forked file**, against **7 ms + 21.5 ms per
thread**. At 32 files the thread model is 2.34× cheaper than the bare fork and
3.9× cheaper than `node --test`. At 50 files that is 1.08 s against 2.56 s.

Work per file, 32 files:

| Work/file | fork | thread |
| --------- | ---- | ------ |
| 0 ms      | 1653 | 693    |
| 1 ms      | 1728 | 777    |
| 5 ms      | 1861 | 893    |
| 20 ms     | 2332 | 1371   |
| 50 ms     | 3270 | 2332   |

Both models add work at 1.01× — the start cost sits on top of the test, it does not
overlap with it.

**Reuse.** The same 32 files on 2 long-lived workers took **43 ms, 1.35 ms per
file** — 16× cheaper than a thread per file. One worker reported having run 16
files (`__seen: 16`): a global set in the first file is still there in the
sixteenth. That is the leak the [Mergify write-up](https://mergify.com/blog/vitest-thread-pool-state-leakage)
describes for Vitest's `threads` pool, measured directly.

## Verdict: VALIDATED

### What worked

- The per-file prediction: 21.5 ms against 20 ms predicted, 0.5 % noise.
- The direction and the decision: threads cut 3.9× off a forked runner, so 50 files
  save about 3 s of pure start.

### What didn't

- The 4× ratio. A bare fork is 51 ms, not 81; the extra 30 ms in 011 is the
  runner's parent–child protocol, which threads pay a version of too. 4× only holds
  against `node --test`, not against `child_process` in general.
- "Most of the cost". 21.5 ms per file is still 100× `bun test`'s 0.2 ms. A thread
  per file is cheaper, not free.

### Surprises

- Pool reuse is the real win, 16×, and it is not the same isolation: the isolate and
  its module graph survive. Fresh thread per file gives isolation, a pool does not.

### Recommendation for the real build

- Pick `pool: 'threads'` with per-file isolation over `forks` above roughly 20 files;
  below that the difference is 20 ms.
- Reach for a reused pool only when files are independent, and reset module state
  yourself. A worker is not a sandbox: a crash still takes the run down, and native
  addons may not load.
