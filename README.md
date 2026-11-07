# uni-git

An easy Git client with Unity integrations, for Windows and macOS. It starts fast, never freezes the window while git works, and keeps itself up to date.

## Install

**Windows** — in PowerShell:

```powershell
irm https://github.com/roflseech/uni-git/releases/latest/download/install.ps1 | iex
```

**macOS** — in Terminal:

```sh
curl -fsSL https://github.com/roflseech/uni-git/releases/latest/download/install.sh | sh
```

The installer adds whatever is missing (Git with Git Credential Manager, Node.js, and the WebView2 runtime on Windows), installs uni-git into your user folder without admin rights and starts it. Afterwards open it from the Start menu (Windows) or `~/Applications/uni-git.app` (macOS). Run the same line again to repair an installation; your settings stay.

**Updates are automatic.** A few seconds after start uni-git checks for a new version, installs it in the background and shows a bar with **Restart now** (the restart takes about a second) and **Later** (the update starts with the next launch). Releases are signed, and the app refuses anything that is not.

## What it does

- **Repositories in groups.** A folder group picks up every repository inside a folder (say, all projects in `D:\Work`); a manual group holds repositories from anywhere. Open a repository or a whole group in VS Code.
- **Changes.** Stage and unstage files, folders or single hunks; side-by-side or inline diff with syntax highlighting; commit, amend, commit & push.
- **History.** Commits of any branch without switching to it; filter by text, author or task; see which branches contain a commit.
- **Branches and merging in one click.** Merge main into your branch, update your branch from the latest remote main, or merge it into main and push, with an optional stash around the operation. The git commands are shown before you run them. "Is this branch merged?" and "Is this commit in that branch?" are answered in place.
- **Conflicts.** Take ours or theirs per file, then continue or abort.
- Cherry-pick (one commit or a range), stash, tags, remotes, submodules.
- **Task trackers.** Per-repository templates (Jira and ClickUp presets included) build branch names from a task code, prefix commit messages and turn task codes into links to the tracker.
- **Accounts.** Sign in through the browser with Git Credential Manager, or use personal access tokens and SSH keys. Password prompts appear in the app instead of leaving git hanging.
- **Nothing blocks.** Every git operation runs in the background, one queue per repository, so you can keep working in another repository meanwhile.

## Unity

- Built for Unity projects: the file watcher ignores `Library/`, `Temp/`, `Logs/` and `obj/`, so big projects stay responsive, and C#, shaders and Unity YAML (`.prefab`, `.unity`, `.asset`) are highlighted in diffs.
- Coming next: one-click UnityYAMLMerge setup, prefab and scene changes shown as a tree of objects and properties, and conflicts explained per property ("Player → Transform → localPosition.x: base 0, ours 1.5, theirs 2.0").

---

## Development

Neutralino shell + Node/TypeScript backend + TypeScript frontend.

**Read first:** [plan_work.md](plan_work.md) — decisions, architecture, UI spec, feature list, stage plan and the current state (section 9).
**UI mockups:** `docs/wireframes/` — open `docs/wireframes/index.html` in a browser; one file per window/state, shared `wire.css`.

### Layout

```
app/        Neutralino shell: neutralino.config.json, bin/ (downloaded), resources/ (built frontend), extensions/backend/ (bundled backend)
frontend/   Vite + TypeScript UI (no framework), builds into app/resources
backend/    Node + TypeScript service: local HTTP/WS API, git CLI wrapper, per-repo job queue, fs watcher, self-update; bundled by esbuild
shared/     API types used by both sides (shared/src/index.ts)
tools/      release/ (build, sign, test releases), win/ (screenshot/click the running app, stop it)
docs/       plan companions: wireframes
data/       created at runtime next to the app: config.json, session.json, cache/, logs/ (git-ignored)
```

### First run on a clean machine

| OS | Run | What it installs if missing |
|---|---|---|
| Windows | double-click `setup.cmd` (or `powershell -ExecutionPolicy Bypass -File setup.ps1`) | Git for Windows (with Git Credential Manager), Node.js LTS, WebView2 runtime — via winget; then npm workspaces + Neutralino binaries |
| macOS | `./setup.sh` | Homebrew, Git, Node.js 22, Git Credential Manager; then npm workspaces + Neutralino binaries |

The prerequisites are installed by `install.ps1 -DepsOnly` / `install.sh --deps-only`, the same code the end-user installers run. Both setups are safe to re-run; they skip what is already present. Everything must work on both Windows and macOS: test each stage on both.

### Commands

```powershell
npm run setup      # npm install for all workspaces + download Neutralino binaries into app/bin (what the setup scripts call last)
npm run dev        # frontend build --watch + backend tsx watch + neu run (extensions off, window reloads on resource changes)
npm run build      # shared, backend (tsc + esbuild bundle → app/extensions/backend/main.js), frontend
npm run dist       # build everything and neu build → app/dist/uni-git/  (Windows + macOS binaries + extensions/)
npm run typecheck
npm test           # vitest: backend parsers and updater, frontend formatters, shared helpers
npm run smoke -w backend   # drives the built backend over HTTP/WS against a temp repository (needs npm run build -w backend)
npm run release:test       # self-update end to end: real backend bundle, local release server, signed manifest
npm run release:build -- --version 0.1.99   # a release folder (release/) without publishing it
```

Runtime requirements: Node 20+, Git 2.40+, Git Credential Manager. Windows additionally needs the WebView2 runtime (present on Windows 10/11).

### How it runs

The shell starts the backend as a Neutralino extension (`node app/extensions/backend/main.js`). The backend listens on
127.0.0.1 with a random port and token, writes them to `data/session.json`, and the frontend reads that file through the
Neutralino filesystem API. The frontend talks to the backend directly over HTTP/WebSocket, so it can also be debugged in a
plain browser: open `app/resources/index.html` via any static server with `?port=…&token=…` from `session.json`.
Backend log: `data/logs/backend.log`.

### Releases and updates

Every push to `main` (except docs-only changes) runs `.github/workflows/release.yml`: typecheck, tests, build, smoke test,
then a GitHub release `v0.1.<run number>` (major.minor come from `package.json`). A release holds the app files, the
installers and `latest.json`, a manifest with the sha256 of every file, signed (ed25519) with the private key from the
repository secret `UNI_GIT_SIGNING_KEY`. The matching public key is `backend/src/update-key.ts`; `npm run release:keygen`
creates the pair (private half in the git-ignored `.keys/`). The workflow keeps the last 10 releases.

Installed copies run the updater in the backend (`backend/src/updater.ts`): it checks 3 s after start and every 4 hours,
downloads only files whose hash changed (usually `main.js` and `resources.neu`, well under 1 MB; the shell binary only
changes with Neutralino or the major.minor version), verifies them and renames them into place, keeping the replaced
files in `.update/` until the next start. Local builds (`-dev` versions) never update themselves.

### Notes for the next agent

- Stack and product decisions are fixed in `plan_work.md`; do not re-open Rust/Electron/Python choices.
- Wireframes are the UI spec. Numbered marks inside a mockup refer to the notes under it.
- The shell contains the Neutralino workarounds we found (HiDPI window size, hide-then-exit on close, extension handshake without newline); see `app/README.md`.
- To check the UI without a human on Windows: start the app, then `tools/win/shot.ps1` (screenshot + optional click/keys), `tools/win/procs.ps1`, `tools/win/kill-app.ps1`.
