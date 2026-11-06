// 015 — what a cache restore costs: tar, tar.gz, tar.zst on a 20k-file tree.
// Bun: `bun run bench.js`. Writes results.json next to this file.
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";

const ROOT = new URL(".", import.meta.url).pathname;
const TMP = `${ROOT}tmp`;
const SRC = `${TMP}/src`; // 20k small files, ~300 MB, node_modules shape
const BIG = `${TMP}/big`; // one 300 MB file: bytes without the file count
const OUT = `${TMP}/out`;
const ARCH = `${TMP}/arch`;

const FILES = 20_000;
const AVG_BYTES = 15_000;
const BIG_BYTES = 300 * 1024 * 1024;
const SESSIONS = 3;
const RUNS = 3;

// deterministic pseudo-random text, node_modules-like: imports, identifiers, repeats
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "export",
  "const",
  "function",
  "return",
  "module",
  "exports",
  "require",
  "define",
  "prototype",
  "callback",
  "async",
  "await",
  "class",
  "extends",
  "Object",
  "Array",
  "Promise",
  "this",
  "value",
  "options",
];

function body(rnd, bytes) {
  const parts = [];
  let n = 0;
  let line = "// synthetic module for a cache-restore experiment\n";
  while (n < bytes) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)];
    const id = Math.floor(rnd() * 1e6).toString(36);
    line = `  ${w} ${id}${w[0]} = ${w}(${id}, ${Math.floor(rnd() * 100)});\n`;
    parts.push(line);
    n += line.length;
  }
  return parts.join("");
}

async function genTree(dir, files, avgBytes) {
  rmSync(dir, { recursive: true, force: true });
  const rnd = mulberry32(42);
  let bytes = 0;
  for (let i = 0; i < files; i++) {
    const pkg = `${dir}/pkg-${String(Math.floor(i / 4)).padStart(5, "0")}`;
    const sub = i % 4 === 0 ? pkg : `${pkg}/lib`;
    mkdirSync(sub, { recursive: true });
    // vary size ±40 % so the tree is not uniform
    const text = body(rnd, Math.floor(avgBytes * (0.6 + rnd() * 0.8)));
    await Bun.write(`${sub}/f${String(i).padStart(5, "0")}.js`, text);
    bytes += text.length;
  }
  return { files, bytes };
}

