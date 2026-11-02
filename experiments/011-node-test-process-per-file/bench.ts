// 011 — what does a child process per test file cost `node --test`?
// Axes: interpreter floor, file extension (.js vs .ts), file count, work per file.
// Serial concurrency so the per-file cost is not hidden by overlap.
// The container is CPU-throttled and shared, so configs are interleaved per round
// and every point keeps all runs plus the minimum.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RUNS = 5;
const ROOT = join(import.meta.dir, "tmp");

type Row = { wall: number[]; median: number; min: number; max: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeSuite(dir: string, files: number, workMs: number, ext: string) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const body = workMs
    ? `  const end = performance.now() + ${workMs};\n  while (performance.now() < end) {}\n`
    : "";
  for (let i = 0; i < files; i++) {
    await writeFile(
      join(dir, `f${i}.test.${ext}`),
      `import { test } from 'node:test';\ntest('t', () => {\n${body}});\n`,
    );
  }
}

async function time(cmd: string[], cwd: string): Promise<number> {
  const t0 = performance.now();
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
  const code = await p.exited;
  const wall = performance.now() - t0;
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
  return wall;
}

function r1(n: number) {
  return Math.round(n * 10) / 10;
}

function stats(wall: number[]): Row {
  const s = [...wall].sort((a, b) => a - b);
  return {
    wall: wall.map(r1),
    median: r1(s[Math.floor(wall.length / 2)]),
    min: r1(s[0]),
    max: r1(s[s.length - 1]),
  };
}

// same round for every config, so CPU drift hits all of them
async function measureAll(
  configs: Record<string, string[]>,
  cwd: string,
): Promise<Record<string, Row>> {
  const runs: Record<string, number[]> = {};
  for (const k of Object.keys(configs)) runs[k] = [];
  for (let i = 0; i < RUNS; i++) {
    for (const [k, cmd] of Object.entries(configs)) {
      runs[k].push(await time(cmd, cwd));
      await sleep(40);
    }
  }
  return Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, stats(v)]));
}

function fit(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const slope = num / den;
  return { fixed: r1(my - slope * mx), perFile: r1(slope * 100) / 100 };
}

async function main() {
  await mkdir(ROOT, { recursive: true });
  const out: Record<string, unknown> = {
    meta: {
      os: `${process.platform} ${process.arch}`,
      node: process.version,
      bun: Bun.version,
      cpus: navigator.hardwareConcurrency,
      cpuQuota: "200000/100000 (2 CPU), throttled",
      runs: RUNS,
      when: new Date().toISOString(),
    },
  };

  // 1. interpreter floor
  const floor = await measureAll(
    { node: ["node", "-e", "0"], bun: ["bun", "-e", "0"] },
    ROOT,
  );
  out.floor = floor;
  console.log(`floor node ${floor.node.median} bun ${floor.bun.median}`);

  // 2. extension: 10 files, serial
  const ext: Record<string, unknown> = {};
  for (const e of ["js", "ts"]) {
    const dir = join(ROOT, `ext-${e}`);
    await makeSuite(dir, 10, 0, e);
    ext[e] = await measureAll(
      {
        process: ["node", "--test", "--test-concurrency=1", dir],
        inProcess: ["node", "--test", "--test-isolation=none", dir],
      },
      ROOT,
    );
    const r = ext[e] as Record<string, Row>;
    console.log(`ext ${e}: proc ${r.process.median} none ${r.inProcess.median}`);
  }
  out.extension = ext;

  // 3. file count, .js, trivial test each
  const countDir = join(ROOT, "count");
  const countRows: unknown[] = [];
  for (const n of [1, 2, 4, 8, 16, 32]) {
    await makeSuite(countDir, n, 0, "js");
    const row = { files: n, ...(await measureAll(
      {
        process: ["node", "--test", "--test-concurrency=1", countDir],
        inProcess: ["node", "--test", "--test-isolation=none", countDir],
        bun: ["bun", "test", countDir],
      },
      ROOT,
    )) } as Record<string, unknown>;
    countRows.push(row);
    console.log(
      `count ${n}: proc ${(row.process as Row).median} none ${(row.inProcess as Row).median} bun ${(row.bun as Row).median}`,
    );
  }
  out.fileCount = countRows;

  // 4. work per file, 32 files, .js
  const workDir = join(ROOT, "work");
  const workRows: unknown[] = [];
  for (const w of [0, 1, 5, 20, 50]) {
    await makeSuite(workDir, 32, w, "js");
    const row = { workMs: w, ...(await measureAll(
      {
        process: ["node", "--test", "--test-concurrency=1", workDir],
        inProcess: ["node", "--test", "--test-isolation=none", workDir],
        processC2: ["node", "--test", "--test-concurrency=2", workDir],
      },
      ROOT,
    )) } as Record<string, unknown>;
    workRows.push(row);
    console.log(
      `work ${w}ms: proc ${(row.process as Row).median} none ${(row.inProcess as Row).median} proc@2 ${(row.processC2 as Row).median}`,
    );
  }
  out.workPerFile = workRows;

  // 5. fits
  const c = countRows as { files: number; process: Row; inProcess: Row; bun: Row }[];
  out.fit = {
    process: fit(c.map((r) => r.files), c.map((r) => r.process.median)),
    processMin: fit(c.map((r) => r.files), c.map((r) => r.process.min)),
    inProcess: fit(c.map((r) => r.files), c.map((r) => r.inProcess.median)),
    bun: fit(c.map((r) => r.files), c.map((r) => r.bun.median)),
  };
  console.log("fit", JSON.stringify(out.fit));

  // 6. noise floor: the 32-file process point again, 7 times
  const noise: number[] = [];
  for (let i = 0; i < 7; i++) {
    noise.push(await time(["node", "--test", "--test-concurrency=1", join(ROOT, "count")], ROOT));
  }
  const ns = [...noise].sort((a, b) => a - b);
  out.noise = {
    wall: noise.map(r1),
    min: r1(ns[0]),
    median: r1(ns[3]),
    max: r1(ns[6]),
    spreadPct: r1((100 * (ns[6] - ns[0])) / ns[3]),
  };
  console.log(`noise ${JSON.stringify(out.noise)}`);

  await writeFile(join(import.meta.dir, "results.json"), JSON.stringify(out, null, 2) + "\n");
}

await main();
