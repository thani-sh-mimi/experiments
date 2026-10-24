# 002 — At what size does a JSON cache file stop being fine?

**Problem.** Build tools cache per-file metadata in one JSON file: read it, parse it,
look up a key, write it back. It is easy to inspect and easy to corrupt. The alternative,
SQLite through `bun:sqlite`, is built in and synchronous. Nobody knows where the JSON
file stops paying for itself, so caches are chosen by habit.

**Hypothesis.** Two numbers, stated before measuring:

1. At 10,000 entries, one JSON file answers 1,000 lookups in under 5 ms, within 3× of SQLite.
2. A single-entry update at 10,000 entries costs at least 5× SQLite's, because JSON
   rewrites the whole file.

The decision either answer changes: whether a tool with a 10k-module cache keeps one
JSON file, and if it does, whether it rewrites that file per change or once per run.

## Method

`bench.ts` generates 1,000 / 10,000 / 100,000 synthetic module entries (~189 B each:
path, size, mtime, 16-hex hash, two dependencies, transform count) into one JSON object
and one SQLite table (`WITHOUT ROWID`, WAL, `synchronous = NORMAL` — a cache, not a ledger).
Three scenarios, each opening the cache from scratch: cold read plus 1,000 point lookups;
one entry changed and persisted; 10% of entries changed and persisted. One warm-up trial
discarded, three measured, median reported; the whole run repeated for confirmation.
`probe.ts` splits the JSON cold read into read, parse and lookup.

Bun 1.4.4, Linux x64, container limited to 2 CPUs, page cache warm after the first trial.
Raw runs: `results.json`, `results-confirm.json`, `probe.json`.

## Results

Medians of three trials, JSON / SQLite, milliseconds:

| Entries | Cache size | Cold read + 1,000 lookups | One entry updated | 10% updated |
|---------|------------|---------------------------|-------------------|-------------|
| 1,000   | 189 KB / 115 KB   | 1.35 / 4.79  | 1.84 / 0.36 | 1.95 / 0.92  |
| 10,000  | 1.89 MB / 1.11 MB | 12.2 / 5.94  | 18.4 / 0.43 | 18.3 / 5.22  |
| 100,000 | 18.9 MB / 10.8 MB | 136 / 8.95   | 225 / 0.51  | 202 / 52     |

The second run reproduced every median within 5%.

Where the JSON cold read goes, read / parse / 1,000 lookups: 0.19 / 1.05 / 0.07 ms at
1k; 1.21 / 11.43 / 0.13 at 10k; 11.6 / 123.9 / 0.16 at 100k. Parsing is ~95% of the cost
and lookups are free — 152–165 MB/s of `JSON.parse` here, inside the 200–400 MB/s range
published for V8 on ASCII payloads, a little slower because it allocates 100k objects.

SQLite's cost is nearly all fixed: 4.79 ms just to open and prepare, 5.94 at 10k,
8.95 at 100k.

## Verdict: PARTIAL

Prediction 1 was wrong. JSON at 10k entries takes 12.2 ms, 2.4× over the stated budget
and 2× slower than SQLite; the crossover for a cold read is around 5,000 entries, and
at 100k JSON is 15× worse.

Prediction 2 held, by more than stated: 18.4 ms against 0.43 ms is 42× at 10k entries,
and 440× at 100k. Rewriting the file is the JSON cache's real cost, not reading it.

### Surprises

- Below roughly 1,000 entries JSON wins even cold: SQLite's ~4.8 ms open is more than
  the whole JSON read.
- SQLite stalls occasionally: single UPDATE trials at 5.5 ms and bulk trials at 23 ms
  against medians under 1 and 5 ms — WAL checkpoint. Medians hide it; a per-file build
  budget would not.
- The SQLite file is 57% of the JSON file's bytes, so the readable format also costs disk.

### Limits

One machine, 2 CPUs, one writer, one process, warm page cache, synthetic entries of a
single shape. Cold disk, concurrent readers and network filesystems were not measured.
SQLite was tuned for a cache, not for durability.

### What I would do

- Past ~5,000 entries, keep the cache in SQLite; below ~2,000, one JSON file is simpler
  and faster cold.
- If the cache stays JSON, rewrite it once per run. At 100k entries each rewrite is
  225 ms; ten changed files cost 2.2 s.
- In SQLite, reuse `db.query()` statements and batch updates in one transaction: 10k
  single-row UPDATEs took 52 ms.

## Sources

- [json-ext benchmarks](https://github.com/discoveryjs/json-ext/blob/master/benchmarks/README.md) — `JSON.parse` 257 ms for a 100 MB fixture on Node 24.
- [samwillis/json-bench](https://github.com/samwillis/json-bench) — 10k small elements (650 KB) parse in 2.05 ms; roughly linear to 100k.
- [Bun SQLite docs](https://bun.com/docs/runtime/sqlite) — synchronous API, prepared statements, `db.query` cache, WAL recommendation.
