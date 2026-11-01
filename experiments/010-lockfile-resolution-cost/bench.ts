// 010 — how much of `bun install` is resolution?
// Six install modes at three dependency counts and two registry round-trip
// latencies, against a local registry, counting the HTTP requests each makes.
//
// usage: bun bench.ts
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";

const PORT = 4873;
const WORK_BASE = "/tmp/010-lockfile";
const SIZES = [50, 200, 600];
const RTTS = [0, 20];
const RUNS = 3;
// one shape per invocation so each gets its own cache dir and work tree
const SHAPE = process.argv[2] ?? "chain";
const WORK = `${WORK_BASE}-${SHAPE}`;
const CACHE = join(WORK, "bun-cache");
const HERE = import.meta.dir;

type Mode =
  | "empty"
  | "noop"
  | "frozen"
  | "nolock-warm"
  | "nolock-cold"
  | "nolock-offline";
const MODES: Mode[] = [
  "empty",
  "noop",
  "frozen",
  "nolock-warm",
  "nolock-cold",
  "nolock-offline",
];

type Sample = {
  ms: number;
  metadata: number;
  tarball: number;
  ok: boolean;
  stderr: string;
};

const rmrf = (p: string) => rmSync(p, { recursive: true, force: true });

function rootPackageJson(n: number) {
  if (n === 0) return JSON.stringify({ name: "root" }, null, 2);
  const deps: Record<string, string> = {};
  // chain: the tail of the chain pulls everything. wide: a halving tree is not
  // reached from 20 tail entries, so depend on all of them.
  const from = SHAPE === "wide" ? 0 : Math.max(0, n - 20);
  for (let i = from; i < n; i++) deps[`pkg-${i}`] = "^1.0.0";
  return JSON.stringify({ name: "root", dependencies: deps }, null, 2);
}

const bunfig = () =>
  `[install]\nregistry = "http://127.0.0.1:${PORT}/"\ncache = "${CACHE}"\n`;

