// Does the cost of a re-encoded asset follow size linearly? 50 revisions at 256 KiB, 1 MiB and 4 MiB.
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "tmp", "027-scale");
const REVS = 50;
const RUNS = 3;
const SIZES = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

function git(dir, args) {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function dirBytes(path) {
  let total = 0;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const c = join(path, e.name);
    if (e.isDirectory()) total += dirBytes(c);
    else total += Bun.file(c).size;
  }
  return total;
}

const out = { runs: RUNS, revs: REVS, cases: {} };
for (let run = 1; run <= RUNS; run++) {
  for (const size of SIZES) {
    const dir = join(ROOT, `run-${run}-${size}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "Spike"]);
    git(dir, ["config", "user.email", "spike@example.invalid"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    git(dir, ["config", "gc.auto", "0"]);
    for (let i = 0; i < REVS; i++) {
      writeFileSync(
        join(dir, "asset.bin"),
        Buffer.from(crypto.getRandomValues(new Uint8Array(size))),
      );
      git(dir, ["add", "asset.bin"]);
      git(dir, ["commit", "-q", "-m", `rev ${i}`]);
    }
    const t = Bun.nanoseconds();
    git(dir, ["gc", "-q", "--prune=now"]);
    const gcMs = (Bun.nanoseconds() - t) / 1e6;
    const pack =
      Number(/size-pack: (\d+)/.exec(git(dir, ["count-objects", "-v"]))[1]) *
      1024;
    const rec = {
      sizeBytes: size,
      packBytes: pack,
      perRevBytes: +(pack / (REVS - 1)).toFixed(0),
      gcMs: +gcMs.toFixed(0),
    };
    (out.cases[size] ??= []).push(rec);
    console.log(
      `${run} ${(size / 1024) | 0} KiB -> pack ${(pack / 1048576).toFixed(2)} MiB, ${(rec.perRevBytes / 1024).toFixed(1)} KiB/rev, ${((rec.perRevBytes / size) * 100).toFixed(1)} % of size`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
}
writeFileSync(
  join(import.meta.dir, "scale.json"),
  JSON.stringify(out, null, 2) + "\n",
);
console.log("wrote scale.json");
