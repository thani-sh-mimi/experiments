// A long-lived worker: loads one test file per message, reports how many
// files this isolate has already seen. Reuse is the point, and the leak.
import { parentPort } from "node:worker_threads";
import { pathToFileURL } from "node:url";

parentPort.on("message", async ({ file }) => {
  try {
    await import(pathToFileURL(file).href);
    parentPort.postMessage({ ok: true, seen: globalThis.__seen ?? 0 });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err) });
  }
});

parentPort.postMessage({ ok: true, ready: true, seen: 0 });
