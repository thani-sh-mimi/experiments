// 018 — what does `--coverage` cost `bun test`?
// Generates a synthetic suite (N test files, one module each), runs it plain and
// with coverage, three timed runs per arm, medians reported.
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const SIZES = [50, 200, 800];
const RUNS = Number(process.env.RUNS_OVERRIDE ?? 3);
const MODE = process.argv[2] ?? "all";
const WORK_SWEEP = (process.env.WORK ?? "1,10,100").split(",").map(Number);
const base = join(import.meta.dir, "tmp");

function moduleSource(i) {
  return `// Synthetic module ${i}. No project code.
export interface Item${i} {
  id: number;
  weight: number;
  tags: string[];
}

const LIMIT_${i} = 97;

export function clamp${i}(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export function score${i}(item: Item${i}): number {
  let total = 0;
  for (const tag of item.tags) {
    if (tag.length === 0) continue;
    total += tag.length * item.weight;
  }
  if (total > LIMIT_${i}) return LIMIT_${i};
  return total;
}

export function bucket${i}(value: number): string {
  switch (value % 4) {
    case 0:
      return "zero";
    case 1:
      return "one";
    case 2:
      return "two";
    default:
      return "three";
  }
}

export function describe${i}(item: Item${i}): string {
  const value = score${i}(item);
  const label = bucket${i}(value);
  return label + ":" + value;
}

export function normalise${i}(items: Item${i}[]): Item${i}[] {
  const out: Item${i}[] = [];
  for (const item of items) {
    const weight = clamp${i}(item.weight, 0, 10);
    if (weight === 0) continue;
    out.push({ id: item.id, weight: weight, tags: item.tags });
  }
  return out;
}
`;
}

function testSource(i, work) {
  return `import { test, expect } from "bun:test";
import {
  clamp${i},
  score${i},
  bucket${i},
  describe${i},
  normalise${i},
} from "../lib/mod${i}.ts";

const WEIGHT = ${work};

test("clamp ${i}", () => {
  for (let k = 0; k < WEIGHT; k++) {
    expect(clamp${i}(-1, 0, 5)).toBe(0);
    expect(clamp${i}(9, 0, 5)).toBe(5);
    expect(clamp${i}(Number.NaN, 1, 5)).toBe(1);
    expect(clamp${i}(3, 0, 5)).toBe(3);
  }
});

test("score ${i}", () => {
  for (let k = 0; k < WEIGHT; k++) {
    expect(score${i}({ id: 1, weight: 2, tags: ["aa", "bbb"] })).toBe(10);
    expect(score${i}({ id: 2, weight: 4, tags: ["", "x"] })).toBe(4);
    expect(score${i}({ id: 3, weight: 20, tags: ["aaaaaa"] })).toBe(97);
  }
});

test("bucket ${i}", () => {
  for (let k = 0; k < WEIGHT; k++) {
    expect(bucket${i}(0)).toBe("zero");
    expect(bucket${i}(1)).toBe("one");
    expect(bucket${i}(2)).toBe("two");
    expect(bucket${i}(3)).toBe("three");
  }
});

test("describe ${i}", () => {
  for (let k = 0; k < WEIGHT; k++) {
    expect(describe${i}({ id: 4, weight: 1, tags: ["ab"] })).toBe("two:2");
  }
});

test("normalise ${i}", () => {
  for (let k = 0; k < WEIGHT; k++) {
    const out = normalise${i}([
      { id: 1, weight: 0, tags: ["a"] },
      { id: 2, weight: 30, tags: ["b"] },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].weight).toBe(10);
  }
});
`;
}

