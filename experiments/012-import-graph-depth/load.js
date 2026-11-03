// Times the load of a module graph, excluding interpreter start.
// usage: bun|node load.js <absolute entry path>
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
const t0 = performance.now();
const ns = await import(pathToFileURL(entry).href);
const t1 = performance.now();
console.log(JSON.stringify({ ms: t1 - t0, marker: ns.mark }));