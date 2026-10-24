// Experiment 001: what does one extra test file cost `bun test`?
// Generates two shapes of suite and times each, so per-file overhead can be
// separated from per-test cost and from the runner's fixed start-up cost.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { cpus } from "node:os";

const SIZES = [1, 5, 25, 100, 400];
const REPS = 3;
const root = import.meta.dir;
const tmp = `${root}/tmp`;

const header = 'import { test, expect } from "bun:test";\n';
const oneTest = (i: number) =>
  `test("case ${i}", () => {\n  expect(${i} + 1).toBe(${i + 1});\n});\n`;

async function buildManyFiles(n: number): Promise<string> {
  const dir = `${tmp}/many-${n}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      writeFile(`${dir}/t${String(i).padStart(3, "0")}.test.ts`, header + oneTest(i)),
    ),
  );
  return dir;
}

async function buildOneFile(n: number): Promise<string> {
  const dir = `${tmp}/single-${n}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const body = header + Array.from({ length: n }, (_, i) => oneTest(i)).join("");
  const file = `${dir}/all.test.ts`;
  await writeFile(file, body);
  return dir;
}

async function buildAppGraph(): Promise<string> {
  const dir = `${tmp}/app`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files = Array.from({ length: 50 }, (_, i) => {
    const next = i < 49 ? `import { v as n } from "./m${i + 1}";\n` : "";
    return writeFile(`${dir}/m${i}.ts`, `${next}export const v = ${i}${i < 49 ? " + n" : ""};\n`);
  });
  await Promise.all(files);
  await writeFile(`${dir}/index.ts`, 'export { v } from "./m0";\n');
  return `${dir}/index.ts`;
}

// Same shape as the first series, but every file imports a 50-module graph the
// way a real test file imports the code it tests.
async function buildManyFilesImporting(n: number): Promise<string> {
  const dir = `${tmp}/importing-${n}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      writeFile(
        `${dir}/t${String(i).padStart(3, "0")}.test.ts`,
        header + 'import { v } from "../app/index.ts";\n' + oneTest(i) + `test("import", () => expect(v).toBe(1225));\n`,
      ),
    ),
  );
  return dir;
}

async function timeBunTest(path: string): Promise<number> {
  const started = performance.now();
  const proc = Bun.spawn(["bun", "test", path], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const elapsed = performance.now() - started;
  if (code !== 0) {
    throw new Error(`bun test ${path} exited ${code}: ${await new Response(proc.stderr).text()}`);
  }
  return Math.round(elapsed);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Least squares y = intercept + slope * x over [x, y] pairs.
function fit(points: [number, number][]) {
  const n = points.length;
  const sx = points.reduce((a, [x]) => a + x, 0);
  const sy = points.reduce((a, [, y]) => a + y, 0);
  const sxx = points.reduce((a, [x]) => a + x * x, 0);
  const sxy = points.reduce((a, [x, y]) => a + x * y, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { intercept: Math.round(sy / n - (slope * sx) / n), slope: Number(slope.toFixed(2)) };
}

async function measure(build: (n: number) => Promise<string>, label: string) {
  await build(1); // warm the page cache and bun's own start-up path
  await timeBunTest(await build(1));
  const rows: { units: number; runs: number[]; median: number }[] = [];
  for (const n of SIZES) {
    const path = await build(n);
    const runs = [];
    for (let r = 0; r < REPS; r++) runs.push(await timeBunTest(path));
    rows.push({ units: n, runs, median: median(runs) });
    console.log(`${label} n=${String(n).padStart(3)}  ${runs.join(" / ")} ms  median ${median(runs)}`);
  }
  return rows;
}

await rm(tmp, { recursive: true, force: true });
const many = await measure(buildManyFiles, "many files, 1 test each ");
const single = await measure(buildOneFile, "one file, n tests       ");
await buildAppGraph();
const importing = await measure(buildManyFilesImporting, "many files + 50-module graph");

const manyFit = fit(many.map((r) => [r.units, r.median]));
const singleFit = fit(single.map((r) => [r.units, r.median]));
const importFit = fit(importing.map((r) => [r.units, r.median]));

const results = {
  experiment: "001-test-file-overhead",
  ranAt: new Date().toISOString(),
  environment: {
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
  },
  method: {
    runner: "bun test <dir>, wall clock including process start",
    sizes: SIZES,
    reps: REPS,
    statistic: "median",
    warmup: "1 discarded run per shape",
  },
  manyFilesOneTest: { rows: many, fit: manyFit },
  oneFileManyTests: { rows: single, fit: singleFit },
  manyFilesImportingGraph: { rows: importing, fit: importFit },
  derived: {
    fixedCostMs: manyFit.intercept,
    msPerExtraFile: manyFit.slope,
    msPerExtraTest: singleFit.slope,
    msPerExtraFileWithImports: importFit.slope,
    importOverheadMsPerFile: Number((importFit.slope - manyFit.slope).toFixed(2)),
    breakEvenTestsPerFile:
      singleFit.slope > 0 ? Number((manyFit.slope / singleFit.slope).toFixed(1)) : null,
  },
};

await writeFile(`${root}/results.json`, JSON.stringify(results, null, 2) + "\n");
console.log("\n" + JSON.stringify(results.derived, null, 2));
