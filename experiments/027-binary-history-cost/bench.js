// What does each revision of a 1 MiB asset add to .git?
// Four cases, 100 revisions each, three runs. Synthetic data only.
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "tmp", "027");
const SIZE = 1024 * 1024;
const REVS = 100;
const RUNS = 3;

function git(dir, args, extra = []) {
  const p = Bun.spawnSync(["git", ...extra, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function init(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Spike"]);
  git(dir, ["config", "user.email", "spike@example.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "gc.auto", "0"]); // measure loose growth, then gc by hand
  git(dir, ["config", "core.compression", "6"]);
}

const commitMs = [];
function commit(dir, file, bytes, i) {
  writeFileSync(join(dir, file), bytes);
  git(dir, ["add", file]);
  const t = Bun.nanoseconds();
  git(dir, ["commit", "-q", "-m", `rev ${i}`]);
  commitMs.push((Bun.nanoseconds() - t) / 1e6);
}

function textBuf(lines) {
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

function makeText() {
  const n = Math.ceil(SIZE / 41);
  const lines = Array.from(
    { length: n },
    (_, i) => `const value_${i} = ${(i * 7919) % 100000}; // filler line`,
  );
  return lines;
}

const cases = {
  // A 1 MiB blob of fresh random bytes each revision: a re-encoded image or a rebuilt archive.
  "binary-rewrite": (dir) => {
    for (let i = 0; i < REVS; i++)
      commit(
        dir,
        "asset.bin",
        Buffer.from(crypto.getRandomValues(new Uint8Array(SIZE))),
        i,
      );
  },
  // Same bytes, 1 % of them rewritten in place each revision: a metadata edit.
  "binary-shift": (dir) => {
    const buf = Buffer.from(crypto.getRandomValues(new Uint8Array(SIZE)));
    for (let i = 0; i < REVS; i++) {
      const at = (i * 104729) % (SIZE - 10240);
      crypto.getRandomValues(buf.subarray(at, at + 10240));
      commit(dir, "asset.bin", buf, i);
    }
  },
  // 1 MiB of source text, 1 % of its lines rewritten each revision.
  "text-edit": (dir) => {
    const lines = makeText();
    const per = Math.round(lines.length * 0.01);
    for (let i = 0; i < REVS; i++) {
      for (let k = 0; k < per; k++) {
        const at = (i * 977 + k * 3301) % lines.length;
        lines[at] = `const value_${at} = ${i * 31 + k}; // edited r${i}`;
      }
      commit(dir, "asset.ts", textBuf(lines), i);
    }
  },
  // A 130-byte LFS pointer per revision; the real blob lives outside the repo.
  pointer: (dir) => {
    const store = join(dir, "..", "store");
    mkdirSync(store, { recursive: true });
    for (let i = 0; i < REVS; i++) {
      const blob = Buffer.from(crypto.getRandomValues(new Uint8Array(SIZE)));
      const oid = new Bun.CryptoHasher("sha256").update(blob).digest("hex");
      writeFileSync(join(store, oid), blob);
      const ptr = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${SIZE}\n`;
      commit(dir, "asset.bin", Buffer.from(ptr), i);
    }
  },
};

function dirBytes(path) {
  let total = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const c = join(p, e.name);
      if (e.isDirectory()) walk(c);
      else total += Bun.file(c).size;
    }
  };
  walk(path);
  return total;
}

function deltaCount(dir) {
  const idx = readdirSync(join(dir, ".git", "objects", "pack")).filter((f) =>
    f.endsWith(".idx"),
  );
  if (!idx.length) return { total: 0, delta: 0 };
  const out = git(dir, [
    "verify-pack",
    "-v",
    join(".git", "objects", "pack", idx[0]),
  ]);
  const rows = out
    .trim()
    .split("\n")
    .filter((l) => /^[0-9a-f]{40} /.test(l));
  return {
    total: rows.length,
    delta: rows.filter((l) => l.trim().split(/\s+/).length >= 7).length,
  };
}

const results = {
  runs: RUNS,
  revs: REVS,
  sizeBytes: SIZE,
  host: `${navigator.hardwareConcurrency} vCPU container`,
  cases: {},
};
let run = 0;
while (run < RUNS) {
  run++;
  const base = join(ROOT, `run-${run}`);
  rmSync(base, { recursive: true, force: true });
  for (const [name, build] of Object.entries(cases)) {
    const dir = join(base, name);
    init(dir);
    commitMs.length = 0;
    const t0 = Bun.nanoseconds();
    build(dir);
    const buildMs = (Bun.nanoseconds() - t0) / 1e6;
    const looseBytes = dirBytes(join(dir, ".git"));

    const t1 = Bun.nanoseconds();
    git(dir, ["gc", "-q", "--prune=now"]);
    const gcMs = (Bun.nanoseconds() - t1) / 1e6;

    const pack =
      Number(/size-pack: (\d+)/.exec(git(dir, ["count-objects", "-v"]))[1]) *
      1024;
    const deltas = deltaCount(dir);

    // What every developer pays on a fresh clone.
    const cloneDir = join(base, `${name}-clone`);
    const t2 = Bun.nanoseconds();
    git(base, ["clone", "-q", "--no-local", dir, `${name}-clone`]);
    const cloneMs = (Bun.nanoseconds() - t2) / 1e6;
    const cloneBytes = dirBytes(join(cloneDir, ".git"));

    const rec = {
      looseBytes,
      packBytes: pack,
      cloneBytes,
      cloneMs: +cloneMs.toFixed(1),
      gcMs: +gcMs.toFixed(1),
      buildMs: +buildMs.toFixed(1),
      commitMs: +(
        commitMs.reduce((a, b) => a + b, 0) / commitMs.length
      ).toFixed(2),
      packDeltas: deltas.delta,
      packObjects: deltas.total,
      lfsStoreBytes: name === "pointer" ? dirBytes(join(base, "store")) : 0,
    };
    (results.cases[name] ??= []).push(rec);
    console.log(
      `${run} ${name.padEnd(15)} pack ${(pack / 1048576).toFixed(1)} MiB  per-rev ${(pack / (REVS - 1) / 1024).toFixed(1)} KiB  deltas ${deltas.delta}/${deltas.total}  clone ${cloneMs.toFixed(0)} ms`,
    );
    rmSync(cloneDir, { recursive: true, force: true });
    rmSync(join(base, "store"), { recursive: true, force: true });
  }
}

writeFileSync(
  join(import.meta.dir, "results.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log("wrote results.json");
