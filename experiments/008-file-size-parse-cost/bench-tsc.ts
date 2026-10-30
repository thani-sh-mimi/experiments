// 008 (second angle): the type checker's view. tsc 7 parses the same bytes cut
// five ways; --diagnostics separates parse from check. Merges into results.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "tmp", "008");
const TSC = join(import.meta.dir, "..", "..", "node_modules", ".bin", "tsc");
const VARIANTS = [10, 40, 99, 334, 834]; // file counts, dirs are named by chunk lines
const DIRS = ["chunk-2000", "chunk-500", "chunk-200", "chunk-50", "chunk-20"];
const RUNS = 3;

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function parseDiag(out: string) {
  const num = (label: string) => {
    const m = out.match(new RegExp(`${label}:\\s+([0-9.]+)s`));
    return m ? +m[1] : null;
  };
  return {
    parse: num("Parse time"),
    bind: num("Bind time"),
    check: num("Check time"),
    total: num("Total time"),
    lines: out.match(/Lines:\s+(\d+)/) ? +out.match(/Lines:\s+(\d+)/)![1] : null,
  };
}

const rows: any[] = [];
for (let r = 0; r < RUNS; r++) {
  for (let i = 0; i < DIRS.length; i++) {
    const s = Bun.nanoseconds();
    const p = Bun.spawnSync([TSC, "-p", join(ROOT, DIRS[i], "tsconfig.json"), "--diagnostics"], { stdout: "pipe", stderr: "pipe" });
    const wall = +((Bun.nanoseconds() - s) / 1e6).toFixed(1);
    const out = p.stdout.toString() + p.stderr.toString();
    const d = parseDiag(out);
    const errors = (out.match(/error TS/g) ?? []).length;
    rows.push({ files: VARIANTS[i], run: r, wallMs: wall, ...d, errors });
  }
}

const summary: any = {};
for (const n of VARIANTS) {
  const rs = rows.filter((r) => r.files === n && r.errors === 0);
  summary[n] = {
    files: n,
    parseMs: +(med(rs.map((r) => r.parse)) * 1000).toFixed(0),
    checkMs: +(med(rs.map((r) => r.check)) * 1000).toFixed(0),
    totalMs: +(med(rs.map((r) => r.total)) * 1000).toFixed(0),
    wallMs: med(rs.map((r) => r.wallMs)),
    errors: rows.filter((r) => r.files === n).map((r) => r.errors),
  };
}

const path = join(import.meta.dir, "results.json");
const out = JSON.parse(readFileSync(path, "utf8"));
out.tsc = { version: Bun.spawnSync([TSC, "--version"]).stdout.toString().trim(), runs: rows, summary };
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 1));
