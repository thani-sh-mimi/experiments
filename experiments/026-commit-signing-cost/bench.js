// What does commit signing cost one commit, and one rewrite of 50?
// Run: bun bench.js
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/signbench";
const GNUPGHOME = join(ROOT, "gnupg");
const SSHKEY = join(ROOT, "sshkey");
const RUNS = 3;
const SIZES = [
  { name: "empty", files: 0 },
  { name: "1f", files: 1 },
  { name: "200f", files: 200 },
  { name: "1000f", files: 1000 },
];
const FILE_BYTES = 8192; // 8 KiB per file -> 1000 files = 8 MB

function run(cmd, cwd, env = {}) {
  const p = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, GNUPGHOME, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(cmd.join(" ") + "\n" + p.stderr.toString());
  return p.stdout.toString();
}
const time = (cmd, cwd, env = {}) => {
  const t = performance.now();
  run(cmd, cwd, env);
  return performance.now() - t;
};
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- keys ----------
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(GNUPGHOME, { recursive: true, mode: 0o700 });
run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "bench", "-f", SSHKEY], ROOT);
const SSH_PUB = readFileSync(SSHKEY + ".pub", "utf8").trim();
run(["gpg", "--batch", "--passphrase", "", "--quick-gen-key", "Bench <bench@example.com>", "ed25519", "sign", "never"], ROOT);
const FPR = run(["gpg", "--list-secret-keys", "--with-colons"], ROOT)
  .split("\n").find((l) => l.startsWith("fpr:")).split(":")[9];
const ALLOWED = `bench@example.com ${SSH_PUB.split(" ").slice(0, 2).join(" ")}\n`;

function newRepo(dir, mode) {
  mkdirSync(dir, { recursive: true });
  run(["git", "init", "-q", "-b", "main", "."], dir);
  run(["git", "config", "user.name", "Bench"], dir);
  run(["git", "config", "user.email", "bench@example.com"], dir);
  run(["git", "config", "commit.gpgsign", mode === "unsigned" ? "false" : "true"], dir);
  if (mode === "ssh") {
    run(["git", "config", "gpg.format", "ssh"], dir);
    run(["git", "config", "user.signingkey", SSHKEY], dir);
    run(["git", "config", "gpg.ssh.allowedSignersFile", join(dir, "allowed_signers")], dir);
    writeFileSync(join(dir, "allowed_signers"), ALLOWED);
  } else if (mode === "gpg") {
    run(["git", "config", "user.signingkey", FPR], dir);
  }
  return dir;
}

function ownAgentRunning() {
  const p = Bun.spawnSync(["pgrep", "-af", "gpg-agent"], { env: { ...process.env, GNUPGHOME }, stdout: "pipe" });
  return p.stdout.toString().split("\n").some((l) => l.includes(`--homedir ${GNUPGHOME}`));
}
function killAgent(dir) {
  run(["gpgconf", "--kill", "gpg-agent"], dir);
  const end = performance.now() + 2000;
  while (performance.now() < end && ownAgentRunning()) Bun.sleepSync(5);
  return !ownAgentRunning();
}

const results = { runs: RUNS, fileBytes: FILE_BYTES, host: "6 vCPU container", cases: {}, noise: {}, verify: {}, rebase: {} };

// noise floor: bare git spawn
{
  const dir = join(ROOT, "noise");
  mkdirSync(dir, { recursive: true });
  run(["git", "init", "-q", "."], dir);
  const xs = [];
  for (let r = 0; r < 9; r++) xs.push(time(["git", "--version"], dir));
  results.noise = { gitVersionMs: xs, medianMs: median(xs) };
  console.log(`noise: git --version ${median(xs).toFixed(1)} ms`);
}

