// 003: what a formatting pre-commit hook costs, full tree versus staged files.
// Bun: `bun run bench.js`. Synthetic TypeScript, no network, prettier from devDependencies.

import { mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const PRETTIER = join(ROOT, "node_modules/prettier/bin/prettier.cjs");
const TMP = join(ROOT, "tmp/003");
const SIZES = [10, 50, 100, 250, 500, 1000, 2000];
const STAGED = 5;
const RUNS = 3;

// Deterministic pseudo-random content so every run formats the same bytes.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeModule(i, rand) {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const pick = () => words[Math.floor(rand() * words.length)];
  const lines = [
    `export interface Shape${i} {`,
    `  id: number;`,
    `  label: string;`,
    `  ratio: number;`,
    `}`,
    ``,
    `export interface Result${i} {`,
    `  shape: Shape${i};`,
    `  weight: number;`,
    `}`,
    ``,
    `const weights${i}: number[] = [${Array.from({ length: 5 }, () => rand().toFixed(4)).join(", ")}];`,
    ``,
    `export function score${i}(input: Shape${i}): Result${i} {`,
    `  const total = weights${i}.reduce((acc, value) => acc + value, 0);`,
    `  const weight = total === 0 ? 0 : (weights${i}[input.id % weights${i}.length] ?? 0) / total;`,
    `  return { shape: input, weight };`,
    `}`,
    ``,
    `export function describe${i}(result: Result${i}): string {`,
    `  return "${pick()}" + ":" + result.shape.label + ":" + result.weight.toFixed(3);`,
    `}`,
  ];
  return lines.join("\n") + "\n";
}

function build(n) {
  const dir = join(TMP, `${n}`);
  rmSync(dir, { recursive: true, force: true });
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `fixture-${n}`, private: true }) + "\n");
  for (let i = 0; i < n; i++) {
    // Spread files across ten nested folders, as a real src tree would be.
    const bucket = join(src, `mod${i % 10}`);
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, `file${i}.ts`), makeModule(i, mulberry32(i + 1)));
  }
  return dir;
}

function filesOf(dir) {
  return readdirSync(join(dir, "src"), { recursive: true })
    .filter((p) => String(p).endsWith(".ts"))
    .sort()
    .map((p) => join(dir, "src", String(p)));
}

function time(args, cwd) {
  const started = performance.now();
  const proc = Bun.spawnSync({ cmd: ["node", PRETTIER, ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const ms = performance.now() - started;
  return {
    ms,
    code: proc.exitCode,
    err: proc.exitCode === 0 ? null : proc.stderr.toString().slice(0, 200),
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (x) => Math.round(x * 10) / 10;

function measure(label, args, cwd) {
  time(args, cwd); // warmup: page cache and node module load, discarded
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(round(time(args, cwd).ms));
  const medianMs = round(median(runs));
  const spread = round(Math.max(...runs) - Math.min(...runs));
  console.log(`${label.padEnd(28)} median ${String(medianMs).padStart(8)} ms   runs [${runs.join(", ")}]`);
  return { label, args: args.join(" ").slice(0, 120), runs, medianMs, spreadMs: spread };
}

const setup = performance.now();
const fixtures = SIZES.map((n) => ({ n, dir: build(n) }));
// Format once up front so ----check has nothing to change; the setup cost is not measured.
for (const { dir } of fixtures) time(["--write", "."], dir);
const setupMs = round(performance.now() - setup);
console.log(`fixtures built and pre-formatted in ${setupMs} ms\n`);

const startup = measure("startup (--version)", ["--version"], ROOT);
const cases = [];
const cacheCases = [];
const argmax = [];

for (const { n, dir } of fixtures) {
  console.log(`--- ${n} files`);
  cases.push({ n, ...measure(`full tree (${n})`, ["--check", "."], dir) });
  const files = filesOf(dir);
  const five = [0, 1, 2, 3, 4].map((k) => files[Math.floor((k * files.length) / STAGED)]);
  cases.push({ n, ...measure(`staged ${STAGED} (${n})`, ["--check", ...five], dir) });

  const cacheAt = join(dir, ".prettier-cache");
  time(["--check", ".", "--cache", "--cache-location", cacheAt], dir); // populate cache, untimed
  cacheCases.push({ n, ...measure(`full tree, cache (${n})`, ["--check", ".", "--cache", "--cache-location", cacheAt], dir) });

  // Naive staged-only: every changed path on the command line, as a shell hook would.
  const all = time(["--check", ...files], dir);
  if (all.code !== 0 && all.err) {
    argmax.push({ n, failed: true, errno: all.err.split("\n")[0] });
    console.log(`all-paths args (${n})         FAILED: ${all.err.split("\n")[0]}`);
  }
}

const full = cases.filter((c) => c.label.startsWith("full tree"));
const staged = cases.filter((c) => c.label.startsWith("staged"));
const slope = (() => {
  const a = full.find((c) => c.n === 100);
  const b = full.find((c) => c.n === 2000);
  return round((b.medianMs - a.medianMs) / (2000 - 100) * 1000) / 1000; // ms per file
})();
const fixed = round(full.find((c) => c.n === 100).medianMs - slope * 100);
const crossoverMs = round((1000 - fixed) / slope);

const result = {
  generatedAt: new Date().toISOString(),
  host: { cpus: (await import("node:os")).cpus().length, bun: Bun.version, node: process.version },
  tool: { prettier: "3.9.10", cache: "off unless --cache" },
  config: { sizes: SIZES, fileBytes: statSync(filesOf(fixtures[0].dir)[0]).size, filesPerModule: 20, stagedFiles: STAGED, runsPerCase: RUNS, warmup: "1 discarded run per case" },
  setupMs,
  startup,
  cases,
  cacheCases,
  argmax,
  model: { msPerFile: slope, fixedMs: fixed, crossover1000ms: crossoverMs, note: "slope from full-tree points at 100 and 2000 files" },
};

writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(result, null, 2) + "\n");
console.log(`\nper-file ${slope} ms, fixed ${fixed} ms, 1 s budget at ${crossoverMs} files -> results.json`);
