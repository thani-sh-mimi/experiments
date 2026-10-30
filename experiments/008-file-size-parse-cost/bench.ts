// 008: the editor tax. Does file size cost parse/transpile time at equal bytes?
// One 20k-line body of synthetic TypeScript, chunked into files of 2000, 500,
// 200, 50 and 20 lines. Same bytes in every variant; only the cut changes.
//   full   - transpile every file once (a cold build, no cache)
//   edit   - transpile the one file an edit lands in (what a bundler re-parses)
//   load   - `bun run entry.ts` importing all of them (real module loader)
// Also writes a tsconfig per variant so a tsc run can be measured outside.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "tmp", "008");
const CHUNKS = [2000, 500, 200, 50, 20]; // target lines per file
const TOTAL_LINES = 20_000;
const RUNS = 3;
const EDIT_REPS = 300;

rmSync(ROOT, { recursive: true, force: true });

// ---- synthetic source: self-contained blocks, 9-17 lines each -------------
function block(i: number): string[] {
  const kind = i % 4;
  const id = `k${i}`;
  if (kind === 0) {
    return [
      `/** Row ${i}: fixed-width record used by the ${id} table. */`,
      `export interface ${id}Row {`,
      `  id: number;`,
      `  name: string;`,
      `  score: number;`,
      `  tags: string[];`,
      `}`,
      `export function ${id}Score(r: ${id}Row): number {`,
      `  let total = r.score;`,
      `  for (const t of r.tags) total += t.length;`,
      `  return total * 2 + r.id;`,
      `}`,
      `export const ${id}Empty: ${id}Row = { id: -1, name: "", score: 0, tags: [] };`,
    ];
  }
  if (kind === 1) {
    return [
      `type ${id}Fn = (a: number, b: number) => number;`,
      `export const ${id}Add: ${id}Fn = (a, b) => a + b;`,
      `export const ${id}Mul: ${id}Fn = (a, b) => a * b;`,
      `export function ${id}Apply(xs: number[], f: ${id}Fn): number[] {`,
      `  const out: number[] = [];`,
      `  for (let j = 0; j < xs.length; j++) out.push(f(xs[j], j));`,
      `  return out;`,
      `}`,
      `export const ${id}Label = "block ${i}";`,
    ];
  }
  if (kind === 2) {
    return [
      `export class ${id}Store {`,
      `  private items = new Map<string, number>();`,
      `  set(k: string, v: number): void {`,
      `    this.items.set(k, v + ${i});`,
      `  }`,
      `  get(k: string): number {`,
      `    return this.items.get(k) ?? 0;`,
      `  }`,
      `  size(): number {`,
      `    return this.items.size;`,
      `  }`,
      `}`,
    ];
  }
  return [
    `export function ${id}Parse(raw: string): { key: string; value: number }[] {`,
    `  const rows: { key: string; value: number }[] = [];`,
    `  for (const line of raw.split("\\n")) {`,
    `    const at = line.indexOf("=");`,
    `    if (at < 1) continue;`,
    `    rows.push({ key: line.slice(0, at), value: Number(line.slice(at + 1)) });`,
    `  }`,
    `  return rows;`,
    `}`,
    `export const ${id}Seed = ${i};`,
  ];
}

const lines: string[] = [];
for (let i = 0; lines.length < TOTAL_LINES; i++) lines.push(...block(i), "");

// ---- build one variant ---------------------------------------------------
function make(targetLines: number) {
  const dir = join(ROOT, `chunk-${targetLines}`);
  mkdirSync(dir, { recursive: true });
  const bodies: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    cur.push(line);
    if (cur.length >= targetLines && line === "") {
      bodies.push(cur.join("\n"));
      cur = [];
    }
  }
  if (cur.length) bodies.push(cur.join("\n"));

  const files: { path: string; code: string }[] = [];
  bodies.forEach((body, n) => {
    const path = join(dir, `m${n}.ts`);
    writeFileSync(path, body);
    files.push({ path, code: body });
  });
  writeFileSync(
    join(dir, "entry.ts"),
    files.map((_, n) => `import * as m${n} from "./m${n}";`).join("\n") +
      `\nexport const n = ${files.length};\nconsole.log("modules", ${files.length});\n`,
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { noEmit: true, strict: true, target: "es2022", module: "esnext" }, include: ["*.ts"] }, null, 2) + "\n",
  );
  const bytes = bodies.reduce((a, b) => a + Bun.stringWidth(b), 0);
  return { dir, files, bodyBytes: bytes, linesPerFile: +(TOTAL_LINES / bodies.length).toFixed(1), count: bodies.length };
}

const variants = CHUNKS.map(make);

// ---- measure -------------------------------------------------------------
const transpiler = new Bun.Transpiler({ loader: "ts" });
const t0warm = Bun.nanoseconds();
transpiler.transformSync("export const x: number = 1;\n");
console.log("warmup", ((Bun.nanoseconds() - t0warm) / 1e6).toFixed(2), "ms");

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const runs: any[] = [];

