# Experiments

One small SDLC problem a day: a hypothesis with a number in it, a harness that measures it, a verdict. Bun scripts, synthetic input, no services.

| # | Experiment | Question | Verdict |
|---|------------|----------|---------|
| 001 | [test-file-overhead](experiments/001-test-file-overhead) | What does each extra test file cost `bun test`? | Validated: 0.18 ms/file, 6 ms fixed |
| 002 | [json-vs-sqlite-cache](experiments/002-json-vs-sqlite-cache) | At what size does a JSON cache file stop being fine? | Partial: crossover ~5k entries, parse dominates |
| 003 | [pre-commit-format-budget](experiments/003-pre-commit-format-budget) | Where does `prettier --check .` break a one-second commit budget? | Partial: 128 files; staged-only flat at 300 ms |

The backlog is in [IDEAS.md](IDEAS.md). How an experiment is run and written up is in [AGENTS.md](AGENTS.md).
