// 009 — CI shard fan-out: how many shards actually help?
// Generates a synthetic bun test suite, then times it whole and in k shards.
// Run: bun run experiments/009-ci-shard-fanout/bench.ts

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), "shard-fanout-suite");
const FILES = 30; // test files in the suite
const TESTS_PER_FILE = 20;
const TARGET_MS_PER_FILE = 100; // so the suite is ~3 s of real work
const RUNS = 3;

// --- calibrate one unit of spin work -------------------------------------
function spin(n: number): number {
  let x = 1;
  for (let i = 0; i < n; i++) x = (x * 31 + i) % 1000003;
  return x;
}

function calibrateIters(): number {
  let iters = 1_000;
  for (let round = 0; round < 6; round++) {
    const t0 = performance.now();
    spin(iters);
    const ms = performance.now() - t0;
    if (ms > 2) return Math.round((iters * (TARGET_MS_PER_FILE / TESTS_PER_FILE)) / ms);
    iters *= 4;
  }
  return iters;
}

const ITERS = calibrateIters();

function testFile(i: number): string {
  const body = Array.from({ length: TESTS_PER_FILE }, (_, t) => {
    return `test("file${i} case${t}", () => {
  let x = 1;
  for (let i = 0; i < ${ITERS}; i++) x = (x * 31 + i) % 1000003;
  expect(x).toBeGreaterThan(-1);
});`;
  }).join("\n");
  return `import { test, expect } from "bun:test";\n${body}\n`;
}

function build(): string[] {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < FILES; i++) {
    const p = join(ROOT, `suite${String(i).padStart(2, "0")}.test.ts`);
    writeFileSync(p, testFile(i));
    files.push(p);
  }
  const empty = join(ROOT, "empty.test.ts");
  writeFileSync(empty, `import { test } from "bun:test";\n`);
  return files;
}

// --- timing ---------------------------------------------------------------
type ShardRun = { k: number; shard: number; files: number; ms: number };

function runShard(files: string[]): number {
  const t0 = performance.now();
  const p = Bun.spawnSync(["bun", "test", ...files], { stdout: "ignore", stderr: "ignore" });
  const ms = performance.now() - t0;
  if (p.exitCode !== 0) throw new Error(`bun test failed: ${p.stderr?.toString().slice(0, 400)}`);
  return ms;
}

function chunks<T>(items: T[], k: number): T[][] {
  const out: T[][] = Array.from({ length: k }, () => []);
  items.forEach((it, i) => out[i % k].push(it));
  return out.filter((c) => c.length > 0);
}

async function runInParallel(groups: string[][]): Promise<number> {
  const t0 = performance.now();
  await Promise.all(
    groups.map(
      (g) =>
        new Promise<void>((res, rej) => {
          const p = Bun.spawn(["bun", "test", ...g], { stdout: "ignore", stderr: "ignore" });
          p.exited.then((code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
        }),
    ),
  );
  return performance.now() - t0;
}

const files = build();
const emptyFile = join(ROOT, "empty.test.ts");
const results: any = { meta: { files: FILES, testsPerFile: TESTS_PER_FILE, iters: ITERS, runs: RUNS }, runs: [], startup: [], shards: [], parallel: [] };

// S: process startup + framework load, no test work.
for (let r = 0; r < RUNS; r++) results.startup.push({ ms: runShard([emptyFile]) });

const configs = [1, 2, 3, 4, 5, 6, 8, 12, 15];
for (const k of configs) {
  const groups = chunks(files, k);
  for (let r = 0; r < RUNS; r++) {
    const shards: ShardRun[] = [];
    for (let s = 0; s < groups.length; s++) {
      shards.push({ k, shard: s, files: groups[s].length, ms: runShard(groups[s]) });
    }
    const sum = shards.reduce((a, b) => a + b.ms, 0);
    const max = Math.max(...shards.map((s) => s.ms));
    results.runs.push({ k, run: r, sequentialSumMs: sum, slowestShardMs: max, perShard: shards.map((s) => Math.round(s.ms * 100) / 100) });
  }
}

// Local reality: all shards at once on this host's 6 cores.
for (const k of [3, 6, 12]) {
  const groups = chunks(files, k);
  for (let r = 0; r < RUNS; r++) {
    results.parallel.push({ k, run: r, wallMs: await runInParallel(groups) });
  }
}

writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(results, null, 2));

// --- summary --------------------------------------------------------------
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const S = median(results.startup.map((s: any) => s.ms));
console.log(`startup S (empty file, median of ${RUNS}): ${S.toFixed(1)} ms`);
console.log(`spin iterations per test: ${ITERS}`);
console.log("");
console.log("shards | slowest shard ms | sum ms | total CI min | speedup vs 1");
const base = median(results.runs.filter((r: any) => r.k === 1).map((r: any) => r.slowestShardMs));
for (const k of configs) {
  const runs = results.runs.filter((r: any) => r.k === k);
  const max = median(runs.map((r: any) => r.slowestShardMs));
  const sum = median(runs.map((r: any) => r.sequentialSumMs));
  console.log(`${String(k).padStart(6)} | ${max.toFixed(1).padStart(16)} | ${sum.toFixed(0).padStart(6)} | ${(sum / 1000).toFixed(1).padStart(12)} | ${(base / max).toFixed(2)}x`);
}
console.log("");
for (const p of results.parallel) {
  const same = results.parallel.filter((q: any) => q.k === p.k);
  if (p.run === 0) console.log(`parallel on 6 cores, k=${p.k}: ${median(same.map((q: any) => q.wallMs)).toFixed(0)} ms wall`);
}
const t1 = median(results.runs.filter((r: any) => r.k === 1).map((r: any) => r.slowestShardMs));
const T = t1 - S;
console.log("");
console.log(`work T = ${T.toFixed(0)} ms, startup S = ${S.toFixed(0)} ms`);
console.log(`k* = sqrt(T/S) = ${Math.sqrt(T / S).toFixed(1)}; with 15 s CI setup: ${Math.sqrt(T / 15000).toFixed(2)}; with 90 s: ${Math.sqrt(T / 90000).toFixed(2)}`);
