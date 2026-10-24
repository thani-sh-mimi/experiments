// Second half of 001: at what per-file workload does `bun test --parallel`
// stop being a net loss? 100 files, each burning a fixed amount of CPU.
import { mkdir, rm, writeFile } from "node:fs/promises";

const FILES = 100;
const WORK_MS = [0, 1, 10, 50];
const REPS = 3;
const root = import.meta.dir;
const tmp = `${root}/tmp`;

async function build(work: number): Promise<string> {
  const dir = `${tmp}/work-${work}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: FILES }, (_, i) =>
      writeFile(
        `${dir}/t${String(i).padStart(3, "0")}.test.ts`,
        'import { test, expect } from "bun:test";\n' +
          `test("spin", () => {\n  const until = performance.now() + ${work};\n` +
          "  let x = 0;\n  while (performance.now() < until) x++;\n  expect(x).toBeGreaterThanOrEqual(0);\n});\n",
      ),
    ),
  );
  return dir;
}

async function time(path: string, parallel: boolean): Promise<number> {
  const started = performance.now();
  const proc = Bun.spawn(parallel ? ["bun", "test", "--parallel", path] : ["bun", "test", path], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
  return Math.round(performance.now() - started);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows = [];

for (const work of WORK_MS) {
  const dir = await build(work);
  await time(dir, false);
  const serial = [];
  const parallel = [];
  for (let r = 0; r < REPS; r++) serial.push(await time(dir, false));
  for (let r = 0; r < REPS; r++) parallel.push(await time(dir, true));
  const row = {
    workMsPerFile: work,
    serialMs: median(serial),
    parallelMs: median(parallel),
    speedup: Number((median(serial) / median(parallel)).toFixed(2)),
  };
  rows.push(row);
  console.log(`${String(work).padStart(3)} ms/file  serial ${row.serialMs} ms  parallel ${row.parallelMs} ms  ${row.speedup}x`);
}

await writeFile(
  `${root}/parallel.json`,
  JSON.stringify({ files: FILES, reps: REPS, statistic: "median", rows }, null, 2) + "\n",
);
