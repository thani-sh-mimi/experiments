# Backlog

Status: `open` · `building` · `done` · `dropped` · `needs Thanish`.

| Idea                        | The question                                                                                                                                                                   | Status        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Test file count             | What does each extra test file cost `bun test`, separate from the tests in it?                                                                                                 | done (001)    |
| Fork-per-file runner        | Same question against `node --test`: what does a worker per file cost, where Bun shares one process?                                                                           | done (011)    |
| Parallel crossover          | Repeat 001's `--parallel` sweep on a host with more than 2 CPUs; the sandbox quota caps speedup at ~2x.                                                                        | needs Thanish |
| Pre-commit hook budget      | Where does `prettier --check .` break the one-second commit budget, and how much does staging-only save?                                                                       | done (003)    |
| Shallow clone               | How much time and disk does `--depth 1` save on a mid-size repo, and at what history size does it start to matter?                                                             | done (007)    |
| Incremental type-check      | Cold `tsc` versus cached incremental on a synthetic 300-module project: what ratio do you actually get?                                                                        | done (004)    |
| Lockfile discipline         | `bun install` with a warm cache and `--frozen-lockfile`: how much of CI install time is resolution?                                                                            | done (010)    |
| Barrel files                | Cost of a re-export barrel versus direct imports in a 500-module graph, measured by bundle time.                                                                               | done (006)    |
| Build cache: JSON vs SQLite | 10k lookup keys: at what size does a JSON file stop being a fine cache?                                                                                                        | done (002)    |
| CI fan-out                  | With fixed setup cost S and test time T, how many shards actually help? Simulate, no CI needed.                                                                                | done (009)    |
| Commit size                 | Lines changed versus review time per file — needs human data, so read published studies instead of measuring.                                                                  | needs Thanish |
| Squash policy               | What a squash merge costs `git blame` on a 5k-commit synthetic history.                                                                                                        | done (005)    |
| Import graph                | Does a 50-file deep import chain cost measurable start-up time versus a flat graph at the same total size?                                                                     | done (012)    |
| Worker-thread isolation     | 011 puts a child process at 81 ms per file. Does a worker-thread pool (`node --test` isolation, or Vitest threads) recover most of it at the same isolation level?             | done (014)    |
| Git index at scale          | How much of a one-second hook budget does `git status --porcelain` eat at 1k/10k/50k tracked files, and what does `-uall` cost versus `-unormal` with untracked files present? | done (013)    |
| Editor tax                  | 2000-line files vs 200-line files: parse and transpile time in Bun at equal total bytes.                                                                                       | done (008)    |
| Cache archive format        | A 20k-file, 300 MB cache tree: what does restoring it cost as `tar`, `tar.gz` and `tar.zst`, and at what link speed does compression pay?                                      | done (015)    |
| Build minify and sourcemap  | On a 1,000-module graph, what do `--minify` and `--sourcemap` cost in build time and bytes — does minify pay for itself, and what does a map add?                              | done (017)    |
| Diff algorithm at scale     | Real commits diff in under 1 ms per algorithm, but do `--histogram` and `--patience` stay free on a 30k-line file, and do they buy fewer hunks there?                          | done (016)    |
| Test coverage cost          | What does `bun test --coverage` add to an 800-file suite, does it scale with executed code, and do the text or lcov reporters move it?                                         | done (018)    |
| skipLibCheck on TS 7        | Does `skipLibCheck` still pay on the native TypeScript 7 compiler, and does the saving follow the declaration file count or the lines inside them?                             | done (019)    |
| Publish tarball             | Does `bun pm pack` ship the same files as `npm pack`, and does a second pack produce the same bytes — can a release hash its tarball?                                          | done (020)    |
