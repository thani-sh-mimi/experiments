// 029 — symlinked node_modules: does resolution cost start-up?
// Builds the same 300 and 1,000 packages twice: as plain directories (npm/bun)
// and as the pnpm layout (.pnpm store dirs plus one symlink per package).
// Then spawns a runner in each tree that imports every package by name.

import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";

const ROOT = "/tmp/spike-029";
const SIZES = [300, 1000];
const RUNS = 3;

const runner = `
const n = Number(process.argv[2]);
const mode = process.argv[3] ?? "import";
const pad = (i) => String(i).padStart(4, "0");
const start = performance.now();
for (let i = 0; i < n; i++) {
  const spec = "pkg-" + pad(i);
  if (mode === "resolve") {
    import.meta.resolve(spec);
  } else {
    const m = await import(spec);
    if (m.default !== spec.length) throw new Error("bad import: " + spec);
  }
}
const ms = performance.now() - start;
process.stdout.write(JSON.stringify({ n, ms }) + "\\n");
`;

function pkgFiles(name) {
  const manifest = {
    name,
    version: "1.0.0",
    type: "module",
    main: "index.js",
    exports: "./index.js",
  };
  const source = `export const id = "${name}";\nexport default id.length;\n`;
  return { manifest: JSON.stringify(manifest) + "\n", source };
}

function writePkg(dir, name) {
  const { manifest, source } = pkgFiles(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), manifest);
  writeFileSync(join(dir, "index.js"), source);
}

function flatTree(n) {
  const root = join(ROOT, `flat-${n}`);
  for (let i = 0; i < n; i++)
    writePkg(
      join(root, "node_modules", "pkg-" + String(i).padStart(4, "0")),
      "pkg-" + String(i).padStart(4, "0"),
    );
  return root;
}

function symlinkTree(n) {
  const root = join(ROOT, `sym-${n}`);
  const nm = join(root, "node_modules");
  for (let i = 0; i < n; i++) {
    const name = "pkg-" + String(i).padStart(4, "0");
    writePkg(join(nm, ".pnpm", `${name}@1.0.0`, "node_modules", name), name);
    symlinkSync(
      join(".pnpm", `${name}@1.0.0`, "node_modules", name),
      join(nm, name),
    );
  }
  return root;
}

