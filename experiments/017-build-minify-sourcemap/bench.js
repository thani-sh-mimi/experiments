// 017 — what do --minify and --sourcemap cost `bun build`?
// Generates a synthetic TypeScript graph, builds it five ways, three timed runs each.
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const MODULE_COUNTS = [100, 1000, 4000];
const VARIANTS = [
  { name: "plain", flags: [] },
  { name: "minify", flags: ["--minify"] },
  { name: "min-whitespace", flags: ["--minify-whitespace"] },
  { name: "min-syntax", flags: ["--minify-syntax"] },
  { name: "min-identifiers", flags: ["--minify-identifiers"] },
  { name: "map", flags: ["--sourcemap=external"] },
  { name: "minify+map", flags: ["--minify", "--sourcemap=external"] },
  { name: "minify+inline", flags: ["--minify", "--sourcemap=inline"] },
];
const RUNS = 3;

const base = join(import.meta.dir, "tmp");

function core() {
  return `// Shared helpers. Synthetic on purpose: no real project code.
export const TAGS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

export function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

export function formatLabel(prefix: string, amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return prefix + ":" + rounded.toFixed(2);
}

export function pickTag(seed: number): string {
  return TAGS[Math.abs(seed) % TAGS.length];
}
`;
}

function moduleSource(i, prev) {
  const importPrev = prev
    ? `import { handle${prev} } from "./mod${prev}.ts";\n`
    : "";
  const callPrev = prev
    ? `  const upstream = handle${prev}(payload);\n`
    : `  const upstream = "root";\n`;
  return `import { clamp, formatLabel, pickTag } from "../lib/core.ts";
${importPrev}
// Scenario ${i}: adjusts a payload before it leaves the module.
export interface Payload${i} {
  kind: string;
  amount: number;
  tags: string[];
}

const WEIGHT_${i} = ${(i % 97) + 1};
const LIMIT_${i} = ${(i % 13) * 100 + 500};

export function handle${i}(payload: Payload${i}): string {
${callPrev}  const amount = clamp(payload.amount * WEIGHT_${i}, 0, LIMIT_${i});
  const tag = pickTag(${i} + payload.tags.length);
  const label = formatLabel("m${i}", amount);
  if (payload.kind === "skip") {
    return upstream + "|" + label + "|skipped";
  }
  const parts = payload.tags.map((value, index) => value + ":" + index);
  return upstream + "|" + label + "|" + tag + "|" + parts.join(",");
}

export function describe${i}(): string {
  return "module ${i} weight ${"${WEIGHT_" + i + "}"} limit ${"${LIMIT_" + i + "}"}";
}
`;
}

function entrySource(count) {
  const imports = Array.from(
    { length: count },
    (_, i) => `import { handle${i}, describe${i} } from "./mod${i}.ts";`,
  ).join("\n");
  const calls = Array.from(
    { length: count },
    (_, i) =>
      `  results.push(handle${i}({ kind: "run", amount: ${i} + 1, tags: ["a", "b"] }));\n  names.push(describe${i}());`,
  ).join("\n");
  return `${imports}

const results: string[] = [];
const names: string[] = [];

export function main(): string {
${calls}
  return results.length + " results, " + names.length + " names";
}

console.log(main());
`;
}

function generate(count) {
  const dir = join(base, `src-${count}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "lib", "core.ts"), core());
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(dir, "app", `mod${i}.ts`),
      moduleSource(i, i === 0 ? null : i - 1),
    );
  }
  writeFileSync(join(dir, "app", "entry.ts"), entrySource(count));
  return { dir, entry: join(dir, "app", "entry.ts") };
}

function dirBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) stack.push(path);
      else total += info.size;
    }
  }
  return total;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const results = [];

for (const count of MODULE_COUNTS) {
  const { dir, entry } = generate(count);
  if (process.argv[2] === "generate") continue;
  const sourceBytes = dirBytes(dir);

  for (const variant of VARIANTS) {
    const outdir = join(base, `out-${count}`);
    const times = [];

    for (let run = 0; run < RUNS + 1; run++) {
      rmSync(outdir, { recursive: true, force: true });
      const started = performance.now();
      const proc = Bun.spawnSync(
        [
          "bun",
          "build",
          entry,
          "--target=bun",
          "--outdir",
          outdir,
          ...variant.flags,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const elapsed = performance.now() - started;
      if (proc.exitCode !== 0) {
        console.error(
          `build failed: ${count} ${variant.name}\n${proc.stderr.toString()}`,
        );
        process.exit(1);
      }
      if (run > 0) times.push(elapsed);
    }

    const files = readdirSync(outdir);
    const jsName = "entry.js";
    const mapName = "entry.js.map";
    const jsBytes = statSync(join(outdir, jsName)).size;
    const mapBytes = files.includes(mapName)
      ? statSync(join(outdir, mapName)).size
      : 0;
    const gzipJs = gzipSync(readFileSync(join(outdir, jsName)), {
      level: 9,
    }).length;
    const gzipMap = factors(files, outdir);

    let mapContentChars = 0;
    let mapMappingsChars = 0;
    let strippedGzip = 0;
    if (files.includes(mapName)) {
      const map = JSON.parse(readFileSync(join(outdir, mapName), "utf8"));
      mapContentChars = (map.sourcesContent ?? []).reduce(
        (sum, text) => sum + (text?.length ?? 0),
        0,
      );
      mapMappingsChars = map.mappings.length;
      const stripped = JSON.stringify({ ...map, sourcesContent: undefined });
      strippedGzip = gzipSync(stripped, { level: 9 }).length;
    }

    results.push({
      modules: count,
      mapContentChars,
      mapMappingsChars,
      strippedGzip,
      variant: variant.name,
      flags: variant.flags,
      sourceBytes,
      runs: times.map((value) => Math.round(value * 10) / 10),
      medianMs: Math.round(median(times) * 10) / 10,
      outBytes: dirBytes(outdir),
      jsBytes,
      mapBytes,
      gzipJs,
      gzipMap,
    });

    console.log(
      `${count} modules ${variant.name.padEnd(14)} ${median(times).toFixed(1)} ms  js ${(jsBytes / 1024).toFixed(0)} KB  ` +
        `map ${(mapBytes / 1024).toFixed(0)} KB  gz ${(gzipJs / 1024).toFixed(0)} KB`,
    );
  }

  rmSync(dir, { recursive: true, force: true });
}

function factors(files, outdir) {
  const mapName = "entry.js.map";
  if (!files.includes(mapName)) return 0;
  return gzipSync(readFileSync(join(outdir, mapName)), { level: 9 }).length;
}

// Baseline: the cost of starting bun at all, so the table can be read net of it.
const spawnTimes = [];
for (let run = 0; run < RUNS + 1; run++) {
  const started = performance.now();
  Bun.spawnSync(["bun", "-e", ""], { stdout: "pipe", stderr: "pipe" });
  const elapsed = performance.now() - started;
  if (run > 0) spawnTimes.push(Math.round(elapsed * 10) / 10);
}
const spawnMs = Math.round(median(spawnTimes) * 10) / 10;

writeFileSync(
  join(import.meta.dir, "results.json"),
  JSON.stringify({ runs: RUNS, spawnMs, spawnTimes, results }, null, 2),
);
console.log(`bun spawn floor ${spawnMs} ms`);
