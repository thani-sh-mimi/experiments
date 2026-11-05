// What does a test file cost when it gets a fresh worker thread instead of a
// fresh process? Run: bun run bench.ts   (Node does the measuring; Bun drives.)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const DRIVER = join(HERE, "driver.mjs");
const POOL_DIR = join(HERE, "tmp", "files");
const RUNS = 3;
const COUNTS = [1, 4, 8, 16, 32];
const WORK = [0, 1, 5, 20, 50];
const NOISE_RUNS = 7;

mkdirSync(POOL_DIR, { recursive: true });
for (let i = 0; i < 32; i++) {
  writeFileSync(
    join(POOL_DIR, `f${i}.mjs`),
    `globalThis.__seen = (globalThis.__seen ?? 0) + 1;\nasync function t() {\n  if (1 + 1 !== 2) throw new Error("math");\n}\nawait t();\n`,
  );
}

type Point = {
  mode: string;
  files: number;
  work: number;
  ms: number;
  wall: number;
  maxSeen?: number;
  run: number;
};

function drive(args: string[]): Point {
  const t0 = performance.now();
  const p = Bun.spawnSync({
    cmd: ["node", DRIVER, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const wall = performance.now() - t0;
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  const line = p.stdout.toString().trim().split("\n").pop()!;
  return { ...JSON.parse(line), wall };
}

const rows: Point[] = [];
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function sweep(
  mode: string,
  files: number,
  work: number,
  runs = RUNS,
  extra: string[] = [],
) {
  const ms: number[] = [];
  for (let r = 0; r < runs; r++) {
    const p = drive([
      "--mode",
      mode,
      "--files",
      String(files),
      "--work",
      String(work),
      ...extra,
    ]);
    rows.push({ ...p, run: r });
    ms.push(p.ms);
  }
  return { median: median(ms), ms };
}

const t0 = performance.now();
const floor = [0, 1, 2].map(() => {
  const s = performance.now();
  Bun.spawnSync({ cmd: ["node", "-e", "0"], stdout: "pipe", stderr: "pipe" });
  return performance.now() - s;
});

const grid: Record<string, Record<number, number>> = {
  fork: {},
  thread: {},
  pool: {},
};
for (const files of COUNTS) {
  for (const mode of ["fork", "thread"]) {
    const { median: m, ms } = sweep(mode, files, 0);
    grid[mode][files] = m;
    console.log(
      `${mode} ${files} files: ${m.toFixed(1)} ms`,
      ms.map((x) => x.toFixed(1)).join(","),
    );
  }
}

const pool32 = sweep("pool", 32, 0, RUNS, [
  "--dir",
  POOL_DIR,
  "--workers",
  "2",
]);
console.log(`pool 32 files / 2 workers: ${pool32.median.toFixed(1)} ms`);

const workSweep: Record<string, Record<number, number>> = {
  fork: {},
  thread: {},
};
for (const work of WORK) {
  for (const mode of ["fork", "thread"]) {
    const { median: m } = sweep(mode, 32, work);
    workSweep[mode][work] = m;
  }
}

const noise: number[] = [];
for (let r = 0; r < NOISE_RUNS; r++) {
  const p = drive(["--mode", "thread", "--files", "32", "--work", "0"]);
  rows.push({ ...p, run: r });
  noise.push(p.ms);
}

const spread = (xs: number[]) =>
  (Math.max(...xs) - Math.min(...xs)) / median(xs);

const out = {
  host: {
    node: Bun.spawnSync({ cmd: ["node", "-v"] })
      .stdout.toString()
      .trim(),
    bun: Bun.version,
    cpus: Number(
      Bun.spawnSync({ cmd: ["nproc"] })
        .stdout.toString()
        .trim(),
    ),
    cpuMax: Bun.spawnSync({ cmd: ["cat", "/sys/fs/cgroup/cpu.max"] })
      .stdout.toString()
      .trim(),
  },
  runs: RUNS,
  counts: COUNTS,
  work: WORK,
  floorMs: floor,
  grid,
  pool32: {
    median: pool32.median,
    maxSeen: rows.filter((r) => r.mode === "pool").at(-1)?.maxSeen,
  },
  workSweep,
  noise: { ms: noise, spread: spread(noise) },
  elapsedMs: performance.now() - t0,
  points: rows,
};

await Bun.write(join(HERE, "results.json"), JSON.stringify(out, null, 2));
console.log(
  JSON.stringify({
    floorMs: floor,
    grid,
    pool32: out.pool32,
    workSweep,
    noise: out.noise,
    elapsedMs: out.elapsedMs,
  }),
);
