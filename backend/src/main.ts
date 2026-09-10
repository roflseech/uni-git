/**
 * epic-git backend: a Node process next to the Neutralino shell.
 *
 * Starts a local HTTP/WS server with a random port and token, writes both to data/session.json for the
 * shell to read, and exits together with the shell (Neutralino extension link, parent watchdog, /shutdown).
 */
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { API_VERSION, APP_NAME, type SessionInfo } from "@epic-git/shared";
import { Backend } from "./server.js";

const startedAt = Date.now();

let logFile: string | null = null;

/** Console and data/logs/backend.log (the shell swallows the extension's stdout). */
function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(`[${APP_NAME} backend] ${msg}`);
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      /* logging is best effort */
    }
  }
}

function openLog(dataDir: string): void {
  try {
    const dir = join(dataDir, "logs");
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, "backend.log");
    // keep the log small: start over when it grows past ~1 MB
    try {
      if (statSync(logFile).size > 1024 * 1024) unlinkSync(logFile);
    } catch {
      /* no file yet */
    }
  } catch {
    logFile = null;
  }
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const pref = process.argv.find((a) => a.startsWith(`${name}=`));
  return pref ? pref.slice(name.length + 1) : undefined;
}

/** data/ next to the app; falls back to the user profile when that folder is read-only (macOS /Applications). */
function resolveDataDir(): string {
  const explicit = argValue("--data-dir") ?? process.env["EPIC_GIT_DATA_DIR"];
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, resolve(here, "../../data")].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    const dir = resolve(c);
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      return dir;
    } catch {
      /* try next */
    }
  }
  const fallback =
    process.platform === "win32"
      ? join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), APP_NAME)
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", APP_NAME)
        : join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), APP_NAME);
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

async function pingExisting(file: string): Promise<SessionInfo | null> {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as SessionInfo;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 800);
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/ping`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.token}` },
        signal: ctrl.signal,
      });
      if (!r.ok) return null;
      const body = (await r.json()) as { pid?: number };
      return body.pid === s.pid ? s : null;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

/** Neutralino writes one JSON line to stdin when it spawns us as an extension. */
function readExtensionHandshake(): Promise<{ nlPort: string; nlConnectToken: string; nlExtensionId: string } | null> {
  return new Promise((done) => {
    if (process.stdin.isTTY) {
      done(null);
      return;
    }
    let buf = "";
    let finished = false;
    const finish = (v: { nlPort: string; nlConnectToken: string; nlExtensionId: string } | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
      done(v);
    };
    const timer = setTimeout(() => finish(null), 3000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      // Neutralino writes one JSON object; accept it with or without a trailing newline.
      const nl = buf.indexOf("\n");
      const candidate = (nl >= 0 ? buf.slice(0, nl) : buf).trim();
      if (!candidate.startsWith("{") || !candidate.endsWith("}")) return;
      try {
        const j = JSON.parse(candidate) as Record<string, unknown>;
        if (j["nlPort"] && j["nlConnectToken"] && j["nlExtensionId"]) {
          finish({ nlPort: String(j["nlPort"]), nlConnectToken: String(j["nlConnectToken"]), nlExtensionId: String(j["nlExtensionId"]) });
          return;
        }
      } catch {
        return; // incomplete, wait for more
      }
      log(`stdin JSON is not a Neutralino handshake: ${candidate.slice(0, 160)}`);
      finish(null);
    });
    process.stdin.on("end", () => {
      log(`stdin ended${buf ? ` after ${buf.length} bytes` : " without data"}`);
      finish(null);
    });
    process.stdin.on("error", (e) => {
      log(`stdin error: ${(e as Error).message}`);
      finish(null);
    });
  });
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  openLog(dataDir);
  const sessionFile = join(dataDir, "session.json");

  const alive = await pingExisting(sessionFile);
  if (alive) {
    log(`another backend already serves ${dataDir} (pid ${alive.pid}, port ${alive.port}); exiting`);
    process.exit(0);
  }

  const token = randomBytes(24).toString("hex");
  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down: ${reason}`);
    backend.close();
    try {
      const cur = JSON.parse(readFileSync(sessionFile, "utf8")) as SessionInfo;
      if (cur.pid === process.pid) unlinkSync(sessionFile);
    } catch {
      /* nothing to clean */
    }
    setTimeout(() => process.exit(0), 50).unref();
  };

  let shellPid: number | null = null;
  const backend = new Backend({
    dataDir,
    token,
    startedAt,
    log,
    onShutdownRequest: (reason) => shutdown(reason),
    onShellPid: (pid) => {
      if (shellPid === pid) return;
      shellPid = pid;
      log(`watching shell process ${pid}`);
    },
    isShellAlive: () => (shellPid === null ? null : isAlive(shellPid)),
  });
  const port = await backend.listen();

  const session: SessionInfo = { apiVersion: API_VERSION, port, token, pid: process.pid, startedAt };
  writeFileSync(sessionFile, JSON.stringify(session), "utf8");
  log(`listening on 127.0.0.1:${port}, data in ${dataDir}, ${Date.now() - startedAt} ms after start`);

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => {
    console.error(e);
  });

  // Watchdogs. The shell's own pid comes from the UI (NL_PID) because on Windows our parent is the cmd.exe
  // wrapper, which outlives the shell. Poll it often: the backend must not outlive the window noticeably.
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const parent = process.ppid;
  setInterval(() => {
    if (!isAlive(parent)) shutdown("parent process exited");
    if (shellPid !== null && !isAlive(shellPid)) shutdown(`shell process ${shellPid} exited`);
  }, 250).unref();

  // Neutralino extension link: the shell closes the socket when it exits.
  const hs = await readExtensionHandshake();
  log(
    hs
      ? `extension handshake received (shell port ${hs.nlPort}, id ${hs.nlExtensionId})`
      : `no extension handshake on stdin (isTTY=${String(process.stdin.isTTY)}), relying on client presence and parent watchdog`,
  );
  if (hs) {
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${hs.nlPort}?extensionId=${encodeURIComponent(hs.nlExtensionId)}&connectToken=${encodeURIComponent(hs.nlConnectToken)}`,
      );
      ws.addEventListener("open", () => log("connected to the Neutralino shell"));
      ws.addEventListener("close", (ev) => shutdown(`shell connection closed (code ${ev.code})`));
      ws.addEventListener("error", () => shutdown("shell connection failed"));
    } catch (e) {
      log(`shell link unavailable: ${(e as Error).message}`);
    }
  }

  // Dev convenience: remove a stale session file left by a crashed run of a different pid.
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify(session), "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
