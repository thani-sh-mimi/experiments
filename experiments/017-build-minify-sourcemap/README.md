# 017 — What do `--minify` and `--sourcemap` cost a build?

**Problem.** A CI step ships a bundle. Two flags decide what it uploads: `--minify` and
`--sourcemap`. The published advice is that minification is nearly free next to the parse
and codegen passes — esbuild documents three AST passes, with minification folded into the
second and third ([esbuild FAQ](https://esbuild.github.io/faq/)) — and that a source map is
a fraction of the bundle it describes: "30-50% the size of the generated file", 10-15 % after
gzip ([Source Maps: Configuration and Debugging](https://www.grizzlypeaksoftware.com/library/source-maps-configuration-and-debugging-vorneibs)).
A map carries a copy of the sources in `sourcesContent` unless the bundler is told not to
([shipping maps](https://www.nazarboyko.com/articles/source-maps-in-production-useful-and-dangerous)),
which suggests the size claim holds only for maps without content. None of that says what a
Bun build actually pays at 4,000 modules.

**Hypothesis, stated before measuring.** Given a 4,000-module TypeScript graph, when built
with `bun build --minify`, then the build finishes within 10 % of unminified and the bundle
is at most half the bytes. Adding `--sourcemap=external` stays under 15 % extra time and
produces a map no larger than the bundle. The decision: if both hold, CI ships a minified
bundle with an external map and never an inline one; if the map outweighs the bundle, the
map leaves the artifact and goes to the error tracker on its own.

## Method

`bench.js` writes a synthetic graph — a `lib/core.ts` of helpers, then N modules that import
it and import the module before them, each with an interface, two constants, two exported
functions and a comment — and one entry file that imports all N and calls them. Sizes 100,
1,000 and 4,000 modules. Eight arms: plain, `--minify`, each of `--minify-whitespace`,
`--minify-syntax`, `--minify-identifiers`, `--sourcemap=external`, `--minify
--sourcemap=external`, `--minify --sourcemap=inline`.

Each arm runs once for warm-up and then three times, timed around `Bun.spawnSync` of the CLI
so process start is included. Raw output size is the sum of the out directory; gzip is
`zlib` level 9 on `entry.js` and on the map. The starting cost of `bun` itself is measured
separately. `check-compression.js` rebuilds the 4,000-module graph twice to add brotli 11.

Host: Linux x64, 6 vCPU (i5-9500T), warm page cache, Bun 1.4.4. Raw runs in `results.json`.

Noise: spreads run 0.0–17.8 ms, and the widest relative spread is 5.2 % (plain, 4,000
modules). Treat differences under 5 % as equal. `bun` itself starts in 1.8 ms. A second
session reproduced every byte count exactly and every median inside 5.7 %, the widest at the
100-module arm where fixed cost dominates.

## Results

Wall time per build, median of three, milliseconds.

| Modules | plain     | minify | whitespace | syntax | identifiers | map   | minify+map | inline |
| ------- | --------- | ------ | ---------- | ------ | ----------- | ----- | ---------- | ------ |
| 100     | **13.7**  | 13.7   | 13.6       | 14.1   | 13.5        | 14.5  | 14.5       | 14.8   |
| 1,000   | **83.6**  | 85.3   | 82.8       | 85.3   | 84.7        | 93.2  | 92.6       | 96.3   |
| 4,000   | **343.6** | 349.1  | 335.8      | 348.0  | 350.3       | 384.9 | 389.6      | 398.2  |

Cost grows linearly past the fixed part: 86 µs per module at 4,000 against 137 µs at 100,
so about 5 ms of the build is not the modules. Minification is inside the noise at every
size (+1.6 % at 4,000, −0.5 % for whitespace alone, +1.9 % for identifiers alone). The map
is not: +12.0 % external, +15.9 % inline.

Bytes at 4,000 modules, raw and gzipped, in KB:

| Arm                             | JS raw | JS gzip | map raw | map gzip | artifact gzip |
| ------------------------------- | ------ | ------- | ------- | -------- | ------------- |
| plain                           | 2,903  | 197     | —       | —        | 197           |
| `--minify`                      | 1,431  | 161     | —       | —        | 161           |
| `--minify-whitespace`           | 2,350  | 178     | —       | —        | 178           |
| `--minify-syntax`               | 2,724  | 194     | —       | —        | 194           |
| `--minify-identifiers`          | 2,098  | 177     | —       | —        | 177           |
| `--minify --sourcemap=external` | 1,431  | 161     | 6,477   | 315      | 476           |
| `--minify --sourcemap=inline`   | 10,067 | 525     | —       | —        | 525           |

Minification cuts 50.7 % of the raw bytes on every size, but only 18.4 % after gzip and
14.6 % after brotli 11 (90.4 KB to 77.2 KB). The external map is 4.53× the bundle raw and
1.91× its gzipped size; with it the artifact is 476 KB gzipped against 161 KB without. Of
the 6.63 MB map, 4.29 MB is `sourcesContent`; the mapping string alone gzips to 22 KB
against 315 KB for the whole map, so 93 % of the compressed map is a copy of the sources.

## Verdict: PARTIAL

### What worked

- `--minify` for time: +1.6 % at 4,000 modules, +2.0 % at 1,000, 0.0 % at 100 — inside a
  noise floor of 5 %. Three runs at 349 ms against 344 ms cannot separate them.
- `--minify` for bytes: 2,903 KB to 1,431 KB, 50.7 % at 100, 51.2 % at 1,000, 50.7 % at
  4,000. The ratio does not drift with graph size, so the 100-module build predicts it.
- The map's time cost: +12.0 %, above the noise floor and consistent across sizes (5.8 %,
  11.5 %, 12.0 %), so it is real and it is bounded.

### What didn't

- The bundle did not halve after compression. Full minify saves 18.4 % gzipped and 14.6 %
  brotli, because whitespace and comments are what compression already removes. The raw
  number overstates the win by 2.7×.
- The map is not a fraction of the bundle. It is 4.53× the code it describes, so the 30–50 %
  claim holds only for a map without `sourcesContent`, and this one is about ten times that.
  My hypothesis allowed a map the size of the bundle and missed by 4.5×.
- A single pass is not half the win. Whitespace alone takes 19.1 % of the raw bytes and
  9.8 % gzipped; identifiers alone take 27.7 % raw and 10.1 % gzipped; syntax takes 6.2 %
  raw and 1.6 % gzipped. The three together give 50.7 % raw and 18.4 % gzipped.

### Surprises

- The compressed map is a copy of the source, not a table of positions. `sourcesContent` is
  4.29 MB of the 6.63 MB map; the mappings alone gzip to 22 KB against 315 KB for the whole
  file. Deleting the content field would cut the map's transfer by 93 %.
- Inline is worse than the folklore: the guide says a 200 KB bundle "might balloon to
  800 KB", and here 1,431 KB becomes 10,067 KB, 7.0× raw and 3.3× gzipped.
- A toy graph cannot answer this. At 100 modules all eight arms land between 13.5 and
  14.8 ms, because 5 ms of fixed cost and 1.8 ms of process start swamp the flag.

### Recommendation for the real build

- Keep `--minify`. It costs nothing measurable and halves the upload; say "half the bytes",
  not "half the transfer", which is 18 %.
- Keep `--sourcemap=external`, but stop treating the map as part of the artifact's size
  budget: it is 1.9× the code gzipped. Either strip `sourcesContent` (esbuild has the flag,
  `bun build` does not) or upload the map out of band to the tracker.
- Never `--sourcemap=inline` in a deployed artifact: 3.3× the gzipped bytes for a map the
  browser does not need.
- Price a build by module count: 86 µs per module, plus about 5 ms. A 1,000-module graph is
  84 ms; the flags are a rounding error next to that.

## Limits

- Synthetic content: every module is the same template with a different index, so both the
  plain and minified outputs compress far better than real code would. That flatters gzip
  and brotli on both arms; the 18 % figure is narrower than it may be for real sources.
- Bun 1.4.4 only, and `bun build` has no `sourcesContent` option, so the stripped map is
  measured by removing the field from the JSON after the build, not by building it.
- One target (`bun`), one format, no tree-shaking, no splitting. Browser-targeted builds
  carry module wrappers that minify differently.
- Three runs per arm on 6 shared vCPUs. Differences under 5 % are not real, and the
  whitespace and identifier arms sit inside that band.
