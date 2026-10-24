// Probe: where the JSON cache's cold-read milliseconds actually go.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SIZES = [1_000, 10_000, 100_000];
const LOOKUPS = 1_000;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (x: number) => Math.round(x * 1000) / 1000;
const out: any = {};

for (const n of SIZES) {
  const path = join(import.meta.dir, "tmp", `json-${n}`, "cache.json");
  const text = readFileSync(path, "utf8");
  const obj = JSON.parse(text) as Record<string, unknown>;
  const ks = Object.keys(obj).slice(0, LOOKUPS);
  const read: number[] = [], parse: number[] = [], look: number[] = [];
  for (let t = 0; t < 5; t++) {
    let a = performance.now(); readFileSync(path, "utf8"); read.push(performance.now() - a);
    a = performance.now(); JSON.parse(text); parse.push(performance.now() - a);
    a = performance.now(); for (const k of ks) obj[k]; look.push(performance.now() - a);
  }
  out[n] = { read: ms(median(read)), parse: ms(median(parse)), lookups: ms(median(look)) };
  console.log(n, JSON.stringify(out[n]));
}
await Bun.write(join(import.meta.dir, "probe.json"), JSON.stringify(out, null, 2));
