# 006: what a re-export barrel costs a build

## Problem

A barrel — an `index.ts` that re-exports a directory — is taught as API hygiene, and the evidence against it is published at enterprise scale only: Atlassian reports 75% fewer build minutes after removing barrels across Jira's frontend ([Atlassian](https://www.atlassian.com/blog/how-we-build/faster-builds-when-removing-barrel-files)), and a smaller benchmark measured a 29% faster cold build and 35% faster test module collection ([Joe Brown](https://joebrown.io/notes/typescript-barrel-files-performance)). Both describe the mechanism — the consumer asks for one export, the tool resolves every re-export and parses the modules behind it — and neither gives a number small enough to decide a rule with: what does one barrel line cost, in the bundler we actually use?

## Hypothesis

In Bun's bundler, importing one of 1,000 modules through a barrel will cost at least 10 ms more than importing it directly — roughly 0.01 ms per re-export. If that holds, a repository with 50 reachable barrels of 1,000 modules pays half a second per clean build and a direct-import rule earns its keep; if the real figure is under 1 ms, the convenience is free and the rule is noise.

## Method

One `Bun.build` per measurement, no minify, `target: bun`, generated TypeScript in `tmp/`. Each module is six lines exporting a function and a constant. Every variant imports exactly one of those functions and nothing else, so the bundle is the same size in all three:

- **direct** — `entry.ts` imports `./mods/m0`.
- **barrel** — `entry.ts` imports `./mods`, a flat `index.ts` with N `export *` lines.
- **nested** — 10 folders of N/10 modules, a folder `index.ts` each, a root `index.ts` re-exporting the 10 folders.

N of 100, 500, 1,000 and 2,000; three runs per cell, interleaved so warmth is shared; one warmup build discarded. Noise floor: five identical builds of the 1,000-module barrel. Also timed: two entrypoints importing through the same barrel, to see whether the cost is per build or per import. Host: 6 vCPU sandbox, Bun 1.4.4, `bench.ts`.

## Results

Medians of three runs, spread in brackets; milliseconds.

| Modules | direct | barrel | nested | barrel − direct |
|---:|---:|---:|---:|---:|
| 100 | 1.48 (1.42–1.67) | 3.21 (3.19–3.43) | 3.33 (3.26–3.84) | +1.73 |
| 500 | 1.30 (1.25–1.49) | 12.85 (12.55–16.40) | 10.97 (10.68–13.71) | +11.55 |
| 1,000 | 1.73 (1.69–1.83) | 27.58 (26.52–32.33) | 20.77 (20.64–24.34) | **+25.85** |
| 2,000 | 2.51 (2.50–2.76) | 66.78 (65.44–75.79) | 42.38 (41.41–50.24) | +64.27 |

- Cost per re-export rises with the barrel's width: 0.017, 0.023, 0.026, 0.032 ms at 100 → 2,000. It is ~0.03 ms per line, not a constant.
- Noise floor: 0.43 ms spread on a 27 ms build (1.6%). The 26 ms overhead at 1,000 is 60× that spread, and three separate harness runs gave 28.13, 27.74 and 27.58 ms for the same cell.
- Output bytes are identical across variants (160–169 bytes). Tree-shaking does its job: the whole cost is graph work whose result is then thrown away. Nobody ships a bigger bundle; everybody waits longer.
- Two entrypoints sharing one 1,000-module barrel took 27.30–27.74 ms against 27.10–27.62 ms for one. The second import is free: the cost is per distinct barrel in a build, not per import site.

## Verdict: VALIDATED

26 ms at 1,000 modules against a predicted 10 ms, and the predicted mechanism: the barrel drags the whole graph in, one line at a time.

### What worked

- The unit is reusable: ~0.03 ms per `export *` line, so a 200-line barrel costs ~6 ms and a 1,000-line one 26 ms — enough to size a codebase from its barrel count.
- Holding the output constant was the right control. Identical bytes prove the number is resolution and parse work, not bundling more code.
- Adding the two-entrypoint case killed a tempting overstatement: the cost does not multiply per importer, because Bun caches the module graph within a build.

### What didn't

- The hypothesis assumed a constant cost per re-export; it is not constant, it grows with the barrel's own size. The linear model under-predicts wide barrels and over-predicts narrow ones.
- These modules are leaves. A real module imports two or three others, so the graph behind each re-export would be several times larger. 26 ms is a floor for a 1,000-re-export barrel, not an estimate of a real one.
- One bundler, one version, one function per module. No dev server, no HMR, no minify — each of which is a different code path, and Vite or webpack may price this very differently.

### Surprises

- Nesting made barrels *cheaper*: at 2,000 modules, two levels cost 42 ms and one flat file 67 ms. Both sources describe cascading barrels as compounding the problem, but in Bun the cost tracks the width of a single file, not the depth of the chain — 11 files of ~180 lines beat one file of 2,000. Depth is not the thing to ban.
- The penalty is paid by the build, not by the importer — an app with one hot barrel pays once however many files import it.

### Recommendation for the real build

- Import from the file when the file is in our repository. The tidier import is not free, and the price is paid by every clean build, forever.
- If a barrel is a real API boundary, keep it under a few hundred lines. Past ~500 re-exports it costs 10 ms or more per build, and splitting it into nested barrels is measurably better than growing it.
- Do not chase depth. Banning `export *` chains while allowing one 1,000-line `index.ts` leaves the expensive half in place.
