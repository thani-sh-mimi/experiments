# 022 — 40 route builds cost 13.9× one build call, and splitting is free

**Problem.** A site with one entrypoint per route has two shapes for its build. Loop over the routes and run a builder for each, or pass all routes to one build and let it dedupe the shared code. The first shape is what a shell loop or a per-route task runner does. The second is what `Bun.build({ entrypoints, splitting: true })` offers. The choice is usually made on bytes, but the build time gap is larger than the size gap: esbuild's design notes say splitting runs tree shaking **once per entrypoint** ([esbuild architecture](https://github.com/evanw/esbuild/blob/master/docs/architecture.md)), and every module two entrypoints share becomes a separate chunk file ([Bun bundler docs](https://bun.com/docs/bundler)), so each shape trades one cost for another.

**Hypothesis, stated before measuring.** Given 40 route entrypoints over one shared core, when the build runs as one call with `splitting: true`, then it finishes in under 2× the time of a one-route build and writes under 30% of the bytes that 40 separate builds write. If that holds, a build that loops over routes pays 40× the fixed cost for nothing, and routes belong in one call.

## Method

`bench.js` generates a synthetic TypeScript graph in `tmp/src`: 60 `core` modules chained by imports, 20 `leaf` modules unique to each route, and one `index.ts` per route that calls all 80. That is 860 modules at 40 routes. Every build is `target: browser`, no minify, no sourcemaps, `root` set to the source dir.

Four shapes, three timed runs each, modes rotated between runs so none always runs first:

- **separate-api** — 40 `Bun.build` calls in one process, one entrypoint each.
- **separate-cli** — 40 `bun build` child processes.
- **combined-unsplit** — one call, 40 entrypoints, no splitting.
- **combined-split** — one call, 40 entrypoints, `splitting: true`.

A sweep at 1 and 10 entrypoints gives the fixed cost and the per-route slope. Bytes are summed file sizes and per-file gzip. A sanity step runs the split `route-0/index.js` in Bun and checks the chunk holds `core59`. Host: Linux x64, 6 vCPU, Bun 1.4.4. Raw runs in `results.json`.

Noise: the within-arm spread is 0.1–5.3 ms, under 10% of every median except the 3.4 ms arms. Treat a gap under 10% as a tie.

## Results

| Build shape                      | Time (ms) | Files | Raw bytes | Gzip bytes |
| -------------------------------- | --------- | ----- | --------- | ---------- |
| 40 builds, one per route (API)   | 127.2     | 40    | 519,425   | 80,641     |
| 40 builds, one per route (CLI)   | 374.0     | 40    | 519,425   | 80,641     |
| one build, 40 entries, no split  | 27.0      | 40    | 519,425   | 80,641     |
| one build, 40 entries, splitting | 23.7      | 41    | 193,482   | 46,081     |
| one build, 10 entries, no split  | 7.8       | 10    | 129,700   | 20,091     |
| one build, 10 entries, splitting | 7.3       | 11    | 55,337    | 12,603     |
| one build, 1 entry               | 3.5       | 1     | 12,964    | 1,955      |

Median of three runs. Splitting is 12% faster than unsplit, inside the noise floor: it is free.

Four things follow.

1. **One call is 4.7× cheaper than 40 API calls and 13.9× cheaper than 40 CLI calls.** 127.2 ms against 27.0 ms, and 374.0 ms when each route pays its own process start. A per-route loop spends most of its wall clock on work the one call does once.
2. **The gap is not per-entrypoint work.** Between 10 and 40 routes the marginal cost is 0.64 ms per route, about 32 µs per module, and the fixed cost is 3.5 ms. Ten routes cost 7.8 ms, forty cost 27.0 ms: linear in modules, not in entrypoints. The esbuild note about a tree-shaking pass per entrypoint describes a cost this graph does not feel at 860 modules.
3. **Splitting cuts raw bytes 63% and gzip bytes only 43%.** The shared core is the compressible part; duplicate copies of it gzip to little more than one. Judged on gzipped bytes, splitting saves 34 KB across the whole deployment, not 318 KB.
4. **Each page pays for it.** A split page loads a 9,497-byte chunk plus its 4,578-byte entry: 14,075 raw and 2,602 gzipped, against 12,964 and 1,955 in the self-contained bundle. That is 8.6% more raw, 33% more gzipped, and one extra request.

## Verdict: INVALIDATED

Both clauses missed. One splitting build took 23.7 ms against 3.5 ms for a one-route build, 6.8×, not under 2×. It wrote 37.2% of the unsplit bytes, not under 30%. The hypothesis was wrong because it compared totals while fixed cost dominates: a one-route build is 3.5 ms whatever it contains, so "under 2× of it" was impossible the moment per-route work was not zero.

The decision it aimed at is still the right one, for a different reason: never loop over routes, because 40 separate builds cost 4.7× to 13.9× the one call, and splitting adds nothing to build time.

### What worked

- The 1, 10, 40 sweep. Without it the 5× looks like per-entrypoint overhead; with it, the slope is 32 µs per module and the rest is fixed.
- Per-file gzip beside raw bytes. Raw bytes flatter splitting by 20 points.
- Running the output. The first generator emitted `(core0 + core1)(1)`, which built fine and threw at run time; the sanity step caught it before any number reached the README.

### What didn't

- Measuring a real framework build. No `node_modules`, no dynamic import, no minify, no sourcemap, so the per-module constants belong to this synthetic graph.
- Measuring the extra request. The split page pays one more round trip; here it has no latency.
- One overlap shape. Every route imports the whole core, which is the best case for one chunk and the worst case for dedupe.

### Surprises

- Without `root`, Bun mirrors the absolute entry path under `outdir`: entries landed at `tmp/src/route-20/index.js`. Any script that globs `outdir/*/index.js` finds nothing, and the build still reports success.
- Splitting made the total build faster, not slower, at every entrypoint count.
- The gzipped split page is a third larger than the unsplit one while the deployment is 43% smaller. One number cannot carry both.

### Recommendation for the real build

- Pass every route to one `Bun.build` call. Set `root` to the source directory so output paths are stable.
- Use `splitting: true` when pages share a large core and the deployment is served with caching, and judge it on gzipped bytes.
- Skip splitting for a page that must render on first visit with nothing cached; the chunk it must fetch first is larger than its own bundle was.
- Measure marginal cost per module before attributing build time to entrypoint count.

## Limits

- One host, warm cache, Bun 1.4.4. The ratios are Bun's; the fixed cost is this machine's.
- Synthetic modules of equal small size, no third-party deps, no CSS or assets in the graph.
- Static imports only. A dynamic `import()` adds an entrypoint per target and changes the chunk count.
- The per-page numbers are file sizes and gzip, not a browser's load time.
