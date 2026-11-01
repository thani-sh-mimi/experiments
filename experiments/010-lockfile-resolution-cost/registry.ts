// Local npm registry: generates N synthetic packages as tarballs, serves
// metadata + tarballs on 127.0.0.1, and logs every request so the harness can
// count how much resolution each install mode does.
//
// usage: bun registry.ts <packageCount> <port> <workDir> [delayMs]
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const N = Number(process.argv[2] ?? 50);
const PORT = Number(process.argv[3] ?? 4873);
const WORK = process.argv[4] ?? "/tmp/reg";
const DELAY = Number(process.argv[5] ?? 0);
// graph shape: "chain" gives depth ≈ N (worst case), "wide" gives depth ≈ log2 N.
const SHAPE = process.argv[6] ?? "chain";
const TARBALLS = join(WORK, "tarballs");
const LOG = join(WORK, "requests.log");

const pkgName = (i: number) => `pkg-${i}`;

// deps of pkg-i: two earlier packages, so the graph is a DAG.
// "chain" includes the i-1 edge, making resolution depth ≈ N; "wide" only
// halves, making depth ≈ log2 N.
function depsOf(i: number): Record<string, string> {
  const out: Record<string, string> = {};
  const halves = [Math.floor((i - 1) / 2), Math.floor((i - 1) / 3)];
  if (SHAPE === "chain" && i > 0) out[pkgName(i - 1)] = "^1.0.0";
  for (const h of halves) {
    if (i > 0 && h >= 0 && h < i && !out[pkgName(h)])
      out[pkgName(h)] = "^1.0.0";
  }
  return out;
}

type VersionMeta = {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  dist: { tarball: string; shasum: string; integrity: string };
};

const meta = new Map<
  string,
  {
    name: string;
    "dist-tags": { latest: string };
    versions: Record<string, VersionMeta>;
  }
>();

for (let i = 0; i < N; i++) {
  const name = pkgName(i);
  const version = "1.0.0";
  const stage = join(WORK, "stage", "package");
  rmSync(join(WORK, "stage"), { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify(
      { name, version, main: "index.js", dependencies: depsOf(i) },
      null,
      2,
    ),
  );
  writeFileSync(
    join(stage, "index.js"),
    `module.exports = ${JSON.stringify(name)};\n`,
  );
  mkdirSync(TARBALLS, { recursive: true });
  const tgz = join(TARBALLS, `${name}-${version}.tgz`);
  const t = Bun.spawnSync([
    "tar",
    "-czf",
    tgz,
    "-C",
    join(WORK, "stage"),
    "package",
  ]);
  if (t.exitCode !== 0)
    throw new Error(`tar failed for ${name}: ${t.stderr.toString()}`);
  const bytes = readFileSync(tgz);
  meta.set(name, {
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name,
        version,
        dependencies: depsOf(i),
        dist: {
          tarball: `http://127.0.0.1:${PORT}/${name}/-/${name}-${version}.tgz`,
          shasum: createHash("sha1").update(bytes).digest("hex"),
          integrity:
            "sha512-" + createHash("sha512").update(bytes).digest("base64"),
        },
      },
    },
  });
}

writeFileSync(LOG, "");
const counts = { metadata: 0, tarball: 0 };

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: async (req: Request) => {
    if (DELAY > 0) await Bun.sleep(DELAY);
    const path = decodeURIComponent(new URL(req.url).pathname);
    const tarballMatch = path.match(/^\/([^/]+)\/-\/([^/]+)\.tgz$/);
    if (tarballMatch) {
      counts.tarball++;
      appendFileSync(LOG, `tarball ${tarballMatch[2]}\n`);
      return new Response(Bun.file(join(TARBALLS, `${tarballMatch[2]}.tgz`)), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    const m = meta.get(path.replace(/^\//, ""));
    if (!m) {
      appendFileSync(LOG, `404 ${path}\n`);
      return new Response("not found", { status: 404 });
    }
    counts.metadata++;
    appendFileSync(LOG, `metadata ${m.name}\n`);
    return Response.json(m, {
      headers: { "cache-control": "public, max-age=3600" },
    });
  },
});

console.log(`ready ${N} packages on ${server.url}`);

process.on("SIGTERM", () => {
  counts.metadata = counts.metadata;
  server.stop();
  process.exit(0);
});
