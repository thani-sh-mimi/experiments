// 022 — does one splitting build of 40 routes beat 40 separate builds?
// Synthetic graph: `core` modules shared by every route, 20 leaf modules unique per route.
import { rm, mkdir, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const SRC = join(ROOT, "tmp/src");
const OUT = join(ROOT, "tmp/out");

const CORE = 60; // modules every route imports
const LEAVES = 20; // modules only one route imports
const ROUTES = 40; // entrypoints
const RUNS = 3;

// ---------- synthetic source ----------
async function generate() {
  await rm(SRC, { recursive: true, force: true });
  await mkdir(join(SRC, "core"), { recursive: true });
  for (let i = 0; i < CORE; i++) {
    const next =
      i + 1 < CORE
        ? `import { core${i + 1} } from "./core-${i + 1}.ts";\n`
        : "";
    const call = i + 1 < CORE ? `core${i + 1}(x + ${i})` : `x + ${i}`;
    const table = Array.from({ length: 8 }, (_, k) => (i * 7 + k) % 97).join(
      ", ",
    );
    await Bun.write(
      join(SRC, "core", `core-${i}.ts`),
      `${next}// shared module ${i}\nexport function core${i}(x: number): number {\n  const table = [${table}];\n  return table[x % table.length] + ${call};\n}\n`,
    );
  }
  for (let r = 0; r < ROUTES; r++) {
    const dir = join(SRC, `route-${r}`);
    await mkdir(dir, { recursive: true });
    for (let l = 0; l < LEAVES; l++) {
      const table = Array.from(
        { length: 8 },
        (_, k) => (r * 13 + l * 7 + k) % 89,
      ).join(", ");
      await Bun.write(
        join(dir, `leaf-${l}.ts`),
        `// route ${r} leaf ${l}\nexport function leaf${l}(x: number): number {\n  const table = [${table}];\n  return table[x % table.length] + ${l};\n}\n`,
      );
    }
    const coreImports = Array.from(
      { length: CORE },
      (_, i) => `import { core${i} } from "../core/core-${i}.ts";`,
    ).join("\n");
    const leafImports = Array.from(
      { length: LEAVES },
      (_, l) => `import { leaf${l} } from "./leaf-${l}.ts";`,
    ).join("\n");
    const coreCalls = Array.from(
      { length: CORE },
      (_, i) => `core${i}(${i + 1})`,
    ).join(" + ");
    const leafCalls = Array.from(
      { length: LEAVES },
      (_, l) => `leaf${l}(${l + 1})`,
    ).join(" + ");
    await Bun.write(
      join(dir, "index.ts"),
      `${coreImports}\n${leafImports}\n\nexport function render(): number {\n  return (${coreCalls}) + (${leafCalls});\n}\n\nif (import.meta.main) console.log("route ${r}", render());\n`,
    );
  }
}

const entry = (r) => join(SRC, `route-${r}`, "index.ts");

// ---------- measurement ----------
async function dirBytes(dir) {
  let raw = 0;
  let gz = 0;
  let files = 0;
  const walk = async (d) => {
    for (const name of await readdir(d)) {
      const p = join(d, name);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else {
        files++;
        raw += s.size;
        gz += gzipSync(readFileSync(p)).length;
      }
    }
  };
  await walk(dir);
  return { files, raw, gz };
}

async function clean() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
}

const separateApi = async (n, outdir) => {
  for (let r = 0; r < n; r++) {
    await Bun.build({
      entrypoints: [entry(r)],
      outdir: join(outdir, `route-${r}`),
      root: SRC,
      target: "browser",
      minify: false,
    });
  }
};

