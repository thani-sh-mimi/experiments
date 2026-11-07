// 016 — does a better diff algorithm stay free as the file grows?
// Myers (default) vs minimal vs histogram vs patience on synthetic 2k–96k line files.
// Bun: `bun run bench.js`. Writes results.json next to this file.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = new URL(".", import.meta.url).pathname;
const TMP = `${ROOT}tmp`;
const SIZES = [2_000, 8_000, 32_000, 96_000];
const ALGOS = ["myers", "minimal", "histogram", "patience"];
const RUNS = 3;
const TIMEOUT_MS = 180_000;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Six-line block. Modulo arithmetic makes many lines identical across blocks,
// which is where the algorithms are allowed to disagree.
function block(k) {
  return [
    `function item${k}(input: number): number {`,
    `  const next = step(${k % 13}, input);`,
    `  if (next > ${k % 7}) return next;`,
    `  const label = "k${k % 23}";`,
    `  return mix(next, label);`,
    `}`,
    ``,
  ];
}

function makeBase(lines, rnd) {
  const out = [];
  for (let k = 0; out.length < lines; k++) out.push(...block(k));
  return out;
}

// Edits a reviewer would actually see: small modifications, moved blocks, deletions.
function makeEdited(base, rnd) {
  const out = base.slice();
  const edits = {
    modified: 0,
    movedBlocks: 0,
    movedLines: 0,
    deleted: 0,
    inserted: 0,
  };

  // 2 % of lines: change a literal in place
  for (let i = 0; i < out.length; i++) {
    if (rnd() < 0.02) {
      out[i] = out[i].replace(/\b(\d+)\b/, (m) => String(Number(m) + 1));
      edits.modified++;
    }
  }

  // 24 blocks of 20 lines cut from one place and pasted in another
  for (let n = 0; n < 24; n++) {
    const from = Math.floor(rnd() * (out.length - 20));
    const block = out.splice(from, 20);
    const to = Math.floor(rnd() * (out.length - 20));
    out.splice(to, 0, ...block);
    edits.movedBlocks++;
    edits.movedLines += 20;
  }

  // 15 contiguous runs deleted
  for (let n = 0; n < 15; n++) {
    const at = Math.floor(rnd() * (out.length - 6));
    out.splice(at, 1 + Math.floor(rnd() * 5));
    edits.deleted++;
  }

  // 30 short runs inserted
  for (let n = 0; n < 30; n++) {
    const at = Math.floor(rnd() * out.length);
    out.splice(
      at,
      0,
      ...block(900_000 + n).slice(0, 1 + Math.floor(rnd() * 4)),
    );
    edits.inserted++;
  }
  return { lines: out, edits };
}

function parse(patch) {
  let hunks = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) hunks++;
    else if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { hunks, added, removed };
}

function run(algo, a, b) {
  const t0 = performance.now();
  const res = spawnSync(
    "git",
    ["diff", "--no-index", `--diff-algorithm=${algo}`, "-U3", a, b],
    {
      cwd: TMP,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      timeout: TIMEOUT_MS,
    },
  );
  const ms = performance.now() - t0;
  if (res.error || res.signal)
    return {
      ms,
      timedOut: true,
      hunks: null,
      added: null,
      removed: null,
      bytes: 0,
    };
  // 0 = identical, 1 = different; anything else is a harness bug, not a result.
  if (res.status !== 0 && res.status !== 1)
    throw new Error(`git diff failed (${res.status}): ${res.stderr}`);
  const patch = res.stdout ?? "";
  return {
    ms,
    timedOut: false,
    ...parse(patch),
    bytes: Buffer.byteLength(patch),
  };
}

