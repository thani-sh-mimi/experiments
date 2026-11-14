// 023 — what does a second working copy for an agent cost?
// Shapes: linked worktree, `clone --shared`, `clone --no-local` (real pack transport).
// Synthetic repo, 400 files, history swept at 500/5,000/20,000 commits, plus a file sweep at 5,000.
import { rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const TMP = join(ROOT, "tmp");
const RUNS = 3;
const FILES = 400;
const HISTORY = [500, 5000, 20000];
const FILE_SWEEP = [100, 400, 1200];
const SWEEP_COMMITS = 5000;
const BODY = 600; // characters of fixed pseudo-random body per file

// ---------- synthetic repo ----------
function bodyFor(seed, file) {
  let x = (seed * 2654435761 + file * 40503 + 1013904223) % 2147483647;
  let s = "";
  while (s.length < BODY) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += x.toString(16).padStart(8, "0");
  }
  return s.slice(0, BODY);
}

function content(seed, file, version) {
  return `// file ${file}\n${bodyFor(seed, file)}\n// version ${version}\n`;
}

function fastImportStream(files, commits, seed) {
  const out = [];
  let mark = 0;
  const blob = (file, version) => {
    const data = content(seed, file, version);
    mark += 1;
    out.push(`blob\nmark :${mark}\ndata ${Buffer.byteLength(data)}\n${data}`);
    return mark;
  };
  const commit = (n, changes) => {
    // blobs must be defined before the commit block that references them
    const refs = changes.map(([file, version]) => [file, blob(file, version)]);
    mark += 1;
    const t = 1700000000 + n * 60;
    out.push(
      `commit refs/heads/main\nmark :${mark}\nauthor Agent <agent@example.com> ${t} +0000\ncommitter Agent <agent@example.com> ${t} +0000\ndata ${Buffer.byteLength(`commit ${n}`)}\ncommit ${n}\n`,
    );
    for (const [file, ref] of refs)
      out.push(`M 100644 :${ref} file-${file}.txt\n`);
    out.push("\n");
  };

  const all = Array.from({ length: files }, (_, f) => [f, 0]);
  commit(0, all);
  for (let n = 1; n < commits; n++) {
    const file = (n * 7919) % files;
    const version = Math.floor(n / files) + 1;
    commit(n, [[file, version]]);
  }
  return out.join("");
}

function git(cwd, args) {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  }
  return p.stdout.toString();
}