function measure(cmd, cwd) {
  const t0 = performance.now();
  const p = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const wall = performance.now() - t0;
  if (p.exitCode !== 0)
    throw new Error(
      `${cmd.join(" ")} in ${cwd} failed: ${p.stderr.toString()}`,
    );
  const out = JSON.parse(p.stdout.toString().trim().split("\n").pop());
  return { wall_ms: wall, inner_ms: out.ms };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(x, d = 2) {
  return Number(x.toFixed(d));
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const trees = {};
for (const n of SIZES) {
  trees[`flat-${n}`] = flatTree(n);
  trees[`sym-${n}`] = symlinkTree(n);
  writeFileSync(join(trees[`flat-${n}`], "run.mjs"), runner);
  writeFileSync(join(trees[`sym-${n}`], "run.mjs"), runner);
}

const cells = [];
for (const n of SIZES) {
  for (const layout of ["flat", "sym"]) {
    cells.push({
      id: `node/${layout}/${n}`,
      runtime: "node",
      layout,
      n,
      cmd: ["node", "run.mjs", String(n)],
    });
    cells.push({
      id: `bun/${layout}/${n}`,
      runtime: "bun",
      layout,
      n,
      cmd: ["bun", "run.mjs", String(n)],
    });
  }
}
// Resolve only, no evaluation: isolates the resolver from module execution.
for (const runtime of ["node", "bun"]) {
  for (const layout of ["flat", "sym"]) {
    cells.push({
      id: `${runtime}/${layout}/${SIZES[1]}/resolve`,
      runtime,
      layout,
      n: SIZES[1],
      cmd: [runtime, "run.mjs", String(SIZES[1]), "resolve"],
    });
  }
}
// Control: the node loader with realpath turned off, on the symlinked tree.
cells.push({
  id: `node/sym/${SIZES[1]}/preserve`,
  runtime: "node",
  layout: "sym-preserve",
  n: SIZES[1],
  cmd: ["node", "--preserve-symlinks", "run.mjs", String(SIZES[1])],
});

const runs = [];
for (let r = 1; r <= RUNS; r++) {
  // Rotate the start so no cell always runs first.
  const order = [...cells.slice(r - 1), ...cells.slice(0, r - 1)];
  for (const cell of order) {
    const cwd = join(
      ROOT,
      `${cell.layout.startsWith("sym") ? "sym" : "flat"}-${cell.n}`,
    );
    const m = measure(cell.cmd, cwd);
    runs.push({
      run: r,
      cell: cell.id,
      runtime: cell.runtime,
      layout: cell.layout,
      n: cell.n,
      ...m,
    });
  }
}

// Noise floor: the fastest cell, ten extra runs.
const fastest = "node/flat/300";
const noise = [];
for (let i = 0; i < 10; i++) {
  const m = measure(["node", "run.mjs", "300"], join(ROOT, "flat-300"));
  noise.push(m);
}

const medians = cells.map((c) => {
  const rows = runs.filter((r) => r.cell === c.id);
  return {
    cell: c.id,
    runtime: c.runtime,
    layout: c.layout,
    n: c.n,
    wall_ms: round(median(rows.map((r) => r.wall_ms))),
    inner_ms: round(median(rows.map((r) => r.inner_ms))),
    inner_us_per_pkg: round(
      (median(rows.map((r) => r.inner_ms)) * 1000) / c.n,
      1,
    ),
  };
});

const get = (cell) => medians.find((m) => m.cell === cell);
const deltas = [];
for (const runtime of ["node", "bun"]) {
  for (const n of SIZES) {
    const f = get(`${runtime}/flat/${n}`);
    const s = get(`${runtime}/sym/${n}`);
    deltas.push({
      pair: `${runtime}/${n}`,
      inner_delta_ms: round(s.inner_ms - f.inner_ms),
      inner_ratio: round(s.inner_ms / f.inner_ms, 2),
      per_pkg_delta_us: round(((s.inner_ms - f.inner_ms) * 1000) / n, 2),
      wall_delta_ms: round(s.wall_ms - f.wall_ms),
    });
  }
}

const results = {
  meta: {
    sizes: SIZES,
    runs: RUNS,
    packages: "pkg-0000..pkg-N, each a package.json plus a 60-byte index.js",
    layouts: {
      flat: "node_modules/pkg-N/index.js",
      sym: "node_modules/pkg-N -> .pnpm/pkg-N@1.0.0/node_modules/pkg-N",
    },
    runner:
      "one process imports every package by bare specifier with dynamic import(), timed with performance.now()",
    host: `${process.platform} ${process.arch}, ${os.cpus().length} vCPU`,
    versions: {
      node: Bun.spawnSync({ cmd: ["node", "-v"] })
        .stdout.toString()
        .trim(),
      bun: Bun.version,
    },
  },
  runs,
  medians,
  deltas,
  noise_floor: {
    cell: fastest,
    wall_ms: noise.map((n) => round(n.wall_ms)),
    inner_ms: noise.map((n) => round(n.inner_ms)),
    wall_spread_pct: round(
      ((Math.max(...noise.map((n) => n.wall_ms)) -
        Math.min(...noise.map((n) => n.wall_ms))) /
        median(noise.map((n) => n.wall_ms))) *
        100,
      1,
    ),
    inner_spread_pct: round(
      ((Math.max(...noise.map((n) => n.inner_ms)) -
        Math.min(...noise.map((n) => n.inner_ms))) /
        median(noise.map((n) => n.inner_ms))) *
        100,
      1,
    ),
  },
};

writeFileSync(
  join(import.meta.dir, "results.json"),
  JSON.stringify(results, null, 2) + "\n",
);

console.log("medians (ms)");
for (const m of medians)
  console.log(
    `${m.cell.padEnd(24)} wall ${String(m.wall_ms).padStart(8)}  inner ${String(m.inner_ms).padStart(7)}  ${m.inner_us_per_pkg} us/pkg`,
  );
console.log("\ndeltas symlink - flat");
for (const d of deltas)
  console.log(
    `${d.pair.padEnd(10)} inner ${String(d.inner_delta_ms).padStart(7)} ms  ${d.inner_ratio}x  ${d.per_pkg_delta_us} us/pkg  wall ${d.wall_delta_ms} ms`,
  );
console.log(
  `\nnoise ${fastest}: inner ${results.noise_floor.inner_ms.join(", ")} ms (${results.noise_floor.inner_spread_pct}%)`,
);