async function startRegistry(n: number, rtt: number) {
  rmrf(join(WORK, "registry"));
  mkdirSync(join(WORK, "registry"), { recursive: true });
  const proc = Bun.spawn(
    [
      "bun",
      join(HERE, "registry.ts"),
      String(Math.max(n, 1)),
      String(PORT),
      join(WORK, "registry"),
      String(rtt),
      SHAPE,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = proc.stdout.getReader();
  let buf = "";
  while (!buf.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("registry died before ready");
    buf += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return proc;
}

const LOG = join(WORK, "registry", "requests.log");

function countLog() {
  const lines = readFileSync(LOG, "utf8").split("\n").filter(Boolean);
  return {
    metadata: lines.filter((l) => l.startsWith("metadata")).length,
    tarball: lines.filter((l) => l.startsWith("tarball")).length,
  };
}

function project(
  name: string,
  n: number,
  withLock: string | null,
  withModules: string | null,
) {
  const dir = join(WORK, "proj", name);
  rmrf(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), rootPackageJson(n));
  writeFileSync(join(dir, "bunfig.toml"), bunfig());
  if (withLock) cpSync(withLock, join(dir, "bun.lock"));
  if (withModules)
    cpSync(withModules, join(dir, "node_modules"), { recursive: true });
  return dir;
}

function timedInstall(dir: string, args: string[]): Sample {
  writeFileSync(LOG, "");
  const t0 = performance.now();
  const p = Bun.spawnSync(["bun", "install", "--no-progress", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const ms = performance.now() - t0;
  const c = countLog();
  return {
    ms: Number(ms.toFixed(1)),
    metadata: c.metadata,
    tarball: c.tarball,
    ok: p.exitCode === 0,
    stderr: p.exitCode === 0 ? "" : p.stderr.toString().slice(0, 300),
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const results: any = {
  shape: SHAPE,
  runs: RUNS,
  sizes: SIZES,
  rtts: RTTS,
  measurements: {},
  raw: {},
  notes: {},
};

rmrf(WORK);
mkdirSync(CACHE, { recursive: true });

for (const rtt of RTTS) {
  for (const n of SIZES) {
    console.log(`\n=== ${SHAPE}, ${n} packages, ${rtt} ms registry delay ===`);
    const reg = await startRegistry(n, rtt);

    // reference: one clean resolve, populating the shared cache
    const ref = project("ref", n, null, null);
    writeFileSync(LOG, "");
    const first = Bun.spawnSync(["bun", "install", "--no-progress"], {
      cwd: ref,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (first.exitCode !== 0)
      throw new Error(`reference install failed: ${first.stderr.toString()}`);
    const lockPath = join(ref, "bun.lock");
    const modulesPath = join(ref, "node_modules");
    const lockPkgs = (
      readFileSync(lockPath, "utf8").match(/^ {4}"pkg-\d+":/gm) ?? []
    ).length;
    const refRequests = countLog();
    results.notes[`${rtt}ms/${n}`] = {
      lockfilePackages: lockPkgs,
      reference: refRequests,
    };
    console.log(
      `reference resolve: ${lockPkgs} packages, meta=${refRequests.metadata} tgz=${refRequests.tarball}`,
    );

    results.raw[`${rtt}ms`] ??= {};
    results.measurements[`${rtt}ms`] ??= {};

    for (const mode of MODES) {
      const samples: Sample[] = [];
      for (let r = 0; r < RUNS; r++) {
        let dir: string;
        let args: string[];
        switch (mode) {
          case "empty":
            dir = project(`${mode}-${r}`, 0, null, null);
            args = [];
            break;
          case "noop":
            dir = project(`${mode}-${r}`, n, lockPath, modulesPath);
            args = ["--frozen-lockfile"];
            break;
          case "frozen":
            dir = project(`${mode}-${r}`, n, lockPath, null);
            args = ["--frozen-lockfile"];
            break;
          case "nolock-warm":
            dir = project(`${mode}-${r}`, n, null, null);
            args = [];
            break;
          case "nolock-cold":
            dir = project(`${mode}-${r}`, n, null, null);
            args = ["--no-cache"];
            break;
          case "nolock-offline":
            dir = project(`${mode}-${r}`, n, null, null);
            args = ["--offline"];
            break;
        }
        const s = timedInstall(dir, args);
        samples.push(s);
        console.log(
          `  ${mode.padEnd(15)} run${r + 1} ${String(s.ms).padStart(8)} ms  meta=${String(s.metadata).padStart(4)} tgz=${String(s.tarball).padStart(4)}${s.ok ? "" : "  FAILED"}`,
        );
        if (!s.ok) console.log(`    ${s.stderr.replace(/\n/g, " ")}`);
      }
      const ms = samples.map((s) => s.ms);
      results.raw[`${rtt}ms`][`${n}/${mode}`] = samples;
      results.measurements[`${rtt}ms`][`${n}/${mode}`] = {
        medianMs: median(ms),
        minMs: Math.min(...ms),
        maxMs: Math.max(...ms),
        spreadPct: Number(
          (((Math.max(...ms) - Math.min(...ms)) / median(ms)) * 100).toFixed(1),
        ),
        metadataRequests: median(samples.map((s) => s.metadata)),
        tarballRequests: median(samples.map((s) => s.tarball)),
        ok: samples.every((s) => s.ok),
      };
    }

    reg.kill();
    await reg.exited;
  }
}

writeFileSync(
  join(HERE, `results-${SHAPE}.json`),
  JSON.stringify(results, null, 2) + "\n",
);

for (const rtt of RTTS) {
  console.log(
    `\n--- ${rtt} ms registry delay: median ms (metadata requests) ---`,
  );
  const head = [
    "mode".padEnd(16),
    ...SIZES.map((n) => `${n} pkgs`.padStart(22)),
  ].join("");
  console.log(head);
  for (const mode of MODES) {
    const cells = SIZES.map((n) => {
      const m = results.measurements[`${rtt}ms`][`${n}/${mode}`];
      return `${String(m.medianMs).padStart(9)} ms (${String(m.metadataRequests).padStart(3)})`.padEnd(
        22,
      );
    });
    console.log(mode.padEnd(16) + cells.join(""));
  }
}
console.log(`\nwrote results-${SHAPE}.json`);
