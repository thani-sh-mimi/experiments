# 024 — a compiled CLI costs 995× the bytes and saves 145 ms of start-up

## Problem

A Bun CLI can ship as a source tree that runs with `bun run entry.ts`, or as a
`bun build --compile` executable. The executable carries a copy of the Bun
runtime. Which one should a release publish, and which compile flags pay?

## Hypothesis

An executable is the runtime with the program attached, so 2,000 modules add
under 1 MB (less than 1%) to the 104 MiB file, and compiled start-up beats
`bun run` on the same tree by under 50 ms. If both hold, a CLI shipped to
machines that already have Bun should ship a tarball.

## Method

`bench.js` generates a synthetic graph: N modules, each exporting one constant
and one function, plus an entry that imports all N as namespaces and sums the
results. N swept at 1, 20, 100, 500, 1,000, 2,000 and 4,000. Four shapes:

- `source`: `bun run src/entry.ts` from the tree, 110 KB gzipped at 4,000.
- `plain`: `bun build --compile`.
- `minify`: `--compile --minify`.
- `bytecode`: `--compile --minify --sourcemap --bytecode`, the flags the Bun
  docs recommend for production.

Each build ran three times and each start-up fifteen times after three warm-up
runs; the harness checks that every binary prints the number the source run
prints, so a shape cannot look fast by doing less work. Medians below, with the
spawn floor at 0.83 ms. Host: 6 vCPU, Linux 6.12, Bun 1.4.4.

## Results

| modules | source gz | source | plain | minify | bytecode | bytecode bytes | bytecode build |
| ------: | --------: | -----: | ----: | -----: | -------: | -------------: | -------------: |
|       1 |     152 B | 6.8 ms |  5.5  |   5.5  |    5.6   |       104.1 MiB |        268 ms |
|      20 |     629 B | 8.3    |  5.7  |   5.7  |    5.8   |       104.1 MiB |        268 ms |
|     100 |   2,725 B | 11.8   |  6.9  |   6.9  |    5.8   |       104.1 MiB |        276 ms |
|     500 |  14,551 B | 25.4   | 12.6  |  12.5  |    6.5   |       104.3 MiB |        318 ms |
|   1,000 |  29,184 B | 42.5   | 19.6  |  19.2  |    7.6   |       104.5 MiB |        460 ms |
|   2,000 |  57,414 B | 79.6   | 32.9  |  32.6  |    9.2   |       104.8 MiB |      1,225 ms |
|   4,000 | 110,149 B | 157.5  | 60.7  |  59.3  |   12.2   |       105.7 MiB |        492 ms |

Derived, from 1 to 4,000 modules:

- The runtime floor is 104.07 MiB. The program adds 434 KB to `plain` (109 B
  per module, 0.4%) and 1.63 MiB to `bytecode` (427 B per module, 1.6%).
- Start-up slope: `source` 37.7 µs per module, `plain` 13.8 µs, `bytecode`
  1.65 µs.
- At 4,000 modules the binary starts 12.9× sooner than the source tree
  (12.2 ms against 157.5 ms) for 995× the bytes of the 110 KB tarball, or 479×
  when both are gzipped.
- `minify` on its own buys 0.2% of bytes and 2% of start-up. It is not the
  lever; `--bytecode` is.
- The source run crosses a 50 ms budget at about 1,150 modules.

Every figure is in `results.json` with all raw samples.

## Verdict: PARTIAL

The first half held. The second did not: the start-up gain is 70 ms at 2,000
modules and 145 ms at 4,000, not under 50 ms. The decision flips with how often
the CLI runs.

### What worked

- The floor is flat exactly as predicted: 109 bytes of program per module in a
  104 MiB file, so the cost of the binary does not follow the size of the code.
- `--bytecode` cuts the per-module start-up slope eightfold against `plain`
  and 23× against `source`, for 1.6% more bytes.

### What didn't

- A plain `--compile` is the worst shape above 1,000 modules: full binary size,
  and it still parses the whole bundle at every start (60.7 ms at 4,000).
- My 50 ms ceiling assumed start-up would not scale with module count. On the
  source shape it scales linearly, at 37.7 µs per module.

### Surprises

- `--bytecode` build time is not monotonic: it climbs to about 1,230 ms at
  2,030 modules and falls to about 380 ms at 2,040, then stays near 400 ms.
  Three samples per point, reproduced across two sessions, cause unexplained.
- `--trim`, which the Bun docs describe for smaller executables, is accepted by
  Bun 1.4.4 and ignored: byte-identical output, 109,123,760 B.

### Recommendation for the real build

- Publish both from one CI job: the source tarball for machines that have Bun,
  and one `--bytecode` binary per target for machines that do not. They share a
  single build graph.
- Always pass `--bytecode` on the compiled artifact. Skip `--minify` unless the
  bytes are measured to matter; it moves neither number.
- Publish the gzipped binary, not the raw one: 52.8 MB instead of 109.6 MB.
- Keep the module count out of the release decision. It costs 109 bytes and
  1.65 µs per module, and the floor decides the download.

## Limits

Synthetic modules with one exported constant and a two-line function are smaller
and faster to parse than real code; a real module costs several times the parse
time, so the crossover near 1,150 modules is an upper bound. One host, one Bun
version, warm page cache throughout. Start-up here includes `spawnSync`
overhead, which the spawn floor puts at 0.83 ms for every shape.

Sources: [Single-file executable](https://bun.com/docs/bundler/executables),
[Smaller executables](https://bun.com/docs/compiler/size).
