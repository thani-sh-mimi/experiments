// bench.js — what a code search costs on a 20k-file repo.
// Builds a synthetic tree, commits it, then times rg / git grep / GNU grep.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const ROOT = "/tmp/spike-028/repo";
const N_FILES = 20_000;
const N_IGNORED = 2_000;
const RARE = "ZEBRA_QUARRY";
const ABSENT = "XYZZY_NOT_PRESENT_e9";
const RARE_FILES = 50;

const WORDS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "theta",
  "lambda",
];

function line(i, j) {
  const w = WORDS[(i * 7 + j * 13) % WORDS.length];
  return `export function ${w}${i}_${j}(input: number): number { return input * ${j} + ${i}; }`;
}

function body(i) {
  const out = [];
  for (let j = 0; j < 40; j++) out.push(line(i, j));
  if (i % (N_FILES / RARE_FILES) === 0)
    out.push(`// marker ${RARE} in file ${i}`);
  return out.join("\n") + "\n";
}

function buildTree() {
  rmSync("/tmp/spike-028", { recursive: true, force: true });
  const files = [];
  for (let i = 0; i < N_FILES; i++) {
    const dir = `${ROOT}/src/g${String(Math.floor(i / 100)).padStart(3, "0")}/sub${i % 10}`;
    mkdirSync(dir, { recursive: true });
    const p = `${dir}/m${i}.ts`;
    writeFileSync(p, body(i));
    files.push(p);
  }
  for (let i = 0; i < N_IGNORED; i++) {
    const dir = `${ROOT}/dist/g${Math.floor(i / 100)}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/b${i}.ts`, body(i));
  }
  writeFileSync(`${ROOT}/.gitignore`, "dist/\nnode_modules/\n");
  writeFileSync(`${ROOT}/src/g000/sub0/one.ts`, line(99999, 0) + "\n");
  return files;
}

