# 015 — What a cache restore costs: tar, tar.gz, tar.zst on 20,000 files

**Problem.** CI restores dependencies from a tarball at the top of every job. The published
advice is about size: compress more, cache less. BuildPulse puts a 1.2 GB `node_modules`
restore at 38 s on a GitHub runner and 90 s at 3 GB
([buildpulse.io](https://buildpulse.io/blog/github-actions-cache-optimization-benchmarks)).
None of that tells us which part of the 38 s is the archive and which part is 20,000 small
files landing on disk, so it does not say what to change. If restore is file-bound, the
codec is the wrong lever and no compression level will move the number.

**Hypothesis, stated before measuring.** On a 20,000-file, 300 MB tree, a plain `.tar`
restores in under 2 s, and `.tar.zst -1` restores within 15 % of it while shipping about
70 % fewer bytes. The decision: if both hold, cache tooling defaults to `zstd -1`, stops
tuning levels, and treats archive format as a minor lever next to file count.

## Method

`bench.js` generates a synthetic `node_modules`-shaped tree — 20,000 files of pseudo-JS
text, 12–24 KB each, 300.9 MB, in 5,000 package directories — and one 340 MB single file
as the same bytes without the file count. It builds six archives and times extraction into
an empty directory: three sessions of three runs after one warm-up, so each number is the
median of nine timings. File count and byte count are verified after every extract.
Archive creation is timed three times.

Host: Linux x64, 2 vCPU, ext4, warm page cache, GNU tar 1.35, zstd 1.5.7, Bun 1.4.4.
Raw runs in `results.json`.

Noise: session medians move 0.1–2.3 % for the tar arms, 1.7 % for `cp`; creation is far
noisier (up to 2.5× across samples) because the tree was just written. Treat extract
differences under 5 % as equal, and creation numbers as order of magnitude only.

## Results

Extraction, medians of nine runs. The 20,000-file tree, 300.9 MB of payload:

| Restore                  | Archive  | Extract      | vs plain tar |
| ------------------------ | -------- | ------------ | ------------ |
| `cp -a` (no archive)     | —        | 2,358 ms     | +47 %        |
| `tar`                    | 321.3 MB | **1,603 ms** | —            |
| `tar.zst -1`             | 93.6 MB  | 1,692 ms     | +5.6 %       |
| `tar.zst -3`             | 93.7 MB  | 1,695 ms     | +5.7 %       |
| `tar.gz -6` (`tar -czf`) | 86.5 MB  | 2,633 ms     | +64 %        |
| `tar.gz -1`              | 102.0 MB | 3,021 ms     | +88 %        |

One 340 MB file, same commands: `tar` 348 ms (340.0 MB), `tar.zst -1` 905 ms (104.6 MB),
`tar.gz -1` 2,812 ms (96.0 MB).

Creation, median of three: `zstd -1` 1,885 ms, `zstd -3` 2,806 ms, `gzip -1` 11,305 ms,
`gzip -6` 23,935 ms. zstd -1 builds the archive 12.7× faster than the default `tar -czf`.

Decomposition: 20,000 files add 1,254 ms over the same bytes in one file, or 62.7 µs per
file — 78 % of the plain-tar restore. Decompressing the 227 MB that zstd removed costs
89 ms. The file count is the restore; the bytes are the errand.

Bandwidth where a compressed archive beats plain tar (extract cost plus download, equal
bytes); above this the uncompressed archive is faster:

| Format    | 20k-file tree | one big file |
| --------- | ------------- | ------------ |
| `zstd -1` | 20,457 Mbps   | 3,388 Mbps   |
| `gz -6`   | 1,823 Mbps    | —            |
| `gz -1`   | 1,237 Mbps    | 792 Mbps     |

## Verdict: VALIDATED

### What worked

- Plain tar restored in 1.60 s, under the 2 s predicted.
- `zstd -1` cost 5.6 % over plain tar and shipped 71 % fewer bytes — inside the 15 % bound.
- Byte cost and file cost separate cleanly: 62.7 µs per file, 89 ms per 227 MB of zstd
  decompression.

### What didn't

- The "gzip is fine, it's only slightly slower" reading. gzip -6 adds 1.03 s per restore,
  64 % over plain tar; gzip -1 is worse still, at 3.02 s — smaller compression effort made
  a bigger archive, and inflate work follows compressed bytes.
- Tuning the zstd level. `-1` and `-3` extract within 3 ms of each other and produce
  archives within 0.2 % in size. The level only moves creation time.

### Surprises

- Extracting a tarball beats copying the directory tree: `cp -a` took 2.36 s against
  1.60 s, because it copies attributes file by file.
- `tar` inflates the payload: 300.9 MB of files became a 321.3 MB archive. Twenty thousand
  headers cost 20 MB, 6.4 % of the upload, to store nothing.
- 227 MB less to download bought only 89 ms of CPU here — this VM decodes zstd at about
  610 MB/s end to end, well under the 1.3 GB/s published for [plain decompression](https://vivianvoss.net/blog/zstd-one-speed),
  because tar also writes 300 MB to disk.

### Recommendation for the real build

- Default cache archives to `tar --zstd -1`, not `tar -czf`: 1.03 s per job, and 12× less
  time in the save step.
- Stop tuning compression level. Pick the codec on restore cost, not ratio.
- Price a cache in files, not megabytes. At 62.7 µs per file, splitting a 20,000-file cache
  into more, smaller keys costs more than it saves unless the hit rate moves.

## Limits

- One 2-vCPU sandbox, warm page cache, no network: the bandwidth table is a model of
  download time, not a measurement of it.
- Synthetic text compresses 3.2× with zstd against the 3–5× a real `node_modules` shows; a
  less compressible tree shrinks the byte saving and moves every crossover left.
- The 62.7 µs per file is a difference between two trees, so it also carries the cost of
  many small writes versus one large one, not only `open`/`close`.
- Single-threaded decoders, as the tools run by default in CI.
