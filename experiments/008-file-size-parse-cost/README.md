# 008 — File size versus parse cost

**Question:** at equal total bytes, does cutting source into big files or small files change how long it takes to parse — and what does one edit cost in a 2,000-line file?

## Hypothesis (written before measuring)

At equal total bytes, full transpile time stays flat within ±10% from 20 to 2,000 lines per file, but an edit re-parses the whole file, so one edit in a 2,000-line file costs about 10× the edit in a 200-line file. If so, the rule is about edit granularity, not file count, and splitting files buys nothing.

## Method

One synthetic TypeScript body of 20,000 lines (530.7 KB) — interfaces, classes, generics, string parsing — cut five ways: 10 files × 2,000 lines, 40 × 500, 99 × 202, 334 × 60, 834 × 24. The bytes are identical in every variant; only the cut moves.

- `bench.ts` — Bun 1.4.4. `full`: `Bun.Transpiler().transformSync` over every file (cold build, no cache). `edit`: the middle file re-transpiled 300× (median, p95). `load`: `bun run entry.ts` importing all modules in a fresh process. Three runs each; medians below. Fixed cost measured by transpiling an empty string 5,000×.
- `bench-tsc.ts` — TypeScript 7.0.2 (`tsc -p --diagnostics`), three runs per variant, parse/check/total read from the compiler's own counters.
- Noise floor: the 2,000-line file re-transpiled 30× gave 1.891–2.179 ms, a 0.29 ms spread. Every difference below is larger than 6× that spread.

## Results

Bun transpiler, same 530.7 KB:

| Files | Lines/file | Full ms | µs/file | Edit µs | Edit % of full |
|-------|-----------|---------|---------|---------|----------------|
| 10 | 2,000 | 19.49 | 1,949 | 1,935 | 9.93 |
| 40 | 500 | 21.31 | 533 | 537 | 2.52 |
| 99 | 202 | 24.55 | 248 | 247 | 1.01 |
| 334 | 60 | 32.06 | 96 | 95 | 0.30 |
| 834 | 24 | 42.88 | 51 | 47 | 0.11 |

- Small files cost **2.2× more to parse at equal bytes**: 19.49 → 42.88 ms.
- The marginal file costs **28.4 µs** (fixed, not per byte) — 10× the 2.7 µs empty-string call.
- Per-byte rate is best in the big file: 0.0367 ms/KB at 2,000 lines, 0.0808 ms/KB at 24.
- One edit: **1,935 µs** in a 2,000-line file, **247 µs** in a 202-line file — 7.8×; against 24-line files, 41×.
- Loader is flat: `bun run` 5.8 ms (10 modules) → 6.4 ms (834 modules); 824 extra modules cost 0.6 ms.

TypeScript 7, same bytes:

| Files | Parse ms | Check ms | Total ms |
|-------|----------|----------|----------|
| 10 | 85 | 481 | 596 |
| 40 | 81 | 489 | 624 |
| 99 | 91 | 501 | 640 |
| 334 | 120 | 526 | 688 |
| 834 | 135 | 479 | 695 |

Parse grows 1.6× (85 → 135 ms, **61 µs per file**); check time is flat within noise; total rises 17%.

## Verdict: PARTIAL

The first half of the hypothesis was wrong. Parse time is not flat: it grows 2.2× in Bun and 1.6× in TS 7 as the same bytes are cut into more files. Two independent implementations agreeing on the direction is the strongest part of this result. The V8 claim that "for parsing speed, the overall amount of script matters, not the organization into files" ([V8 dev on SO](https://stackoverflow.com/questions/60338924/does-javascript-file-size-impact-parsing-time-on-browser-will-two-5kb-js-files)) holds per byte, not per file: each file pays ~28 µs (Bun) to 61 µs (tsc) of setup before its first byte is parsed.

The second half held: an edit in a 2,000-line file costs 7.8× the edit in a 202-line file, close to the predicted 10×.

But the magnitude kills the concern. The most expensive edit measured is 1.9 ms, and the least efficient split of 530 KB still parses in 43 ms. No editor or build is gated on that. Splitting files for tooling speed is a cost, not a saving — and if the edit latency ever mattered, it would be worth noticing that a 2,000-line file re-parses in under 2 ms, so the limit is about 500× further out than the file sizes people argue about.

## Limits

- `Bun.Transpiler` strips types; it is a proxy for a bundler's parse, not the editor's language service. The tsc numbers cover the checker.
- The blocks are synthetic, and a V8 developer warns that "thousands of files with dummy content" is not a realistic split. Each block is self-contained, so no variant pays cross-file type resolution; a real graph would add cost that the cut could amplify.
- One host, six CPUs, warm page cache, 530 KB body. A 10 MB codebase could behave differently at the small-file end.
- No cache layer was modelled: with Bun's compile cache or `tsc --incremental`, a one-file edit may not re-parse neighbours at all.

## What I would do

Nothing about file layout. Keep files the size that reads well; ~2,000 lines is cheap enough on every axis measured. If a build ever gets slow, measure it before splitting — the split itself costs up to 2.2× the parse. The next question this raises: does that 28 µs per-file cost survive a warm transpiler cache, or is it a cold-start artifact?

## Sources

- [The cost of JavaScript in 2019 — V8](https://v8.dev/blog/cost-of-javascript-2019): parse/compile is no longer the dominant cost; split by cache boundary, not by size.
- [Does JS file size impact parse time — Stack Overflow](https://stackoverflow.com/questions/60338924/does-javascript-file-size-impact-parsing-time-on-browser-will-two-5kb-js-files): a V8 developer's claim that parse cost tracks total script, not file count.

## Reproduce

```bash
bun run experiments/008-file-size-parse-cost/bench.ts
bun run experiments/008-file-size-parse-cost/bench-tsc.ts
```
