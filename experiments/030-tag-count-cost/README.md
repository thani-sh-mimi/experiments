# 030 — A tag costs 12.6 µs in `git tag`, and nothing in `git status`

## Problem

A repo that tags every release, or every build, accumulates thousands of refs.
Common advice says the count hurts git. Atlassian reports a ref advertisement as
the first cost of every fetch, and that loose refs are slow to list until
`git gc` packs them; Bitbucket warns that over 3,000 tags cause timeouts. None of
that says what a tag costs a local command — the ones a commit hook, a CI step or
an agent loop runs.

The question: what does each tag cost `git tag`, `git describe`, `git status`
and three other commands, loose against packed, and at what count does
`pack-refs` pay for itself?

## Hypothesis

Written before the first run: a loose tag costs about 20 µs to a local `git`
command, so 10,000 tags add under 200 ms and 50,000 under a second. `pack-refs`
removes most of that. If so, a tag-heavy repo needs one scheduled `pack-refs`,
not a policy against tags.

## Method

`bench.js` (Bun) builds repos under `/tmp/spike-030`: a `main` branch, 200
commits, then 0, 100, 1,000, 10,000 or 50,000 tags made with
`git update-ref --stdin`, spread over the history. Each repo is measured twice:
as loose refs, then after `git pack-refs --all`, which leaves no files in
`.git/refs/tags`.

Commands, each spawned as a real process with a warm-up run and three timed
runs, median reported: `git tag`, `git for-each-ref`, `git describe --tags`,
`git status --porcelain`, `git log -1`, `git rev-parse --short HEAD`,
`git checkout -B probe`.

`lsremote.js` then measures the transport side on local paths only:
`git ls-remote` and a `--bare --no-hardlinks` clone of the 10,000 and 50,000
tag repos.

Noise floor: twelve repeats of the cheapest cell spread 1.9–2.3 ms on `git tag`
(±0.4 ms) and 2.7–2.9 ms on `git status` (±0.2 ms). Host: 6 vCPU, Linux 6.12,
git 2.47.3, page cache warm.

## Results

Median of three runs, milliseconds.

| tags   | layout | tag   | for-each-ref | describe | status | log -1 | rev-parse | checkout -B |
| ------ | ------ | ----- | ------------ | -------- | ------ | ------ | --------- | ----------- |
| 0      | loose  | 2.1   | 2.0          | 7.5      | 2.7    | 2.6    | 2.1       | 3.5         |
| 1,000  | loose  | 14.7  | 14.4         | 18.2     | 2.7    | 2.4    | 2.0       | 3.4         |
| 10,000 | loose  | 128.5 | 126.7        | 122.5    | 2.6    | 2.4    | 2.0       | 3.3         |
| 50,000 | loose  | 632.3 | 630.5        | 589.2    | 2.6    | 2.4    | 2.0       | 3.3         |
| 0      | packed | 2.0   | 2.0          | 7.7      | 2.8    | 2.4    | 2.0       | 3.4         |
| 10,000 | packed | 14.8  | 13.0         | 4.3      | 2.7    | 2.4    | 2.1       | 3.5         |
| 50,000 | packed | 66.1  | 58.1         | 12.3     | 2.7    | 2.5    | 2.1       | 3.5         |

Per tag above the zero-tag baseline:

| layout | `git tag` | `for-each-ref` | `describe` |
| ------ | --------- | -------------- | ---------- |
| loose  | 12.6 µs   | 12.6 µs        | 11.6 µs    |
| packed | 1.28 µs   | 1.12 µs        | 0.09 µs    |

`pack-refs` itself costs 89.5 µs per tag: 94 ms at 1,000, 896 ms at 10,000,
4.48 s at 50,000. At 10,000 tags it saves 113.7 ms per listing command, so it
pays back after eight of them. The ratio holds at 50,000: 566 ms saved per call,
eight calls.

Disk, from `du -sk` of the repo directory, 50,000 tags: 203 MB loose against
6.2 MB packed, because each ref file takes a 4 KiB block.

Transport, local paths: `git ls-remote` 788 ms loose against 207 ms packed at
50,000 tags; a bare clone 1,895 against 1,311 ms, both writing 6.2 MB.

## Verdict: VALIDATED

### What worked

- The cost is linear and small: 12.6 µs per loose tag, so 10,000 tags add
  126 ms and 50,000 add 630 ms. My 20 µs estimate was 1.6× high.
- Packing removes 90 % of it for `git tag` and essentially all of it for
  `describe`, which has a sorted index to search: 0.09 µs per tag.
- `git status`, `git log -1`, `git rev-parse` and `git checkout -B` do not move
  at all between 0 and 50,000 tags. They never enumerate tags, so the hook
  budget fears nothing here.

### What didn't

- "A local `git` command" in my hypothesis was too broad. Only commands that
  list refs pay; the four most common commands are flat at 2.0–3.5 ms.
- Packed refs are cheaper, not free. 50,000 packed tags still cost 66 ms per
  listing, ten times the zero-tag baseline, and 6.2 MB of `packed-refs`.
- A local clone saved only 31 % from packing (1,895 to 1,311 ms). The remaining
  time is object negotiation over 500 KiB of history, not refs.

### Surprises

- The disk cost dwarfs the time cost: 192 MB more block space for 2 MB of ref
  content, 32× the packed repo. A tag per build fills a small disk before it
  slows a command.
- `describe` costs 7.5 ms with no tags and 5.8 ms with 100 loose ones — noise at
  that size, and a reminder that a single run at low counts proves nothing.
- `pack-refs` is cheap per tag but not cheap: 4.5 s at 50,000. Run it in the
  release job, not in a hook that lists tags.

### Recommendation for the real build

- Do not ration tags for local speed. At a few hundred tags a year the cost is
  under 5 ms and invisible.
- Add `git pack-refs --all` to the release job, or `gc.writeCommitGraph` and
  `maintenance` equivalents. It pays back in eight tag-listing commands and
  returns about 97 % of the disk.
- If a CI step runs `git describe` or `git tag` per commit, pack refs or pass
  `--no-tags` to the fetch. At 50,000 tags that is 0.6 s per call, on every job.

## Limits

Warm page cache on one host, three runs, synthetic tags on a synthetic 200-commit
history. All commands spawn on the same filesystem; a networked filesystem would
raise the per-file cost of loose refs and lower the crossover. The transport
numbers come from a local path, so they price ref enumeration and packing, not a
network round trip. Sources read: [Atlassian on
monorepos](https://www.atlassian.com/git/tutorials/monorepos), [Git docs for
`pack-refs`](https://git-scm.com/docs/git-pack-refs), and [Git Rev News 103 on
tag transfer during
fetch](https://git.github.io/rev_news/2023/09/30/edition-103/).