function generate(count, work) {
  const dir = join(base, `suite-${count}-w${work}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, "lib", `mod${i}.ts`), moduleSource(i));
    writeFileSync(join(dir, "test", `mod${i}.test.ts`), testSource(i, work));
  }
  return dir;
}

const ARMS = [
  { name: "plain", flags: [] },
  { name: "coverage-text", flags: ["--coverage"] },
  {
    name: "coverage-text+lcov",
    flags: ["--coverage-reporter=text", "--coverage-reporter=lcov"],
  },
  { name: "coverage-lcov", flags: ["--coverage-reporter=lcov"] },
];

// bunfig that excludes the source tree: instrumentation may still run, but no
// source file appears in the report, so the table and lcov writes shrink to the
// test files only. Prices the reporting side separately from the running side.
const IGNORE_BUNFIG = `[test]
coveragePathIgnorePatterns = ["lib/**"]
`;
const EXCLUDED_ARM = {
  name: "coverage-exclude-src",
  flags: ["--coverage"],
  bunfig: IGNORE_BUNFIG,
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function spread(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return ((hi - lo) / lo) * 100;
}

const results = [];

// Arms run interleaved, one pass per round, so a burst of host noise lands on every
// arm instead of one. The first round is warm-up and is discarded.
function runInterleaved(dir, arms, work, count, label) {
  const times = new Map(arms.map((arm) => [arm.name, []]));
  let lastOut = new Map();
  const lcovBytesByArm = new Map();
  const bunfig = join(dir, "bunfig.toml");
  const lcovPath = join(dir, "coverage", "lcov.info");
  for (let round = 0; round < RUNS + 1; round++) {
    for (const arm of arms) {
      rmSync(join(dir, "coverage"), { recursive: true, force: true });
      rmSync(bunfig, { force: true });
      if (arm.bunfig) writeFileSync(bunfig, arm.bunfig);
      const started = performance.now();
      const proc = Bun.spawnSync(["bun", "test", ...arm.flags], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const elapsed = performance.now() - started;
      if (proc.exitCode !== 0) {
        console.error(
          `FAILED ${label} ${arm.name}\n${proc.stdout}\n${proc.stderr}`,
        );
        process.exit(1);
      }
      lastOut.set(arm.name, proc.stderr.toString() + proc.stdout.toString());
      lcovBytesByArm.set(
        arm.name,
        existsSync(lcovPath) ? statSync(lcovPath).size : 0,
      );
      if (round > 0) times.get(arm.name).push(elapsed);
    }
  }
  rmSync(bunfig, { force: true });
  for (const arm of arms) {
    const values = times.get(arm.name);
    const out = lastOut.get(arm.name) ?? "";
    const lcovBytes = lcovBytesByArm.get(arm.name) ?? 0;
    const summary = out.split("\n").filter((line) => line.includes("Ran "));
    const row = {
      label: `${label} ${arm.name}`,
      files: count,
      work,
      arm: arm.name,
      runs: values.map((value) => Math.round(value * 10) / 10),
      medianMs: Math.round(median(values) * 10) / 10,
      spreadPct: Math.round(spread(values) * 10) / 10,
      reportBytes: out.length,
      lcovBytes,
      testsRan: summary.length ? summary[summary.length - 1].trim() : "",
      coverageRows: (out.match(/^\s*\S+\.ts\s*\|/gm) ?? []).length,
    };
    results.push(row);
    console.log(
      `${row.label.padEnd(34)} ${row.medianMs.toFixed(1).padStart(7)} ms  spread ${row.spreadPct
        .toFixed(1)
        .padStart(
          4,
        )} %  report ${(row.reportBytes / 1024).toFixed(1).padStart(5)} KB  ` +
        `lcov ${(row.lcovBytes / 1024).toFixed(1).padStart(6)} KB  rows ${String(
          row.coverageRows,
        ).padStart(3)}`,
    );
  }
}

// Main sweep: file count against arm.
if (MODE === "all" || MODE === "main") {
  for (const count of SIZES) {
    const dir = generate(count, 1);
    runInterleaved(dir, [...ARMS, EXCLUDED_ARM], 1, count, `${count} files`);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Work sweep at 200 files: how much of the cost follows executed code?
if (MODE === "all" || MODE === "work") {
  for (const work of WORK_SWEEP) {
    const dir = generate(200, work);
    runInterleaved(
      dir,
      [ARMS[0], ARMS[1], ARMS[2]],
      work,
      200,
      `200 files w${work}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
}

// Baseline: the cost of starting bun at all.
const spawnTimes = [];
for (let run = 0; run < RUNS + 1; run++) {
  const started = performance.now();
  Bun.spawnSync(["bun", "-e", ""], { stdout: "pipe", stderr: "pipe" });
  const elapsed = performance.now() - started;
  if (run > 0) spawnTimes.push(Math.round(elapsed * 10) / 10);
}

writeFileSync(
  join(
    import.meta.dir,
    MODE === "all" ? "results.json" : `results-${MODE}.json`,
  ),
  JSON.stringify(
    {
      runs: RUNS,
      bun: Bun.version,
      mode: MODE,
      spawnMs: Math.round(median(spawnTimes) * 10) / 10,
      spawnTimes,
      results,
    },
    null,
    2,
  ),
);
console.log(`bun -e "" floor ${median(spawnTimes).toFixed(1)} ms`);
