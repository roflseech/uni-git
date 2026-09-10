/**
 * Finds the running backend: the shell reads data/session.json written by the backend
 * (port + token); in a plain browser the values come from the URL (?port=..&token=..).
 */
import type { SessionInfo } from "@epic-git/shared";
import { APP_NAME } from "@epic-git/shared";

export interface Session {
  port: number;
  token: string;
}

const POLL_MS = 100;
const TIMEOUT_MS = 30000;

export function hasShell(): boolean {
  return typeof Neutralino !== "undefined" && typeof NL_PATH === "string";
}

export async function findSession(onProgress: (msg: string) => void): Promise<Session> {
  const params = new URLSearchParams(location.search);
  const port = Number(params.get("port"));
  const token = params.get("token");
  if (port && token) {
    const s = { port, token };
    if (await ping(s)) return s;
    throw new Error(`backend at 127.0.0.1:${port} does not answer`);
  }

  const cached = readLocal();
  if (cached && (await ping(cached))) return cached;

  if (!hasShell()) {
    throw new Error("No backend: open the page with ?port=…&token=… (see data/session.json) or run inside the shell.");
  }

  const candidates = await sessionFileCandidates();
  const started = Date.now();
  let lastNote = "";
  while (Date.now() - started < TIMEOUT_MS) {
    for (const file of candidates) {
      const info = await readSessionFile(file);
      if (!info) continue;
      const s = { port: info.port, token: info.token };
      if (await ping(s, info.pid)) {
        writeLocal(s);
        return s;
      }
      lastNote = `backend from ${file} is not answering, waiting…`;
    }
    const waited = Math.round((Date.now() - started) / 1000);
    if (waited >= 3) onProgress(lastNote || `Starting backend… ${waited} s`);
    await sleep(POLL_MS);
  }
  throw new Error("Backend did not start within 30 s. Is Node.js installed? See data/logs.");
}

async function sessionFileCandidates(): Promise<string[]> {
  const list = [`${NL_PATH}/data/session.json`];
  try {
    const os = typeof NL_OS === "string" ? NL_OS : "";
    if (os === "Darwin") {
      const home = await Neutralino.os.getEnv("HOME");
      if (home) list.push(`${home}/Library/Application Support/${APP_NAME}/session.json`);
    } else if (os === "Windows") {
      const local = await Neutralino.os.getEnv("LOCALAPPDATA");
      if (local) list.push(`${local}\\${APP_NAME}\\session.json`);
    } else {
      const xdg = await Neutralino.os.getEnv("XDG_DATA_HOME");
      const home = await Neutralino.os.getEnv("HOME");
      list.push(`${xdg || `${home}/.local/share`}/${APP_NAME}/session.json`);
    }
  } catch {
    /* env lookup failed: the app-local candidate is enough */
  }
  return list;
}

async function readSessionFile(path: string): Promise<SessionInfo | null> {
  try {
    const text = await Neutralino.filesystem.readFile(path);
    const info = JSON.parse(text) as SessionInfo;
    if (typeof info.port === "number" && typeof info.token === "string") return info;
  } catch {
    /* not there yet */
  }
  return null;
}

async function ping(s: Session, expectPid?: number): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 700);
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.token}` },
      signal: ctrl.signal,
    });
    if (!r.ok) return false;
    const body = (await r.json()) as { pid?: number };
    return expectPid === undefined || body.pid === expectPid;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

const LOCAL_KEY = "epic-git.session";

function readLocal(): Session | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s.port && s.token ? s : null;
  } catch {
    return null;
  }
}

function writeLocal(s: Session): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(s));
  } catch {
    /* storage may be unavailable */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
