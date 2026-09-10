// Bundles the backend into one file that the Neutralino shell starts with plain `node`:
// app/extensions/backend/main.js (copied into dist by `neu build`, see cli.extensionsPath).
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../app/extensions/backend/main.js");
mkdirSync(dirname(out), { recursive: true });
// The bundle is ESM; tell Node so without a warning (the file is loaded by plain `node main.js`).
writeFileSync(resolve(dirname(out), "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");

await build({
  entryPoints: [resolve(here, "src/main.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "none",
  banner: {
    // esbuild's ESM output of CommonJS deps (ws) needs `require`; provide it.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
