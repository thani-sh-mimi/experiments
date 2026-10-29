# 007: what a shallow clone actually saves

## Problem

`--depth 1` is what most CI already does: `actions/checkout` fetches one commit by default, and Depot's scan of 60,000 checkout steps found 98.5% of organisations on the defaults ([Depot](https://depot.dev/blog/why-organizations-have-slow-actions-checkout)). The published case for going further is scale-only: GitHub measured a shallow clone of `jquery/jquery` at 300 ms against 2,000 ms full, and `torvalds/linux` at 1.2 min against 5 min ([GitHub](https://github.blog/open-source/git/git-clone-a-data-driven-study-on-cloning-behaviors/)). Those repos are 40 MB and 4 GB. Ours are a few hundred files and a few thousand commits.

So the question a rule needs answering is not "is shallow faster" — it is **at what history size does it start to matter, and what part of the clone is history versus checkout?**

## Hypothesis

A shallow clone's cost is set by the working tree, not the history: at 4,000 commits `--depth 1` should finish in under 40% of a full clone's wall time and use under 15% of its `.git` bytes, while the saving stays under 50 ms below ~500 commits.

If that holds, the default is already right for small repos and no `fetch-depth` policy is worth writing; adding `fetch-depth: 0` "just in case" is the only expensive mistake.

## Method

Five synthetic origins with the same shape — 400 TypeScript files in 20 directories, every commit touching 3 of them — and history of 100, 500, 1,000, 2,000 and 4,000 commits. Built with `git fast-import` from a seeded PRNG, so each origin is byte-identical on every run; only the commit count changes.

Each origin is cloned full and with `--depth 1`, three runs per cell, interleaved. Clones go through `file://` with `--no-hardlinks`, which forces the real pack protocol instead of a local copy — the same work a network clone does minus the bandwidth. Each clone is timed with `performance.now()`, its `.git` and working tree measured, then deleted. A second pass at 100 and 4,000 commits clones with `--no-checkout` to split pack transfer from checkout.

Noise floor: five identical full clones of the 2,000-commit origin. Host: 6 vCPU sandbox, git 2.47.3, `bench.ts`.

## Results

Medians of three runs, spread in brackets.

| Commits | full (ms) | `--depth 1` (ms) | saved | saved | full `.git` | shallow `.git` |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 47.99 (47.72–48.15) | 39.26 (38.93–39.37) | 8.7 ms | 18% | 0.27 MB | 0.15 MB |
| 500 | 92.17 (91.72–92.28) | 39.07 (38.77–39.52) | 53.1 ms | 58% | 0.75 MB | 0.15 MB |
| 1,000 | 149.29 (149.04–150.58) | 39.25 (39.01–39.37) | 110.0 ms | 74% | 1.35 MB | 0.15 MB |
| 2,000 | 262.56 (262.52–264.52) | 40.05 (39.55–40.49) | 222.5 ms | 85% | 2.56 MB | 0.15 MB |
| 4,000 | 515.07 (506.54–517.50) | 39.75 (39.73–39.86) | 475.3 ms | 92% | 5.00 MB | 0.15 MB |

- Full clone grows at **0.12 ms per commit**, almost perfectly linear (47.99 at 100 → 515.07 at 4,000, r² ≈ 1). Shallow is **flat at 39–40 ms** across a 40× range of history: it never reads the commits it does not need, so it does not pay for them.
- Shallow `.git` is 0.15 MB at every size — the tip commit's blobs, nothing else. At 100 commits that is still 56% of a full `.git`, because in a small repo the current files are most of the repository.
- Decomposition (`--no-checkout`, so only pack transfer and object parsing remain): at 4,000 commits full 499.09 ms against shallow 27.85 ms. Writing 400 files to disk costs 12–16 ms in both. **A shallow clone is ~28 ms of fixed git work plus ~12 ms of checkout; a full clone is that plus 0.12 ms per commit of history.**
- Noise floor: 3.61 ms spread across five identical 263 ms clones (1.4%). The 110 ms saving at 1,000 commits is 30× that.

## Verdict: VALIDATED

All three predictions held: at 4,000 commits shallow took 7.7% of the full clone's time (predicted under 40%) and 3.0% of its `.git` bytes (predicted under 15%), and the saving was still 8.7 ms at 100 commits.

### What worked

- Holding repository shape constant and varying only commit count made the linear term a single number you can carry to another repo: **0.12 ms and ~1.2 KB per commit of history** at three small files changed per commit.
- The `--no-checkout` pass turned "shallow is flat" into a decomposition: ~28 ms is git's own floor (spawn, ref advertisement, `index-pack`), ~12 ms is the checkout. Neither depends on history.
- `file://` with `--no-hardlinks` kept the measurement honest. A plain path clone would have hardlinked or copied the object store and measured disk, not pack work.

### What didn't

- No network. The entire variable cost of a real clone — bytes over the wire — is absent, so this is the CPU half of the answer. Where this harness sees 13× at 4,000 commits, GitHub measured 6× on a 40 MB repo: wall time there is dominated by bandwidth, not by the pack work measured here.
- One shape only: 400 small text files, 3 touched per commit, no binaries, no LFS, no submodules. A repo with a 5 MB asset per commit would move the per-commit cost by orders of magnitude.
- Clone-and-delete only. The cost that bites in practice is the *second* fetch in an existing shallow clone, which GitHub notes is more expensive server-side than a full fetch.
- One host, one git version. 0.12 ms/commit is a CPU number from this sandbox, not a portable constant.

### Surprises

- The shallow floor is 39 ms and git's fixed overhead is 28 ms of it: for any repo under ~200 commits a clone is dominated by process startup, and neither setting is measurable against a CI job that takes a minute to boot a runner.
- `--depth 1` saves almost nothing in *disk* on a young repo (44% at 100 commits) but almost everything on an old one (97% at 4,000). Disk and time cross over at different points, so "shallow saves space" is only true once history is older than the tree.
- The saving is not a percentage of anything stable: it is history, minus zero. Which is why the useful rule is a commit count, not a ratio.

### Recommendation for the real build

- Leave `fetch-depth: 1` as the default for build and test jobs. It costs nothing and the payoff is linear in history — 110 ms at 1,000 commits, 475 ms at 4,000, before bandwidth multiplies it.
- Only opt into `fetch-depth: 0` in the jobs that genuinely walk history: changelog, semantic release, `git blame`, `git log -L`. A shallow clone cannot be cheaply reversed — `--unshallow` re-downloads the pack — so the wrong default is paid twice.
- Size the decision from the repo, not the advice: ~0.12 ms and ~1.2 KB per commit. Under ~500 commits shallow buys under 60 ms and is not worth a policy line; a monorepo at 20,000 commits is 2.4 s of CPU that you are currently paying on every job.
