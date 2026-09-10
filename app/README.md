# app — Neutralino shell

Only the shell lives here: `neutralino.config.json`, the downloaded binaries in `bin/` and client library in `client/`
(both from `npm run neu:update`), `resources/`, which is the **build output of `../frontend`** (Vite writes there), and
`extensions/backend/`, where `npm run build -w backend` puts the bundled backend (`main.js`; `run.sh` is committed).
Nothing in `resources/` or `extensions/backend/main.js` is edited by hand.

- The client library is loaded as a classic `<script src="./js/neutralino.js">` (the Vite build copies it from `client/`).
  Do not switch to the ESM npm package `@neutralinojs/lib` for runtime: bundled through Vite its `init()` fails inside
  the shell (NL_* globals are not visible to it). The package stays as a devDependency for types only.

- `exitProcessOnClose` is off on purpose: the frontend hides the window first and then calls `app.exit()`,
  otherwise WebView2 teardown keeps the window on screen for ~300 ms.
- Window size is in physical pixels; the frontend rescales it by `devicePixelRatio` on start.

## Backend as an extension

`enableExtensions` + `extensions[]` start the Node backend with the shell: `node "${NL_PATH}/extensions/backend/main.js"`
on Windows, `/bin/sh "${NL_PATH}/extensions/backend/run.sh"` on macOS/Linux (GUI apps start with a minimal PATH, the
script looks for node in Homebrew/nvm/fnm/volta locations). `neu build` copies `extensions/` into `dist/` (`.map` files
are excluded by `cli.extensionsExclude`).

- The shell writes the handshake JSON to the extension's stdin **without a trailing newline**.
- The backend writes `data/session.json` (port + token) next to the app; the frontend polls it through the Neutralino
  filesystem API. The shell swallows the extension's stdout, so the backend logs to `data/logs/backend.log`.
- Shutdown: the frontend calls `/shutdown` on `windowClose` and passes the shell pid (`NL_PID`) when it connects to
  the events socket; the backend polls that pid every 250 ms and exits as soon as the shell is gone (measured: ~220 ms
  after a force kill). The 15 s no-client timeout applies only when the pid is unknown (page opened in a browser).
- Dev mode (`npm run dev`) runs the shell with `--enable-extensions=false` and the backend under `tsx watch` instead,
  with `--data-dir ../app/data` so both modes share the same `data/`.

`npm run dist` at the repo root builds everything and runs `neu build` → `app/dist/epic-git/`.