function full(v: (typeof variants)[number], run: number) {
  const start = Bun.nanoseconds();
  let outBytes = 0;
  for (const f of v.files) outBytes += transpiler.transformSync(f.code).length;
  const ms = (Bun.nanoseconds() - start) / 1e6;
  runs.push({ chunk: v.count, linesPerFile: v.linesPerFile, bodyBytes: v.bodyBytes, run, ms: +ms.toFixed(3), outBytes });
}

function edit(v: (typeof variants)[number], run: number) {
  const f = v.files[Math.floor(v.files.length / 2)];
  const samples: number[] = [];
  for (let i = 0; i < EDIT_REPS; i++) {
    const s = Bun.nanoseconds();
    transpiler.transformSync(f.code);
    samples.push((Bun.nanoseconds() - s) / 1e6);
  }
  runs.push({
    chunk: v.count,
    linesPerFile: v.linesPerFile,
    run,
    kind: "edit",
    editMs: +med(samples).toFixed(4),
    editP95Ms: +[...samples].sort((a, b) => a - b)[Math.floor(EDIT_REPS * 0.95)].toFixed(4),
    editFileBytes: f.code.length,
  });
}

// warm every variant once so the first touch of each is not the outlier
for (const v of variants) full(v, -1);
runs.length = 0;

for (let r = 0; r < RUNS; r++) {
  for (const v of variants) full(v, r);
  for (const v of variants) edit(v, r);
}

// noise floor: the smallest variant, transpiled 30 times
const noise: number[] = [];
for (let i = 0; i < 30; i++) {
  const s = Bun.nanoseconds();
  transpiler.transformSync(variants[0].files[0].code);
  noise.push((Bun.nanoseconds() - s) / 1e6);
}

// per-call fixed overhead: transpile an empty file 5,000 times
const empty: number[] = [];
for (let i = 0; i < 5000; i++) {
  const s = Bun.nanoseconds();
  transpiler.transformSync("");
  empty.push((Bun.nanoseconds() - s) / 1e3);
}

// ---- real loader: spawn bun on each variant's entry ----------------------
const load: any[] = [];
for (let r = 0; r < RUNS; r++) {
  for (const v of variants) {
    const s = Bun.nanoseconds();
    const p = Bun.spawnSync([process.execPath, join(v.dir, "entry.ts")], { stdout: "pipe", stderr: "pipe" });
    const ms = (Bun.nanoseconds() - s) / 1e6;
    load.push({ chunk: v.count, linesPerFile: v.linesPerFile, run: r, ms: +ms.toFixed(3), ok: p.exitCode === 0, err: p.exitCode === 0 ? undefined : p.stderr.toString().slice(0, 300) });
  }
}

const summary: any = {};
for (const v of variants) {
  const fulls = runs.filter((r) => r.chunk === v.count && r.kind !== "edit").map((r) => r.ms);
  const edits = runs.filter((r) => r.chunk === v.count && r.kind === "edit").map((r) => r.editMs);
  const loads = load.filter((r) => r.chunk === v.count && r.ok).map((r) => r.ms);
  const fullMs = med(fulls);
  summary[v.count] = {
    files: v.count,
    linesPerFile: v.linesPerFile,
    bodyKB: +(v.bodyBytes / 1024).toFixed(1),
    fullMs: +fullMs.toFixed(3),
    fullAllMs: fulls,
    msPerKB: +(fullMs / (v.bodyBytes / 1024)).toFixed(4),
    perFileUs: +((fullMs * 1000) / v.count).toFixed(2),
    editUs: +(med(edits) * 1000).toFixed(1),
    editP95Us: +(med(runs.filter((r) => r.chunk === v.count && r.kind === "edit").map((r) => r.editP95Ms)) * 1000).toFixed(1),
    editShareOfFullPct: +((med(edits) / fullMs) * 100).toFixed(2),
    loadMs: loads.length ? +med(loads).toFixed(1) : null,
    loadAllMs: loads,
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  bun: Bun.version,
  platform: `${process.platform} ${process.arch}`,
  cpus: require("node:os").cpus().length,
  totalLines: TOTAL_LINES,
  chunks: CHUNKS,
  runs,
  load,
  summary,
  noiseFloorMs: {
    samples: noise.map((x) => +x.toFixed(3)),
    min: +Math.min(...noise).toFixed(3),
    max: +Math.max(...noise).toFixed(3),
    spread: +(Math.max(...noise) - Math.min(...noise)).toFixed(3),
  },
  emptyCallUs: { median: +med(empty).toFixed(2), min: +Math.min(...empty).toFixed(2), max: +Math.max(...empty).toFixed(2) },
};

writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 1));
console.log("noise", out.noiseFloorMs);
console.log("empty call us", out.emptyCallUs);
