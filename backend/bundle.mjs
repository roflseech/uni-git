// Bundles the backend into one file that the Neutralino shell starts with plain `node`:
// app/extensions/backend/main.js (copied into dist by `neu build`, see cli.extensionsPath).
//   node bundle.mjs [--out <file>]
// The version comes from UNI_GIT_VERSION (release builds, see tools/release/build.mjs); without it the build is
// "<root package version>-dev" and does not self-update.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? resolve(process.argv[outArg + 1]) : resolve(here, "../app/extensions/backend/main.js");
const rootVersion = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")).version;
const version = process.env.UNI_GIT_VERSION || `${rootVersion}-dev`;
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
  define: { __UNI_GIT_VERSION__: JSON.stringify(version) },
  banner: {
    // esbuild's ESM output of CommonJS deps (ws) needs `require`; provide it.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
console.log(`backend ${version} -> ${out}`);
