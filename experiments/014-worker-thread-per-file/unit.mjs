// One synthetic test file, run once in a fresh isolate (fork or worker).
// Marks the isolate so a reused worker shows the mark on the next file.
import assert from "node:assert/strict";

globalThis.__seen = (globalThis.__seen ?? 0) + 1;

const work = Number(process.env.UNIT_WORK ?? 0);
if (work > 0) {
  const end = performance.now() + work;
  while (performance.now() < end) {
    // burn the slice
  }
}

assert.equal(1 + 1, 2);
