// 012 — does import depth cost startup time at a fixed module count?
// Generates a chain and a flat graph with the same modules, edges and bytes,
// then times `import(entry)` in bun and node, three runs each.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dir, 'tmp', 'graphs');
const MODULE_BYTES = 200;
const RUNS = 3;

const pad = (s, n) => {
  if (s.length > n) throw new Error(`content ${s.length} > ${n}`);
  return s + '\n// ' + 'x'.repeat(n - s.length - 4);
};

function writeModule(dir, name, ext, idx, next) {
  const imp = next === null ? '' : `import './${next}.${ext}';\n`;
  const body = `export const v = ${idx};\n`;
  fs.writeFileSync(path.join(dir, `${name}.${ext}`), pad(imp + body, MODULE_BYTES));
}

function build(shape, n, ext) {
  const dir = path.join(ROOT, `${shape}-${n}-${ext}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    writeModule(dir, `m${i}`, ext, i, shape === 'chain' && i < n - 1 ? `m${i + 1}` : null);
  }
  const entryName = `entry.${ext}`;
  const flatEntry = `${Array.from({ length: n }, (_, i) => `import './m${i}.${ext}';`).join('\n')}\nexport const mark = 1;\n`;
  const raw = shape === 'chain' ? `import './m0.${ext}';\nexport const mark = 1;\n` : flatEntry;
  const target = flatEntry.length + 4; // byte parity across shapes at this n (4 = the pad prefix)
  fs.writeFileSync(path.join(dir, entryName), pad(raw, target));
  const bytes = fs.readdirSync(dir).reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  return { dir, entry: path.join(dir, entryName), bytes };
}

async function time(runtime, entry) {
  const p = Bun.spawn([runtime, path.join(import.meta.dir, 'load.js'), entry], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = (await new Response(p.stdout).text()).trim();
  const err = (await new Response(p.stderr).text()).trim();
  await p.exited;
  const line = out.split('\n').filter(Boolean).pop();
  if (!line) return { error: err.split('\n').filter(Boolean).slice(-1)[0] || 'no output' };
  return { ms: JSON.parse(line).ms };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 100) / 100;

const results = { runs: [], noise: null, meta: {} };
const runtimes = ['bun', 'node'];
const sizes = [50, 200, 800];

for (const ext of ['js', 'ts']) {
  for (const n of sizes) {
    if (ext === 'ts' && n === 800) continue;
    for (const shape of ['chain', 'flat']) {
      const g = build(shape, n, ext);
      for (const rt of runtimes) {
        const samples = [];
        const errors = [];
        for (let r = 0; r < RUNS; r++) {
          const res = await time(rt, g.entry);
          if (res.error) errors.push(res.error);
          else samples.push(round(res.ms));
        }
        const row = { ext, n, shape, runtime: rt, ms: samples, bytes: g.bytes };
        if (samples.length) row.median = median(samples);
        if (errors.length) row.errors = errors;
        results.runs.push(row);
        console.log(ext, n, shape, rt, row.median ?? errors[0]);
      }
    }
  }
}

// noise floor: repeat the 200-module flat js point seven times
{
  const g = build('flat', 200, 'js');
  const samples = [];
  for (let r = 0; r < 7; r++) samples.push(round((await time('bun', g.entry)).ms));
  const m = median(samples);
  results.noise = {
    samples,
    median: m,
    spreadPct: round(((Math.max(...samples) - Math.min(...samples)) / m) * 100),
  };
  console.log('noise', JSON.stringify(results.noise));
}

// depth limit: how deep can a chain go before the loader gives up?
results.depthLimit = [];
for (const n of [700, 720, 740, 760, 765, 770, 780, 900, 2000]) {
  const g = build('chain', n, 'js');
  for (const rt of runtimes) {
    const res = await time(rt, g.entry);
    results.depthLimit.push({ n, runtime: rt, ...res });
    console.log('depth', n, rt, res.ms ?? res.error);
  }
}

// realistic shape: 40 chains of 50 hanging off one entry, against a flat 2000
function buildLattice(width, depth, ext) {
  const dir = path.join(ROOT, `lattice-${width}x${depth}-${ext}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let c = 0; c < width; c++)
    for (let d = 0; d < depth; d++)
      writeModule(dir, `m${c}_${d}`, ext, d, d < depth - 1 ? `m${c}_${d + 1}` : null);
  const entry = `${Array.from({ length: width }, (_, c) => `import './m${c}_0.${ext}';`).join('\n')}\nexport const mark = 1;\n`;
  fs.writeFileSync(path.join(dir, `entry.${ext}`), pad(entry, entry.length + 4));
  return { dir, entry: path.join(dir, `entry.${ext}`) };
}

results.lattice = [];
for (const [label, g] of [
  ['40 chains of 50 (2000 modules), depth 50', buildLattice(40, 50, 'js')],
  ['flat 2000, depth 1', build('flat', 2000, 'js')],
]) {
  for (const rt of runtimes) {
    const samples = [];
    const errors = [];
    for (let r = 0; r < RUNS; r++) {
      const res = await time(rt, g.entry);
      if (res.error) errors.push(res.error);
      else samples.push(round(res.ms));
    }
    const row = { label, runtime: rt, ms: samples };
    if (samples.length) row.median = median(samples);
    if (errors.length) row.errors = errors;
    results.lattice.push(row);
    console.log('lattice', label, rt, row.median ?? errors[0]);
  }
}

// is the 6% gap at depth 50 above noise? seven repeats of the lattice point
{
  const g = buildLattice(40, 50, 'js');
  const samples = [];
  for (let r = 0; r < 7; r++) samples.push(round((await time('bun', g.entry)).ms));
  const m = median(samples);
  results.latticeNoise = {
    samples,
    median: m,
    spreadPct: round(((Math.max(...samples) - Math.min(...samples)) / m) * 100),
  };
  console.log('latticeNoise', JSON.stringify(results.latticeNoise));
}

results.meta = {
  bun: Bun.version,
  node: (await new Response(Bun.spawn(['node', '--version'], { stdout: 'pipe' }).stdout).text()).trim(),
  cpus: (await Bun.file('/sys/fs/cgroup/cpu.max').text()).trim(),
  moduleBytes: MODULE_BYTES,
  runs: RUNS,
  date: new Date().toISOString().slice(0, 10),
};

fs.writeFileSync(path.join(import.meta.dir, 'results.json'), JSON.stringify(results, null, 2));
console.log('written results.json');