# 003: the pre-commit formatting budget

## Problem

A `pre-commit` hook that runs `prettier --check .` over the whole tree is the default advice, and every guide says to move to staged-only files. Nobody says where the full-tree form crosses the point a person stops tolerating it. One second is the usual budget for a hook nobody notices.

## Hypothesis

Prettier's default CLI costs about 4 ms per file plus ~0.35 s of startup, so:

- `prettier --check .` crosses a one-second budget at roughly 175 files;
- a 1,000-file repo takes ~4.4 s per commit;
- a hook that checks only five staged files takes ~0.3 s whatever the repo size.

Decision it changes: whether a repo of a few hundred files can keep the simple full-tree hook, or has to take on `lint-staged` and its configuration.

## Method

Synthetic TypeScript: modules spread over ten folders, 588 bytes each (interfaces, a reduce, a template-free concatenation), pre-formatted once so `--check` has nothing to report. Sizes 10 to 2,000 files.

Prettier 3.9.10 from `devDependencies`, spawned as `node node_modules/prettier/bin/prettier.cjs`, default settings, no config file, no `--cache` unless named. Each case: one discarded warmup run, then three timed runs, median reported. Fixtures are rebuilt from a seeded PRNG every run. Host: 6 vCPU sandbox, Bun 1.4.4, Node 26.

Three modes per size: full tree (`--check .`), staged-only (`--check` + five paths, as a hook would pass them), full tree with a warm `--cache`.

## Results

Medians in ms; spread is max−min across the three runs.

| Files | Full tree | Staged 5 | Full tree, warm cache |
|------:|----------:|---------:|----------------------:|
| 10 | 394 | 302 | 214 |
| 50 | 636 | 305 | 291 |
| 100 | 888 | 303 | 398 |
| 250 | 1,596 | 306 | 669 |
| 500 | 2,613 | 299 | 1,068 |
| 1,000 | 4,564 | 300 | 1,826 |
| 2,000 | 8,465 | 305 | 3,340 |

- Fit from the 100- and 2,000-file points: **3.99 ms per file, 489 ms fixed**. Predicted 1 s crossover: **128 files**; measured full-tree at 100 files is 888 ms, at 250 files 1,596 ms, so the crossing sits between them, near 130.
- Staged-only is flat: 299–306 ms from 10 to 2,000 files, a 3× saving at 100 files and **28× at 2,000** (8,465 → 305 ms).
- Warm `--cache` is not flat — it still costs ~1.6 ms per file (3,340 ms at 2,000). It buys 2.5×, not 10×.
- Bare startup (`prettier --version`) is 107 ms; a `--check` over ten files already costs 394 ms, so ~290 ms goes to config and directory resolution before any file is parsed.
- Passing all 2,000 paths on the command line did not fail: no argument-length error at 57 KB of argv.
- Noise floor: median spread 1.8% of the median, worst case 4.9%. Timing gaps between the three modes are far outside it.

## Verdict: PARTIAL

The core question is answered: the simple hook stops being free at about 130 files, not the 175 I predicted, and staged-only is flat and cheap. The per-file cost and the staged-mode behaviour matched the hypothesis; the fixed cost was 0.49 s, not 0.35 s, which moves the crossover down.

### What worked

- 3.99 ms/file held from 250 to 2,000 files within 4%.
- Staged-only is independent of repo size — the decision should be made on the size of a commit, not the size of the repo.

### What didn't

- My 0.35 s fixed cost was low by 40%; most of the surprise is per-invocation config and file resolution, not node start.

### Surprises

- `--cache` scales with file count instead of amortising: the cache is a lookup per file, so it saves the parse, not the walk.
- At ten files the full-tree run (394 ms) is already 3.7× bare startup — a hook on a tiny repo pays for discovery, and staging five files is barely cheaper.

### Recommendation for the real build

- Under ~100 files: keep `prettier --check .`; it is under a second and needs no extra dependency.
- Over ~150 files: pass staged paths (`git diff --cached --name-only --diff-filter=ACMR`), not `lint-staged`. It measured 305 ms flat, and the argument list held 2,000 paths without trouble.
- Do not rely on `--cache` for a one-second budget: it is 1.8 s at 1,000 files.
- A full-tree format check belongs in CI, where its 4.5 s at 1,000 files is irrelevant.

## Limits

- One file size (588 bytes) and one language; a repo of large generated files will move both numbers.
- Prettier runs on Node here, single-threaded; prettier's own parallel experimental CLI was not tested.
- Fixtures were already formatted, so `--check` printed nothing; a repo with many unformatted files pays extra for the report.
- Warm OS page cache throughout: a cold first run after a reboot will be slower.
- Argument-length failure was not reached, so the practical ceiling for the all-paths form is somewhere above 2,000 files and unmeasured.

## Sources

- Prettier's CLI performance deep dive, on where the old CLI spent its time (config resolution, file walking): <https://prettier.io/blog/2023/11/30/cli-deep-dive.html>
- e18e, new CLI results: 29.4 s for `--check .` on TSESLint with the old CLI, 9.1 s uncached and 1.7 s cached with the new one: <https://e18e.dev/blog/prettier-speed-up>
