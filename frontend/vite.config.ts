import { defineConfig, type Plugin } from "vite";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// The Neutralino client library is downloaded by `neu update` into app/client/ (see cli.clientLibrary in
// app/neutralino.config.json) and loaded by index.html as a classic script, exactly like the prototype did.
// Vite wipes app/resources on every build, so we copy the library in after each build (also in --watch mode).
const APP = resolve(__dirname, "../app");
function copyNeutralinoClient(): Plugin {
  return {
    name: "copy-neutralino-client",
    closeBundle() {
      const src = resolve(APP, "client/neutralino.js");
      if (!existsSync(src)) {
        this.warn("app/client/neutralino.js is missing: run `npm run neu:update`");
        return;
      }
      mkdirSync(resolve(APP, "resources/js"), { recursive: true });
      copyFileSync(src, resolve(APP, "resources/js/neutralino.js"));
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [copyNeutralinoClient()],
  build: {
    outDir: "../app/resources",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: { port: 5173, strictPort: true },
});
