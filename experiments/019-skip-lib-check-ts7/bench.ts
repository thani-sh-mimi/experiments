#!/usr/bin/env bun
// 019: does skipLibCheck still pay on TypeScript 7, and does the saving
// follow the number of .d.ts files or the lines inside them?
//
// Generates five projects that differ only in their lib/*.d.ts tree, then
// type-checks each with TS 6 and TS 7 under three declaration-checking arms:
//   check       - skipLibCheck off, skipDefaultLibCheck off
//   defaultlib  - skipDefaultLibCheck on, skipLibCheck off
//   skip        - skipLibCheck on
// Both compilers reject `--skipLibCheck=false` on the command line, so every
// arm lives in its own tsconfig.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const HERE = import.meta.dir;
const WORK = join(HERE, "tmp");
const OUT = join(HERE, "results.json");

const OWN_MODULES = 200;
const RUNS = 4;
const WARMUP = 1;
const VARIANTS = ["check", "defaultlib", "skip"] as const;
type Variant = (typeof VARIANTS)[number];

const COMPILERS = [
  { name: "ts6", bin: join(HERE, "../../node_modules/typescript6/bin/tsc") },
  { name: "ts7", bin: join(HERE, "../../node_modules/typescript/bin/tsc") },
];

type Layout = { name: string; files: number; blocks: number; light?: boolean; lib?: string[] };

const LAYOUTS: Layout[] = [
  { name: "none", files: 0, blocks: 0 },
  { name: "none-es5", files: 0, blocks: 0, lib: ["ES5"] },
  { name: "many-heavy", files: 300, blocks: 4 },
  { name: "few-heavy", files: 12, blocks: 100 },
  { name: "many-light", files: 300, blocks: 0, light: true },
];

const pad = (n: number, w = 3) => String(n).padStart(w, "0");

// ---------------------------------------------------------------- own code

function ownModule(i: number): string {
  const prev = (i + OWN_MODULES - 1) % OWN_MODULES;
  return `import type { Row${prev} } from "./m${pad(prev)}";

export interface Row${i} {
  readonly id: string;
  count: number;
  label: "alpha" | "beta" | "gamma";
  tags: string[];
}

export interface View${i} {
  row: Row${i};
  sibling: Row${prev} | null;
  order: number;
}

export function thing${i}(row: Row${i}): View${i} {
  return { row, sibling: null, order: ${i} };
}

export function fold${i}<T>(items: readonly T[], f: (acc: T, next: T) => T): T | undefined {
  let acc: T | undefined;
  for (const item of items) acc = acc === undefined ? item : f(acc, item);
  return acc;
}

export function pick${i}<K extends keyof Row${i}>(row: Row${i}, key: K): Row${i}[K] {
  return row[key];
}

export const count${i} = (rows: readonly Row${i}[]): number => rows.length;
`;
}

// ------------------------------------------------------------- declarations

function heavyBlock(id: string): string {
  const E = `Ent_${id}`;
  return `export interface ${E} {
  readonly id: string;
  kind: "alpha" | "beta" | "gamma";
  scores: Record<string, number>;
  rows: Array<{ at: number; tag: string; ok: boolean }>;
}

export type Mapped_${id} = { -readonly [K in keyof ${E}]: ${E}[K] };
export type Cond_${id}<T> = T extends string ? "s" : T extends number ? "n" : T extends readonly unknown[] ? "a" : "o";
export type Split_${id}<T> = T extends \`\${infer H}.\${infer R}\` ? [H, R] : never;
export type Deep_${id}<T, D extends number = 3> = D extends 0 ? T : T extends readonly (infer U)[] ? Deep_${id}<U, 2> : T;
export declare function make_${id}<T extends ${E}>(v: T): Cond_${id}<T["kind"]>;
export declare function split_${id}<T extends string>(v: T): Split_${id}<T>;
export declare const index_${id}: Map<string, ${E}[]>;
`;
}

function lightFile(id: string): string {
  return `export interface Tiny_${id} { a: number; b: string; c: boolean }\n`;
}

function heavyFile(layout: string, fileIndex: number, blocks: number): string {
  let out = `// generated declaration file ${fileIndex}\n`;
  for (let b = 0; b < blocks; b++) out += heavyBlock(`${layout.replace(/-/g, "_")}_${pad(fileIndex)}_${b}`);
  return out;
}

// ---------------------------------------------------------------- generate

function tsconfig(variant: Variant, lib?: string[]) {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      types: [],
      incremental: false,
      skipLibCheck: variant === "skip",
      skipDefaultLibCheck: variant === "defaultlib",
      ...(lib ? { lib } : {}),
    },
    include: [] as string[],
  };
}

function generate(layout: Layout): string {
  const dir = join(WORK, layout.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });

  for (let i = 0; i < OWN_MODULES; i++) {
    writeFileSync(join(dir, "src", `m${pad(i)}.ts`), ownModule(i));
  }

  if (layout.files > 0) {
    mkdirSync(join(dir, "lib"), { recursive: true });
    for (let f = 0; f < layout.files; f++) {
      const body = layout.light ? lightFile(`${pad(f)}`) : heavyFile(layout.name, f, layout.blocks);
      writeFileSync(join(dir, "lib", `l${pad(f)}.d.ts`), body);
    }
  }

  const include = layout.files > 0 ? ["src", "lib"] : ["src"];
  for (const variant of VARIANTS) {
    const cfg = tsconfig(variant, layout.lib);
    cfg.include = include;
    writeFileSync(join(dir, `tsconfig.${variant}.json`), JSON.stringify(cfg, null, 2));
  }
  return dir;
}

