# 029 — A symlinked `node_modules` costs 70–93 ms per 1,000 packages

## Problem

pnpm builds `node_modules` from symlinks: one link per direct dependency, each
pointing into `.pnpm/<name>@<version>/node_modules/<name>`. Node does not treat
a symlink as the module's identity. It calls `realpath` on every resolved file
and uses the real path as the cache key. Every package therefore pays a
`readlink` that a flat npm tree does not.

The question: does that cost show up at start-up, and how large is it at 300 and
1,000 packages? An agent starts a process per tool call, so start-up is the
budget that matters.

## Hypothesis

Written before the first run: symlink resolution adds at most 0.1 ms per
package, so 1,000 symlinked packages add under 100 ms and under 30 % to a Node
start-up. If so, the layout is an install-time decision, not a start-up one.

## Method

`bench.js` generates the same packages twice under `/tmp/spike-029`: 300 and
1,000 packages, each a `package.json` with `exports` plus a 60-byte ESM
`index.js`.

- **flat** — `node_modules/pkg-0000/index.js`, a real directory.
- **sym** — `node_modules/pkg-0000 -> .pnpm/pkg-0000@1.0.0/node_modules/pkg-0000`,
  which is pnpm's shape for a direct dependency.

The runner sits in each tree, imports every package by bare specifier with
`await import()`, checks one export, and times the loop with `performance.now()`.
The parent measures wall clock around the spawn. Two modes: `import` and
`resolve` (`import.meta.resolve` only, no evaluation), which separates the
resolver from module execution.

Cases: Node 26 and Bun 1.4, both layouts, both sizes, three runs each, start
rotated so no cell always runs first. Two controls: Node with
`--preserve-symlinks` (turns `realpath` off), and a ten-run repeat of the
fastest cell for the noise floor.

Noise floor: the fastest cell over ten runs spread 117.5–126.1 ms around a
121.9 ms median, 7.1 %. A second full harness run moved the 1,000-package delta
from 77.7 to 69.9 ms in Node and 98.2 to 93.4 ms in Bun. Host: 6 vCPU, Linux
6.12, page cache warm.

## Results

Median of three runs per cell. Wall is spawn to exit; the import loop excludes
process start.

| cell           | wall ms | import ms | µs/package |
| -------------- | ------- | --------- | ---------- |
| node flat 300  | 178.0   | 123.6     | 412        |
| node sym 300   | 199.2   | 145.8     | 486        |
| node flat 1000 | 404.9   | 345.8     | 346        |
| node sym 1000  | 476.9   | 415.7     | 416        |
| bun flat 300   | 77.2    | 55.0      | 183        |
| bun sym 300    | 108.0   | 85.4      | 285        |
| bun flat 1000  | 207.6   | 184.3     | 184        |
| bun sym 1000   | 302.4   | 277.7     | 278        |

Symlink against flat, on the import loop:

| runtime | 300      | 1,000    | per package |
| ------- | -------- | -------- | ----------- |
| node    | +22.2 ms | +69.9 ms | 70 µs       |
| bun     | +30.4 ms | +93.4 ms | 93 µs       |

Resolve only, 1,000 packages: Node 143.3 ms flat against 215.8 ms symlink
(+72 µs/package); Bun 34.8 against 55.2 (+20 µs/package). The rest of the loop is
load and evaluation: Node 202.5 µs/package in both layouts, Bun 149.5 flat
against 222.5 symlinked.

`--preserve-symlinks` on the symlinked tree: 297.7 ms against 415.7. Turning
`realpath` off saves 118 ms at 1,000 packages, 0.12 ms each.

## Verdict: VALIDATED

### What worked

- The cost stayed under the 100 ms ceiling: +70 ms in Node at 1,000 packages,
  +93 ms in Bun. Per package it is 70 and 93 µs, under the 0.1 ms predicted.
- The cost is linear in package count: 300 packages pay a third of what 1,000
  pay, in both runtimes.
- Node's penalty lands where the docs say it does. The resolve pass carries the
  whole delta (72 µs/package) and load is identical at 202.5 µs.

### What didn't

- "Under 30 %" held only for Node, at 20 %. Bun pays 51 %, because its flat start
  is so cheap: 184 ms for 1,000 packages against Node's 346 ms.
- At 1,000 packages, +93 ms is 45 % of a 208 ms Bun start. That is no longer a
  rounding error for a CLI that starts per call.

### Surprises

- `realpath` costs 118 ms at 1,000 packages, more than the 70 ms gap between the
  two layouts, because Node also realpaths the flat tree. Preserving symlinks
  beats the flat layout by 48 ms (297.7 against 345.8), which no one would
  predict from the layout alone.
- In Bun the penalty is not in resolution. Its resolver is 4.1× cheaper than
  Node's (34.8 against 143.3 ms) and the symlink adds only 20 µs there, yet the
  import loop pays 73 µs/package more in load. Bun looks up the link target again
  when it creates module identity.

### Recommendation for the real build

- A pnpm layout is affordable below about 300 direct packages: +22 ms in Node,
  +30 ms in Bun. Do not treat the symlinks as a reason to hoist.
- Above 1,000 packages, budget +0.1 s per process start, and use a hoisted
  layout for anything that starts a process per request: a serverless handler, a
  per-file test runner, a CLI in a loop.
- The larger lever is package count. 1,000 flat packages cost 184 ms in Bun
  before any of your code runs; bundling or pruning them pays more than the
  layout choice.

## Limits

Warm page cache, one machine, three runs. The packages are synthetic: one tiny
module, no nested dependencies, no `exports` conditions beyond a single string,
no native modules, no `.bin`. A real pnpm tree nests a symlink per dependency
edge, so a deep graph should cost more than measured here. Neither runtime was
run with a cold cache, and the sandbox has 6 vCPU shared with other work.

## Sources

- [pnpm, Symlinked `node_modules` structure](https://pnpm.io/symlinked-node-modules-structure)
  — the `.pnpm/<name>@<version>/node_modules/<name>` store shape and the symlink
  from the root `node_modules`, which this harness copies.
- [Node.js, CommonJS module resolution](https://github.com/ishtms/nodebook/blob/main/chapters/06-modules/02-resolution-algorithm.md)
  — after resolution Node calls `fs.realpathSync` and uses the real path as the
  cache key; `--preserve-symlinks` skips the step and "can measurably speed up
  startup in symlink-heavy environments (like pnpm workspaces with thousands of
  packages)"; the native `realpath` is one `readlink` on Linux.