// ---------- commit cost ----------
for (const mode of ["unsigned", "ssh", "gpg-warm", "gpg-cold"]) {
  for (const size of SIZES) {
    const dir = newRepo(join(ROOT, `repo-${mode}-${size.name}`), mode.startsWith("gpg") ? "gpg" : mode);
    const times = [];
    for (let round = 0; round < RUNS; round++) {
      if (size.files > 0) {
        for (let i = 0; i < size.files; i++) writeFileSync(join(dir, `f${i}.txt`), "x".repeat(FILE_BYTES) + `${i}-r${round}`);
        run(["git", "add", "-A"], dir);
      }
      run(["sync"], dir); // flush dirty pages so writeback does not land inside the timed commit
      let agentDead = null;
      if (mode === "gpg-cold") { agentDead = killAgent(dir); Bun.sleepSync(20); }
      const cmd = size.files === 0
        ? ["git", "commit", "-q", "--allow-empty", "-m", `c${round}`]
        : ["git", "commit", "-q", "-m", `c${round}`];
      times.push(time(cmd, dir));
      if (mode === "gpg-cold") results.cases[`${mode}/${size.name}`] ??= { agentDeadEachRun: [] },
        results.cases[`${mode}/${size.name}`].agentDeadEachRun.push(agentDead);
    }
    results.cases[`${mode}/${size.name}`] = {
      ...(results.cases[`${mode}/${size.name}`] ?? {}),
      mode, size: size.name, files: size.files, ms: times, medianMs: median(times),
    };
    console.log(`${mode.padEnd(9)} ${size.name.padEnd(6)} median ${median(times).toFixed(1)} ms  [${times.map((t) => t.toFixed(1)).join(", ")}]`);
  }
}

// ---------- verification cost ----------
{
  const dir = newRepo(join(ROOT, "repo-verify"), "ssh");
  const N = 100;
  for (let i = 0; i < N; i++) {
    writeFileSync(join(dir, "a.txt"), `v${i}`);
    run(["git", "add", "-A"], dir);
    run(["git", "commit", "-q", "-m", `c${i}`], dir);
  }
  const plain = [], status = [], sig20 = [];
  for (let r = 0; r < RUNS; r++) {
    plain.push(time(["git", "log", "--format=%h"], dir));
    status.push(time(["git", "log", "--format=%h %G?"], dir));
    sig20.push(time(["git", "log", "--show-signature", "--format=%h", "-n", "20"], dir));
  }
  const verified = run(["git", "log", "--format=%G?"], dir).trim().split("\n");
  results.verify = {
    commits: N,
    plainLogMs: median(plain), logWithStatusMs: median(status),
    showSignature20Ms: median(sig20), showSignaturePerCommitMs: median(sig20) / 20,
    statusVerifiedAll: verified.every((v) => v === "G"), statusSample: verified.slice(0, 3),
    raw: { plain, status, sig20 },
  };
  console.log(`verify ${N} signed commits: plain ${median(plain).toFixed(1)} ms, %G? ${median(status).toFixed(1)} ms, show-signature/20 ${median(sig20).toFixed(1)} ms (${(median(sig20) / 20).toFixed(2)} ms/commit), all G=${results.verify.statusVerifiedAll}`);
}

// ---------- rewrite cost: rebase 50 commits ----------
for (const mode of ["unsigned", "ssh", "gpg-warm"]) {
  const times = [];
  for (let round = 0; round < RUNS; round++) {
    const dir = newRepo(join(ROOT, `rebase-${mode}-${round}`), mode.startsWith("gpg") ? "gpg" : mode);
    for (let i = 0; i < 50; i++) run(["git", "commit", "-q", "--allow-empty", "-m", `c${i}`], dir);
    times.push(time(["git", "rebase", "-q", "--root", "--force-rebase", "-x", "true"], dir));
  }
  const sample = newRepo(join(ROOT, `rebase-check-${mode}`), mode.startsWith("gpg") ? "gpg" : mode);
  for (let i = 0; i < 5; i++) run(["git", "commit", "-q", "--allow-empty", "-m", `c${i}`], sample);
  run(["git", "rebase", "-q", "--root", "--force-rebase", "-x", "true"], sample);
  const marks = run(["git", "log", "--format=%G?"], sample).trim().split("\n");
  results.rebase[mode] = { commits: 50, ms: times, medianMs: median(times), perCommitMs: median(times) / 50, signatureStatus: [...new Set(marks)].join(",") };
  console.log(`rebase 50 ${mode.padEnd(9)} median ${median(times).toFixed(1)} ms (${(median(times) / 50).toFixed(2)} ms/commit) status=${results.rebase[mode].signatureStatus}`);
}

writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(results, null, 2));
console.log("\nwrote results.json");
