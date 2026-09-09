# app — Neutralino shell

Only the shell lives here: `neutralino.config.json`, the downloaded binaries in `bin/` and client library in `client/`
(both from `npm run neu:update`), and `resources/`, which is the **build output of `../frontend`** (Vite writes there).
Nothing in `resources/` is edited by hand.

- The client library is loaded as a classic `<script src="./js/neutralino.js">` (the Vite build copies it from `client/`).
  Do not switch to the ESM npm package `@neutralinojs/lib` for runtime: bundled through Vite its `init()` fails inside
  the shell (NL_* globals are not visible to it). The package stays as a devDependency for types only.

- `exitProcessOnClose` is off on purpose: the frontend hides the window first and then calls `app.exit()`,
  otherwise WebView2 teardown keeps the window on screen for ~300 ms.
- Window size is in physical pixels; the frontend rescales it by `devicePixelRatio` on start.
- The Node backend will be attached as a Neutralino extension (`enableExtensions` + `extensions[]`) in stage 1;
  until then it is a separate process started by `npm run dev`.

`npm run dist` at the repo root builds everything and runs `neu build` → `app/dist/epic-git/`.
