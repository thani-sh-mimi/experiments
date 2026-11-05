// Times N synthetic test files under one isolation model. Prints one JSON line.
//   node driver.mjs --mode fork|thread|pool --files 32 --work 0 [--workers 2]
// fork   : child_process.fork per file, fresh process, fresh module graph
// thread : new Worker per file, fresh isolate, fresh module graph
// pool   : --workers long-lived workers, each imports files one by one
import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const unit = join(here, "unit.mjs");
const poolWorker = join(here, "pool-worker.mjs");

const opt = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2)
  opt[argv[i].replace(/^--/, "")] = argv[i + 1];

const mode = opt.mode;
const files = Number(opt.files ?? 1);
const work = Number(opt.work ?? 0);
const workers = Number(opt.workers ?? 2);
const env = { ...process.env, UNIT_WORK: String(work) };

function runFork() {
  return new Promise((resolve, reject) => {
    const child = fork(unit, [], { env, stdio: "ignore" });
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`fork exit ${code}`)),
    );
  });
}

function runThread() {
  return new Promise((resolve, reject) => {
    const w = new Worker(unit, { env, stdout: true, stderr: true });
    w.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
    );
    w.once("error", reject);
  });
}

function runPool(dir) {
  return new Promise((resolve, reject) => {
    const queue = Array.from({ length: files }, (_, i) =>
      join(dir, `f${i}.mjs`),
    );
    let done = 0;
    let maxSeen = 0;
    const pool = Array.from({ length: workers }, () => new Worker(poolWorker));
    let ready = 0;

    const feed = (w) => {
      const file = queue.shift();
      if (!file) return;
      w.postMessage({ file });
    };

    for (const w of pool) {
      w.on("message", (msg) => {
        if (msg.ready) {
          ready++;
          if (ready === workers) pool.forEach(feed);
          return;
        }
        if (!msg.ok) return reject(new Error(msg.error));
        maxSeen = Math.max(maxSeen, msg.seen);
        done++;
        if (done === files) {
          Promise.all(pool.map((p) => p.terminate())).then(() =>
            resolve({ maxSeen }),
          );
        } else feed(w);
      });
      w.once("error", reject);
    }
  });
}

const t0 = performance.now();
let extra = {};
if (mode === "fork" || mode === "thread") {
  for (let i = 0; i < files; i++) {
    if (mode === "fork") await runFork();
    else await runThread();
  }
} else if (mode === "pool") {
  extra = await runPool(opt.dir);
} else {
  throw new Error(`bad mode ${mode}`);
}
const ms = performance.now() - t0;
console.log(JSON.stringify({ mode, files, work, workers, ms, ...extra }));