const separateCli = async (n, outdir) => {
  for (let r = 0; r < n; r++) {
    const p = Bun.spawn(
      [
        "bun",
        "build",
        entry(r),
        "--outdir",
        join(outdir, `route-${r}`),
        "--target",
        "browser",
        "--root",
        SRC,
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const code = await p.exited;
    if (code !== 0)
      throw new Error(
        `cli build failed: ${await new Response(p.stderr).text()}`,
      );
  }
};

const combined = (splitting) => async (n, outdir) => {
  const res = await Bun.build({
    entrypoints: Array.from({ length: n }, (_, r) => entry(r)),
    outdir,
    root: SRC,
    target: "browser",
    splitting,
    minify: false,
  });
  if (!res.success) throw new Error(res.logs.join("\n"));
};

const modes = [
  { name: "separate-api-40", run: separateApi },
  { name: "separate-cli-40", run: separateCli },
  { name: "combined-unsplit-40", run: combined(false) },
  { name: "combined-split-40", run: combined(true) },
  // sweep: does time follow modules or entrypoints?
  { name: "combined-unsplit-1", run: (n, o) => combined(false)(1, o) },
  { name: "combined-split-1", run: (n, o) => combined(true)(1, o) },
  { name: "combined-unsplit-10", run: (n, o) => combined(false)(10, o) },
  { name: "combined-split-10", run: (n, o) => combined(true)(10, o) },
];

const runs = {};

await generate();

for (let run = 0; run < RUNS; run++) {
  for (const mode of modes) {
    const n = Number(mode.name.split("-").at(-1));
    const outdir = join(OUT, `${mode.name}-r${run}`);
    await clean();
    await mkdir(outdir, { recursive: true });
    const t0 = performance.now();
    await mode.run(n, outdir);
    const ms = performance.now() - t0;
    const b = await dirBytes(outdir);
    runs[mode.name] ??= { ms: [], bytes: [] };
    runs[mode.name].ms.push(Number(ms.toFixed(1)));
    runs[mode.name].bytes.push(b);
  }
  // rotate so no mode always runs first or last
  modes.push(modes.shift());
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const summary = Object.fromEntries(
  Object.entries(runs).map(([k, v]) => {
    const b = v.bytes[0];
    const stable = v.bytes.every((x) => x.raw === b.raw && x.files === b.files);
    return [
      k,
      {
        ms: Number(median(v.ms).toFixed(1)),
        raw_runs: v.ms,
        files: b.files,
        raw: b.raw,
        gz: b.gz,
        bytes_identical_across_runs: stable,
      },
    ];
  }),
);

// ---------- sanity: the split output must run, and the chunk must hold the core ----------
async function sanity() {
  const outdir = join(OUT, "sanity");
  await clean();
  await mkdir(outdir, { recursive: true });
  await combined(true)(ROUTES, outdir);
  const files = (await readdir(outdir)).sort();
  const p = Bun.spawn(["bun", join(outdir, "route-0", "index.js")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  const sizes = {};
  for (const f of files.slice(0, 4))
    sizes[f] = (await stat(join(outdir, f))).size;
  const chunk = files.find((f) => f.startsWith("chunk-"));
  const chunkText = chunk ? readFileSync(join(outdir, chunk), "utf8") : "";
  return {
    dir_entries: files.length,
    first: files.slice(0, 4),
    sizes,
    split_entry_bytes: (await dirBytes(join(outdir, "route-0"))).raw,
    chunk_holds_core: /core59/.test(chunkText),
    run_exit: code,
    run_stdout: stdout.trim(),
    run_stderr: stderr.trim().slice(0, 400),
  };
}

const sanityResult = await sanity();

// fixed cost of one tiny build, against the smallest real build
const t0 = performance.now();
const tDir = join(OUT, "tiny");
await clean();
await mkdir(tDir, { recursive: true });
await Bun.write(join(SRC, "tiny.ts"), "console.log(1);\n");
await Bun.build({
  entrypoints: [join(SRC, "tiny.ts")],
  outdir: tDir,
  target: "browser",
});
const tinyMs = Number((performance.now() - t0).toFixed(1));

const report = {
  run: new Date().toISOString(),
  bun: Bun.version,
  graph: { core: CORE, leaves_per_route: LEAVES, routes: ROUTES },
  runs: RUNS,
  summary,
  spread_ms: Object.fromEntries(
    Object.entries(runs).map(([k, v]) => [
      k,
      Number((Math.max(...v.ms) - Math.min(...v.ms)).toFixed(1)),
    ]),
  ),
  tiny_build_ms: tinyMs,
  sanity: sanityResult,
};

await Bun.write(join(ROOT, "results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
