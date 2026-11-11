# 020 — The packer changes the tarball's bytes, not its files

**Problem.** A package can be packed locally by `bun pm pack` and in CI by `npm pack`. Bun's
docs say `bun pm pack` "creates a `.tgz` file containing all files that would be published to
npm, following the same rules as `npm pack`" ([bun pm](https://bun.com/docs/pm/cli/pm)); npm
documents the `files` allowlist as the way to keep test fixtures and build output out of the
tarball ([package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[npm-pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)). Nobody states whether the two
tools agree on the file list, whether a second pack produces the same bytes, or what the speed
difference is made of.

**Hypothesis, stated before measuring.** Given a 1,503-file package with no dependencies, when
packed with both tools, then both ship the same file list and each tool reproduces its own bytes
on a re-run, so the packer is a CI-time choice and never an artefact decision: bun finishes under
a third of npm's time (my prior: 600 ms against 2,100 ms).

## Method

`bench.js` writes a synthetic package: 1,500 modules of 2 KB under `src/`, 800 fixtures of 8 KB
under `test/fixtures/`, 300 build files of 4 KB under `dist/`, `README.md`, `LICENSE`, and a
`package.json` with no dependencies. Two variants decide the file list: `files: ["src"]`, and no
`files` field with `.gitignore` holding `test/`, `dist/`. A third tree has no filter at all, to
price the allowlist.

For each variant and tool: a timed pack into a fresh directory, three times, after one discarded
warm-up; `sha256` of each tarball; the entry list from `tar -tzf`; and the payload — every
extracted file's `sha256`, mode and mtime — so order and compression cannot hide a content
difference. A scale sweep packs five more trees of 100 to 1,500 files at 64 B to 256 KB, plus one
with 20 files of 256 KB, to separate per-file cost from per-byte cost. Timing wraps
`spawnSync`, so process start counts. Host: Linux x64, 2 vCPU, Bun 1.4.4, npm 11.20.0,
Node 26.12.1. Raw runs in `results.json`.

Noise: spreads inside an arm run 0.4–2.9 %, except the 20-file npm arm at 11.4 %, so treat a gap
under 5 % as a tie.

## Results

Same files, same content, different bytes.

| Check                                         | `files: ["src"]`     | no `files`, `.gitignore` |
| --------------------------------------------- | -------------------- | ------------------------ |
| Entries in the tarball                        | 1,503 / 1,503        | 1,503 / 1,503            |
| File set, bun against npm                     | identical, 0 either way | identical, 0 either way |
| Payload: sha256, mode, mtime of every file    | identical, 1,503/1,503 | identical, 1,503/1,503 |
| Tarball size, bun / npm                       | 313,709 / 313,672 B  | 313,674 / 313,636 B      |
| `sha256` of the third pack against the first  | bun same, npm same   | bun same, npm same       |
| `sha256` bun against npm                      | different            | different                |

Both tools honour `files` and `.gitignore`, normalise every mtime to 1985-10-26 08:15, and
compress at gzip level 9. The only difference is entry **order**: bun writes `package.json`,
`LICENSE`, `README.md` and then `src/` in sorted order; npm writes `LICENSE`, then the `src/`
tree, and puts `package.json` and `README.md` at the end. Different order, different deflate
stream, different hash — 37 bytes apart on the `files` variant, 38 on the `.gitignore` one.

Pack time, median of three, milliseconds:

| Tree                            | bun   | npm   | ratio |
| ------------------------------- | ----- | ----- | ----- |
| 1,503 files, 3.07 MB            | 555   | 2,113 | 3.8×  |
| 1,500 files, 64 B each          | 51    | 1,226 | 24.1× |
| 100 files, 2 KB each            | 40    | 554   | 13.9× |
| 400 files, 2 KB each            | 152   | 900   | 5.9×  |
| 400 files, 8 KB each            | 704   | 1,852 | 2.6×  |
| 20 files, 256 KB each           | 1,282 | 2,607 | 2.0×  |
| no filter: 2,603 files, 10.9 MB | 2,196 | 5,554 | 2.5×  |

Three things follow.

1. **The speed edge is per file, not per byte.** Hold the bytes near zero and give both tools
   1,500 files of 64 B: npm takes 1,226 ms against bun's 51, which is 0.48 ms per file against
   4.4 µs. Hold the file count at 400 and multiply the bytes by four: npm pays 951 ms against
   bun's 552. npm's byte work runs at 0.30 ms/KB and bun's compression at 5.6 MB/s, so the two
   are 3.8× apart at 1,503 small files and 2.0× at 20 large ones.
2. **npm's `--dry-run` is not free.** It builds and compresses the tarball to report `shasum` and
   `integrity`: 2,064 ms dry against 2,113 ms real at 1,503 files. Bun's dry run only lists
   (11.5 ms), so a pre-publish check costs nothing in bun and two seconds in npm.
3. **The allowlist is worth 69 % of the bytes.** Without `files` or `.gitignore` the same tree
   packs 2,603 files and 1,026,289 bytes against 313,672, and npm's pack time falls from 5,554 ms
   to 2,113 ms.

## Verdict: PARTIAL

The file list and the per-tool reproducibility held exactly: 1,503 entries, no difference in
either variant, and three packs of the same tree with the same tool gave one `sha256`. The claim
that the packer is "never an artefact decision" failed. The two tools publish the same content in
a different order, so the tarball hash depends on which tool packed it, and a manifest that
records the hash is only valid for one of them.

### What worked

- Comparing payloads, not tarballs. `sha256` of the `.tgz` says "different"; per-file sha, mode
  and mtime say "same content, different wrapper". Without that split the result reads as a
  mismatch bug.
- The two filter variants. `files` and `.gitignore` agreeing in both tools is the claim I most
  doubted, and it took one table to answer for both.
- Sweeping file count and file size separately. One dimension alone gives "bun is 3.8× faster" or
  "bun is 2.1× faster"; both give the reason.

### What didn't

- Separating npm's file walk from its compression. `npm pack --dry-run` already compresses, so
  the 0.48 ms/file and 0.30 ms/KB are its two measurable slopes, not two internals.
- Testing cross-machine reproducibility. Both tools were run in one directory on one host; a pack
  from a different path or filesystem may move the hash for reasons this harness cannot see.
- The absolute byte numbers. Synthetic word-soup contents compress about 10:1, so the 3.07 MB
  tree packs to 313 KB. A real source tree would land nearer 3:1.

### Surprises

- Both tools zero the gzip timestamp and pin mtime to 1985-10-26, so neither needed a
  `SOURCE_DATE_EPOCH` to be reproducible on a re-run.
- The content is identical and the bytes are not. A release cache keyed on the tarball hash is
  reproducible within a tool and wrong across tools — the exact case the docs' "same rules" line
  invites.
- npm's file-count cost, 0.48 ms per file, is the whole gap. At 1,500 files of 64 B npm spends
  1,226 ms where bun spends 51; process start (126 ms, measured) plus the per-file work accounts
  for all of it, and none of it is compression.

### Recommendation for the real build

- Pick one packer and name it in the release script; run the other only to compare. Never mix
  them, and never compare a hash from one with a hash from the other.
- If a release records a `sha256`, record the packer and its version beside it. Bun's output was
  stable across three runs of one version, which is not the same as stable across upgrades.
- Keep the `files` allowlist in every package: it cuts the tarball 69 % here and npm's pack time
  with it. Prefer it over `.npmignore` — both tools read it, and it survives a move to bun.
- Do not swap the packer for the speed alone on a package with few large files: 2.0× is the
  floor of the win, and that is a one-second saving on a five-second pack.

## Limits

- No dependencies, no lifecycle scripts, no workspaces: `prepack` and `prepare` would add a
  second process to every run and were left out on purpose.
- One host, 2 vCPU, warm page cache. The per-byte slopes are gzip-bound and will move with the
  compressor each tool ships; the per-file slope is the portable number.
- Two versions only: Bun 1.4.4 and npm 11.20.0. Bun's packer is young, so the ordering rule is
  the part most likely to change.
- Nothing here tests what the registry does with the tarball, or how `npm publish` differs from
  `npm pack` on the same tree.
