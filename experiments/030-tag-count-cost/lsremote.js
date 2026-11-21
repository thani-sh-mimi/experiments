// lsremote.js — does a tag-heavy repo cost a fetch its ref advertisement?
// Uses local paths only: no network. Times `git ls-remote` and `git clone --bare`.
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const SRC = process.argv[2] || "/tmp/spike-030/loose-50000";
const RUNS = 3;

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const r1 = (x) => Math.round(x * 10) / 10;

function time(args, cwd = "/tmp") {
  const t0 = performance.now();
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return ms;
}

function dirSize(p) {
  const r = spawnSync("du", ["-sk", p], { encoding: "utf8" });
  return Number(r.stdout.split(/\s+/)[0]);
}

const out = { source: SRC, cells: {} };

for (const label of [
  "loose-10000",
  "packed-10000",
  "loose-50000",
  "packed-50000",
]) {
  const dir = `/tmp/spike-030/${label}`;
  const ls = [];
  for (let i = 0; i < RUNS; i++) ls.push(time(["ls-remote", dir]));
  const clones = [];
  for (let i = 0; i < RUNS; i++) {
    const dest = `/tmp/spike-030-clone-${label}`;
    rmSync(dest, { recursive: true, force: true });
    clones.push(time(["clone", "-q", "--bare", "--no-hardlinks", dir, dest]));
  }
  out.cells[label] = {
    lsRemote: ls.map(r1),
    bareClone: clones.map(r1),
    bareCloneKiB: dirSize(`/tmp/spike-030-clone-${label}`),
    sourceKiB: dirSize(dir),
  };
  console.log(
    `${label.padEnd(12)} ls-remote ${r1(median(ls))} ms · bare clone ${r1(median(clones))} ms · ${dirSize(`/tmp/spike-030-clone-${label}`)} KiB`,
  );
}

writeFileSync(
  "/tmp/spike-030/results-remote.json",
  JSON.stringify(out, null, 2) + "\n",
);
