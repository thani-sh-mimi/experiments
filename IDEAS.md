# Backlog

Status: `open` · `building` · `done` · `dropped` · `needs Thanish`.

| Idea | The question | Status |
|------|--------------|--------|
| Test file count | What does each extra test file cost `bun test`, separate from the tests in it? | done (001) |
| Fork-per-file runner | Same question against `node --test`: what does a worker per file cost, where Bun shares one process? | open |
| Parallel crossover | Repeat 001's `--parallel` sweep on a host with more than 2 CPUs; the sandbox quota caps speedup at ~2x. | needs Thanish |
| Pre-commit hook budget | Where does `prettier --check .` break the one-second commit budget, and how much does staging-only save? | open |
| Shallow clone | How much time and disk does `--depth 1` save on a mid-size repo, and what stops working? | open |
| Incremental type-check | Cold `tsc` versus cached incremental on a synthetic 300-module project: what ratio do you actually get? | open |
| Lockfile discipline | `bun install` with a warm cache and `--frozen-lockfile`: how much of CI install time is resolution? | open |
| Barrel files | Cost of a re-export barrel versus direct imports in a 500-module graph, measured by bundle time. | open |
| Build cache: JSON vs SQLite | 10k lookup keys: at what size does a JSON file stop being a fine cache? | done (002) |
| CI fan-out | With fixed setup cost S and test time T, how many shards actually help? Simulate, no CI needed. | open |
| Commit size | Lines changed versus review time per file — needs human data, so read published studies instead of measuring. | needs Thanish |
| Squash policy | What a squash merge costs `git blame` on a 5k-commit synthetic history. | open |
| Import graph | Does a 50-file deep import chain cost measurable start-up time versus a flat graph at the same total size? | open |
| Editor tax | 2000-line files vs 200-line files: parse and transpile time in Bun at equal total bytes. | open |
