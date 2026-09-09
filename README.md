# epic-git

Fast-starting cross-platform Git client (Windows + macOS). Neutralino shell + Node/TypeScript backend + TypeScript frontend.

**Read first:** [plan_work.md](plan_work.md) — decisions, architecture, UI spec, feature list and stage plan.
**UI mockups:** `docs/wireframes/` — open `docs/wireframes/index.html` in a browser; one file per window/state, shared `wire.css`.

## Layout

```
app/        Neutralino shell: neutralino.config.json, bin/ (downloaded), resources/ (built frontend)
frontend/   Vite + TypeScript UI, builds into app/resources
backend/    Node + TypeScript service process (git CLI, job queue, askpass, Unity YAML) — skeleton for now
shared/     Types and constants used by both sides
docs/       plan companions: wireframes
data/       created at runtime next to the app; settings, cache, logs (git-ignored)
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
npm run dev        # frontend build --watch + backend tsx watch + neu run (window reloads on resource changes)
npm run build      # shared, backend, frontend
npm run dist       # build everything and neu build → app/dist/epic-git/  (Windows + macOS binaries)
npm run typecheck
```

Runtime requirements: Node 20+, Git 2.40+, Git Credential Manager. Windows additionally needs the WebView2 runtime (present on Windows 10/11).

## Notes for the next agent

- Stack and product decisions are fixed in `plan_work.md`; do not re-open Rust/Electron/Python choices.
- Wireframes are the UI spec. Numbered marks inside a mockup refer to the notes under it.
- The shell already contains the two Neutralino workarounds we found (HiDPI window size, hide-then-exit on close).
