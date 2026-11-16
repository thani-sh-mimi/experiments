// 025 — when does `git diff` stop rendering a move-with-edits commit as renames?
//
// Two knobs decide it: the basename heuristic (uncapped, needs ~75% similarity)
// and the N x M matrix (capped by diff.renameLimit, default 1000, i.e. 1000^2
// pairs). This harness builds synthetic repos, makes one move commit, and
// records rename count, review surface (added + deleted lines) and wall time.
import { rm, mkdir, writeFile } from "node:fs/promises";

const ROOT = "/tmp/spike-025b";
const RUNS = 3;

function content(id, lines, ratio) {
  const step = ratio > 0 ? Math.max(1, Math.round(1 / ratio)) : 0;
  const out = [];
  for (let i = 0; i < lines; i++) {
    const base = "export const v" + id + "_" + i + " = " + (id * 1000 + i) + ";";
    out.push(step > 0 && i % step === 0 ? base + " // touched" : base);
  }
  return out.join("\n") + "\n";
}

function git(dir, args) {
  const start = performance.now();
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ms: performance.now() - start, out: p.stdout.toString(), err: p.stderr.toString() };
}

const VARIANTS = [
  { name: "default", args: [] },
  { name: "no-renames", args: ["--no-renames"] },
  { name: "l0", args: ["-l0"] },
  { name: "M60", args: ["-M60%"] },
];

const CASES = [
  // basename changes with the directory: the basename pass cannot help
  ...[100, 900, 1000, 1001, 1500, 2000].map((n) => ({
    n, lines: 200, edit: 0.2, keep: false,
    label: "renamed n=" + n,
  })),
  // same move, basename preserved: the heuristic can pair files for free
  ...[1200, 2500].map((n) => ({ n, lines: 200, edit: 0.2, keep: true, label: "kept n=" + n })),
  // same move, tiny files: nothing scores high enough for the heuristic
  ...[1000, 1001].map((n) => ({ n, lines: 5, edit: 0.2, keep: true, label: "tiny n=" + n })),
  // the 50% floor, far below any limit
  ...[0.3, 0.49, 0.6].map((e) => ({
    n: 100, lines: 200, edit: e, keep: true,
    label: "similarity edit=" + Math.round(e * 100) + "%",
  })),
];

function parseNumstat(out) {
  let added = 0, deleted = 0, entries = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [a, d] = line.split("\t");
    if (a === "-" || d === "-") continue;
    added += Number(a);
    deleted += Number(d);
    entries++;
  }
  return { added, deleted, lines: added + deleted, entries };
}

function parseStatus(out) {
  const counts = {};
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const code = line[0];
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

const results = [];
const t0 = performance.now();

for (const c of CASES) {
  const dir = ROOT + "/" + c.label.replace(/[^a-z0-9]+/gi, "-");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir + "/src/old", { recursive: true });

  for (let i = 0; i < c.n; i++) {
    await writeFile(dir + "/src/old/f" + i + ".ts", content(i, c.lines, 0));
  }
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "spike@local"]);
  git(dir, ["config", "user.name", "spike"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "initial"]);

  await rm(dir + "/src/old", { recursive: true, force: true });
  await mkdir(dir + "/src/new", { recursive: true });
  for (let i = 0; i < c.n; i++) {
    const name = c.keep ? "f" + i : "m" + i;
    await writeFile(dir + "/src/new/" + name + ".ts", content(i, c.lines, c.edit));
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "move src/old to src/new"]);

  const row = { ...c, variants: {} };

  for (const v of VARIANTS) {
    // -l0 is quadratic: skip it above 2,000 files to keep the run bounded
    if (v.name === "l0" && c.n > 2000) continue;
    const times = [];
    let stat = null, status = null, stderr = "", warn = "";
    for (let r = 0; r < RUNS; r++) {
      const d = git(dir, ["diff", "--numstat", "HEAD~1", "HEAD", ...v.args]);
      times.push(Math.round(d.ms * 100) / 100);
      stat = parseNumstat(d.out);
      stderr = d.err.trim();
      const s = git(dir, ["diff", "--name-status", "HEAD~1", "HEAD", ...v.args]);
      status = parseStatus(s.out);
    }
    times.sort((a, b) => a - b);
    if (stderr.includes("skipped")) warn = "inexact detection skipped";
    row.variants[v.name] = {
      median_ms: times[Math.floor(times.length / 2)],
      runs_ms: times,
      ...stat,
      renames: status.R ?? 0,
      added_files: status.A ?? 0,
      deleted_files: status.D ?? 0,
      warning: warn,
    };
  }

  // does the move survive `git log --follow` once detection is skipped?
  if (!c.keep && c.n >= 1001) {
    const follows = {};
    for (const [name, args] of [["default", []], ["l0", ["-l0"]]]) {
      const target = "src/new/m0.ts";
      const f = git(dir, ["log", "--follow", "--oneline", ...args, "--", target]);
      follows[name] = f.out.trim().split("\n").filter(Boolean).length;
    }
    row.follow_commits = follows;
  }

  results.push(row);
  const d = row.variants.default;
  console.log(
    c.label.padEnd(24) +
      "R=" + String(d.renames).padEnd(5) +
      "A=" + String(d.added_files).padEnd(5) +
      "lines=" + String(d.lines).padEnd(8) +
      String(d.median_ms) + "ms" +
      (d.warning ? "  [" + d.warning + "]" : "") +
      (row.variants.l0 ? "  l0:" + row.variants.l0.renames + "R/" + row.variants.l0.median_ms + "ms" : ""),
  );
  await rm(dir, { recursive: true, force: true });
}

const payload = {
  experiment: "025-rename-detection-cliff",
  date: new Date().toISOString().slice(0, 10),
  git: Bun.spawnSync(["git", "--version"]).stdout.toString().trim(),
  bun: Bun.version,
  cpus: navigator.hardwareConcurrency,
  runs_per_variant: RUNS,
  wall_ms: Math.round(performance.now() - t0),
  cases: results,
};
await writeFile(new URL("./results.json", import.meta.url), JSON.stringify(payload, null, 2) + "\n");
console.log("\nwall " + payload.wall_ms + " ms -> results.json");
