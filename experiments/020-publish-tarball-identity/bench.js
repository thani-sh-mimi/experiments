// 020: does `bun pm pack` ship the same files as `npm pack`, and is the tarball
// byte-identical on a re-run? Synthetic package, no dependencies, no network.
import { mkdir, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const BUN = Bun.which("bun");
const NPM = Bun.which("npm");
const ROOT = join(import.meta.dir, "work");
const SRC = 1500; // 2 KB modules
const TEST = 800; // 8 KB fixtures, excluded from the tarball
const DIST = 300; // 4 KB build output, gitignored

// Deterministic pseudo-random text so gzip sees realistic entropy.
function text(bytes, seed) {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "kappa", "lambda"];
  let s = seed >>> 0;
  const parts = [];
  let n = 0;
  while (n < bytes) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const w = words[s % words.length];
    parts.push(w);
    n += w.length + 1;
  }
  return parts.join(" ") + "\n";
}

async function writeTree(dir, pkg) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "test", "fixtures"), { recursive: true });
  await mkdir(join(dir, "dist"), { recursive: true });
  const jobs = [];
  for (let i = 0; i < SRC; i++) jobs.push(Bun.write(join(dir, "src", `mod-${i}.js`), text(2048, i + 1) + `export const id = ${i};\n`));
  for (let i = 0; i < TEST; i++) jobs.push(Bun.write(join(dir, "test", "fixtures", `fx-${i}.json`), text(8192, i + 7) + `\n`));
  for (let i = 0; i < DIST; i++) jobs.push(Bun.write(join(dir, "dist", `bundle-${i}.js`), text(4096, i + 13)));
  await Promise.all(jobs);
  await Bun.write(join(dir, "README.md"), "# synthetic package for experiment 020\n");
  await Bun.write(join(dir, "LICENSE"), "MIT\n");
  await Bun.write(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

const VARIANTS = [
  {
    name: "allowlist",
    pkg: { name: "synthetic-pkg", version: "1.0.0", files: ["src"] },
    gitignore: null,
  },
  {
    name: "gitignore",
    pkg: { name: "synthetic-pkg", version: "1.0.0" },
    gitignore: "test/\ndist/\nnode_modules/\n",
  },
];

const TOOLS = {
  bun: (dir, out) => [BUN, "pm", "pack", "--quiet", "--destination", out],
  npm: (dir, out) => [NPM, "pack", "--pack-destination", out, "--silent"],
};

function run(cmd, cwd) {
  const t0 = performance.now();
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const ms = performance.now() - t0;
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${p.stderr.toString()}`);
  return { ms, out: p.stdout.toString() };
}

async function sha256(path) {
  const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
  return createHash("sha256").update(buf).digest("hex");
}

async function inventory(tool, dir) {
  const cmd = tool === "bun" ? [BUN, "pm", "pack", "--dry-run"] : [NPM, "pack", "--dry-run", "--json", "--silent"];
  const { out } = run(cmd, dir);
  if (tool === "bun") {
    return out
      .split("\n")
      .filter((l) => l.startsWith("packed "))
      .map((l) => l.replace(/^packed \S+ /, "").trim())
      .sort();
  }
  const j = JSON.parse(out.slice(out.search(/\[\s*\{/)));
  return j[0].files.map((f) => f.path).sort();
}

async function tarEntries(tgz) {
  const p = Bun.spawnSync(["tar", "-tzf", tgz], { stdout: "pipe" });
  return p.stdout
    .toString()
    .split("\n")
    .filter((l) => l && !l.endsWith("/"))
    .length;
}

async function tarList(tgz) {
  const p = Bun.spawnSync(["tar", "-tzf", tgz], { stdout: "pipe" });
  return p.stdout
    .toString()
    .split("\n")
    .filter((l) => l)
    .map((l) => l.replace(/^package\//, ""));
}

// Every file under `dir`, with its size, mode and mtime: the payload's identity
// independent of how the tar wrapped it.
async function walk(dir, base = dir, out = {}) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else {
      const s = await Bun.file(p).stat();
      const buf = new Uint8Array(await Bun.file(p).arrayBuffer());
      out[p.slice(base.length + 1)] = {
        sha: createHash("sha256").update(buf).digest("hex"),
        mode: (s.mode & 0o777).toString(8),
        mtime: Math.floor(s.mtimeMs / 1000),
        size: s.size,
      };
    }
  }
  return out;
}

async function payload(tgz, tag) {
  const dir = join(ROOT, `x-${tag}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const p = Bun.spawnSync(["tar", "-xzf", tgz, "-C", dir], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`extract failed: ${p.stderr.toString()}`);
  return walk(dir);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

await mkdir(ROOT, { recursive: true });

const results = { runs: 3, files: { src: SRC, test: TEST, dist: DIST }, startup: {}, variants: {} };

// Fixed interpreter cost, the floor under every pack run.
for (const [name, cmd] of Object.entries({ bun: [BUN, "--version"], npm: [NPM, "--version"] })) {
  const times = [];
  for (let i = 0; i < 3; i++) times.push(+run(cmd, import.meta.dir).ms.toFixed(1));
  results.startup[name] = times;
}

for (const v of VARIANTS) {
  const dir = join(ROOT, v.name);
  await writeTree(dir, v.pkg);
  if (v.gitignore) await Bun.write(join(dir, ".gitignore"), v.gitignore);

  const arm = { files: {}, pack: {}, digest: {}, entries: {}, size: {}, inventory: {} };
  const maps = {};
  arm.inventory.bun = await inventory("bun", dir);
  arm.inventory.npm = await inventory("npm", dir);
  arm.inventory.same = JSON.stringify(arm.inventory.bun) === JSON.stringify(arm.inventory.npm);
  arm.inventory.count = arm.inventory.npm.length;
  arm.inventory.onlyBun = arm.inventory.bun.filter((f) => !arm.inventory.npm.includes(f));
  arm.inventory.onlyNpm = arm.inventory.npm.filter((f) => !arm.inventory.bun.includes(f));

  // How much of a pack run is the file walk and how much is gzip?
  for (const [tool, cmd] of Object.entries({
    bun: [BUN, "pm", "pack", "--dry-run"],
    npm: [NPM, "pack", "--dry-run", "--json", "--silent"],
  })) {
    const t = [];
    run(cmd, dir);
    for (let i = 0; i < results.runs; i++) t.push(+run(cmd, dir).ms.toFixed(1));
    arm.inventory[`${tool}_ms`] = t;
    arm.inventory[`${tool}_median`] = median(t);
  }

  for (const [tool, build] of Object.entries(TOOLS)) {
    const times = [];
    const shas = [];
    let last = null;
    run(build(dir, join(ROOT, "warm")), dir); // untimed warm-up, dropped
    for (let i = 0; i < results.runs; i++) {
      const out = join(ROOT, `out-${v.name}-${tool}-${i}`);
      await rm(out, { recursive: true, force: true });
      await mkdir(out, { recursive: true });
      const r = run(build(dir, out), dir);
      times.push(+r.ms.toFixed(1));
      const names = await readdir(out);
      last = join(out, names[0]);
      shas.push(await sha256(last));
    }
    arm.pack[tool] = times;
    arm.pack[`${tool}_median`] = median(times);
    arm.digest[tool] = shas;
    arm.digest[`${tool}_stable`] = new Set(shas).size === 1;
    arm.entries[tool] = await tarEntries(last);
    arm.size[tool] = (await Bun.file(last).size);
    arm.order = arm.order || {};
    arm.order[tool] = (await tarList(last)).slice(0, 6);
    arm.order[`${tool}_pkgjson_at`] = (await tarList(last)).indexOf("package.json");
    maps[tool] = await payload(last, `${v.name}-${tool}`);
  }

  arm.order.same = JSON.stringify(arm.order.bun) === JSON.stringify(arm.order.npm);
  // Only the summary is kept: a hash per file would add megabytes for two booleans.
  const keys = Object.keys(maps.bun);
  arm.payload = {
    fileCount: keys.length,
    same: keys.length === Object.keys(maps.npm).length && keys.every((k) => JSON.stringify(maps.bun[k]) === JSON.stringify(maps.npm[k])),
    firstDiff: keys.find((k) => JSON.stringify(maps.bun[k]) !== JSON.stringify(maps.npm[k])) || null,
    modes: [...new Set(Object.values(maps.bun).map((f) => f.mode))],
    mtimes: [...new Set(Object.values(maps.bun).map((f) => f.mtime))],
  };
  arm.digest.cross_tool_same = arm.digest.bun[0] === arm.digest.npm[0];
  results.variants[v.name] = arm;
  console.log(v.name, "files", arm.inventory.count, "same", arm.inventory.same,
    "bun", arm.pack.bun, "npm", arm.pack.npm,
    "stable", arm.digest.bun_stable, arm.digest.npm_stable,
    "cross", arm.digest.cross_tool_same, "payload", arm.payload.same, arm.payload.firstDiff || "",
    "order", arm.order.bun.slice(0, 2).join(","), "|", arm.order.npm.slice(0, 2).join(","));
}

// What the allowlist is worth in bytes: the same tree with no filter at all.
{
  const dir = join(ROOT, "no-filter");
  await writeTree(dir, { name: "synthetic-pkg", version: "1.0.0" });
  const arm = { inventory: {}, size: {} };
  arm.inventory.npm = (await inventory("npm", dir)).length;
  arm.inventory.bun = (await inventory("bun", dir)).length;
  for (const [tool, build] of Object.entries(TOOLS)) {
    const out = join(ROOT, `out-none-${tool}`);
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    const r = run(build(dir, out), dir);
    arm.size[tool] = await Bun.file(join(out, (await readdir(out))[0])).size;
    arm[`${tool}_ms`] = +r.ms.toFixed(1);
  }
  results.noFilter = arm;
  console.log("no-filter files", arm.inventory, "size", arm.size);
}

// Is npm's time the walk or gzip? Sweep the file count at fixed bytes per file.
async function writeFlat(dir, n, bytes = 2048) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src"), { recursive: true });
  const jobs = [];
  for (let i = 0; i < n; i++) jobs.push(Bun.write(join(dir, "src", `mod-${i}.js`), text(bytes, i + 1)));
  await Promise.all(jobs);
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "synthetic-pkg", version: "1.0.0", files: ["src"] }, null, 2) + "\n");
}

