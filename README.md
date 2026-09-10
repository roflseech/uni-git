# epic-git

Fast-starting cross-platform Git client (Windows + macOS). Neutralino shell + Node/TypeScript backend + TypeScript frontend.

**Read first:** [plan_work.md](plan_work.md) — decisions, architecture, UI spec, feature list, stage plan and the current state (section 9).
**UI mockups:** `docs/wireframes/` — open `docs/wireframes/index.html` in a browser; one file per window/state, shared `wire.css`.

## Layout

```
app/        Neutralino shell: neutralino.config.json, bin/ (downloaded), resources/ (built frontend), extensions/backend/ (bundled backend)
frontend/   Vite + TypeScript UI (no framework), builds into app/resources
backend/    Node + TypeScript service: local HTTP/WS API, git CLI wrapper, per-repo job queue, fs watcher; bundled by esbuild
shared/     API types used by both sides (shared/src/index.ts)
docs/       plan companions: wireframes
tools/win/  PowerShell helpers to screenshot/click the running app and to stop it (agent-driven UI checks)
data/       created at runtime next to the app: config.json, session.json, cache/, logs/ (git-ignored)
```

## First run on a clean machine

| OS | Run | What it installs if missing |
|---|---|---|
| Windows | double-click `setup.cmd` (or `powershell -ExecutionPolicy Bypass -File setup.ps1`) | Git for Windows (with Git Credential Manager), Node.js LTS, WebView2 runtime — via winget; then npm workspaces + Neutralino binaries |
| macOS | `./setup.sh` | Homebrew, Git, Node.js 22, Git Credential Manager; then npm workspaces + Neutralino binaries |

Both scripts are safe to re-run; they skip what is already present. Everything must work on both Windows and macOS: test each stage on both.

## Commands

```powershell
npm run setup      # npm install for all workspaces + download Neutralino binaries into app/bin (what the setup scripts call last)
npm run dev        # frontend build --watch + backend tsx watch + neu run (extensions off, window reloads on resource changes)
npm run build      # shared, backend (tsc + esbuild bundle → app/extensions/backend/main.js), frontend
npm run dist       # build everything and neu build → app/dist/epic-git/  (Windows + macOS binaries + extensions/)
npm run typecheck
npm test           # vitest: backend parsers, frontend formatters
npm run smoke -w backend   # drives the built backend over HTTP/WS against a temp repository (needs npm run build -w backend)
```

Runtime requirements: Node 20+, Git 2.40+, Git Credential Manager. Windows additionally needs the WebView2 runtime (present on Windows 10/11).

## How it runs

The shell starts the backend as a Neutralino extension (`node app/extensions/backend/main.js`). The backend listens on
127.0.0.1 with a random port and token, writes them to `data/session.json`, and the frontend reads that file through the
Neutralino filesystem API. The frontend talks to the backend directly over HTTP/WebSocket, so it can also be debugged in a
plain browser: open `app/resources/index.html` via any static server with `?port=…&token=…` from `session.json`.
Backend log: `data/logs/backend.log`.

## Notes for the next agent

- Stack and product decisions are fixed in `plan_work.md`; do not re-open Rust/Electron/Python choices.
- Wireframes are the UI spec. Numbered marks inside a mockup refer to the notes under it.
- The shell contains the Neutralino workarounds we found (HiDPI window size, hide-then-exit on close, extension handshake without newline); see `app/README.md`.
- To check the UI without a human on Windows: start the app, then `tools/win/shot.ps1` (screenshot + optional click/keys), `tools/win/procs.ps1`, `tools/win/kill-app.ps1`.