// ------------------------------------------------------------------- run

function timeIt(bin: string, project: string, variant: Variant) {
  const config = join(project, `tsconfig.${variant}.json`);
  const args = ["--project", config, "--extendedDiagnostics", "--pretty", "false"];
  const t0 = performance.now();
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const wallMs = performance.now() - t0;
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const ms = (label: string) => {
    const m = out.match(new RegExp(`^${label}:\\s+([\\d.]+)(ms|s)`, "m"));
    if (!m) return null;
    return m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
  };
  const count = (label: string) => {
    const m = out.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) : -1;
  };
  // TS 7 prints one `Lines:` total; TS 6 splits it into Library / Definitions / TypeScript.
  const totalLines =
    count("Lines") >= 0
      ? count("Lines")
      : count("Lines of Library") + count("Lines of Definitions") + count("Lines of TypeScript");
  return {
    wallMs,
    totalMs: ms("Total time"),
    checkMs: ms("Check time"),
    files: count("Files"),
    lines: totalLines,
    defLines: count("Lines of Definitions"),
    exit: r.status,
    output: r.status === 0 ? null : out.slice(0, 300),
  };
}

// ------------------------------------------------------------------ main

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const dirs: Record<string, string> = {};
for (const layout of LAYOUTS) dirs[layout.name] = generate(layout);

const runs: any[] = [];
// Interleave: one pass touches every cell, so a burst of host noise lands on
// all of them instead of on one. Pass -1 is the discarded warm-up.
for (let i = -WARMUP; i < RUNS; i++) {
  for (const compiler of COMPILERS) {
    for (const layout of LAYOUTS) {
      for (const variant of VARIANTS) {
        const res = timeIt(compiler.bin, dirs[layout.name], variant);
        if (i >= 0) runs.push({ compiler: compiler.name, layout: layout.name, variant, run: i, ...res });
        if (res.exit !== 0) console.error(`FAIL ${compiler.name} ${layout.name} ${variant}: ${res.output}`);
      }
    }
  }
  process.stdout.write(".");
}
process.stdout.write("\n");

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const cells = [] as any[];
for (const compiler of COMPILERS) {
  for (const layout of LAYOUTS) {
    const cell: any = { compiler: compiler.name, layout: layout.name };
    for (const variant of VARIANTS) {
      const rs = runs.filter(
        (r) => r.compiler === compiler.name && r.layout === layout.name && r.variant === variant,
      );
      cell[`${variant}Wall`] = median(rs.map((r) => r.wallMs));
      cell[`${variant}Check`] = median(rs.map((r) => r.checkMs));
      cell[`${variant}Min`] = Math.min(...rs.map((r) => r.wallMs));
      cell[`${variant}Max`] = Math.max(...rs.map((r) => r.wallMs));
      cell.files = rs[0].files;
      cell.lines = rs[0].lines;
      cell.defLines = rs[0].defLines;
    }
    // Decompose: the default lib's check cost, then the project d.ts check cost.
    cell.defaultLibSavingMs = cell.checkWall - cell.defaultlibWall;
    cell.projectDtsSavingMs = cell.defaultlibWall - cell.skipWall;
    cell.savedPct = (1 - cell.skipWall / cell.checkWall) * 100;
    cell.ratio = cell.checkWall / cell.skipWall;
    cell.spreadPct = Math.max(
      ...VARIANTS.map((v) => ((cell[`${v}Max`] - cell[`${v}Min`]) / cell[`${v}Wall`]) * 100),
    );
    cells.push(cell);
  }
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

const table = cells.map((c) => ({
  compiler: c.compiler,
  layout: c.layout,
  files: c.files,
  lines: c.lines,
  check_ms: round(c.checkWall),
  defaultlib_ms: round(c.defaultlibWall),
  skip_ms: round(c.skipWall),
  saved_pct: round(c.savedPct),
  lib_part_ms: round(c.defaultLibSavingMs),
  dts_part_ms: round(c.projectDtsSavingMs),
  check_full_ms: round(c.checkCheck),
  check_skip_ms: round(c.skipCheck),
  spread_pct: round(c.spreadPct),
}));

console.table(table);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      question:
        "Does skipLibCheck still pay on TypeScript 7, and does the saving follow d.ts file count or lines?",
      generatedAt: new Date().toISOString(),
      versions: { ts6: "6.0.3", ts7: "7.0.2", bun: Bun.version },
      setup: {
        ownModules: OWN_MODULES,
        runs: RUNS,
        warmupRunsDiscarded: WARMUP,
        variants: VARIANTS,
        layouts: LAYOUTS,
        compilers: COMPILERS.map((c) => c.name),
      },
      cells: cells.map((c) => ({
        compiler: c.compiler,
        layout: c.layout,
        files: c.files,
        lines: c.lines,
        declarationLines: c.defLines,
        wallMs: Object.fromEntries(
          VARIANTS.map((v) => [
            v,
            { median: round(c[`${v}Wall`]), min: round(c[`${v}Min`]), max: round(c[`${v}Max`]), medianCheckMs: round(c[`${v}Check`]) },
          ]),
        ),
        savedPct: round(c.savedPct),
        defaultLibSavingMs: round(c.defaultLibSavingMs),
        projectDtsSavingMs: round(c.projectDtsSavingMs),
        withinCellSpreadPct: round(c.spreadPct),
      })),
      runs,
    },
    null,
    2,
  ),
);
console.log(`\nwrote ${OUT}`);
