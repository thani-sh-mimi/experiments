# 027 — each revision of a 1 MiB asset costs a whole megabyte in `.git`

## Problem

Git stores every version of every file. For text it stores a delta, so an edit
costs the size of the edit. For a binary it often stores the whole file again.
Almost every team learns this after a clone gets slow, and the usual advice is
"run `git gc`" or "use LFS", with no number attached. An agent that commits a
build artifact or a screenshot is the way it usually starts, because the gate
that would have caught a 1 MiB file does not exist yet.

So: what does one revision of a 1 MiB asset add to `.git`, what does `git gc`
give back, and what does the cheapest alternative — a pointer file — cost?

## Hypothesis

Written before the first run: each revision of a 1 MiB binary that changes
substantially adds about 1.0 MiB to `.git`, and `git gc` returns under 5 % of it.
One MiB of text that edits 1 % of its lines per revision stays under 20 KiB per
revision. If so, the decision is a pre-commit gate at 1 MiB — GitHub's
recommended single-object maximum — because the only cheap moment to keep an
asset out of history is before the first commit.

## Method

`bench.js` builds a throwaway repo per case under `tmp/027/`, 100 revisions of a
1 MiB file each, then measures the loose `.git`, `git gc --prune=now`, the pack
file, and a `git clone --no-local` of the result. Four cases:

- **binary-rewrite** — 1 MiB of fresh random bytes each revision: a re-encoded
  image or a rebuilt archive.
- **binary-shift** — the same buffer with 10 KiB (1 %) rewritten in place: a
  metadata edit.
- **text-edit** — 1 MiB of synthetic TypeScript, 1 % of its lines rewritten.
- **pointer** — a 130-byte LFS pointer file per revision; the blob goes to a
  directory outside the repo and is counted separately.

Three runs per case; the table reports medians. `scale.js` repeats the worst case
at 256 KiB, 1 MiB and 4 MiB over 50 revisions to test for a linear law.

Noise floor: every byte count was identical across the three runs, except
binary-shift's pack (7.0–7.2 MiB, because delta choice depends on offsets that
differ per run). Timings spread about 5 %. Host: 6 vCPU, Linux 6.12, git 2.47.3,
Bun 1.4.4, zlib default.

## Results

100 revisions of a 1 MiB file, median of three runs:

| case                             | loose `.git` | pack after gc | per revision | fresh clone         |
| -------------------------------- | ------------ | ------------- | ------------ | ------------------- |
| binary, re-encoded each time     | 100.1 MiB    | 100.1 MiB     | 1,035 KiB    | 100.1 MiB, 1,577 ms |
| binary, 1 % rewritten in place   | 100.1 MiB    | 7.2 MiB       | 74 KiB       | 7.2 MiB, 378 ms     |
| text, 1 % of lines edited        | 16.3 MiB     | 1.03 MiB      | 10.6 KiB     | 1.05 MiB, 371 ms    |
| LFS pointer, blob stored outside | 0.08 MiB     | 0.04 MiB      | 0.4 KiB      | 0.07 MiB, 30 ms     |

`git gc` gave back 0.04 % on the re-encoded binary: 100.10 MiB of loose objects
became 100.06 MiB of pack. Packing cost 9.2 s, against 1.7 s for the 7.2 MiB
case. The commit itself paid nothing extra: 11.5 ms per commit in all three
1 MiB cases, because the blob is hashed and zlib-compressed either way.

The law is linear in size. 50 revisions of fresh random bytes per run:

| file size | pack       | per revision | share of the file |
| --------- | ---------- | ------------ | ----------------- |
| 256 KiB   | 12.52 MiB  | 261.6 KiB    | 102.2 %           |
| 1 MiB     | 50.03 MiB  | 1,045.5 KiB  | 102.1 %           |
| 4 MiB     | 200.08 MiB | 4,181.2 KiB  | 102.1 %           |

All three runs returned the same bytes. The 2 % above the file size is the
commit and tree objects.

Neither delta case is as cheap as it looks. Both packs hold 5 whole copies and 95
deltas, so the pack is mostly the copies:

| case         | whole copies                | 95 deltas   | delta size range   |
| ------------ | --------------------------- | ----------- | ------------------ |
| binary-shift | 5,242,880 B, zlib saved 0 % | 2,252,340 B | 10 KiB to 265 KiB  |
| text-edit    | 835,841 B, zlib saved 84 %  | 212,161 B   | 2.2 KiB to 4.6 KiB |

Extrapolated from the measured 1,035 KiB per revision: 1,013 revisions of one
1 MiB asset reach 1 GiB of history, which is GitHub's recommended repository
size, and every clone pays all of it.

## Verdict: VALIDATED

### What worked

- The 1.0 MiB per revision prediction held at 1,035 KiB, and the linear law held
  at three sizes with identical byte counts.
- `git gc` recovered nothing on incompressible content, as predicted, and 93.7 %
  on text. The pack is not a repair pass.
- The pointer file is 2,500× cheaper than the blob it points at in history
  (40 KiB against 100.1 MiB), which is the whole case for LFS.

### What didn't

- The 20 KiB prediction for text held at 10.6 KiB, but for the wrong reason: the
  delta is not the edit. 84 % of the text pack is five compressed whole copies,
  and the deltas are 2.2 KiB each.

### Surprises

- A 1 % in-place edit of a binary is not a 1 % cost. It came to 74 KiB per
  revision, 7.4× the edit, because each delta runs from the nearest whole copy:
  the largest deltas (193–265 KiB, depth 1) carry 19–25 revisions of edits at
  once, and zlib gives nothing back on random bytes.
- Loose objects from text are 16.3 MiB for 100 revisions, not 100 MiB, because
  each loose blob is zlib-compressed on write. A hook that measures `.git` size
  before `gc` sees a very different number for text than for a binary.

### Recommendation for the real build

- Gate at 1 MiB per blob before the first commit. That is GitHub's recommended
  single-object maximum, and below it 1,000 revisions still cost 1 GiB.
- Send assets over the gate to a release artifact or an LFS pointer. Test the
  gate on the blob size, not the path, and allow a declared exception list.
- Never plan to remove the asset later: removal needs a history rewrite, and
  every clone has already paid for it.

## Limits

Random bytes are the worst case; a PNG that keeps most of its pixels compresses
like `binary-shift`, which still cost 74 KiB per revision. Only local filesystem
and `--no-local` clone were measured, so network transfer is modelled by bytes,
not timed. The pointer case simulates LFS with a directory, so no LFS server,
batch API or checkout filter ran. `git gc` used default settings; `pack.window`,
`pack.depth` and `core.bigFileThreshold` were left alone. 100 revisions per case,
one file per repo.

## Sources

- [GitHub repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
  — 1 MB recommended single object, 100 MB enforced, 10 GB `.git`; recommends
  LFS for binaries.
- [Atlassian: How to handle big repositories with Git](https://www.atlassian.com/git/tutorials/big-repositories)
  — git stores each version of a binary in full, `git gc` repacks but does not
  shrink incompressible content.
