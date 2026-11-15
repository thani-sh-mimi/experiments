// 024 — what does shipping a compiled CLI cost against shipping the source?
// Shapes: `bun build --compile` (plain), `--minify` only, the documented
// production flags (--minify --sourcemap --bytecode), and a source tarball run
// with `bun run`. Synthetic module graph, swept at 1…4,000 modules.
//
// HYPOTHESIS (written before the first number): an executable is a copy of the
// Bun runtime with the program attached, so 2,000 modules add under 1 MB
// (<1%) to the ~109 MB file, and start-up on the compiled binary beats
// `bun run` on the same tree by under 50 ms. If both hold, a CLI shipped to
// machines that already have Bun should ship the tarball.
import { rm, mkdir, writeFile, stat, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const TMP = join(ROOT, "tmp");
const SIZES = [1, 20, 100, 500, 1000, 2000, 4000];
const BUILD_RUNS = 3;
const START_RUNS = 15;
const WARMUP = 3;
const COMPILED = [
  { key: "plain", flags: [] },
  { key: "minify", flags: ["--minify"] },
  { key: "bytecode", flags: ["--minify", "--sourcemap", "--bytecode"] },
];

const now = () => performance.now();
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (xs) => ({ min: Math.min(...xs), max: Math.max(...xs) });

function sh(cmd, opts = {}) {
  const t0 = now();
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", ...opts });
  return { ms: now() - t0, code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

// ---------- synthetic module graph ----------
async function generate(dir, n) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src"), { recursive: true });
  for (let i = 0; i < n; i++) {
    const body =
      `// module ${i}\nexport const v${i}: number = ${i};\n` +
      `export function f${i}(x: number): number {\n  return x * 3 + ${i};\n}\n`;
    await writeFile(join(dir, "src", `m${i}.ts`), body);
  }
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`import * as m${i} from "./m${i}";`);
  lines.push("let sum = 0;");
  for (let i = 0; i < n; i++) lines.push(`sum += m${i}.f${i}(m${i}.v${i});`);
  lines.push("console.log(sum);");
  await writeFile(join(dir, "src", "entry.ts"), lines.join("\n") + "\n");
  return join(dir, "src", "entry.ts");
}

async function sourceBytes(dir) {
  const files = (await readdir(join(dir, "src"))).sort();
  let raw = 0;
  const parts = [];
  for (const f of files) {
    const b = await Bun.file(join(dir, "src", f)).bytes();
    raw += b.length;
    parts.push(b);
  }
  return { raw, gzip: gzipSync(Buffer.concat(parts), { level: 9 }).length, files: files.length };
}

function startMs(argv, cwd, expect) {
  const samples = [];
  for (let i = 0; i < START_RUNS + WARMUP; i++) {
    const t0 = now();
    const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const dt = now() - t0;
    const out = p.stdout.toString().trim();
    if (p.exitCode !== 0 || out !== String(expect))
      throw new Error(`start failed: ${argv.join(" ")} :: code ${p.exitCode} out "${out}" err "${p.stderr}"`);
    if (i >= WARMUP) samples.push(dt);
  }
  return { med: median(samples), ...spread(samples), n: samples.length, raw: samples };
}

// sum of f_i(v_i) = v_i*3 + i over i in [0, n) — the harness checks the binary
// prints the same number the source run does, so a "fast" shape cannot be fast
// because it did less work.
const expected = (n) => (3 * ((n - 1) * n)) / 2 + ((n - 1) * n) / 2;

const results = { meta: {}, spawnFloor: null, sizes: [] };

const floor = [];
for (let i = 0; i < START_RUNS; i++) {
  const t0 = now();
  Bun.spawnSync(["/bin/true"]);
  floor.push(now() - t0);
}
results.spawnFloor = { med: median(floor), ...spread(floor) };

results.meta = {
  bun: sh(["bun", "--version"]).out.trim(),
  bunBinaryBytes: (await stat(await Bun.resolve(sh(["bash", "-lc", "command -v bun"]).out.trim(), "/"))).size,
  cpus: sh(["bash", "-lc", "nproc"]).out.trim(),
  host: sh(["bash", "-lc", "uname -sr"]).out.trim(),
  startRuns: START_RUNS,
  buildRuns: BUILD_RUNS,
  flags: COMPILED,
  at: new Date().toISOString(),
};

for (const n of SIZES) {
  const dir = join(TMP, `n${n}`);
  const entry = await generate(dir, n);
  const src = await sourceBytes(dir);
  const row = { modules: n, source: src, shapes: {} };

  for (const shape of COMPILED) {
    const rec = { flags: shape.flags, buildMs: [], bytes: 0 };
    for (let r = 0; r < BUILD_RUNS; r++) {
      const out = join(dir, `cli-${shape.key}`);
      await rm(out, { force: true });
      const b = sh(["bun", "build", "--compile", ...shape.flags, entry, "--outfile", out]);
      if (b.code !== 0) throw new Error(`${shape.key} compile failed: ${b.err}`);
      rec.buildMs.push(b.ms);
      rec.bytes = (await stat(out)).size;
      if (r === BUILD_RUNS - 1) {
        rec.gzip = gzipSync(await Bun.file(out).bytes(), { level: 6 }).length;
        rec.start = startMs([out], dir, expected(n));
        await rm(out, { force: true });
      }
    }
    rec.buildMed = median(rec.buildMs);
    row.shapes[shape.key] = rec;
  }

  const srcShape = { flags: [], buildMs: [0], buildMed: 0, bytes: src.raw, gzip: src.gzip };
  srcShape.start = startMs(["bun", "run", entry], dir, expected(n));
  row.shapes.source = srcShape;

  results.sizes.push(row);

  const f = (x) => x.toFixed(1).padStart(7);
  console.log(
    `n=${String(n).padStart(4)}  ` +
      COMPILED.map((s) => `${s.key} ${f(row.shapes[s.key].start.med)}ms ${(row.shapes[s.key].bytes / 1048576).toFixed(1)}MiB/${f(row.shapes[s.key].buildMed)}ms`).join("  ") +
      `  | source ${f(srcShape.start.med)}ms ${(src.gzip / 1024).toFixed(0)}KiB`,
  );

  await rm(dir, { recursive: true, force: true });
}

await writeFile(join(ROOT, "results.json"), JSON.stringify(results, null, 2));
console.log("\nspawn floor", results.spawnFloor.med.toFixed(2), "ms · bun", results.meta.bun,
  "· bun binary", (results.meta.bunBinaryBytes / 1048576).toFixed(1), "MiB");
