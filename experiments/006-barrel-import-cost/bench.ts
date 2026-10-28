// 006: what a re-export barrel costs a build at equal work.
// For each module count, builds the same app three ways and times Bun.build.
//   direct  entry -> mods/m0.ts                    (one module)
//   barrel  entry -> mods/index.ts -> export * N   (flat barrel)
//   nested  entry -> mods/index.ts -> f0/index.ts  (two levels of barrels)
// Every variant imports the same one function and nothing else, so the output
// bundle is identical by construction; only the module graph differs.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "tmp", "006");
const COUNTS = [100, 500, 1000, 2000];
const RUNS = 3;
const FOLDERS = 10;

rmSync(ROOT, { recursive: true, force: true });

function module(n: number, id: string) {
  return [
    `export function fn${id}(x: number): number {`,
    `  const k = ${n};`,
    `  return x * 2 + k;`,
    `}`,
    `export const val${id} = ${n};`,
    "",
  ].join("\n");
}

function make(n: number, variant: string) {
  const dir = join(ROOT, `${variant}-${n}`);
  mkdirSync(join(dir, "mods"), { recursive: true });

  if (variant === "nested") {
    const per = n / FOLDERS;
    for (let f = 0; f < FOLDERS; f++) {
      const fdir = join(dir, "mods", `f${f}`);
      mkdirSync(fdir, { recursive: true });
      for (let j = 0; j < per; j++) {
        const id = `${f}_${j}`;
        writeFileSync(join(fdir, `m${j}.ts`), module(f * per + j, id));
      }
      writeFileSync(
        join(fdir, "index.ts"),
        Array.from({ length: per }, (_, j) => `export * from "./m${j}";`).join("\n") + "\n",
      );
    }
    writeFileSync(
      join(dir, "mods", "index.ts"),
      Array.from({ length: FOLDERS }, (_, f) => `export * from "./f${f}";`).join("\n") + "\n",
    );
    writeFileSync(join(dir, "entry.ts"), `import { fn0_0 } from "./mods";\nconsole.log(fn0_0(1));\n`);
    return dir;
  }

  for (let k = 0; k < n; k++) writeFileSync(join(dir, "mods", `m${k}.ts`), module(k, String(k)));
  if (variant === "barrel") {
    writeFileSync(
      join(dir, "mods", "index.ts"),
      Array.from({ length: n }, (_, k) => `export * from "./m${k}";`).join("\n") + "\n",
    );
    writeFileSync(join(dir, "entry.ts"), `import { fn0 } from "./mods";\nconsole.log(fn0(1));\n`);
  } else {
    writeFileSync(join(dir, "entry.ts"), `import { fn0 } from "./mods/m0";\nconsole.log(fn0(1));\n`);
  }
  return dir;
}

const runs = [];

async function time(dir: string, n: number, variant: string, run: number) {
  const outdir = join(ROOT, "out", `${variant}-${n}-${run}`);
  rmSync(outdir, { recursive: true, force: true });
  const t0 = performance.now();
  const res = await Bun.build({ entrypoints: [join(dir, "entry.ts")], target: "bun", minify: false, outdir });
  const ms = performance.now() - t0;
  if (!res.success) throw new Error(`${variant}-${n}: ${res.logs.join(" ")}`);
  runs.push({ n, variant, run, ms: +ms.toFixed(3), bytes: res.outputs[0]?.size ?? 0 });
}

const variants = ["direct", "barrel", "nested"];
const dirs = {};
for (const n of COUNTS) for (const v of variants) dirs[`${v}-${n}`] = make(n, v);

// warm the transpiler once so the first build of the process is not the outlier
await time(dirs["direct-100"], 100, "direct", -1);
await time(dirs["barrel-100"], 100, "barrel", -1);
runs.length = 0;

for (let r = 0; r < RUNS; r++) {
  for (const n of COUNTS) {
    for (const v of variants) await time(dirs[`${v}-${n}`], n, v, r);
  }
}

// noise floor: same build, same input, five times
const noise = [];
for (let i = 0; i < 5; i++) {
  const outdir = join(ROOT, "out", `noise-${i}`);
  const t0 = performance.now();
  await Bun.build({ entrypoints: [join(dirs["barrel-1000"], "entry.ts")], target: "bun", outdir });
  noise.push(+(performance.now() - t0).toFixed(3));
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.floor(s.length / 2)].toFixed(3);
};

const summary = {};
for (const n of COUNTS) {
  summary[n] = {};
  for (const v of variants) {
    const rows = runs.filter((r) => r.n === n && r.variant === v);
    summary[n][v] = {
      medianMs: med(rows.map((r) => r.ms)),
      allMs: rows.map((r) => r.ms),
      bytes: [...new Set(rows.map((r) => r.bytes))],
    };
  }
  summary[n].overheadVsDirectMs = +(summary[n].barrel.medianMs - summary[n].direct.medianMs).toFixed(3);
  summary[n].msPerReExport = +((summary[n].barrel.medianMs - summary[n].direct.medianMs) / n).toFixed(4);
}

// does a second entrypoint pay the barrel again, or is the graph cached per build?
const shared = [];
for (let i = 0; i < 3; i++) {
  const second = join(dirs["barrel-1000"], "entry2.ts");
  writeFileSync(second, `import { fn5 } from "./mods";\nconsole.log(fn5(2));\n`);
  const outdir = join(ROOT, "out", `two-entries-${i}`);
  const t0 = performance.now();
  await Bun.build({ entrypoints: [join(dirs["barrel-1000"], "entry.ts"), second], target: "bun", outdir });
  shared.push(+(performance.now() - t0).toFixed(3));
}

const out = {
  generatedAt: new Date().toISOString(),
  bun: Bun.version,
  platform: `${process.platform} ${process.arch}`,
  counts: COUNTS,
  runs,
  summary,
  twoEntrypointsSharingOneBarrelMs: shared,
  noiseFloorMs: { samples: noise, min: Math.min(...noise), max: Math.max(...noise), spread: +(Math.max(...noise) - Math.min(...noise)).toFixed(3) },
};

writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out.summary, null, 1));
console.log("noise", out.noiseFloorMs);