results.scale = [];
for (const [n, bytes] of [[100, 2048], [400, 2048], [400, 8192], [1500, 64], [1500, 2048], [20, 262144]]) {
  const dir = join(ROOT, `scale-${n}-${bytes}`);
  await writeFlat(dir, n, bytes);
  const row = { n, bytes };
  const dry = {
    bun: [BUN, "pm", "pack", "--dry-run"],
    npm: [NPM, "pack", "--dry-run", "--silent"],
  };
  for (const [tool, build] of Object.entries(TOOLS)) {
    run(dry[tool], dir);
    const w = [];
    for (let i = 0; i < results.runs; i++) w.push(+run(dry[tool], dir).ms.toFixed(1));
    row[`${tool}_walk`] = w;
    row[`${tool}_walk_median`] = median(w);
    const out = join(ROOT, `s-out-${n}-${tool}`);
    await mkdir(out, { recursive: true });
    const p = [];
    run(build(dir, out), dir);
    for (let i = 0; i < results.runs; i++) {
      await rm(out, { recursive: true, force: true });
      await mkdir(out, { recursive: true });
      p.push(+run(build(dir, out), dir).ms.toFixed(1));
    }
    row[`${tool}_pack`] = p;
    row[`${tool}_pack_median`] = median(p);
  }
  results.scale.push(row);
  console.log("scale", n, bytes, JSON.stringify(row));
}

await Bun.write(join(import.meta.dir, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log("wrote results.json");
