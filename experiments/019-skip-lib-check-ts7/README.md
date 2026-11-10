# 019 — Does `skipLibCheck` still pay on TypeScript 7?

**Problem.** `skipLibCheck: true` sits in most tsconfigs because checking `node_modules`
declarations was expensive. The advice is written for TypeScript 6: "20–40 % faster
compilation" ([curated TS config guide](https://github.com/pproenca/dot-skills/blob/HEAD/skills/.curated/typescript/references/tscfg-skip-lib-check.md)),
"often the biggest single win" on a large dependency tree. TypeScript 7 is a Go binary and
reports 7.7–11.9× on large projects, 4.2× on a generated 1,000-module project on 2 vCPUs
([howtodoinjava](https://howtodoinjava.com/typescript/typescript-7-native-compiler/)). If the
checker got that cheap, the flag may save little — and nobody publishes its share on 7.

**Hypothesis, stated before measuring.** Given a project with 17,400 lines of `.d.ts` and no
other dependency, when type-checked with TypeScript 7, then `skipLibCheck` saves under 20 % of
the run, so the flag stays in our tsconfigs only as a TypeScript 6 habit. If it saves over
40 %, the flag is still the first lever after the upgrade and the advice is unchanged.

## Method

`bench.ts` generates five projects that differ only in their `lib/` tree and type-checks each
with TS 6.0.3 (`typescript6`) and TS 7.0.2, both from the repo's `node_modules`. Every project
has the same 200 hand-written modules (6,200 lines) and builds the same program; only the
declarations change:

| Project      | `.d.ts` files | What is in them                                               |
| ------------ | ------------- | ------------------------------------------------------------- |
| `none`       | 0             | nothing; the compiler's own `lib.es2022.*.d.ts` still loads   |
| `none-es5`   | 0             | same, with `lib: ["ES5"]` instead — 11k lines instead of 56k  |
| `many-heavy` | 300           | 1,200 blocks: interfaces, mapped, conditional and infer types |
| `few-heavy`  | 12            | the same 1,200 blocks, 100 per file                           |
| `many-light` | 300           | one three-field interface per file, 600 lines in total        |

Three arms per project: `check` (both flags off), `defaultlib` (`skipDefaultLibCheck: true`
only), `skip` (`skipLibCheck: true`). The `defaultlib` arm separates the compiler's own
library from the project's declarations. Both compilers reject `--skipLibCheck=false` on the
command line (TS5025, TS5023), so each arm is a tsconfig file, and every run starts from no
build info.

Runs are interleaved: one pass walks all 30 cells, so host noise lands on every arm. One
warm-up pass is discarded, then four timed passes, median reported. Timing wraps
`spawnSync`, so process start is included. Host: Linux x64, 6 vCPU, Bun 1.4.4.
Raw runs in `results.json`.

Noise: spreads inside a cell run 1.5–9.8 %, median about 6 %. Treat a gap under 8 % as a tie.

## Results

Wall time, median of four, milliseconds.

| Project      | TS 6 check | TS 6 `skipDefaultLibCheck` | TS 6 `skipLibCheck` | saved | TS 7 check | TS 7 `skipDefaultLibCheck` | TS 7 `skipLibCheck` | saved |
| ------------ | ---------- | -------------------------- | ------------------- | ----- | ---------- | -------------------------- | ------------------- | ----- |
| `none`       | 2,196.2    | 1,181.2                    | **1,178.4**         | 46.3% | 644.3      | 252.7                      | **244.1**           | 62.1% |
| `none-es5`   | 839.3      | 742.7                      | **737.6**           | 12.1% | 173.1      | 155.3                      | **150.8**           | 12.9% |
| `many-heavy` | 3,263.8    | 2,263.0                    | **1,529.2**         | 53.1% | 1,006.0    | 543.7                      | **411.1**           | 59.1% |
| `few-heavy`  | 3,205.0    | 2,187.8                    | **1,498.7**         | 53.2% | 960.6      | 499.4                      | **362.4**           | 62.3% |
| `many-light` | 2,253.1    | 1,221.5                    | **1,222.3**         | 45.7% | 689.9      | 266.8                      | **265.0**           | 61.6% |

The flag saves **46 % on TypeScript 6 and 62 % on TypeScript 7 on a project with no
dependencies at all**. The `skipDefaultLibCheck` column says where it comes from: on `none` it
reproduces the whole saving, and `skipLibCheck` adds 2.8 ms (TS 6) and 8.6 ms (TS 7) on top.
`skipLibCheck` skips every `.d.ts`, and that includes `lib.es2022.d.ts`. Give the project an
ES5 library and the same flag saves 12 % — the difference is 45,000 lines of standard library.

Decomposed, milliseconds:

| Project      | TS 6 default lib | TS 6 project `.d.ts` | TS 7 default lib | TS 7 project `.d.ts` |
| ------------ | ---------------- | -------------------- | ---------------- | -------------------- |
| `none`       | 1,015.0          | 2.7                  | 391.7            | 8.5                  |
| `many-heavy` | 1,000.9          | 733.8                | 462.3            | 132.6                |
| `few-heavy`  | 1,017.2          | 689.1                | 461.2            | 136.9                |
| `many-light` | 1,031.6          | −0.8                 | 423.1            | 1.7                  |

Three things follow.

1. **The default lib did not get 4× cheaper.** TypeScript 7 checks the standard library in
   392–462 ms against 1,001–1,032 ms for TypeScript 6, a 2.2–2.6× gain, while the project's
   declarations went from 734 to 133 ms, a 5.5× gain. The fixed part is now the larger half of
   the bill, which is why the flag's _share_ grew from 53 % to 59 % even as its absolute value
   fell from 1,734 to 595 ms.
2. **The cost follows declaration content, not file count.** `many-heavy` and `few-heavy` hold
   the same 1,200 blocks; splitting them over 300 files instead of 12 adds 59 ms (TS 6) and
   45 ms (TS 7) of wall time, a 1.8 % and a 4.7 % difference at the edge of the noise floor.
   300 trivial files cost nothing measurable to check: 1.7 ms on TS 7.
3. **Declarations are now cheaper to load than to check on TS 7.** Adding 17,400 declaration
   lines costs 167 ms with checking off and 362 ms with checking on. On TS 6 the same addition
   costs 351 ms and 1,068 ms. Checking a declaration line is 7.6 µs on TS 7 against 42 µs on
   TS 6.

Whole-run speedup of TS 7 over TS 6 at this size: 3.2× on `many-heavy`, 3.4× on `none`, 4.8× on
`none-es5`. That is far below the 7.7–11.9× published for large multi-core builds and close to
the 2.4× and 4.2× other generated-project runs report.

## Verdict: INVALIDATED

The hypothesis said `skipLibCheck` would save under 20 % on TypeScript 7. It saved 59 % on the
project the hypothesis named, and 62 % with no declarations at all. The flag did not lose its
value in the port; its share went up.

### What worked

- The `defaultlib` arm. Without it the `none` project looks like a control and reads as noise;
  with it, the saving splits cleanly into the compiler's library and the project's
  declarations, and the surprise becomes a measurement.
- The layout pair `many-heavy` / `few-heavy`: equal content, 25× the file count, no difference
  that clears the noise floor. One table answered the second question.
- Interleaving the arms. Sequential passes in the first attempt spread up to 17.7 % on the
  smallest cells; interleaved passes held six of ten cells under 7 %.

### What didn't

- The `all-or-nothing` framing. `skipLibCheck` is two flags in one coat: the standard library
  and third-party declarations. On a project with no dependencies the second half is zero, and
  the number that a dependency-heavy repo would see cannot be read off this harness.
- Comparing the flag against TypeScript 6's absolute cost. The 46 % and 62 % are shares of very
  different totals; the flag is worth 1,018 ms on TS 6 and 400 ms on TS 7 for `none`.

### Surprises

- `skipLibCheck` is not about `node_modules`. Most of what it buys on a bare project is
  `lib.es2022.d.ts`, which `skipDefaultLibCheck` alone removes.
- TypeScript 7 fixed the checker, not the parser. On TS 7 the parse, bind and load work is now
  the bigger half of a declaration-heavy run: 411 ms total with checking off.
- 17,400 lines of mapped, conditional and infer-heavy declarations cost 133 ms to check on
  TS 7. The type patterns that people fear are cheap at this scale; the volume of the standard
  library is what the flag actually removes.

### Recommendation for the real build

- Keep `skipLibCheck: true` after the TypeScript 7 upgrade. Price it at 400 ms on a bare
  project with a 6 vCPU host, not at "40 % faster".
- Stop justifying the flag by the size of the dependency tree. The floor is the standard
  library, so a repo with no dependencies gets almost the same saving as one with fifty.
- If you want to keep checking third-party declarations, `skipDefaultLibCheck: true` is the
  narrow lever: it takes the standard library only, and on this harness it is worth the same
  as the wide flag on `none`.
- Do not split a generated `.d.ts` bundle into many files for checking speed, or merge it: the
  cost follows the blocks, and 288 extra files moved the run by under 2 %.

## Limits

- Synthetic declarations: 1,200 identical blocks of mapped, conditional and infer types. A real
  `@types` tree mixes overloads, huge unions and `declare module` blocks, and may price
  differently per line.
- No `node_modules`: `types: []` keeps `@types` out, so the harness isolates the compiler's
  library from third-party declarations. The third-party half is unmeasured here.
- Two compilers, one host, one shape: TS 6.0.3 and TS 7.0.2, 6 vCPU, `strict`, `noEmit`,
  `incremental: false`. TS 7 splits checking across 4 checkers by default; on 2 vCPU or with
  `--singleThreaded` the shares will move.
- Wall clock includes process start, measured at 103 ms for TS 6 against 60 ms for TS 7 with
  `--version`; that flatters TS 7 on small projects and matters to nobody on a 3-second one.
