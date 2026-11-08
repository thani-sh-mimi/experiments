// Extra: does the minify win survive brotli?
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const base = join(import.meta.dir, "tmp");
const out = {};
for (const [label, flags] of [
  ["plain", []],
  ["minify", ["--minify"]],
]) {
  const outdir = join(base, `cmp-${label}`);
  const proc = Bun.spawnSync(
    [
      "bun",
      "build",
      join(base, "src-4000", "app", "entry.ts"),
      "--target=bun",
      "--outdir",
      outdir,
      ...flags,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    process.exit(1);
  }
  const raw = readFileSync(join(outdir, "entry.js"));
  out[label] = {
    bytes: raw.length,
    gzip: gzipSync(raw, { level: 9 }).length,
    brotli: brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}
console.log(JSON.stringify(out, null, 2));
console.log(
  "raw cut",
  (100 * (1 - out.minify.bytes / out.plain.bytes)).toFixed(1) + "%",
  "gzip cut",
  (100 * (1 - out.minify.gzip / out.plain.gzip)).toFixed(1) + "%",
  "brotli cut",
  (100 * (1 - out.minify.brotli / out.plain.brotli)).toFixed(1) + "%",
);
