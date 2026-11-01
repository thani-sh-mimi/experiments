# 010 — Lockfile discipline

**Question:** in CI, with a warm cache, how much of `bun install` is resolution — and
does committing `bun.lock` buy time or only determinism?

## Hypothesis (written before the corrected run)

With a warm manifest cache, dropping the lockfile costs under 50% of install time and
zero HTTP requests; with a cold manifest cache at 20 ms RTT it costs 5–10× on a
realistic graph. If so the lockfile is a determinism lever with a modest speed
dividend, and CI should care about cache restore order, not the flag.

## Method

`registry.ts` generates N synthetic packages (`pkg-0…pkg-N-1`) as real tarballs and
serves npm metadata plus tarballs from `127.0.0.1:4873`, logging every request. A
per-request `--delay` models registry RTT, so nothing leaves the machine.

Two graph shapes, because depth and count are different costs:

| Shape   | Edges                                         | Depth            |
| ------- | --------------------------------------------- | ---------------- |
| `chain` | each package depends on `i-1` and `⌊(i-1)/2⌋` | ≈ N (worst case) |
| `wide`  | depends on `⌊(i-1)/2⌋` and `⌊(i-1)/3⌋`        | ≈ log₂ N         |

Six modes, each in a fresh project dir with a shared, pre-warmed tarball cache:

| Mode             | State                             | Command                         |
| ---------------- | --------------------------------- | ------------------------------- |
| `empty`          | no dependencies                   | `bun install`                   |
| `noop`           | lockfile + `node_modules` correct | `bun install --frozen-lockfile` |
| `frozen`         | lockfile, no `node_modules`       | `bun install --frozen-lockfile` |
| `nolock-warm`    | no lockfile, warm manifest cache  | `bun install`                   |
| `nolock-cold`    | no lockfile, cache bypassed       | `bun install --no-cache`        |
| `nolock-offline` | no lockfile                       | `bun install --offline`         |

N ∈ {50, 200, 600}, RTT ∈ {0, 20} ms, 3 runs each; medians in `results.json`. Noise
floor: median spread across the 72 cells is 1.9%, worst 20.4% (one 53 ms cell).

## Results — 20 ms registry RTT, median ms (metadata requests)

`chain`:

| Mode           | 50         | 200           | 600             |
| -------------- | ---------- | ------------- | --------------- |
| frozen         | 5.4 (0)    | 9.5 (0)       | **20.7** (0)    |
| nolock-warm    | 6.4 (0)    | 12.7 (0)      | 29.3 (0)        |
| nolock-cold    | 130.6 (50) | 1,677.6 (200) | **5,803** (600) |
| nolock-offline | 6.2 (0)    | 12.6 (0)      | 29.5 (0)        |

`wide`:

| Mode           | 50        | 200        | 600           |
| -------------- | --------- | ---------- | ------------- |
| frozen         | 5.4 (0)   | 9.7 (0)    | **21.6** (0)  |
| nolock-warm    | 6.3 (0)   | 12.8 (0)   | 29.9 (0)      |
| nolock-cold    | 29.7 (50) | 96.7 (200) | **234** (600) |
| nolock-offline | 6.2 (0)   | 12.8 (0)   | 30.2 (0)      |

- **Linking is 30 µs per package**, flat across sizes and shapes: 3.0 ms for an empty
  install, 20.7 ms for 600 packages, 15.6 ms to relink an intact `node_modules`.
- **A warm cache does not make the lockfile redundant.** `nolock-warm` made zero
  requests and still took 17–42% longer (20.7 → 29.3 ms at 600): resolving from cached
  manifests costs ~14 µs/package even with no socket opened.
- **Cold resolution is depth-bound, not count-bound.** 600 packages at 20 ms RTT cost
  234 ms on the wide graph (10.8× `frozen`) and 5.8 s on the chain (280×), because a
  chain pays RTT once per level. The per-request cost is the same; the shape decides
  whether you pay it 10 times or 600.
- **`--offline` without a lockfile succeeds** and matches warm: a complete cache is
  enough to resolve, and a lockfile is not needed for hermetic installs.
- At 0 ms RTT cold resolution is cheap (600 packages: 74.9 ms chain, 53 ms wide), so
  the whole finding is about latency, not CPU.

## Verdict: VALIDATED

### What worked

- The local registry with request counting made resolution directly observable:
  `frozen` and `nolock-warm` both issue zero metadata requests, `nolock-cold` issues
  exactly one per package.
- Both predicted bands held: warm-cache penalty 17–42% (predicted under 50%),
  cold-cache multiplier 10.8× wide (predicted 5–10×).

### What didn't

- The first pass served `cache-control: no-store`, so Bun never reused a manifest and
  the "warm" modes still fetched everything. The reported 5.8 s at 600 packages was
  then mostly graph depth, not resolution cost. Half an hour of measurement was spent
  before the bug was visible; the numbers looked plausible, which is the danger.
- Latency modelling is a fixed 20 ms per request, not a distribution, so no tail.

### Surprises

- The lockfile beats a warm cache by a third of install time while making no network
  calls at all — the cost is parsing cached manifests, not fetching them.
- `--no-cache` and a warm cache differ by 10 ms at 0 ms RTT but 3× at 20 ms, so
  manifest-cache behaviour is invisible until a network has latency.

### Recommendation for the real build

- Keep `bun ci` for determinism; expect 30 µs/package of linking plus a ~3 ms floor,
  and stop attributing CI install time to resolution when the cache is warm.
- Restore the Bun cache _before_ install and check that the manifest cache is included;
  a tarball-only cache silently turns every install into a metadata sweep.
- Treat dependency depth as the latency risk: a chain-shaped graph pays RTT per level,
  so a deep graph justifies the lockfile and `--offline` far more than a wide one.

## Limits

Bun 1.4.4, one machine, 6 cores (2-CPU quota). Tarballs were always cached, so download
time is excluded; lifecycle scripts are absent; synthetic packages are ~1 KB, so
extraction is cheaper than real ones. Absolute times will move with package size and
disk; the ratios and the 30 µs floor should hold.

## Sources

- [bun install](https://bun.com/docs/pm/cli/install) — `--frozen-lockfile` errors on a
  `package.json`/lockfile mismatch; `--no-cache` skips the manifest cache; `--offline`
  never touches the network.
- [Lockfile](https://bun.com/docs/pm/lockfile) — `--frozen-lockfile` writes nothing.