function statTree(dir) {
  let files = 0,
    bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else {
        files++;
        bytes += statSync(p).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

function run(cmd, env) {
  const t = performance.now();
  const r = Bun.spawnSync({
    cmd,
    stdout: "ignore",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined,
  });
  const ms = performance.now() - t;
  if (r.exitCode !== 0)
    throw new Error(
      `${cmd.join(" ")} failed: ${r.stderr.toString().slice(0, 300)}`,
    );
  return ms;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x) => Math.round(x * 100) / 100;

// variants: name -> { mk: create archive, ex: extract argv }
const VARIANTS = {
  cp: { ex: (dst) => ["cp", "-a", `${SRC}/.`, dst] },
  tar: {
    mk: (out) => ["tar", "-cf", out, "-C", SRC, "."],
    ex: (dst) => ["tar", "-xf", `${ARCH}/tree.tar`, "-C", dst],
  },
  gz1: {
    mk: (out) => ["tar", "-c", "-I", "gzip -1", "-f", out, "-C", SRC, "."],
    ex: (dst) => [
      "tar",
      "-x",
      "-I",
      "gzip -1",
      "-f",
      `${ARCH}/tree.gz1`,
      "-C",
      dst,
    ],
  },
  gz6: {
    mk: (out) => ["tar", "-czf", out, "-C", SRC, "."],
    ex: (dst) => ["tar", "-xzf", `${ARCH}/tree.tgz`, "-C", dst],
  },
  zst1: {
    mk: (out) => ["tar", "-c", "-I", "zstd -1 -T0", "-f", out, "-C", SRC, "."],
    ex: (dst) => [
      "tar",
      "-x",
      "--zstd",
      "-f",
      `${ARCH}/tree.tar.zst`,
      "-C",
      dst,
    ],
  },
  zst3: {
    mk: (out) => ["tar", "-c", "-I", "zstd -3 -T0", "-f", out, "-C", SRC, "."],
    ex: (dst) => ["tar", "-x", "--zstd", "-f", `${ARCH}/tree.zst3`, "-C", dst],
  },
  big_tar: {
    big: true,
    ex: (dst) => ["tar", "-xf", `${ARCH}/big.tar`, "-C", dst],
  },
  big_zst1: {
    big: true,
    ex: (dst) => [
      "tar",
      "-x",
      "--zstd",
      "-f",
      `${ARCH}/big.tar.zst`,
      "-C",
      dst,
    ],
  },
  big_gz1: {
    big: true,
    ex: (dst) => ["tar", "-xzf", `${ARCH}/big.tgz`, "-C", dst],
  },
};

function timeExtract(name, v, sessions = SESSIONS) {
  const samples = [];
  const sessionMedians = [];
  for (let s = 0; s < sessions; s++) {
    const inSession = [];
    run(v.ex(OUT)); // warm-up, also fills page cache for the archive
    rmSync(OUT, { recursive: true, force: true });
    for (let i = 0; i < RUNS; i++) {
      rmSync(OUT, { recursive: true, force: true });
      mkdirSync(OUT, { recursive: true });
      const ms = run(v.ex(OUT));
      inSession.push(ms);
      samples.push(ms);
    }
    sessionMedians.push(median(inSession));
  }
  return {
    median: round(median(samples)),
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
    sessionMedians: sessionMedians.map(round),
    spread: round(
      (Math.max(...sessionMedians) / Math.min(...sessionMedians) - 1) * 100,
    ),
    samples: samples.map(round),
  };
}

const results = {
  date: "2026-11-06",
  host: {
    platform: process.platform,
    cpus: navigator.hardwareConcurrency,
    bun: Bun.version,
  },
  config: {
    files: FILES,
    avgBytes: AVG_BYTES,
    sessions: SESSIONS,
    runsPerSession: RUNS,
  },
};

console.log("generating tree…");
mkdirSync(TMP, { recursive: true });
mkdirSync(ARCH, { recursive: true });
results.tree = await genTree(SRC, FILES, AVG_BYTES);
results.bigfile = await genTree(BIG, 1, BIG_BYTES);
console.log("tree:", results.tree, "big:", results.bigfile);

// create archives, three timed runs each
results.create = {};
const ARCHIVE = {
  tar: `${ARCH}/tree.tar`,
  gz1: `${ARCH}/tree.gz1`,
  gz6: `${ARCH}/tree.tgz`,
  zst1: `${ARCH}/tree.tar.zst`,
  zst3: `${ARCH}/tree.zst3`,
};
for (const [name, v] of Object.entries(VARIANTS)) {
  if (!v.mk) continue;
  const dst = ARCHIVE[name];
  const times = [];
  for (let i = 0; i < RUNS; i++) times.push(run(v.mk(dst)));
  results.create[name] = {
    median: round(median(times)),
    samples: times.map(round),
  };
}

// big-file archives
run(["tar", "-cf", `${ARCH}/big.tar`, "-C", BIG, "."]);
process.env.GZIP = "-1";
run(["tar", "-czf", `${ARCH}/big.tgz`, "-C", BIG, "."]);
run([
  "tar",
  "-c",
  "-I",
  "zstd -1 -T0",
  "-f",
  `${ARCH}/big.tar.zst`,
  "-C",
  BIG,
  ".",
]);

results.archives = {};
for (const f of readdirSync(ARCH))
  results.archives[f] = { bytes: statSync(`${ARCH}/${f}`).size };

console.log("extracting…");
results.extract = {};
for (const [name, v] of Object.entries(VARIANTS)) {
  if (name.startsWith("big")) continue;
  results.extract[name] = timeExtract(name, v);
  console.log(name, results.extract[name].median, "ms");
  if (name !== "cp") {
    const got = statTree(OUT);
    results.extract[name].verified =
      got.files === results.tree.files && got.bytes === results.tree.bytes;
  }
}

results.bigExtract = {};
for (const [name, v] of Object.entries(VARIANTS)) {
  if (!name.startsWith("big")) continue;
  results.bigExtract[name] = timeExtract(name, v);
  console.log(name, results.bigExtract[name].median, "ms");
}

// per-file and per-byte decomposition, from the small-file and big-file arms
const tTar = results.extract.tar.median;
const tBigTar = results.bigExtract.big_tar.median;
const bytes = results.archives["tree.tar"].bytes;
results.decomposition = {
  fixedMs: round(Math.max(0, tTar - tBigTar)),
  perFileUs: round(((tTar - tBigTar) / FILES) * 1000),
  note: "tar vs one-file tar at the same byte count: the difference is the file count",
};

// crossover: bandwidth (Mbps) at which a compressed archive beats plain tar
const ns = (name) => results.archives[name]?.bytes ?? 0;
const cross = (tarName, compName, tTarMs, tCompMs) => {
  const savedBytes = ns(tarName) - ns(compName);
  const extraMs = tCompMs - tTarMs;
  return {
    bytesSaved: savedBytes,
    extraRestoreMs: round(extraMs),
    // ms = bytes*8/Mbps/1000 -> Mbps where extra time equals download saving
    breakEvenMbps: extraMs <= 0 ? 0 : round((savedBytes * 8) / extraMs / 1000),
  };
};
results.crossover = {
  small: {
    zst1: cross(
      "tree.tar",
      "tree.tar.zst",
      results.extract.tar.median,
      results.extract.zst1.median,
    ),
    zst3: cross(
      "tree.tar",
      "tree.zst3",
      results.extract.tar.median,
      results.extract.zst3.median,
    ),
    gz1: cross(
      "tree.tar",
      "tree.gz1",
      results.extract.tar.median,
      results.extract.gz1.median,
    ),
    gz6: cross(
      "tree.tar",
      "tree.tgz",
      results.extract.tar.median,
      results.extract.gz6.median,
    ),
    zst1_vs_gz6: {
      bytesSaved: ns("tree.tgz") - ns("tree.tar.zst"),
      extraRestoreMs: round(
        results.extract.zst1.median - results.extract.gz6.median,
      ),
      breakEvenMbps: round(
        ((ns("tree.tgz") - ns("tree.tar.zst")) * 8) /
          Math.max(
            0.001,
            results.extract.zst1.median - results.extract.gz6.median,
          ) /
          1000,
      ),
    },
  },
  big: {
    zst1: cross(
      "big.tar",
      "big.tar.zst",
      results.bigExtract.big_tar.median,
      results.bigExtract.big_zst1.median,
    ),
    gz1: cross(
      "big.tar",
      "big.tgz",
      results.bigExtract.big_tar.median,
      results.bigExtract.big_gz1.median,
    ),
  },
};

writeFileSync(`${ROOT}results.json`, JSON.stringify(results, null, 2));
console.log("\nwrote results.json");