function git(args, cwd = ROOT) {
  const p = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function time(cmd, cwd) {
  const t0 = performance.now();
  const p = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const ms = performance.now() - t0;
  const out = p.stdout.toString();
  const okExit = [0, 1, 2, 123]; // 1 = no match, 2 = grep warning, 123 = xargs saw exit 1
  if (!okExit.includes(p.exitCode))
    throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return {
    ms,
    lines: out === "" ? 0 : out.replace(/\n$/, "").split("\n").length,
  };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const files = buildTree();
git(["init", "-q"]);
git(["config", "user.email", "spike@local"]);
git(["config", "user.name", "spike"]);
git(["config", "gc.auto", "0"]);
git(["config", "maintenance.auto", "false"]);
git(["add", "-A"]);
git(["commit", "-qm", "synthetic tree"]);
// pack the objects up front: a real repo is packed, and a background auto-gc
// deleting loose objects mid-run would turn into read errors under grep
git(["gc", "--quiet"]);

const dirs = [".", "src/g100/sub3"];
const EXCL = [
  "--exclude-dir=.git",
  "--exclude-dir=dist",
  "--exclude-dir=node_modules",
];
const LIST = "/tmp/spike-028/list.txt";
Bun.spawnSync({
  cmd: ["git", "ls-files", "-z"],
  cwd: ROOT,
  stdout: Bun.file(LIST),
});

const queries = {
  // 50 hits in 20k tracked files: the tool must scan every file
  rare: [
    { tool: "rg", cmd: ["rg", "-n", "--no-heading", RARE] },
    { tool: "git grep", cmd: ["git", "grep", "-n", "--no-color", RARE] },
    { tool: "grep (fair)", cmd: ["grep", "-rnI", ...EXCL, RARE, "."] },
    { tool: "grep (naive)", cmd: ["grep", "-rnI", RARE, "."] },
    {
      tool: "xargs grep",
      cmd: ["xargs", "-0", "-a", LIST, "grep", "-nI", RARE],
    },
  ],
  // zero hits anywhere: no early exit for any tool
  absent: [
    { tool: "rg", cmd: ["rg", "-n", "--no-heading", ABSENT] },
    { tool: "git grep", cmd: ["git", "grep", "-n", "--no-color", ABSENT] },
    { tool: "grep (fair)", cmd: ["grep", "-rnI", ...EXCL, ABSENT, "."] },
    { tool: "grep (naive)", cmd: ["grep", "-rnI", ABSENT, "."] },
    {
      tool: "xargs grep",
      cmd: ["xargs", "-0", "-a", LIST, "grep", "-nI", ABSENT],
    },
  ],
  // the walk on its own, with nothing searched: how much of grep's cost is the tree walk
  walk: [
    { tool: "git ls-files", cmd: ["git", "ls-files", "-z"] },
    {
      tool: "find",
      cmd: [
        "find",
        ".",
        "-path",
        "./.git",
        "-prune",
        "-o",
        "-path",
        "./dist",
        "-prune",
        "-o",
        "-type",
        "f",
        "-print",
      ],
    },
    { tool: "rg --files", cmd: ["rg", "--files"] },
  ],
  // one small file: startup cost dominates
  onefile: [
    {
      tool: "rg",
      cmd: ["rg", "-n", "--no-heading", "alpha1_", "src/g000/sub0/one.ts"],
    },
    {
      tool: "git grep",
      cmd: [
        "git",
        "grep",
        "-n",
        "--no-color",
        "alpha1_",
        "--",
        "src/g000/sub0/one.ts",
      ],
    },
    { tool: "grep", cmd: ["grep", "-nI", "alpha1_", "src/g000/sub0/one.ts"] },
  ],
};

const RUNS = 3;
const results = { meta: {}, runs: [], medians: {}, noise: null };

const du = Bun.spawnSync({ cmd: ["du", "-sh", ROOT], stdout: "pipe" })
  .stdout.toString()
  .split("\t")[0];
const tracked = git(["ls-files"]).trim().split("\n").length;
const ignored = N_IGNORED;
results.meta = {
  files_tracked: tracked,
  files_ignored: ignored,
  bytes_on_disk: du.trim(),
  bytes_tracked_on_disk: Number(
    Bun.spawnSync({
      cmd: ["du", "-sb", "--exclude=.git", "."],
      cwd: ROOT,
      stdout: "pipe",
    })
      .stdout.toString()
      .split("\t")[0],
  ),
  bytes_of_file_list: git(["ls-files", "-z"]).length,
  query_rare: RARE,
  query_absent: ABSENT,
  runs: RUNS,
  versions: ["rg 14.1.1", "grep 3.11", "git 2.47.3"],
  cwd: dirs[0],
};

const startup = [];
const versionArgs = {
  rg: ["rg", "--version"],
  "git grep": ["git", "--version"],
  grep: ["grep", "--version"],
};
for (const tool of ["rg", "git grep", "grep"]) {
  const times = [];
  for (let r = 0; r < 9; r++) times.push(time(versionArgs[tool], ROOT).ms);
  startup.push({
    tool,
    probe: versionArgs[tool].join(" "),
    median_ms: +median(times).toFixed(2),
  });
}
results.startup = startup;

for (let r = 0; r < RUNS; r++) {
  for (const [q, tools] of Object.entries(queries)) {
    for (const t of tools) {
      const res = time(t.cmd, ROOT);
      results.runs.push({
        run: r + 1,
        query: q,
        tool: t.tool,
        ms: +res.ms.toFixed(2),
        lines: res.lines,
      });
    }
  }
}

for (const [q, tools] of Object.entries(queries)) {
  results.medians[q] = {};
  for (const t of tools) {
    const xs = results.runs.filter((x) => x.query === q && x.tool === t.tool);
    results.medians[q][t.tool] = {
      ms: +median(xs.map((x) => x.ms)).toFixed(2),
      lines: xs[0].lines,
      all: xs.map((x) => x.ms),
    };
  }
}

// noise floor: the fastest tool, ten back-to-back runs of the absent query
const noisy = [];
for (let r = 0; r < 10; r++)
  noisy.push(+time(queries.absent[0].cmd, ROOT).ms.toFixed(2));
results.noise = {
  tool: "rg absent",
  min: Math.min(...noisy),
  median: median(noisy),
  max: Math.max(...noisy),
  all: noisy,
};

// correctness: an agent leaves scratch files untracked. Who sees them?
writeFileSync(
  `${ROOT}/src/g000/sub0/scratch.ts`,
  `// ${RARE} in an untracked file\n`,
);
const untrackedProbe = {};
for (const [name, cmd] of Object.entries({
  rg: ["rg", "-n", "--no-heading", RARE],
  "git grep": ["git", "grep", "-n", "--no-color", RARE],
  "git grep --untracked": [
    "git",
    "grep",
    "-n",
    "--no-color",
    "--untracked",
    RARE,
  ],
  "grep (fair)": ["grep", "-rnI", ...EXCL, RARE, "."],
})) {
  untrackedProbe[name] = time(cmd, ROOT).lines;
}
results.untracked_probe = {
  file: "src/g000/sub0/scratch.ts",
  hits_per_tool: untrackedProbe,
};
rmSync(`${ROOT}/src/g000/sub0/scratch.ts`);

await Bun.write(
  new URL("./results.json", import.meta.url),
  JSON.stringify(results, null, 2),
);

const pad = (s, n) => String(s).padEnd(n);
console.log(
  `${results.meta.files_tracked} tracked files, ${ignored} ignored, ${results.meta.bytes_on_disk} on disk`,
);
console.log(
  `start-up: ${startup.map((s) => `${s.tool} ${s.median_ms} ms`).join("  ")}`,
);
for (const q of Object.keys(queries)) {
  console.log(`\n${q}`);
  for (const [tool, v] of Object.entries(results.medians[q])) {
    console.log(
      `  ${pad(tool, 14)} ${pad(v.ms + " ms", 10)} lines=${v.lines}  all=[${v.all.join(", ")}]`,
    );
  }
}
console.log(
  `\nnoise (rg absent, 10 runs): min ${results.noise.min} median ${results.noise.median} max ${results.noise.max}`,
);
console.log(`untracked file hits: ${JSON.stringify(untrackedProbe)}`);
