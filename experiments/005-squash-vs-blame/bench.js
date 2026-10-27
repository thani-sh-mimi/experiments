// 005: what a squash merge costs `git blame`, on a synthetic 5,000-commit history.
// Bun: `bun run bench.js`. Local git only, no network, synthetic data.

import { mkdirSync, rmSync, writeFileSync, closeSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const WORK = join(ROOT, "tmp", "005");
const REVS = Number(process.env.REVS ?? 5000);
const GROUP = Number(process.env.GROUP ?? 25);
const FILES = 8;
const LINES = 400;
const SAMPLE = "src/mod00.ts";
const SAMPLED_REPO_FILES = 20; // commits whose diff size we read
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const REPEATS = Number(process.env.REPEATS ?? 5);

const git = (cwd, args, opts = {}) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};

const fastImport = (dir, file) => {
  const r = spawnSync("sh", ["-c", `git fast-import --quiet < '${file}'`], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fast-import failed: ${r.stderr}`);
};

const timeIt = (cwd, args) => {
  const t0 = performance.now();
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return { ms, out: r.stdout };
};

// ---- synthetic history -----------------------------------------------------

const state = Array.from({ length: FILES }, () => Array.from({ length: LINES }, () => "export const v0 = 0;"));
const hist = Array.from({ length: FILES }, () => Array.from({ length: LINES }, () => []));

const pathOf = (f) => `src/mod${String(f).padStart(2, "0")}.ts`;
const body = (f) => state[f].join("\n") + "\n";

// One branch = GROUP commits. In "block" mode every commit re-edits a 5-line block of one file.
// In "mixed" mode odd-numbered branches touch 25 distinct lines instead, so only half the
// branches lump repeated edits onto the same line.
function changeOf(rev, mode) {
  const g = Math.floor((rev - 1) / GROUP);
  const j = (rev - 1) % GROUP;
  // pairs of consecutive branches share a file, so both parities reach every file
  const f = Math.floor(g / 2) % FILES;
  const window = Math.floor(g / (2 * FILES)) % 10;
  if (mode === "mixed" && g % 2 === 1) {
    const line = 200 + ((j * 8) % 200); // 25 distinct lines, never the block region
    return { g, f, line };
  }
  const line = window * 40 + ((j * 3) % 5); // 0-based within lines 0..399
  return { g, f, line };
}

const resetState = () => {
  for (let f = 0; f < FILES; f++) {
    state[f] = Array.from({ length: LINES }, () => "export const v0 = 0;");
    hist[f] = Array.from({ length: LINES }, () => []);
  }
};

const buf = { parts: [], bytes: 0, fd: 0 };
const emit = (s) => {
  buf.parts.push(s);
  buf.bytes += Buffer.byteLength(s);
  if (buf.bytes > 4 << 20) flush();
};
const flush = () => {
  if (buf.parts.length) writeSync(buf.fd, buf.parts.join(""));
  buf.parts = [];
  buf.bytes = 0;
};

const stamp = (rev) => `${1700000000 + rev * 60} +0000`;
const dataBlock = (s) => `data ${Buffer.byteLength(s)}\n${s}\n`;

function commit({ mark, message, rev, from, files }) {
  emit(`commit refs/heads/main\nmark :${mark}\n`);
  emit(`author Dev <dev@example.com> ${stamp(rev)}\n`);
  emit(`committer Dev <dev@example.com> ${stamp(rev)}\n`);
  emit(dataBlock(message));
  if (from) emit(`from :${from}\n`);
  for (const f of files) {
    emit(`M 100644 inline ${pathOf(f)}\n`);
    emit(dataBlock(body(f)));
  }
  emit("\n");
}

function initRepo(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "Dev"]);
  git(dir, ["config", "gc.auto", "0"]);
}

function generate(mode) {
  const dir = join(WORK, mode);
  const linear = join(dir, "linear");
  const squashed = join(dir, "squashed");
  resetState();
  for (const d of [linear, squashed]) initRepo(d);

  // linear: 1 commit per rev
  buf.fd = openSync(join(dir, "linear.fi"), "w");
  commit({ mark: 1, message: "init", rev: 0, files: [...Array(FILES).keys()] });
  for (let rev = 1; rev <= REVS; rev++) {
    const { f, line } = changeOf(rev, mode);
    state[f][line] = `export const v${line + 1} = ${rev};`;
    hist[f][line].push(rev);
    commit({ mark: rev + 1, message: `rev ${rev}`, rev, from: rev, files: [f] });
  }
  flush();
  closeSync(buf.fd);
  fastImport(linear, join(dir, "linear.fi"));

  // squashed: reset state, then 1 commit per branch of GROUP revs
  resetState();
  buf.fd = openSync(join(dir, "squashed.fi"), "w");
  commit({ mark: 1, message: "init", rev: 0, files: [...Array(FILES).keys()] });
  let mark = 2;
  let prev = 1;
  const branches = Math.ceil(REVS / GROUP);
  for (let g = 0; g < branches; g++) {
    const touched = new Set();
    for (let j = 0; j < GROUP; j++) {
      const rev = g * GROUP + j + 1;
      const c = changeOf(rev, mode);
      state[c.f][c.line] = `export const v${c.line + 1} = ${rev};`;
      hist[c.f][c.line].push(rev);
      touched.add(c.f);
    }
    commit({
      mark,
      message: `squash ${g} (revs ${g * GROUP + 1}-${g * GROUP + GROUP})`,
      rev: g * GROUP + GROUP,
      from: prev,
      files: [...touched],
    });
    prev = mark++;
  }
  flush();
  closeSync(buf.fd);
  fastImport(squashed, join(dir, "squashed.fi"));

  for (const d of [linear, squashed]) {
    git(d, ["checkout", "-q", "main"]);
    git(d, ["gc", "-q"]);
    git(d, ["commit-graph", "write", "--reachable"]);
  }
  return { linear, squashed };
}

// ---- measurement -----------------------------------------------------------

const parseBlame = (out) => {
  // porcelain: first field is the commit hash on each "line" block
  const lines = [];
  for (const ln of out.split("\n")) {
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(ln);
    if (m) lines.push(m[1]);
  }
  return lines;
};

function measure(dir, label, probeLine) {
  const tree = git(dir, ["rev-parse", "main^{tree}"]).trim();
  const commits = Number(git(dir, ["rev-list", "--count", "main"]).trim());
  const fileCommits = Number(git(dir, ["rev-list", "--count", "main", "--", SAMPLE]).trim());
  const sizeKb = Number(
    spawnSync("du", ["-sk", join(dir, ".git")], { encoding: "utf8" }).stdout.split("\t")[0],
  );

  const blameTimes = [];
  let blamed = [];
  for (let i = 0; i < REPEATS; i++) {
    const { ms, out } = timeIt(dir, ["blame", "--line-porcelain", "--", SAMPLE]);
    blameTimes.push(ms);
    blamed = parseBlame(out);
  }
  const lineTimes = [];
  for (let i = 0; i < REPEATS; i++) lineTimes.push(timeIt(dir, ["blame", "-L", `${probeLine},${probeLine}`, "--", SAMPLE]).ms);

  // message per commit, to map hash -> rev or branch
  const log = git(dir, ["log", "--format=%H %s", "main"]).split("\n").filter(Boolean);
  const msgOf = new Map(log.map((l) => [l.slice(0, 40), l.slice(41)]));

  // diff size per commit (added + deleted lines)
  const hashes = log.slice(0, SAMPLED_REPO_FILES).map((l) => l.slice(0, 40));
  const diffs = [];
  for (const h of hashes) {
    const out = git(dir, ["show", "--numstat", "--format=", h]);
    let sum = 0;
    for (const row of out.split("\n")) {
      const [a, d] = row.split("\t");
      if (a && d) sum += Number(a) + Number(d);
    }
    diffs.push(sum);
  }
  return { label, dir, tree, commits, fileCommits, sizeKb, blameTimes, lineTimes, blamed, msgOf, diffs };
}

function attribution(dir) {
  // For the sample file, how many lines resolve to a branch that hid more than one change?
  const { out } = timeIt(dir, ["blame", "--line-porcelain", "--", SAMPLE]);
  const hashes = parseBlame(out);
  const log = git(dir, ["log", "--format=%H %s", "main"]).split("\n").filter(Boolean);
  const msgOf = new Map(log.map((l) => [l.slice(0, 40), l.slice(41)]));

  let touched = 0, hidden = 0, sumK = 0, blameOnWrongLine = 0;
  const samples = [];
  for (let i = 0; i < LINES; i++) {
    const revs = hist[0][i];
    if (revs.length === 0) continue;
    touched++;
    const last = revs[revs.length - 1];
    const g = Math.floor((last - 1) / GROUP);
    const inGroup = revs.filter((r) => Math.floor((r - 1) / GROUP) === g).length;
    if (inGroup >= 2) {
      hidden++;
      sumK += inGroup;
    }
    const msg = msgOf.get(hashes[i]) ?? "";
    const blamedRev = /^rev (\d+)$/.exec(msg);
    const blamedBranch = /^squash (\d+)/.exec(msg);
    if (blamedRev && Number(blamedRev[1]) !== last) blameOnWrongLine++;
    if (samples.length < 6 && inGroup >= 2)
      samples.push({
        line: i + 1,
        blamed: msg,
        trueRevs: revs,
        changesInBranch: inGroup,
      });
    if (blamedBranch && Number(blamedBranch[1]) !== g) blameOnWrongLine++;
  }
  return { touched, hidden, meanK: hidden ? sumK / hidden : 0, blameOnWrongLine, samples };
}

// ---- run -------------------------------------------------------------------

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function runMode(mode) {
  const t0 = performance.now();
  const { linear, squashed } = generate(mode);
  const genMs = performance.now() - t0;

  // the freshest line in the sample file: same line, both histories
  let probeLine = 1;
  let best = -1;
  hist[0].forEach((revs, i) => {
    if (revs.length && revs[revs.length - 1] > best) { best = revs[revs.length - 1]; probeLine = i + 1; }
  });

  const rounds = [];
  for (let r = 0; r < ROUNDS; r++) {
    const order = r % 2 ? [squashed, linear] : [linear, squashed];
    const round = {};
    for (const dir of order) {
      const label = dir === linear ? "linear" : "squashed";
      round[label] = measure(dir, label, probeLine);
    }
    rounds.push(round);
  }

  const allBlame = (label) => rounds.flatMap((r) => r[label].blameTimes);
  const allLine = (label) => rounds.flatMap((r) => r[label].lineTimes);

  const base = rounds[0];
  const truth = { linear: attribution(linear), squashed: attribution(squashed) };

  const summary = {
    mode,
    config: { REVS, GROUP, FILES, LINES, SAMPLE, ROUNDS, REPEATS, genMs: Math.round(genMs) },
    treesEqual: base.linear.tree === base.squashed.tree,
    commits: { linear: base.linear.commits, squashed: base.squashed.commits },
    commitsTouchingSample: { linear: base.linear.fileCommits, squashed: base.squashed.fileCommits },
    gitSizeKb: { linear: base.linear.sizeKb, squashed: base.squashed.sizeKb },
    blameFileMs: {
      linear: { median: +med(allBlame("linear")).toFixed(2), runs: allBlame("linear").map((x) => +x.toFixed(2)) },
      squashed: { median: +med(allBlame("squashed")).toFixed(2), runs: allBlame("squashed").map((x) => +x.toFixed(2)) },
    },
    blameLineMs: {
      linear: { median: +med(allLine("linear")).toFixed(2), runs: allLine("linear").map((x) => +x.toFixed(2)) },
      squashed: { median: +med(allLine("squashed")).toFixed(2), runs: allLine("squashed").map((x) => +x.toFixed(2)) },
    },
    diffLinesPerCommit: {
      linear: base.linear.diffs,
      squashed: base.squashed.diffs,
      medianLinear: med(base.linear.diffs),
      medianSquashed: med(base.squashed.diffs),
    },
    attribution: {
      touched: truth.squashed.touched,
      hidden: truth.squashed.hidden,
      hiddenShare: +(truth.squashed.hidden / truth.squashed.touched).toFixed(3),
      meanChangesHidden: +truth.squashed.meanK.toFixed(2),
      linearBlameWrong: truth.linear.blameOnWrongLine,
      squashedBlameWrong: truth.squashed.blameOnWrongLine,
      samples: truth.squashed.samples,
    },
    rounds: rounds.map((r) => ({
      linear: { blame: r.linear.blameTimes.map((x) => +x.toFixed(2)), line: r.linear.lineTimes.map((x) => +x.toFixed(2)) },
      squashed: { blame: r.squashed.blameTimes.map((x) => +x.toFixed(2)), line: r.squashed.lineTimes.map((x) => +x.toFixed(2)) },
    })),
  };
  summary.blameSpeedup = +(summary.blameFileMs.linear.median / summary.blameFileMs.squashed.median).toFixed(2);
  summary.diffRatio = +(summary.diffLinesPerCommit.medianSquashed / summary.diffLinesPerCommit.medianLinear).toFixed(2);
  return summary;
}

const main = () => {
  for (const stale of ["linear", "squashed", "linear.fi", "squashed.fi"]) rmSync(join(WORK, stale), { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const modes = (process.env.MODES ?? "block,mixed").split(",");
  const out = { generatedAt: new Date().toISOString(), modes: {} };
  for (const m of modes) out.modes[m] = runMode(m);
  writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(out, null, 2) + "\n");
  for (const [m, s] of Object.entries(out.modes)) {
    console.log(
      `${m}: trees=${s.treesEqual} commits ${s.commits.linear}→${s.commits.squashed} ` +
        `path ${s.commitsTouchingSample.linear}→${s.commitsTouchingSample.squashed} ` +
        `blame ${s.blameFileMs.linear.median}→${s.blameFileMs.squashed.median} ms (${s.blameSpeedup}×) ` +
        `line ${s.blameLineMs.linear.median}→${s.blameLineMs.squashed.median} ms ` +
        `diff ${s.diffLinesPerCommit.medianLinear}→${s.diffLinesPerCommit.medianSquashed} (${s.diffRatio}×) ` +
        `hidden ${s.attribution.hidden}/${s.attribution.touched} (k=${s.attribution.meanChangesHidden}) ` +
        `size ${s.gitSizeKb.linear}→${s.gitSizeKb.squashed} KB`,
    );
  }
};

main();
