// 021 — what a pre-commit hook pays to read staged content, three ways.
// Fresh synthetic repo per run: N staged files, D of them also dirty in the worktree.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from "node:fs";

const BASE = `${import.meta.dir}/tmp`;
const LINES = Array.from(
  { length: 20 },
  (_, i) => `export const v${i} = ${i};`,
);
const BODY = LINES.join("\n") + "\n";
const TALL =
  Array.from({ length: 120 }, (_, i) => `export const w${i} = ${i};`).join(
    "\n",
  ) + "\n";

function git(cwd, args, opts = {}) {
  const t = process.hrtime.bigint();
  const r = spawnSync("git", args, {
    cwd,
    encoding: opts.encoding ?? "utf8",
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  return { ms, code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function setup(dir, n, dirty, mode) {
  const apart = mode === "apart";
  const body = apart ? TALL : BODY;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/src`, { recursive: true });
  for (let i = 0; i < n; i++)
    writeFileSync(`${dir}/src/f${String(i).padStart(5, "0")}.ts`, body);
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "spike@aivara.se"]);
  git(dir, ["config", "user.name", "spike"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  for (let i = 0; i < n; i++) {
    const p = `${dir}/src/f${String(i).padStart(5, "0")}.ts`;
    apart
      ? writeFileSync(p, "// staged\n" + body)
      : appendFileSync(p, "// staged\n");
  }
  git(dir, ["add", "-A"]);
  for (let i = 0; i < dirty; i++)
    appendFileSync(
      `${dir}/src/f${String(i).padStart(5, "0")}.ts`,
      "// unstaged\n",
    );
}

function name(i) {
  return `src/f${String(i).padStart(5, "0")}.ts`;
}

// A: lint-staged's pattern — hide unstaged work, lint the index, restore.
function stashDance(dir, n) {
  const push = git(dir, ["stash", "push", "--keep-index", "-q"]);
  const pop = git(dir, ["stash", "pop", "-q"]);
  const conflicts =
    git(dir, ["ls-files", "-u"]).out.split("\n").filter(Boolean).length / 3;
  const left = git(dir, ["stash", "list"])
    .out.split("\n")
    .filter(Boolean).length;
  return {
    ms: push.ms + pop.ms,
    pushMs: push.ms,
    popMs: pop.ms,
    pushCode: push.code,
    popCode: pop.code,
    conflicts,
    stashesLeft: left,
  };
}

// B: export the index into a scratch tree, read-only for the repo.
function checkoutIndex(dir, n, scratch) {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const r = git(dir, ["checkout-index", "-a", `--prefix=${scratch}/`]);
  let files = 0;
  try {
    files = readdirSync(`${scratch}/src`).length;
  } catch {}
  return { ms: r.ms, code: r.code, files };
}

// C: stream the index blobs through one cat-file process.
function catFileBatch(dir, n) {
  const input =
    Array.from({ length: n }, (_, i) => `:${name(i)}`).join("\n") + "\n";
  const r = git(dir, ["cat-file", "--batch"], { input });
  const blobs = (r.out.match(/ blob \d+\n/g) || []).length;
  return { ms: r.ms, code: r.code, blobs, bytes: r.out.length };
}

// Does each method hand the linter the staged bytes, not the worktree bytes?
function verify(dir, scratch) {
  const staged = git(dir, ["show", `:${name(0)}`]).out;
  const exported = spawnSync("cat", [`${scratch}/${name(0)}`], {
    encoding: "utf8",
  }).stdout;
  const batch = git(dir, ["cat-file", "--batch"], {
    input: `:${name(0)}\n`,
  }).out;
  const m = /^(\S+) blob (\d+)\n/.exec(batch);
  const body = m ? batch.slice(m[0].length, m[0].length + Number(m[2])) : "";
  return {
    checkoutIsStaged: exported === staged,
    catFileIsStaged: body === staged,
  };
}

function sample(dir, n, dirty, mode) {
  const last = dirty > 0 ? dirty - 1 : 0;
  const got = spawnSync("cat", [`${dir}/${name(last)}`], {
    encoding: "utf8",
  }).stdout;
  const want =
    mode === "apart"
      ? "// staged\n" + TALL + (dirty > 0 ? "// unstaged\n" : "")
      : BODY + "// staged\n" + (last < dirty ? "// unstaged\n" : "");
  return got === want;
}

const configs = [
  { n: 10, dirty: 10, mode: "adjacent" },
  { n: 100, dirty: 100, mode: "adjacent" },
  { n: 1000, dirty: 0, mode: "adjacent" },
  { n: 1000, dirty: 1000, mode: "adjacent" },
  { n: 1000, dirty: 1000, mode: "apart" },
  { n: 5000, dirty: 0, mode: "adjacent" },
  { n: 5000, dirty: 5000, mode: "adjacent" },
];
const RUNS = 3;
const results = [];

for (const { n, dirty, mode } of configs) {
  const dir = `${BASE}/repo-${n}-${dirty}-${mode}`;
  const scratch = `${BASE}/out-${n}-${dirty}-${mode}`;
  const runs = [];
  let checks = null;
  for (let r = 0; r < RUNS; r++) {
    setup(dir, n, dirty, mode);
    const a = stashDance(dir, n);
    const restored = sample(dir, n, dirty, mode);
    setup(dir, n, dirty, mode);
    const b = checkoutIndex(dir, n, scratch);
    const c = catFileBatch(dir, n);
    checks = verify(dir, scratch);
    runs.push({ a, b, c, restored });
  }
  const med = (k, f) => {
    const xs = runs
      .map(f)
      .slice()
      .sort((x, y) => x - y);
    return xs[Math.floor(xs.length / 2)];
  };
  results.push({
    n,
    dirty,
    mode,
    runs,
    checks,
    median: {
      stashMs: med("a", (r) => r.a.ms),
      checkoutMs: med("b", (r) => r.b.ms),
      catFileMs: med("c", (r) => r.c.ms),
    },
    spread: {
      stashMs: [
        Math.min(...runs.map((r) => r.a.ms)),
        Math.max(...runs.map((r) => r.a.ms)),
      ],
      checkoutMs: [
        Math.min(...runs.map((r) => r.b.ms)),
        Math.max(...runs.map((r) => r.b.ms)),
      ],
      catFileMs: [
        Math.min(...runs.map((r) => r.c.ms)),
        Math.max(...runs.map((r) => r.c.ms)),
      ],
    },
  });
  const last = results.at(-1);
  console.log(
    `${n} files, ${dirty} dirty, ${mode}: stash ${last.median.stashMs.toFixed(0)} ms (conflicts ${runs[0].a.conflicts}, restored ${runs[0].restored}), checkout-index ${last.median.checkoutMs.toFixed(0)} ms (${runs[0].b.files} files), cat-file ${last.median.catFileMs.toFixed(0)} ms (${runs[0].c.blobs} blobs)`,
  );
}

writeFileSync(
  `${import.meta.dir}/results.json`,
  JSON.stringify(
    {
      bun: Bun.version,
      git: git(import.meta.dir, ["--version"]).out.trim(),
      runs: RUNS,
      results,
    },
    null,
    2,
  ),
);
