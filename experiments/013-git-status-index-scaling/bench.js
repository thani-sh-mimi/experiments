// Does `git status` scale with tracked file count, and what does `-uall` cost?
// Synthetic repos only. Run: bun run bench.js
//
// Modes measured at every size:
//   status            porcelain, default (untracked=normal)
//   status -uno       tracked files only
//   status -uall      lists every untracked file
//   diff --cached     staged paths only (the cheap hook path)
//   ls-files -m       modified paths only
// Each mode: 2 warm-up calls, then RUNS timed calls. Raw milliseconds are kept.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "tmp", "013");
const SIZES = [1_000, 10_000, 50_000, 100_000];
const RUNS = 5;
const UNTRACKED_DIRS = 100;
const UNTRACKED_PER_DIR = 100;

function run(cmd, cwd, env) {
  const r = Bun.spawnSync({
    cmd,
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString()}`);
  return r;
}

const git = (args, cwd, env) => run(["git", ...args], cwd, env);

function makeRepo(n) {
  const dir = join(ROOT, `${n}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dirs = 100;
  const perDir = Math.ceil(n / dirs);
  for (let d = 0; d < dirs; d++) {
    const sub = join(dir, "src", `d${d}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < perDir && d * perDir + f < n; f++) {
      writeFileSync(join(sub, `f${f}.ts`), `export const v${f} = ${f};\n`);
    }
  }
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "spike@local"], dir);
  git(["config", "user.name", "spike"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "init"], dir);
  return dir;
}

function time(label, args, cwd) {
  git(args, cwd);
  git(args, cwd);
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = Bun.nanoseconds();
    git(args, cwd);
    ms.push(Number(Bun.nanoseconds() - t0) / 1e6);
  }
  const sorted = [...ms].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const spread = ((sorted.at(-1) - sorted[0]) / median) * 100;
  return {
    label,
    ms: ms.map((v) => +v.toFixed(2)),
    median: +median.toFixed(2),
    spreadPct: +spread.toFixed(1),
  };
}

// Pull region durations out of GIT_TRACE2_PERF. Returns milliseconds.
function trace(args, cwd) {
  const r = git(args, cwd, { GIT_TRACE2_PERF: "1" });
  const out = {};
  for (const line of r.stderr.toString().split("\n")) {
    const p = line.split("|").map((s) => s.trim());
    if (p.length < 9 || p[3] !== "region_leave") continue;
    const label = (p[8] || "").replace("..label:", "").replace("label:", "");
    const seconds = Number(p[6]);
    if (!Number.isFinite(seconds)) continue;
    out[label] = +(seconds * 1000).toFixed(2);
  }
  return out;
}

function addUntracked(dir) {
  const sub = join(dir, "scratch");
  mkdirSync(sub, { recursive: true });
  let count = 0;
  for (let d = 0; d < UNTRACKED_DIRS; d++) {
    const s = join(sub, `u${d}`);
    mkdirSync(s, { recursive: true });
    for (let f = 0; f < UNTRACKED_PER_DIR; f++) {
      writeFileSync(join(s, `n${f}.ts`), `export const u = ${f};\n`);
      count++;
    }
  }
  return count;
}

const results = {
  generatedAt: new Date().toISOString(),
  runs: RUNS,
  git: "",
  sessions: [],
  summary: {},
};

results.git = git(["--version"], process.cwd()).stdout.toString().trim();

const session = { at: results.generatedAt, floor: null, scale: [], untrackedHeavy: {}, dirtyOne: {} };

// Cost of a git process that reads no index: the floor every call pays.
session.floor = time("git --version", ["--version"], process.cwd());

for (const n of SIZES) {
  const dir = makeRepo(n);
  const tracked = git(["ls-files"], dir).stdout.toString().trim().split("\n").length;
  session.scale.push({
    tracked,
    status: time("status --porcelain", ["status", "--porcelain"], dir),
    uno: time("status --porcelain -uno", ["status", "--porcelain", "-uno"], dir),
    uall: time("status --porcelain -uall", ["status", "--porcelain", "-uall"], dir),
    diffCached: time("diff --cached --name-only", ["diff", "--cached", "--name-only"], dir),
    lsFilesM: time("ls-files -m", ["ls-files", "-m"], dir),
    trace: trace(["status", "--porcelain"], dir),
  });
}

// Untracked-heavy case: 10,000 untracked files in 100 directories, at 100k tracked.
const big = join(ROOT, "100000");
session.untrackedHeavy = {
  count: addUntracked(big),
  cacheOff: {
    normal: time("status -unormal (cache off)", ["status", "--porcelain", "-unormal"], big),
    all: time("status -uall (cache off)", ["status", "--porcelain", "-uall"], big),
    uno: time("status -uno (cache off)", ["status", "--porcelain", "-uno"], big),
  },
  traceNormal: trace(["status", "--porcelain", "-unormal"], big),
  traceAll: trace(["status", "--porcelain", "-uall"], big),
};

git(["config", "core.untrackedCache", "true"], big);
git(["update-index", "--untracked-cache"], big);
git(["status", "--porcelain"], big); // populate the cache
session.untrackedHeavy.cacheOn = {
  normal: time("status -unormal (cache on)", ["status", "--porcelain", "-unormal"], big),
  all: time("status -uall (cache on)", ["status", "--porcelain", "-uall"], big),
  uno: time("status -uno (cache on)", ["status", "--porcelain", "-uno"], big),
};
session.untrackedHeavy.traceNormalCached = trace(["status", "--porcelain", "-unormal"], big);
session.untrackedHeavy.traceAllCached = trace(["status", "--porcelain", "-uall"], big);

// Dirty tree: one modified tracked file at 100k.
writeFileSync(join(big, "src", "d0", "f0.ts"), "export const v0 = 999;\n");
session.dirtyOne = {
  normal: time("status --porcelain (1 modified)", ["status", "--porcelain"], big),
  uno: time("status --porcelain -uno (1 modified)", ["status", "--porcelain", "-uno"], big),
  diffCached: time("diff --cached --name-only (1 modified)", ["diff", "--cached", "--name-only"], big),
};

const path = join(import.meta.dir, "results.json");
const previous = (await Bun.file(path).exists()) ? await Bun.file(path).json() : null;
results.sessions = [...(previous?.sessions ?? []), session];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.floor(s.length / 2)].toFixed(2);
};

// Median across sessions of each config's median, plus the spread of those medians.
const across = (samples) => ({
  median: median(samples),
  sessionMedians: samples.map((v) => +v.toFixed(2)),
});

results.summary = { floor: across(results.sessions.map((s) => s.floor.median)), scale: [] };
for (let i = 0; i < session.scale.length; i++) {
  const rows = results.sessions.map((s) => s.scale[i]);
  results.summary.scale.push({
    tracked: rows[0].tracked,
    status: across(rows.map((r) => r.status.median)),
    uno: across(rows.map((r) => r.uno.median)),
    uall: across(rows.map((r) => r.uall.median)),
    diffCached: across(rows.map((r) => r.diffCached.median)),
    lsFilesM: across(rows.map((r) => r.lsFilesM.median)),
    trace: rows.map((r) => r.trace),
  });
}
results.summary.untrackedHeavy = {};
for (const cache of ["cacheOff", "cacheOn"]) {
  results.summary.untrackedHeavy[cache] = {};
  for (const mode of ["normal", "all", "uno"]) {
    results.summary.untrackedHeavy[cache][mode] = across(
      results.sessions.map((s) => s.untrackedHeavy[cache][mode].median),
    );
  }
}
results.summary.dirtyOne = {};
for (const mode of ["normal", "uno", "diffCached"]) {
  results.summary.dirtyOne[mode] = across(results.sessions.map((s) => s.dirtyOne[mode].median));
}

await Bun.write(join(import.meta.dir, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
