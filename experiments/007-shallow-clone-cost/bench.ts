// 007: what does `git clone --depth 1` actually save?
// Builds synthetic origins (same 400-file tree, growing history) and clones each
// twice per run: full, and --depth 1. Times the clone and measures .git on disk.
// History is generated with fast-import so the only thing that varies is commits.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..", "..", "tmp", "007");
const COUNTS = [100, 500, 1000, 2000, 4000];
const RUNS = 3;
const FILES = 400;
const DIRS = 20;
const TOUCHED = 3;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const git = (args: string[], cwd?: string, input?: Uint8Array) => {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

// small deterministic PRNG so every origin is byte-identical across runs
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const path = (i: number) => `src/d${i % DIRS}/f${i}.ts`;

function content(fileIdx: number, version: number) {
  const r = rng(fileIdx * 7919 + version);
  const lines = [`// f${fileIdx} v${version}`];
  for (let k = 0; k < 10; k++) {
    const hex = Math.floor(r() * 0xffffffff).toString(16).padStart(8, "0");
    lines.push(`export const k${k}_${fileIdx} = "${hex}${hex}";`);
  }
  const body = lines.join("\n") + "\n";
  return { body, bytes: Buffer.byteLength(body) };
}

function stream(n: number) {
  const out: string[] = [];
  let t = 1600000000;
  for (let i = 0; i < n; i++) {
    t += 60;
    out.push("commit refs/heads/main", `mark :${i + 1}`);
    out.push(`author Dev <dev@example.com> ${t} +0000`);
    out.push(`committer Dev <dev@example.com> ${t} +0000`);
    const msg = `commit ${i}\n`;
    out.push(`data ${Buffer.byteLength(msg)}`, msg);

    const touched: number[] = [];
    if (i === 0) for (let f = 0; f < FILES; f++) touched.push(f);
    else for (let k = 0; k < TOUCHED; k++) touched.push((i * (7 + k * 6) + k) % FILES);

    for (const f of touched) {
      const { body, bytes } = content(f, i);
      out.push(`M 100644 inline ${path(f)}`, `data ${bytes}`, body);
    }
  }
  return out.join("\n") + "\n";
}

function origin(n: number) {
  const dir = join(ROOT, `origin-${n}`);
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "--initial-branch=main"], dir);
  git(["fast-import", "--quiet"], dir, Buffer.from(stream(n)));
  git(["reset", "--hard", "-q"], dir);
  git(["count-objects", "-v"], dir);
  git(["gc", "-q", "--prune=now"], dir);
  return dir;
}

function bytes(dir: string) {
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

function clone(src: string, mode: string, label: number, checkout = true) {
  const dest = mkdtempSync(join(tmpdir(), "c-"));
  rmSync(dest, { recursive: true, force: true });
  const args = ["clone", "--quiet", "--no-hardlinks"];
  if (mode === "shallow") args.push("--depth", "1");
  if (!checkout) args.push("--no-checkout");
  args.push(`file://${src}`, dest);

  const t0 = performance.now();
  git(args);
  const ms = performance.now() - t0;
  const gitBytes = bytes(join(dest, ".git"));
  const wtBytes = checkout ? bytes(join(dest, "src")) : 0;
  const commits = Number(git(["rev-list", "--count", "HEAD"], dest).trim());
  rmSync(dest, { recursive: true, force: true });
  return { n: label, mode, ms: +ms.toFixed(2), gitBytes, wtBytes, commits };
}

const origins: Record<number, string> = {};
for (const n of COUNTS) origins[n] = origin(n);

const runs: any[] = [];
for (let r = 0; r < RUNS; r++) {
  for (const n of COUNTS) {
    for (const mode of ["full", "shallow"]) runs.push({ ...clone(origins[n], mode, n), run: r });
  }
}

// noise floor: identical full clones of the 2,000-commit origin, five times
const noise: number[] = [];
for (let i = 0; i < 5; i++) noise.push(clone(origins[2000], "full", 2000).ms);

// decompose the plateau: same clones without a working-tree checkout, so what
// remains is pack transfer and object parsing only.
const bare: any[] = [];
for (let r = 0; r < RUNS; r++) {
  for (const n of [100, 4000]) {
    for (const mode of ["full", "shallow"]) bare.push({ ...clone(origins[n], mode, n, false), run: r });
  }
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return +(s[Math.floor(s.length / 2)]).toFixed(2);
};

const summary: any = {};
for (const n of COUNTS) {
  const pick = (mode: string) => runs.filter((x) => x.n === n && x.mode === mode);
  const full = pick("full");
  const shallow = pick("shallow");
  summary[n] = {
    fullMs: med(full.map((x) => x.ms)),
    fullRange: [Math.min(...full.map((x) => x.ms)), Math.max(...full.map((x) => x.ms))],
    shallowMs: med(shallow.map((x) => x.ms)),
    shallowRange: [Math.min(...shallow.map((x) => x.ms)), Math.max(...shallow.map((x) => x.ms))],
    savedMs: +(med(full.map((x) => x.ms)) - med(shallow.map((x) => x.ms))).toFixed(2),
    fullGitMB: +(med(full.map((x) => x.gitBytes)) / 1e6).toFixed(2),
    shallowGitMB: +(med(shallow.map((x) => x.gitBytes)) / 1e6).toFixed(2),
    diskRatio: +(med(shallow.map((x) => x.gitBytes)) / med(full.map((x) => x.gitBytes))).toFixed(3),
    commitsSeen: shallow[0].commits,
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  git: git(["--version"]).trim(),
  shape: { files: FILES, dirs: DIRS, touchedPerCommit: TOUCHED, counts: COUNTS, runs: RUNS },
  runs,
  summary,
  noCheckout: bare,
  noCheckoutMedians: Object.fromEntries(
    [100, 4000].map((n) => [
      n,
      Object.fromEntries(
        ["full", "shallow"].map((m) => [
          m,
          med(bare.filter((b) => b.n === n && b.mode === m).map((b) => b.ms)),
        ]),
      ),
    ]),
  ),
  noiseFloorMs: {
    samples: noise,
    spread: +(Math.max(...noise) - Math.min(...noise)).toFixed(2),
  },
};

writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 1));
console.log("noise", out.noiseFloorMs);