function median(xs) {
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// Floor: the cost of spawning git at all.
const floorFile = `${TMP}/floor.txt`;
writeFileSync(floorFile, "same\n");
const floors = [];
for (let i = 0; i < 10; i++) floors.push(run("myers", floorFile, floorFile).ms);
const floor = median(floors);

const results = {
  git: spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim(),
  floorMs: floor,
  scenarios: [],
};

function measure(scenario, lines, bytes, edits, a, b) {
  const row = { scenario, lines, bytes, edits, algorithms: {} };
  for (const algo of ALGOS) {
    const samples = [];
    run(algo, a, b); // warm-up, not recorded
    for (let i = 0; i < RUNS; i++) samples.push(run(algo, a, b));
    const times = samples.map((s) => s.ms);
    row.algorithms[algo] = {
      ms: times.map((t) => +t.toFixed(1)),
      medianMs: +median(times).toFixed(1),
      netMs: +Math.max(0, median(times) - floor).toFixed(1),
      hunks: samples[0].hunks,
      added: samples[0].added,
      removed: samples[0].removed,
      churn: samples[0].added + samples[0].removed,
      bytes: samples[0].bytes,
      timedOut: samples.some((s) => s.timedOut),
    };
  }
  results.scenarios.push(row);
  console.log(
    `${scenario} ${String(lines).padStart(6)} lines: ` +
      ALGOS.map(
        (x) =>
          `${x} ${row.algorithms[x].medianMs}ms ${row.algorithms[x].hunks}h ${row.algorithms[x].churn}c`,
      ).join(" | "),
  );
  return row;
}

// A: source code, mixed edits (modifications, moves, deletions, insertions)
for (const size of SIZES) {
  const rnd = mulberry32(size);
  const base = makeBase(size, rnd);
  const { lines: editedLines, edits } = makeEdited(base, rnd);
  const a = `${TMP}/a-${size}.txt`;
  const b = `${TMP}/b-${size}.txt`;
  writeFileSync(a, base.join("\n") + "\n");
  writeFileSync(b, editedLines.join("\n") + "\n");
  measure(
    "source",
    size,
    Buffer.byteLength(editedLines.join("\n")),
    edits,
    a,
    b,
  );
}

// B: generated data, heavy line repetition, minimal edit: one value changed, one line deleted.
// This is the shape where patience and histogram are allowed to disagree with Myers.
function recordBase(lines) {
  const out = [];
  for (let k = 0; out.length < lines; k++) {
    out.push(
      "  {",
      '    "kind": "metric",',
      `    "value": ${k % 5},`,
      '    "unit": "ms",',
      "  },",
    );
  }
  return out;
}

for (const size of [8_000, 32_000]) {
  const base = recordBase(size);
  const edited = base.slice();
  edited[10] = '    "value": 4,';
  edited.splice(Math.floor(size / 2), 1);
  const a = `${TMP}/records-a-${size}.txt`;
  const b = `${TMP}/records-b-${size}.txt`;
  writeFileSync(a, base.join("\n") + "\n");
  writeFileSync(b, edited.join("\n") + "\n");
  measure(
    "records",
    size,
    Buffer.byteLength(edited.join("\n")),
    { modified: 1, deleted: 1 },
    a,
    b,
  );
}

// C: adversarial shapes where the algorithms are known to disagree.
// Each probe is a 4k-line file with one small edit; churn is what a reviewer scrolls through.
const PROBES = [
  {
    name: "one-line-edit-in-identical-blocks",
    build() {
      const blockCount = 100;
      const b = [];
      for (let k = 0; k < blockCount; k++)
        for (let i = 0; i < 40; i++)
          b.push(`  step(${i % 4}, "alpha", handler);`);
      const a = b.slice();
      b[3 * 40 + 7] = `  step(9, "alpha", handler);`;
      return [a, b];
    },
  },
  {
    name: "block-moved-far",
    build() {
      const a = makeBase(4_000);
      const moved = a.splice(0, 200);
      const b = a.concat(moved);
      return [makeBase(4_000), b];
    },
  },
  {
    name: "duplicated-chunk",
    build() {
      const chunk = makeBase(40);
      const a = [];
      for (let k = 0; k < 100; k++) a.push(...chunk);
      const b = a.slice();
      b.splice(2_000, 1);
      return [a, b];
    },
  },
  {
    name: "json-braces",
    build() {
      const a = [];
      for (let k = 0; k < 400; k++) {
        a.push("  {");
        for (let i = 0; i < 8; i++) a.push(`    "k${i}": ${k % 3},`);
        a.push("  },");
      }
      const b = a.slice();
      b[100] = '    "k0": 7,';
      return [a, b];
    },
  },
];

for (const probe of PROBES) {
  const [a, b] = probe.build();
  const ap = `${TMP}/probe-a.txt`;
  const bp = `${TMP}/probe-b.txt`;
  writeFileSync(ap, a.join("\n") + "\n");
  writeFileSync(bp, b.join("\n") + "\n");
  const row = measure(
    `probe:${probe.name}`,
    a.length,
    Buffer.byteLength(b.join("\n")),
    { probe: true },
    ap,
    bp,
  );
  const churns = ALGOS.map((x) => row.algorithms[x].churn);
  row.diverged = new Set(churns).size > 1;
  row.worstRatio = +(
    Math.max(...churns) / Math.max(1, Math.min(...churns))
  ).toFixed(2);
}

results.floorSamples = floors.map((f) => +f.toFixed(1));
writeFileSync(`${ROOT}results.json`, JSON.stringify(results, null, 2) + "\n");
console.log(`floor ${floor.toFixed(1)} ms`);
