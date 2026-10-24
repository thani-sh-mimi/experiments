# 001 — What does one extra test file cost `bun test`?

**Problem.** Test suites grow by splitting files. If each file carries start-up cost,
a suite of 400 small files is slower than four big ones, and CI pays for it. Nobody
knows the number, so restructuring is decided by feel.

**Hypothesis.** Two numbers, stated before measuring:

1. An extra test file costs under 1 ms of runner time, so file count is not the lever.
2. `bun test --parallel` loses until each file does about 2 ms of real work.

The decision either answer changes: whether to reorganise a suite by file count, and
whether to add `--parallel` to CI.

## Method

`bench.ts` generates two shapes of suite and times `bun test <dir>` end to end, process
start included: N files with one trivial test each, and one file with N tests. A third
shape gives every file a 50-module import graph so an import costs something. Three
runs per point, median, one discarded warm-up; least squares over the five points splits
fixed cost from per-unit cost.

`parallel.ts` runs 100 files, each burning 0, 1, 10 or 50 ms of CPU, serial against
`--parallel`, same protocol.

Bun 1.4.4, Linux x64, i5-9500T; the container is limited to **2 CPUs** (`cpu.max`
200000/100000) while `nproc` reports 6. Raw runs: `results.json`, `parallel.json`.

## Results

Many files, one test each:

| Files | 1 | 5 | 25 | 100 | 400 |
|-------|---|---|----|-----|-----|
| ms    | 7 | 7 | 11 | 24  | 77  |

One file, N tests: 6, 7, 7, 9, 15 ms.

Many files, each importing 50 modules: 13, 14, 19, 35, 110 ms.

Fitted: fixed cost **6 ms**, **0.18 ms per file**, **0.02 ms per test**. With the
import graph, 0.24 ms per file — the graph costs 0.06 ms per file because Bun loads a
module once per run and shares it across files. One extra file costs about as much as
nine trivial tests.

Parallelism, 100 files:

| Work per file | serial | `--parallel` | speedup |
|---------------|--------|--------------|---------|
| 0 ms          | 23 ms  | 88 ms        | 0.26x   |
| 1 ms          | 125 ms | 190 ms       | 0.66x   |
| 10 ms         | 1030 ms| 569 ms       | 1.81x   |
| 50 ms         | 5036 ms| 2566 ms      | 1.96x   |

## Verdict: VALIDATED

File count is cheap: 400 files cost 77 ms, and the 50-module graph per file adds 33 ms
overall. Both predictions held — 0.18 ms is well under 1 ms, and `--parallel` flips
between 1 and 10 ms of work per file. The 2-CPU quota caps the speedup near 2x, so on
a wider CI box the crossover would be lower and the ceiling higher.

What would change the answer: a runner that forks per file (Jest, Vitest with threads,
`node --test`) pays real process cost per file; the shared-module discount here comes
from Bun's single-process default. A suite whose files open a database or load fixtures
has its own per-file cost that no file-count rule covers.

## What I would do

- Do not split or merge tests to chase speed; the shape of the file is a readability
  choice at this cost.
- Add `--parallel` only when the suite's median per-file time is above ~10 ms. Below
  that it is 4x slower.
- Measure the fixed 6 ms and preload cost first. For a suite that finishes in 100 ms,
  runner overhead and setup are the whole budget.

Follow-up worth doing: repeat the parallel crossover on a host with more cores, and
measure `node --test` for the fork-per-file comparison. Both are in `IDEAS.md`.
