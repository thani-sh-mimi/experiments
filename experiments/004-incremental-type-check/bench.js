// 004: what `tsc --incremental` actually buys, on TypeScript 7 (Go) and TypeScript 6 (JavaScript).
// Bun: `bun run bench.js`. Synthetic TypeScript only, compilers from devDependencies, no network.

import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SIZES = (process.env.SIZES ?? "300,1000").split(",").map(Number);
const RUNS = Number(process.env.RUNS ?? 3);
const BUCKETS = 10;

const COMPILERS = [
  { name: "ts7", version: "7.0.2", bin: join(ROOT, "node_modules/typescript/bin/tsc") },
  { name: "ts6", version: "6.0.3", bin: join(ROOT, "node_modules/typescript6/bin/tsc") },
];

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let TMP = "";

const pathOf = (i) => `src/mod${i % BUCKETS}/m${i}.ts`;
const specOf = (from, to) => {
  let rel = relative(join(TMP, "src", `mod${from % BUCKETS}`), join(TMP, pathOf(to)));
  rel = rel.replace(/\.ts$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
};

// Each module imports two earlier ones and builds on their types: a real graph, walked for real.
function makeModule(i, rand) {
  const picks = i === 0 ? [] : [i - 1, Math.floor(rand() * i)];
  const uniq = [...new Set(picks)];
  const lines = [];
  for (const j of uniq) lines.push(`import type { Iface${j}, Union${j}, Mapped${j} } from "${specOf(i, j)}";`);
  if (uniq.length) lines.push("");
  const parent = uniq.length ? `Iface${uniq[0]}` : `{ id: number; name: string }`;
  lines.push(
    `export interface Iface${i}<T extends Record<string, number> = Record<string, number>> {`,
    `  id: number;`,
    `  name: string;`,
    `  payload: T;`,
    `  parent: ${parent} | null;`,
    `}`,
    ``,
    `export type Keys${i} = \`k\${number}_${i}\`;`,
    ``,
    `export type Mapped${i}<T> = T extends { id: infer I extends number } ? I : never;`,
    ``,
    uniq.length
      ? `export type Union${i} = Union${uniq[0]} | { kind: Keys${i}; at: Mapped${uniq[0]}<Iface${uniq[0]}> };`
      : `export type Union${i} = { kind: Keys${i}; at: number };`,
    ``,
    `export function read${i}(value: Iface${i}, other: ${uniq.length ? `Iface${uniq[0]}` : `Iface${i}`}): number {`,
    `  const sum = Object.values(value.payload).reduce((a, b) => a + b, 0);`,
    `  return sum + value.id + (value.parent ? value.parent.id : 0) + other.id;`,
    `}`,
    ``,
    `export function tally${i}(items: Union${i}[]): number {`,
    `  let n = 0;`,
    `  for (const item of items) n += typeof item.at === "number" ? item.at : 0;`,
    `  return n;`,
    `}`,
    ``,
  );
  return lines.join("\n");
}

function build(size) {
  TMP = join(ROOT, `tmp/004/${size}`);
  rmSync(TMP, { recursive: true, force: true });
  for (let b = 0; b < BUCKETS; b++) mkdirSync(join(TMP, "src", `mod${b}`), { recursive: true });
  for (let i = 0; i < size; i++) writeFileSync(join(TMP, pathOf(i)), makeModule(i, mulberry32(i + 7)));
  writeFileSync(join(TMP, "package.json"), JSON.stringify({ name: "fixture", private: true }) + "\n");
  writeFileSync(
    join(TMP, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          incremental: true,
          tsBuildInfoFile: ".cache/tsconfig.tsbuildinfo",
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );
}

const info = () => join(TMP, ".cache/tsconfig.tsbuildinfo");
const cacheOff = () => rmSync(join(TMP, ".cache"), { recursive: true, force: true });

function run(bin, extra = []) {
  const started = performance.now();
  const proc = Bun.spawnSync({ cmd: ["node", bin, "--project", ".", ...extra], cwd: TMP, stdout: "pipe", stderr: "pipe" });
  return { ms: performance.now() - started, code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

// A compiler that dies is a result, not a reason to stop: record the exit code and the first error line.
function runCase(bin) {
  const res = run(bin);
  if (res.code === 0) return { ok: true, ms: round(res.ms) };
  const line = (res.err + res.out).split("\n").find((l) => /error|Error|overflow/.test(l)) ?? "";
  return { ok: false, ms: round(res.ms), code: res.code, error: line.trim().slice(0, 160) };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x) => Math.round(x * 10) / 10;

const results = [];
const diagnostics = {};
const startups = [];
let lastTmp = "";
let lastSize = 0;

for (const size of SIZES) {
  build(size);
  const mid = join(TMP, pathOf(Math.floor(size / 2)));
  const leaf = join(TMP, pathOf(size - 1));
  const midSrc = await Bun.file(mid).text();
  const leafSrc = await Bun.file(leaf).text();
  const bytes = statSync(join(TMP, pathOf(0))).size;
  console.log(`\n=== ${size} modules, ${bytes} bytes each`);

  for (const c of COMPILERS) {
    // Startup floor: what `tsc --version` costs before it looks at any file.
    const boot = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      Bun.spawnSync({ cmd: ["node", c.bin, "--version"], cwd: TMP, stdout: "pipe", stderr: "pipe" });
      boot.push(round(performance.now() - t0));
    }
    startups.push({ size, compiler: c.name, runs: boot, medianMs: round(median(boot)) });

    const cases = { cold: [], noop: [], "edit-mid": [], "edit-leaf": [], nocache: [] };
    const cacheBytes = [];
    // One discarded full cycle so the first number is not the page-cache cold one.
    cacheOff();
    run(c.bin);
    run(c.bin);

    for (let r = 0; r < RUNS; r++) {
      cacheOff();
      cases.cold.push(runCase(c.bin));

      cases.noop.push(runCase(c.bin));
      if (cases.noop.at(-1).ok) cacheBytes.push(statSync(info()).size);

      // Each edit is measured from a settled build, so exactly one file is new since the last run.
      writeFileSync(leaf, leafSrc + `export const touched = ${r};\n`);
      cases["edit-leaf"].push(runCase(c.bin));
      writeFileSync(leaf, leafSrc);
      run(c.bin); // settle, untimed

      writeFileSync(mid, midSrc + `export const touched = ${r};\n`);
      cases["edit-mid"].push(runCase(c.bin));
      writeFileSync(mid, midSrc);
      run(c.bin); // settle, untimed

      cacheOff();
      cases.nocache.push(runCase(c.bin));
    }

    const pick = (arr) => {
      const ok = arr.filter((x) => x.ok);
      const med = ok.length ? round(median(ok.map((x) => x.ms))) : null;
      return {
        runs: arr,
        medianMs: med,
        spreadMs: ok.length ? round(Math.max(...ok.map((x) => x.ms)) - Math.min(...ok.map((x) => x.ms))) : null,
        failures: arr.filter((x) => !x.ok).map((x) => x.error),
      };
    };
    const summary = {};
    for (const [k, arr] of Object.entries(cases)) summary[k] = pick(arr);
    summary.tsbuildinfoBytes = {
      runs: cacheBytes,
      median: cacheBytes.length ? [...cacheBytes].sort((a, b) => a - b)[Math.floor(cacheBytes.length / 2)] : null,
    };
    results.push({ size, modules: size, compiler: c.name, version: c.version, ...summary });
    const show = (k) => (summary[k].medianMs === null ? `FAILED (${summary[k].failures[0] ?? ""})` : `${summary[k].medianMs}`);
    console.log(
      `${c.name}: cold ${show("cold")} | noop ${show("noop")} | edit-leaf ${show("edit-leaf")} | edit-mid ${show("edit-mid")} | nocache ${show("nocache")} ms (boot ${round(median(boot))})`,
    );
  }

  // Phase breakdown from the compiler's own diagnostics: cold, nothing changed, and one leaf edit.
  for (const c of COMPILERS) {
    cacheOff();
    const cold = run(c.bin, ["--extendedDiagnostics"]);
    const noop = run(c.bin, ["--extendedDiagnostics"]);
    writeFileSync(leaf, leafSrc + `export const touched = "diag";\n`);
    const edited = run(c.bin, ["--extendedDiagnostics"]);
    writeFileSync(leaf, leafSrc);
    diagnostics[`${size}-${c.name}`] = { cold: cold.out.trim(), noop: noop.out.trim(), editLeaf: edited.out.trim() };
  }
  lastTmp = TMP;
  lastSize = size;
}

// Control: the same graph with the recursive union chain flattened. If the cold cost is my fixture's
// union nesting rather than the checker, this is where it shows.
{
  const dir = join(ROOT, `tmp/004/control-${lastSize}`);
  rmSync(dir, { recursive: true, force: true });
  for (let b = 0; b < BUCKETS; b++) mkdirSync(join(dir, "src", `mod${b}`), { recursive: true });
  for (let i = 0; i < lastSize; i++) {
    const src = await Bun.file(join(lastTmp, pathOf(i))).text();
    writeFileSync(
      join(dir, pathOf(i)),
      src.replace(/\| \{ kind: Keys\d+; at: Mapped\d+<Iface\d+> \}/, `| { kind: "x"; at: number }`),
    );
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "control", private: true }) + "\n");
  writeFileSync(join(dir, "tsconfig.json"), await Bun.file(join(lastTmp, "tsconfig.json")).text());
  const prev = TMP;
  TMP = dir;
  const control = {};
  for (const c of COMPILERS) {
    cacheOff();
    const res = run(c.bin, ["--extendedDiagnostics"]);
    control[c.name] = { wallMs: round(res.ms), diagnostics: res.out.trim() };
  }
  TMP = prev;
  diagnostics.control = { size: lastSize, flattenedUnionChain: true, ...control };
  console.log(`\ncontrol (${lastSize} modules, union chain flattened): ${COMPILERS.map((c) => `${c.name} ${control[c.name].wallMs} ms`).join(", ")}`);
}

// Does the harness prove the compiler checks types at all? One wrong annotation must fail the build.
const broken = join(TMP, pathOf(0));
const keep = await Bun.file(broken).text();
writeFileSync(broken, keep + `export const wrong: number = "not a number";\n`);
const detect = {};
for (const c of COMPILERS) {
  cacheOff();
  const res = run(c.bin);
  detect[c.name] = { code: res.code, message: res.out.split("\n").find((l) => l.includes("error TS")) ?? null };
}
writeFileSync(broken, keep);
console.log(`\ntype-error detection: ${JSON.stringify(detect)}`);

writeFileSync(
  join(import.meta.dir, "results.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      host: { cpus: (await import("node:os")).cpus().length, bun: Bun.version, node: process.version },
      config: {
        sizes: SIZES,
        bytesPerModule: statSync(join(TMP, pathOf(0))).size,
        runsPerCase: RUNS,
        warmup: "one discarded cycle per compiler",
        compilerOptions: "strict, noEmit, skipLibCheck, incremental, tsBuildInfoFile=.cache/tsconfig.tsbuildinfo",
        edits: "append one exported const; mid = module index size/2 (half the graph depends on it), leaf = last module (nothing depends on it)",
      },
      startups,
      results,
      diagnostics,
      typeErrorDetection: detect,
    },
    null,
    2,
  ) + "\n",
);
console.log("\nresults.json written");
