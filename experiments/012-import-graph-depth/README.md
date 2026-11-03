# 012 — Does import depth cost start-up time at a fixed module count?

**Problem.** Every style guide in this org says "keep imports shallow", and nobody has
priced it. A 50-file chain through barrel re-exports is the shape that rule warns about.
If depth is free, the rule costs review time and buys nothing; if it is not, "shallow"
needs a number so a reviewer can say no to a specific graph.

**Hypothesis, stated before measuring.** A chain of 50 modules loads within 10 % of a
flat graph with the same modules, edges and bytes, so the shallow-import rule can be
dropped from review. A gap of 30 % or more would mean the rule stays, with a depth limit.

## Method

`bench.js` generates synthetic graphs of 200-byte modules into `tmp/graphs/`, then times
`await import(entry)` inside `load.js`, so the interpreter start is outside the clock.
Two shapes, each with N modules, N edges and byte-identical totals:

- **chain** — entry imports `m0`, which imports `m1`, and so on, depth N
- **flat** — entry imports all N modules, depth 1

Both run in `bun` and `node`, three runs each, median reported. A third shape is the
realistic one: 40 chains of 50 under one entry, against a flat 2000.

Host: Linux x64, 2-CPU quota (`cpu.max` 200000/100000). Bun 1.4.4, Node v26.12.1.
Noise floor, 7 repeats of the flat-200 point: **5.7 %** spread. Raw runs in `results.json`.

## Results

Milliseconds to load the graph, `.js`:

| Modules | chain bun | flat bun | ratio | chain node | flat node |
|---------|-----------|----------|-------|------------|-----------|
| 50      | 6.75      | 3.16     | 2.14× | 23.3       | 25.2      |
| 200     | 19.6      | 7.56     | 2.59× | 78.6       | 74.2      |
| 800     | 70.1      | 23.4     | 3.00× | RangeError | 255.7     |

Bun charges **58–72 µs per level of depth**, and that charge does not grow with width:
`40 × 50` (2000 modules, depth 50) took 66.8 ms against 59.8 ms flat, +11.6 % inside a
20.9 % noise band. The model `flat + 60 µs × depth` predicts 178 ms for a 2000-deep chain;
one run gave 181 ms.

Bun's flat cost is 29–38 µs per module. Node's is 320–500 µs per module, nine to ten
times more, which hides the depth tax: Node's chain of 200 is 6 % slower than flat.

Node has a hard ceiling. A chain of 760 modules loads in 268 ms; **765 throws
`RangeError: Maximum call stack size exceeded` in `node:internal/modules/esm/loader`**.
Bun loaded 2000 (181 ms).

TypeScript costs Node 0.47 ms per module (flat 200: 169.6 ms against 74.2 ms for `.js`);
Bun pays 0.05 ms. Depth ratios are the same in `.ts` for both.

## Verdict: PARTIAL

### What worked

- The measurement separates depth from module count and from bytes, so the ratio is
  a property of shape, not of size.
- The model holds: cost is flat load plus 60 µs per level in Bun.

### What didn't

- The hypothesis failed in the pure chain: 2.14× at 50 modules, never 1.1×.
- At depth 50 in a 2000-module graph the extra cost sits under the noise band, so this
  host cannot say whether it is 5 % or 12 %.

### Surprises

- Depth is priced per level, not per module. Width is nearly free once the spine is deep.
- Node cannot load a chain of 765 files at all. That is a crash, not a slowdown.

### Recommendation for the real build

- Keep the shallow-import rule as a habit, not a review gate: a 50-deep barrel spine
  costs about 3 ms and cannot be measured in a real graph.
- Forbid the pathological case by number: no single import chain deeper than 150 files
  (Bun: 10 % of a 60 ms load), and never above 700 (Node: stack overflow).
- Prefer Bun for cold start of large graphs: 10× cheaper per module than Node, and no
  depth ceiling.

## Limits

Synthetic modules with one side-effect import each; no bindings, no top-level await, no
`node_modules` resolution. One host, two runtimes, medians of three runs.
