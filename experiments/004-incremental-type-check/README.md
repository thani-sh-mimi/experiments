# 004: what `tsc --incremental` actually buys

## Problem

Every CI guide says to persist `.tsbuildinfo` between runs. The published cases are large: TypeScript's own announcement measured VS Code dropping from 47.54 s cold to 11.49 s on a rebuild with no API change ([TS 3.4](https://devblogs.microsoft.com/typescript/announcing-typescript-3-4/)); VS Code reports 36 s → 5 s just by moving to the Go compiler ([TS 7 in VS Code](https://code.visualstudio.com/blogs/2026/06/26/iterating-faster-with-ts-7)). Neither says what the cache saves on a project of a few hundred files, which is where most repositories sit — nor whether the answer survives TypeScript 7, whose native compiler already cut cold builds by an order of magnitude ([TS 7 progress](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/)).

## Hypothesis

On a 300-module strict project:

- cold `tsc` 7 takes ~450 ms;
- a run with nothing changed takes ~180 ms, about 2.5× faster;
- one edited leaf module takes ~320 ms, about 1.4× faster;
- so a CI job that caches `.tsbuildinfo` saves under 0.3 s — less than moving the cache around — and should not bother.

On TypeScript 6 the same cache should give about 2×.

Decision it changes: whether a repository of this size wires up a cache for its type-check job at all.

## Method

Synthetic TypeScript: 300 and 1,000 modules of 711 bytes, spread over ten folders. Each module imports two earlier ones and builds on their types (generic interface, mapped type, conditional type, a union that references a parent module's union), so the check walks a real graph. Compiler options: `strict`, `noEmit`, `skipLibCheck`, `incremental`, `tsBuildInfoFile=.cache/tsconfig.tsbuildinfo`.

Both compilers from `devDependencies`: `typescript@7.0.2` (Go) and `typescript@6.0.3` (aliased `typescript6`, JavaScript). Spawned as `node node_modules/<pkg>/bin/tsc --project .`.

Five cases per compiler and size, three timed runs each after one discarded cycle: cold (cache deleted), no-op, one edited leaf module (nothing imports it), one edited mid-graph module (half the graph imports it), and cold with `--incremental false` as the control. Every edit is measured from a settled build, so exactly one file is new. If a run exits non-zero it is recorded as a failure rather than aborting the run.

Fixtures are rebuilt from a seeded PRNG. Host: 6 vCPU sandbox, Bun 1.4.4, Node 26. Control for the fixture: the same 1,000-module graph with the recursive union chain flattened.

## Results

Medians in ms, spread (max−min of three runs) in parentheses.

| Modules | Compiler | Cold | No-op | Edit leaf | Edit mid | Cold, no cache |
|---:|---|---:|---:|---:|---:|---:|
| 300 | 7.0.2 | 443 (±14) | 192 (±27) | 263 (±16) | 433 (±38) | 447 (±5) |
| 300 | 6.0.3 | 1,681 (±141) | 941 (±5) | 1,207 (±19) | 1,729 (±43) | 1,761 (±61) |
| 1,000 | 7.0.2 | 2,941 (±55) | 357 (±11) | 1,206 (±20) | 2,827 (±90) | 2,838 (±59) |
| 1,000 | 6.0.3 | 3,893 (±184) | 1,400 (±23) | **crashed** | 3,670 (±19) | 3,883 (±60) |

- No-op ratio to cold: **0.43** (300, TS 7), 0.56 (300, TS 6), **0.12** (1,000, TS 7), 0.36 (1,000, TS 6). In milliseconds the same cache saves 251 ms at 300 modules and 2,584 ms at 1,000.
- One edited leaf: 0.59 of cold at 300, 0.41 at 1,000 on TS 7. One edited mid-graph module: 0.98 and 0.96 — no saving at all, because the dependants must be re-checked.
- The no-op run is mostly fixed cost. At 300 modules the compiler reports `Check time 0.000s`, `Parse time 0.086s`, and `tsc --version` costs 61 ms, so ~190 ms is startup, parse and the build-info read.
- Cold cost per file is not constant in my fixture: 1.2 ms per source file at 300 modules, 2.8 ms at 1,000 (`Check time` 0.249 s → 2.522 s while the graph grew 3.3×).
- TS 6 crashed on the single-leaf edit at 1,000 modules, on all three runs: `RangeError: Maximum call stack size exceeded` in `getExternalModuleMember`. TS 7 finished the same edit in 1,206 ms.
- Control (1,000 modules, union chain flattened): TS 7 3,003 ms, TS 6 3,712 ms — the union chain is not what makes the graph expensive.
- `tsbuildinfo` size: 31 KB at 300 modules, 88 KB at 1,000 (TS 7); 45 KB and 125 KB (TS 6).
- Noise floor: median spread 2.5% of the median, worst cell 14.2% (TS 6 cold at 300). Every gap reported above is outside it except `cold` versus `nocache`, which agrees within noise and is meant to.
- The harness checks that the compiler checks: one wrong annotation (`const x: number = "..."`) fails both compilers with `error TS2322`.

## Verdict: PARTIAL

The 300-module prediction held — 443 ms against 450, 2.3× against 2.5×, and the cache saves 251 ms, which is not worth wiring a CI cache for. The part I got wrong is the assumption behind the decision: I treated the ratio as a property of the toolchain. It is a property of the graph and its size. At 1,000 modules the same cache saves 2.6 s, 10× the saving, from 3.3× the files. My "do not cache" advice is right for small projects and wrong as a rule.

### What worked

- Cold cost at 300 modules was within 2% of the prediction, and TS 7 is 3.8× faster than TS 6 there.
- The suspicion that a mid-graph edit gains nothing was confirmed: 433 ms with the cache against 447 ms without.
- `--incremental false` matches cold within 5% in all four cells (0.97× to 1.05×), so writing no build info costs nothing measurable when there is none to read.

### What didn't

- The leaf edit was faster than predicted (1.7× rather than 1.4×), and that was luck, not method: the compiler re-checked 69 ms of the 249 ms of checking, and the remaining gap is what fixed cost allows.
- The fixture's check cost is superlinear — 3.3× the modules, 10× the checking. One 1,000-deep import chain with chained interface types is not how an application tree looks, so the 1,000-module row describes this graph, not "a 1,000-file repo".
- TS 7's advantage over TS 6 shrank from 3.8× to 1.3× between the two sizes in this graph, which no published benchmark predicts; I could not attribute it, so I do not claim it generalises.

### Surprises

- The cheapest run is not the cached run, it is any run where no check happens: 192 ms of which 130 ms is parse and process start. No caching strategy improves on that floor.
- TypeScript 6's incremental path dies with a stack overflow where its own cold path, and TS 7's incremental path, both succeed.

### Recommendation for the real build

- Under ~500 files on TypeScript 7, skip the `.tsbuildinfo` cache: 251 ms saved does not pay for a cache step.
- Above that, cache it — but expect the win only on runs where the tree is untouched (docs, unchanged PRs). A one-file change to a module with dependants gains nothing.
- Measure your own cold check first. If it is under a second, the cache is a rounding error; if it is over two, it is the cheapest CI change available.