function duBytes(path) {
  const p = Bun.spawnSync(["du", "-sb", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`du failed: ${p.stderr.toString()}`);
  return Number(p.stdout.toString().split("\t")[0]);
}

async function makeRepo(name, files, commits, seed) {
  const dir = join(TMP, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  const stream = new TextEncoder().encode(
    fastImportStream(files, commits, seed),
  );
  const p = Bun.spawnSync(["git", "fast-import", "--quiet"], {
    cwd: dir,
    stdin: stream,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0)
    throw new Error(`fast-import ${name}: ${p.stderr.toString()}`);
  git(dir, ["reset", "--hard", "--quiet", "main"]);
  git(dir, ["config", "gc.auto", "0"]);
  return dir;
}

// ---------- measurement ----------
const ARMS = ["worktree", "clone-shared", "clone-file"];

function addCopy(arm, src, dst) {
  if (arm === "worktree")
    return git(src, ["worktree", "add", "--detach", "--quiet", dst, "main"]);
  if (arm === "clone-shared")
    return git(ROOT, [
      "clone",
      "--shared",
      "--quiet",
      "--single-branch",
      "--branch",
      "main",
      src,
      dst,
    ]);
  return git(ROOT, [
    "clone",
    "--no-local",
    "--quiet",
    "--single-branch",
    "--branch",
    "main",
    src,
    dst,
  ]);
}

function removeCopy(arm, src, dst) {
  if (arm === "worktree")
    return git(src, ["worktree", "remove", "--force", dst]);
  return rm(dst, { recursive: true, force: true });
}

const runs = [];

async function measure(repo, arm, run) {
  const src = join(TMP, repo);
  const dst = join(TMP, `${repo}-${arm}-${run}`);
  await rm(dst, { recursive: true, force: true });

  const t0 = performance.now();
  addCopy(arm, src, dst);
  const ms = performance.now() - t0;

  const disk = duBytes(dst);
  const status = git(dst, ["status", "--porcelain"]).trim();
  const head = git(dst, ["rev-parse", "HEAD"]).trim();
  const srcHead = git(src, ["rev-parse", "HEAD"]).trim();
  const files = git(dst, ["ls-files"]).trim().split("\n").length;

  const t1 = performance.now();
  await removeCopy(arm, src, dst);
  const teardownMs = performance.now() - t1;

  if (status !== "" || head !== srcHead || existsSync(dst)) {
    throw new Error(
      `${repo}/${arm}/${run} failed sanity: status=${status} head=${head} src=${srcHead} exists=${existsSync(dst)}`,
    );
  }

  const row = {
    repo,
    arm,
    run,
    ms: +ms.toFixed(2),
    diskBytes: disk,
    teardownMs: +teardownMs.toFixed(2),
    files,
  };
  runs.push(row);
  console.log(
    `${repo.padEnd(14)} ${arm.padEnd(13)} run ${run}  ${row.ms.toFixed(1).padStart(8)} ms  ${(disk / 1024).toFixed(0).padStart(6)} KiB  teardown ${teardownMs.toFixed(1)} ms  ${files} files`,
  );
  return row;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- main ----------
await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

const repos = [];
for (const commits of HISTORY) {
  const name = `h${commits}`;
  repos.push({ name, files: FILES, commits });
}
repos.push({
  name: `files${FILE_SWEEP.at(-1)}`,
  files: FILE_SWEEP.at(-1),
  commits: SWEEP_COMMITS,
});
repos.push({
  name: `files${FILE_SWEEP[0]}`,
  files: FILE_SWEEP[0],
  commits: SWEEP_COMMITS,
});

for (const repo of repos)
  await makeRepo(repo.name, repo.files, repo.commits, 7);

const summary = [];
for (const repo of repos) {
  for (let run = 1; run <= RUNS; run++) {
    // rotate so no arm always runs first
    const order = ARMS.map((_, i) => ARMS[(i + run - 1) % ARMS.length]);
    for (const arm of order) await measure(repo.name, arm, run);
  }
  for (const arm of ARMS) {
    const rows = runs.filter((r) => r.repo === repo.name && r.arm === arm);
    summary.push({
      repo: repo.name,
      files: repo.files,
      commits: repo.commits,
      arm,
      ms: +median(rows.map((r) => r.ms)).toFixed(2),
      msSpread: +(
        Math.max(...rows.map((r) => r.ms)) - Math.min(...rows.map((r) => r.ms))
      ).toFixed(2),
      diskKiB: +(median(rows.map((r) => r.diskBytes)) / 1024).toFixed(1),
      teardownMs: +median(rows.map((r) => r.teardownMs)).toFixed(2),
    });
  }
}

// slope in ms per commit, from the 400-file history sweep
function slope(arm, lo, hi) {
  const a = summary.find((s) => s.repo === lo && s.arm === arm);
  const b = summary.find((s) => s.repo === hi && s.arm === arm);
  return +((b.ms - a.ms) / (b.commits - a.commits)).toFixed(4);
}

const slopes = {};
for (const arm of ARMS) slopes[arm] = slope(arm, "h500", "h20000");

const result = {
  meta: {
    host: {
      cpus: (await Bun.$`nproc`.text()).trim(),
      git: (await Bun.$`git --version`.text()).trim(),
      bun: Bun.version,
    },
    files: FILES,
    history: HISTORY,
    fileSweep: FILE_SWEEP,
    sweepCommits: SWEEP_COMMITS,
    runs: RUNS,
    note: "disk is `du -sb` apparent size of the new directory; a worktree dir holds only checkout files",
  },
  runs,
  summary,
  slopesMsPerCommit: slopes,
};
await Bun.write(
  join(ROOT, "results.json"),
  JSON.stringify(result, null, 2) + "\n",
);

console.log(
  "\nrepo  files  commits  arm           median ms  spread  disk KiB  teardown ms",
);
for (const s of summary) {
  console.log(
    `${s.repo.padEnd(6)}${String(s.files).padStart(6)}${String(s.commits).padStart(9)}  ${s.arm.padEnd(13)}${String(s.ms).padStart(9)}${String(s.msSpread).padStart(8)}${String(s.diskKiB).padStart(10)}${String(s.teardownMs).padStart(12)}`,
  );
}
console.log("\nslope ms/commit (500→20,000):", slopes);
