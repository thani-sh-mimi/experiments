# Experiments

One day, one small SDLC problem, one measurement, one verdict.

## The loop

1. Pick an idea from `IDEAS.md` that has no experiment yet (or invent one if the list is empty) and mark it `building` with the date.
2. Research it briefly: what already exists, what the plausible numbers are. Two or three sources, no more. Cite links in the README.
3. State the hypothesis with a number in it and the decision it would change. "If per-file overhead is under 2 ms, splitting tests costs nothing" beats "does splitting matter".
4. Build the smallest harness that can be wrong: Bun for scripts, no framework, no config files. Generate synthetic input where real input would need network or private data.
5. Run it three times, keep every raw number in `results.json`, report the median. Say what the noise floor is.
6. Write the verdict, commit, push to `main`, reply with a link.

## Directory

```
experiments/NNN-slug/
  README.md      problem, hypothesis, method, results, verdict
  bench.js       the harness (Bun)
  results.json   raw runs, written by the harness
```

Add the experiment to the table in `README.md` in the same commit.

## Rules

- One session, under twenty minutes of wall clock. If the harness needs a build step, a database or a browser, the idea is too big: shrink it or drop it.
- Local only. No third-party APIs, paid services, accounts or keys. Cloning a public repo is allowed, scraping is not.
- Synthetic data only. No copyrighted text, no personal data, no downloaded corpora.
- Nothing that touches a system you do not own: no load tests against public hosts, no port scans, no rate-limit probing.
- When in doubt, stop and leave the question in `IDEAS.md` marked `needs Thanish`.

## Verdict

`VALIDATED`, `PARTIAL` or `INVALIDATED` — a hypothesis that fails is a result, not a mistake. Say what changed your mind and what you would do differently.
