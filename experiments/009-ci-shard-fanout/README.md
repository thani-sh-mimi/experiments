# 009 — CI shard fan-out

**Question:** with a fixed per-shard setup cost S and T seconds of tests, how many shards actually pay for themselves — and does the textbook answer survive contact with a real runner?

## Hypothesis (written before measuring)

Bun test startup is roughly 150 ms per shard, so a 3 s suite stops improving at 4–5 shards: the 6th saves under 150 ms. With real CI setup (15–90 s per job, per the sources below), even 2 shards fail to pay for a 3 s suite. If so, shard count is computed from measured S and T, never picked by feel.

## Method

`bench.ts` generates a synthetic Bun suite into `$TMPDIR/shard-fanout-suite`: 30 test files × 20 tests, each test a calibrated ~5 ms arithmetic loop, so one file is ~100 ms and the suite is **T = 2,673 ms** of real work. Nothing touches the network.

- **S** — `bun test` on a file with no tests, median of 3 (process start, framework load, zero work).
- **k shards** — files dealt round-robin into k groups, each group run as `bun test <files>` in sequence, so every shard's own duration is measured without contention. k ∈ {1,2,3,4,5,6,8,12,15}, 3 runs each, median reported.
- **The model** — shard wall clock = S + T·⌈30/k⌉/30 (the ⌈⌉ is the imbalance when files don't divide evenly).
- **Local parallel run** — all k shards at once, to see what the machine actually delivers.
- Noise floor: k=1 across 3 runs gave 2,679.0 / 2,679.2 / 2,684.8 ms — a 5.8 ms spread on a 2.7 s measurement. That is 0.2%, so speedup ratios below are not noise, but the 7.8 ms per-shard overhead is the same order as one run's spread and rests on summing 15 shards.

## Results

| Shards | Slowest shard ms | Predicted ms | Error | Speedup |
|--------|------------------|--------------|-------|---------|
| 1 | 2,679.2 | 2,679.2 | — | 1.00× |
| 2 | 1,347.4 | 1,342.5 | +0.4% | 1.99× |
| 3 | 899.2 | 896.9 | +0.3% | 2.98× |
| 4 | 721.5 | 718.7 | +0.4% | 3.71× |
| 6 | 453.7 | 451.4 | +0.5% | 5.91× |
| 8 | 365.4 | 362.3 | +0.9% | 7.33× |
| 12 | 275.4 | 273.2 | +0.8% | 9.73× |
| 15 | 187.1 | 184.1 | +1.7% | **14.32×** |

- **S = 5.8 ms**, not 150 ms. `bun test` starts in single-digit milliseconds.
- Fan-out stayed **near-linear to 15 shards**. The sum of shard times grew 2,679 → 2,792 ms: **7.8 ms of overhead per extra shard**, of which 5.8 ms is the process that would exist anyway.
- The model is right to within **1.7%** at every k, once imbalance counts — k=4 deals 8/8/7/7 files, and the 8-file shard is the one that finishes last.
- The k-th extra shard saves **T/(k(k+1))** seconds: 1,337 ms going 1→2, 223 ms going 3→4, **37 ms going 7→8**.
- Parallel on this host bought almost nothing: k=6 took 2,275 ms against 2,719 ms of summed shard time (**1.18×**), because `cpu.max` is `200000 100000` — a **2-CPU quota** behind `nproc`'s 6.

Solving S + T/k for real CI setup, with the measured T:

| Setup S | Best k | Wall clock | Runner-minutes |
|---------|--------|-----------|----------------|
| 5.8 ms (this host) | 21 | 133 ms | 3 s |
| 15 s (cached CI) | 1 | 17.7 s | 17.7 s |
| 90 s (cold CI) | 1 | 92.7 s | 92.7 s |

## Verdict: PARTIAL

The shape held, the magnitude did not. `k ≈ √(T/S)` is the whole decision rule, and the measured data follows it: with S = 5.8 ms the plateau sits at **21 shards**, not the 4–5 I predicted from a 150 ms assumption. Local sharding is nearly free, so "when does it stop helping" is the wrong question on a warm machine — it barely ever does.

The second half held, and it is the half that matters. Shard k is worth adding only when **S < T/(k(k+1))**, so a suite needs **T > S·k(k+1)** before k shards pay: at 15 s of setup, 2 shards need 90 s of tests, 4 need 300 s, 8 need 1,080 s. A 2.7 s suite gets **nothing** from sharding on any real runner — it pays 15 s of setup either way and saves 1.3 s at best.

Cross-check against published guidance: 15 s setup × the qaskills table predicts k* = 5.7 for an 8-minute suite and 8.9 for a 20-minute one, where they recommend "4–6 shards" and "6–10 or more". The model reproduces advice that was arrived at by trial, which is the most useful thing here — it means the count can be computed instead of guessed.

## Limits

- One host, one runner, zero cache and zero install: the measured S is a floor. The 15 s and 90 s rows are **cited**, not measured — install needs a registry, which this repository's rules exclude.
- The cross-machine model is arithmetic on measured per-shard durations, not a sharded CI fleet. The 2-CPU quota means the parallel column cannot validate it here (this is the `needs Thanish` item "Parallel crossover" in `IDEAS.md`).
- Tests are uniformly ~100 ms. Real suites have a long tail, where one slow file caps every shard no matter the count; the model only captures that through `⌈30/k⌉`.
- Checkout is not the setup: a `--depth 1` clone of this repo's 736 KB tree took 21 ms. Install and build are what a per-shard budget is actually spent on.

## What I would do

Compute the shard count, don't pick it: measure S on the runner and T for the suite, then take the largest k where S < T/(k(k+1)). For suites under a few minutes, spend the effort on **S** — cache installs, build once and share the artifact — because every shard multiplies whatever S is. And run the tests in parallel workers on one machine first: it costs nothing per extra unit of concurrency, which shards never do.

## Sources

- [Playwright test sharding and parallel CI guide](https://qaskills.sh/blog/playwright-test-sharding-parallel-ci-guide): per-shard overhead "under fifteen seconds" once browsers and modules are cached; "under two minutes, do not shard"; 2–8 min → 2–3 shards, 8–20 min → 4–6.
- [Speed up Jest test suites with sharding](https://learn.michaelguay.dev/blog/speed-up-jest-test-suites-with-sharding): time falls to "about 1/N of the original plus some overhead"; every shard repeats checkout, setup and install; 8 shards took 19 min to under 3.

## Reproduce

```bash
bun run experiments/009-ci-shard-fanout/bench.ts   # ~95 s, writes results.json
```
