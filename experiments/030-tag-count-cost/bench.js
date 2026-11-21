// bench.js — what does each tag cost the git commands a hook or agent runs?
// Builds synthetic repos with N tags, loose (one file per tag) and packed
// (single packed-refs file), then times whole git processes around them.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";

const ROOT = "/tmp/spike-030";
const SIZES = [0, 100, 1_000, 10_000, 50_000];
const COMMITS = 200;
const RUNS = 3;

const COMMANDS = [
  ["tag", ["tag"]],
  ["status", ["status", "--porcelain"]],
  ["status-uno", ["status", "--porcelain", "-uno"]],
  ["log-1", ["log", "-1", "--format=%h"]],
  ["rev-parse", ["rev-parse", "--short", "HEAD"]],
  ["for-each-ref", ["for-each-ref", "--format=%(refname)"]],
  ["describe", ["describe", "--tags", "--always"]],
  ["checkout-b", ["checkout", "-q", "-B", "probe"]],
];

function git(cwd, args, input) {
  const t0 = performance.now();
  const r = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const ms = performance.now() - t0;
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return ms;
}

function env(cwd) {
  const r = spawnSync("git", ["rev-list", "--all", "--max-count=100000"], {
    cwd,
    encoding: "utf8",
  });
  return r.stdout.trim().split("\n").filter(Boolean);
}

function build(dir, nTags) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  // 500 commits on one file; cheap, and gives `describe` a graph to walk.
  const script = [
    `mkdir -p src`,
    `for i in $(seq 1 ${COMMITS}); do echo "line $i" > src/f.txt; git add -A; git commit -qm "c$i"; done`,
  ].join("\n");
  spawnSync("bash", ["-c", script], { cwd: dir });

  const commits = env(dir);
  if (nTags > 0) {
    const lines = [];
    for (let i = 0; i < nTags; i++) {
      const oid = commits[i % commits.length];
      lines.push(`create refs/tags/v${String(i).padStart(6, "0")} ${oid}`);
    }
    git(dir, ["update-ref", "--stdin"], lines.join("\n") + "\n");
  }
  return commits;
}

function looseCount(dir) {
  const p = `${dir}/.git/refs/tags`;
  return existsSync(p) ? readdirSync(p).length : 0;
}

function measure(dir) {
  const out = {};
  for (const [name, args] of COMMANDS) {
    git(dir, args); // warm page cache and git index
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(git(dir, args));
    out[name] = runs;
  }
  return out;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const r1 = (x) => Math.round(x * 10) / 10;

const results = {
  generatedAt: new Date().toISOString(),
  runs: RUNS,
  commits: COMMITS,
  cells: {},
};

// Noise floor: repeat the cheapest cell many times.
const noiseDir = `${ROOT}/noise`;
build(noiseDir, 0);
const noise = { tag: [], status: [] };
for (let i = 0; i < 12; i++) {
  noise.tag.push(git(noiseDir, ["tag"]));
  noise.status.push(git(noiseDir, ["status", "--porcelain"]));
}
results.noiseFloor = {
  tag: noise.tag.map(r1),
  status: noise.status.map(r1),
  tagSpread: r1(Math.max(...noise.tag) - Math.min(...noise.tag)),
  statusSpread: r1(Math.max(...noise.status) - Math.min(...noise.status)),
};

for (const n of SIZES) {
  for (const layout of ["loose", "packed"]) {
    const dir = `${ROOT}/${layout}-${n}`;
    build(dir, n);
    let packMs = null;
    if (layout === "packed") {
      packMs = git(dir, ["pack-refs", "--all"]);
    }
    const commands = measure(dir);
    results.cells[`${layout}-${n}`] = {
      tags: n,
      layout,
      looseFilesLeft: looseCount(dir),
      packMs: packMs === null ? null : r1(packMs),
      commands: Object.fromEntries(
        Object.entries(commands).map(([k, v]) => [k, v.map(r1)]),
      ),
    };
    const m = Object.entries(commands)
      .map(([k, v]) => `${k} ${r1(median(v))}`)
      .join(" · ");
    console.log(`${layout.padEnd(6)} ${String(n).padStart(6)} tags  ${m}`);
  }
}

writeFileSync(`${ROOT}/results.json`, JSON.stringify(results, null, 2) + "\n");
console.log(
  `noise: tag ±${results.noiseFloor.tagSpread} ms · status ±${results.noiseFloor.statusSpread} ms`,
);
console.log(`wrote ${ROOT}/results.json`);
