// 002 — one JSON cache file vs SQLite, at the sizes a build cache actually reaches.
// Reads/writes are local; every entry is synthesised. Run: bun run bench.ts
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SIZES = [1_000, 10_000, 100_000];
const LOOKUPS = 1_000;
const TRIALS = 3;
const WARMUP = 1;
const DIR = join(import.meta.dir, "tmp");

// deterministic PRNG, so a rerun sees the same "project"
let seed = 0x9e3779b9;
function rnd() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
  return seed / 0xffffffff;
}
function hex(n: number) {
  return Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, "0").slice(0, n);
}

type Entry = {
  path: string;
  size: number;
  mtime: number;
  hash: string;
  deps: string[];
  transforms: number;
};

function entry(i: number): Entry {
  const dir = i % 97;
  return {
    path: `src/feature${dir}/module${i.toString(36).padStart(6, "0")}.ts`,
    size: 800 + ((i * 37) % 4200),
    mtime: 1_760_000_000_000 + i * 1_000,
    hash: hex(16),
    deps: [`src/lib/dep${i % 13}.ts`, `src/shared/util${i % 7}.ts`],
    transforms: i % 3,
  };
}

function keys(n: number) {
  seed = 0x12345678; // same lookup pattern for every implementation
  const out: string[] = [];
  for (let k = 0; k < LOOKUPS; k++) out.push(entry(Math.floor(rnd() * n)).path);
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ms = (x: number) => Math.round(x * 1000) / 1000;

// ---------- JSON file cache ----------
function writeJson(dir: string, n: number) {
  const obj: Record<string, Entry> = {};
  for (let i = 0; i < n; i++) { const e = entry(i); obj[e.path] = e; }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "cache.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

function jsonCold(path: string, ks: string[]) {
  const t0 = performance.now();
  const obj = JSON.parse(readFileSync(path, "utf8")) as Record<string, Entry>;
  let hits = 0;
  for (const k of ks) if (obj[k]) hits++;
  return { ms: performance.now() - t0, hits };
}

function jsonOneUpdate(path: string, key: string, val: Entry) {
  const t0 = performance.now();
  const obj = JSON.parse(readFileSync(path, "utf8")) as Record<string, Entry>;
  obj[key] = val;
  writeFileSync(path, JSON.stringify(obj));
  return performance.now() - t0;
}

function jsonBulkUpdate(path: string, ks: string[], n: number) {
  const t0 = performance.now();
  const obj = JSON.parse(readFileSync(path, "utf8")) as Record<string, Entry>;
  for (const k of ks) obj[k] = entry(Math.floor(rnd() * n));
  writeFileSync(path, JSON.stringify(obj));
  return performance.now() - t0;
}

// ---------- SQLite cache ----------
function writeSqlite(dir: string, n: number) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "cache.db");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  const db = new Database(file, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("CREATE TABLE entries (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, hash TEXT, deps TEXT, transforms INTEGER) WITHOUT ROWID");
  const ins = db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)");
  const tx = db.transaction((from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const e = entry(i);
      ins.run(e.path, e.size, e.mtime, e.hash, JSON.stringify(e.deps), e.transforms);
    }
  });
  tx(0, n);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return file;
}

function sqliteCold(file: string, ks: string[]) {
  const t0 = performance.now();
  const db = new Database(file);
  db.run("PRAGMA journal_mode = WAL");
  const q = db.prepare("SELECT path FROM entries WHERE path = ?");
  let hits = 0;
  for (const k of ks) if (q.get(k)) hits++;
  db.close();
  return { ms: performance.now() - t0, hits };
}

function sqliteOneUpdate(file: string, key: string) {
  const t0 = performance.now();
  const db = new Database(file);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.prepare("UPDATE entries SET size = size + 1 WHERE path = ?").run(key);
  db.close();
  return performance.now() - t0;
}

function sqliteBulkUpdate(file: string, ks: string[]) {
  const t0 = performance.now();
  const db = new Database(file);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  const upd = db.prepare("UPDATE entries SET size = size + 1 WHERE path = ?");
  db.transaction((list: string[]) => { for (const k of list) upd.run(k); })(ks);
  db.close();
  return performance.now() - t0;
}

// ---------- run ----------
rmSync(DIR, { recursive: true, force: true });
const raw: any = { env: { bun: Bun.version, platform: `${process.platform}-${process.arch}`, cpus: navigator.hardwareConcurrency, date: new Date().toISOString(), lookups: LOOKUPS, trials: TRIALS }, sizes: {} };

for (const n of SIZES) {
  const ks = keys(n);
  const jdir = join(DIR, `json-${n}`);
  const sdir = join(DIR, `sqlite-${n}`);
  const jpath = writeJson(jdir, n);
  const spath = writeSqlite(sdir, n);

  const rec: any = {
    bytes: { json: statSync(jpath).size, sqlite: statSync(spath).size },
    coldRead: { json: [] as number[], sqlite: [] as number[] },
    oneUpdate: { json: [] as number[], sqlite: [] as number[] },
    bulkUpdate: { json: [] as number[], sqlite: [] as number[] },
    hits: {} as any,
  };

  const bumpKey = ks[0];
  const bulkKeys = ks.slice(0, Math.floor(n / 10));

  for (let t = 0; t < WARMUP + TRIALS; t++) {
    const measured = t >= WARMUP;
    const jr = jsonCold(jpath, ks);
    const sr = sqliteCold(spath, ks);
    rec.hits.json = jr.hits; rec.hits.sqlite = sr.hits;
    const jo = jsonOneUpdate(jpath, bumpKey, entry(1));
    const so = sqliteOneUpdate(spath, bumpKey);
    const jb = jsonBulkUpdate(jpath, bulkKeys, n);
    const sb = sqliteBulkUpdate(spath, bulkKeys);
    if (measured) {
      rec.coldRead.json.push(ms(jr.ms)); rec.coldRead.sqlite.push(ms(sr.ms));
      rec.oneUpdate.json.push(ms(jo)); rec.oneUpdate.sqlite.push(ms(so));
      rec.bulkUpdate.json.push(ms(jb)); rec.bulkUpdate.sqlite.push(ms(sb));
    }
  }
  rec.median = {
    coldRead: { json: ms(median(rec.coldRead.json)), sqlite: ms(median(rec.coldRead.sqlite)) },
    oneUpdate: { json: ms(median(rec.oneUpdate.json)), sqlite: ms(median(rec.oneUpdate.sqlite)) },
    bulkUpdate: { json: ms(median(rec.bulkUpdate.json)), sqlite: ms(median(rec.bulkUpdate.sqlite)) },
  };
  raw.sizes[n] = rec;
  console.log(n, "entries", JSON.stringify(rec.median));
}

// noise floor: repeat the cheapest measurement ten times
const noise: number[] = [];
const jsmall = join(DIR, "json-1000", "cache.json");
const ksmall = keys(1_000);
for (let i = 0; i < 10; i++) noise.push(ms(jsonCold(jsmall, ksmall).ms));
raw.noiseFloor = { probe: "json cold read + 1000 lookups, 1000 entries, 10 repeats", runs: noise, min: Math.min(...noise), median: ms(median(noise)), max: Math.max(...noise), spread: ms(Math.max(...noise) - Math.min(...noise)) };
console.log("noise floor", raw.noiseFloor.min, raw.noiseFloor.median, raw.noiseFloor.max);

await Bun.write(join(import.meta.dir, "results.json"), JSON.stringify(raw, null, 2));
