/**
 * Local HTTP + WebSocket server on 127.0.0.1. Every request carries the session token.
 * HTTP: POST <route> with a JSON body, JSON answer. WS: server → client events (ServerEvent).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Api, ApiRoute, AppConfig, FolderGroup, ServerEvent } from "@epic-git/shared";
import { API_VERSION } from "@epic-git/shared";
import { ConfigStore, newId, normalizePath } from "./config.js";
import { discoverRepos, isGitRepo } from "./discover.js";
import { setGitExecutable } from "./git.js";
import { JobManager } from "./jobs.js";
import { RepoService, enqueueClone } from "./repo.js";
import { RepoWatcher } from "./watcher.js";

type Handlers = { [K in ApiRoute]: (body: Api[K]["req"]) => Promise<Api[K]["res"]> | Api[K]["res"] };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface BackendOptions {
  dataDir: string;
  token: string;
  startedAt: number;
  log: (msg: string) => void;
  onShutdownRequest: (reason: string) => void;
  /** Exit when the last UI client is gone for this long and the shell pid is unknown (browser debugging). 0 disables. */
  orphanTimeoutMs?: number;
  /** The UI reports the shell's process id (NL_PID) when it connects. */
  onShellPid?: (pid: number) => void;
  /** null = pid unknown */
  isShellAlive?: () => boolean | null;
}

const DEFAULT_ORPHAN_TIMEOUT_MS = 15000;

export class Backend {
  readonly config: ConfigStore;
  readonly jobs = new JobManager();
  private readonly repos = new Map<string, RepoService>();
  private readonly watcher: RepoWatcher;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly handlers: Handlers;
  private pendingLogs = new Map<string, string>();
  private logFlush: NodeJS.Timeout | null = null;
  private hadClient = false;
  private orphanTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: BackendOptions) {
    this.config = new ConfigStore(opts.dataDir);
    setGitExecutable(this.config.get().settings.gitPath);
    this.config.onChange((c) => {
      setGitExecutable(c.settings.gitPath);
      this.broadcast({ type: "configChanged", config: c });
    });

    this.watcher = new RepoWatcher((path) => {
      const entry = this.config.repoByPath(path);
      if (entry) this.broadcast({ type: "repoChanged", repoId: entry.id });
    });

    this.jobs.on("job", (job) => this.broadcast({ type: "job", job }));
    this.jobs.on("log", (jobId, chunk) => this.queueLog(jobId, chunk));
    this.jobs.on("repoChanged", (repoId) => this.broadcast({ type: "repoChanged", repoId }));

    this.handlers = this.buildHandlers();
    this.http = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/events" || url.searchParams.get("token") !== opts.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const shellPid = Number(url.searchParams.get("shellPid"));
      if (shellPid > 0 && opts.onShellPid) opts.onShellPid(shellPid);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onClient(ws));
    });
  }

  listen(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, "127.0.0.1", () => {
        const addr = this.http.address() as AddressInfo;
        resolvePort(addr.port);
      });
    });
  }

  close(): void {
    if (this.orphanTimer) clearTimeout(this.orphanTimer);
    this.watcher.close();
    this.jobs.cancelAll();
    for (const c of this.clients) c.close();
    this.wss.close();
    this.http.close();
  }

  // ───────────── websocket ─────────────

  private onClient(ws: WebSocket): void {
    this.clients.add(ws);
    this.hadClient = true;
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
    }
    const gone = () => {
      this.clients.delete(ws);
      this.checkOrphan();
    };
    ws.on("close", gone);
    ws.on("error", gone);
    this.send(ws, { type: "hello", pid: process.pid, jobs: this.jobs.list() });
  }

  /** No UI left: the window was closed or the shell crashed. Exit at once if the shell is gone, else give a reload a moment. */
  private checkOrphan(): void {
    if (!this.hadClient || this.clients.size > 0) return;
    if (this.opts.isShellAlive?.() === false) {
      this.opts.onShutdownRequest("shell process gone and no UI client");
      return;
    }
    const timeout = this.opts.orphanTimeoutMs ?? DEFAULT_ORPHAN_TIMEOUT_MS;
    if (timeout <= 0 || this.orphanTimer) return;
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      if (this.clients.size === 0) this.opts.onShutdownRequest("no UI client for " + Math.round(timeout / 1000) + " s");
    }, timeout);
  }

  private send(ws: WebSocket, ev: ServerEvent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
  }

  private broadcast(ev: ServerEvent): void {
    const data = JSON.stringify(ev);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(data);
  }

  private queueLog(jobId: string, chunk: string): void {
    this.pendingLogs.set(jobId, (this.pendingLogs.get(jobId) ?? "") + chunk);
    if (this.logFlush) return;
    this.logFlush = setTimeout(() => {
      this.logFlush = null;
      for (const [id, text] of this.pendingLogs) this.broadcast({ type: "jobLog", jobId: id, chunk: text });
      this.pendingLogs.clear();
    }, 120);
  }

  // ───────────── http ─────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${this.opts.token}`) {
      this.json(res, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = url.pathname as ApiRoute;
    const handler = this.handlers[route];
    if (!handler) {
      this.json(res, 404, { error: `unknown route ${route}` });
      return;
    }
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      const result = await (handler as (b: unknown) => Promise<unknown>)(body);
      this.json(res, 200, result ?? {});
    } catch (e) {
      if (e instanceof HttpError) {
        this.json(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        this.json(res, 500, { error: msg });
      }
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length });
    res.end(data);
  }

  // ───────────── domain ─────────────

  private repo(id: string): RepoService {
    let svc = this.repos.get(id);
    const entry = this.config.repo(id);
    if (!entry) throw new HttpError(404, `repository ${id} is not registered`, "no-repo");
    if (!svc || svc.entry !== entry) {
      svc = new RepoService(entry, this.opts.dataDir, this.jobs);
      this.repos.set(id, svc);
    }
    return svc;
  }

  private rescanFolderGroup(group: FolderGroup, c: AppConfig): void {
    const found = discoverRepos(group.root);
    const hidden = new Set(group.hidden.map(normalizePath));
    for (const d of found) {
      if (hidden.has(normalizePath(d.path))) continue;
      if (c.repos.some((r) => normalizePath(r.path) === normalizePath(d.path))) continue;
      c.repos.push({ id: newId(), groupId: group.id, name: d.name, path: d.path });
    }
    // repositories that disappeared from the folder
    c.repos = c.repos.filter((r) => r.groupId !== group.id || r.external || existsSync(r.path));
  }

  private buildHandlers(): Handlers {
    const cfg = this.config;
    return {
      "/ping": () => ({ pid: process.pid, startedAt: this.opts.startedAt, apiVersion: API_VERSION }),

      "/config": () => cfg.get(),

      "/config/select": ({ repoId }) => {
        const next = cfg.update((c) => {
          if (repoId && cfg.repo(repoId)) c.lastRepoId = repoId;
          else delete c.lastRepoId;
        });
        const entry = repoId ? cfg.repo(repoId) : undefined;
        if (entry) this.watcher.watch(entry.path);
        else this.watcher.close();
        return next;
      },

      "/groups/scan": ({ root }) => {
        const dir = requireDir(root);
        const repos = discoverRepos(dir).map((d) => {
          const known = cfg.repoByPath(d.path);
          const groupName = known ? cfg.group(known.groupId)?.name : undefined;
          return groupName ? { ...d, knownIn: groupName } : d;
        });
        return { repos };
      },

      "/groups/add-folder": ({ root, name, hidden }) => {
        const dir = requireDir(root);
        const group: FolderGroup = { id: newId(), kind: "folder", name: name.trim() || basename(dir), root: dir, hidden };
        return cfg.update((c) => {
          c.groups.push(group);
          this.rescanFolderGroup(group, c);
        });
      },

      "/groups/add-manual": ({ name }) => {
        const n = name.trim();
        if (!n) throw new HttpError(400, "group name is empty");
        return cfg.update((c) => c.groups.push({ id: newId(), kind: "manual", name: n }));
      },

      "/groups/rescan": ({ groupId }) => {
        const g = cfg.group(groupId);
        if (!g || g.kind !== "folder") throw new HttpError(400, "not a folder group");
        return cfg.update((c) => this.rescanFolderGroup(g, c));
      },

      "/groups/remove": ({ groupId }) =>
        cfg.update((c) => {
          c.groups = c.groups.filter((g) => g.id !== groupId);
          c.repos = c.repos.filter((r) => r.groupId !== groupId);
          if (c.lastRepoId && !c.repos.some((r) => r.id === c.lastRepoId)) delete c.lastRepoId;
        }),

      "/repos/open": ({ path, groupId }) => {
        const dir = requireDir(path);
        if (!isGitRepo(dir)) throw new HttpError(400, `${dir} is not a git repository (no .git)`, "not-a-repo");
        const g = cfg.group(groupId);
        if (!g) throw new HttpError(404, "group not found");
        const existing = cfg.repoByPath(dir);
        if (existing) throw new HttpError(409, `already added to group "${cfg.group(existing.groupId)?.name ?? "?"}"`, "exists");
        const external = g.kind === "folder" && normalizePath(resolve(dir, "..")) !== normalizePath(g.root);
        cfg.addRepo(dir, groupId, external);
        return cfg.get();
      },

      "/repos/remove": ({ repoId }) =>
        cfg.update((c) => {
          const r = c.repos.find((x) => x.id === repoId);
          c.repos = c.repos.filter((x) => x.id !== repoId);
          const g = r ? c.groups.find((x) => x.id === r.groupId) : undefined;
          if (r && g && g.kind === "folder" && !r.external) g.hidden.push(r.path);
          if (c.lastRepoId === repoId) delete c.lastRepoId;
          this.repos.delete(repoId);
        }),

      "/repos/clone": ({ url, dest, groupId, recurse }) => {
        if (!url.trim()) throw new HttpError(400, "URL is empty");
        if (!dest.trim() || !isAbsolute(dest)) throw new HttpError(400, "destination must be an absolute path");
        if (existsSync(dest)) throw new HttpError(409, `${dest} already exists`);
        const g = cfg.group(groupId);
        if (!g) throw new HttpError(404, "group not found");
        const job = enqueueClone(this.jobs, url.trim(), dest, recurse, (done) => {
          const external = g.kind === "folder" && normalizePath(resolve(done, "..")) !== normalizePath(g.root);
          cfg.addRepo(done, groupId, external);
        });
        return { job };
      },

      "/repo/snapshot": ({ repoId }) => this.repo(repoId).snapshot(),
      "/repo/status": ({ repoId }) => this.repo(repoId).status(),
      "/repo/refs": ({ repoId }) => this.repo(repoId).refs(),
      "/repo/diff": ({ repoId, file }) => this.repo(repoId).diff(file),
      "/repo/stage": ({ repoId, paths }) => ({ job: this.repo(repoId).stage(requirePaths(paths)) }),
      "/repo/unstage": ({ repoId, paths }) => ({ job: this.repo(repoId).unstage(requirePaths(paths)) }),
      "/repo/commit": ({ repoId, message, amend, push }) => {
        if (!message.trim()) throw new HttpError(400, "commit message is empty");
        return { job: this.repo(repoId).commit(message, amend, push) };
      },
      "/repo/log": ({ repoId, skip, limit, text, author }) => this.repo(repoId).log(skip, limit, text, author),
      "/repo/commit-details": ({ repoId, sha }) => this.repo(repoId).commitDetails(sha),
      "/repo/commit-branches": async ({ repoId, sha }) => ({ branches: await this.repo(repoId).commitBranches(sha) }),
      "/repo/commit-diff": ({ repoId, sha, path }) => this.repo(repoId).commitDiff(sha, path),
      "/repo/checkout": ({ repoId, branch, remote, stash }) => {
        if (!branch.trim()) throw new HttpError(400, "branch name is empty");
        return { job: this.repo(repoId).checkout(branch.trim(), remote, stash) };
      },
      "/repo/fetch": ({ repoId }) => ({ job: this.repo(repoId).fetch() }),
      "/repo/pull": ({ repoId }) => ({ job: this.repo(repoId).pull() }),
      "/repo/push": ({ repoId }) => ({ job: this.repo(repoId).push() }),
      "/repo/last-message": async ({ repoId }) => ({ message: await this.repo(repoId).lastMessage() }),
      "/repo/user": ({ repoId }) => this.repo(repoId).user(),

      "/jobs": () => ({ jobs: this.jobs.list() }),
      "/jobs/log": ({ jobId }) => {
        const log = this.jobs.logOf(jobId);
        if (log === undefined) throw new HttpError(404, "job not found");
        return { log };
      },
      "/jobs/cancel": ({ jobId }) => ({ ok: this.jobs.cancel(jobId) }),

      "/os/open-in-editor": ({ path }) => {
        openInEditor(requireDir(path), cfg.get().settings.editorCommand);
        return { ok: true };
      },

      "/shutdown": () => {
        setTimeout(() => this.opts.onShutdownRequest("requested by the shell"), 10);
        return { ok: true };
      },
    };
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function requireDir(path: string): string {
  const p = resolve(path.trim());
  if (!existsSync(p)) throw new HttpError(400, `folder does not exist: ${p}`, "no-folder");
  return p;
}

function requirePaths(paths: string[]): string[] {
  const list = paths.map((p) => p.trim()).filter(Boolean);
  if (!list.length) throw new HttpError(400, "no paths given");
  return list;
}

/** Opens a folder in the editor. Default: VS Code. macOS GUI apps have a minimal PATH, hence the fallbacks. */
export function openInEditor(path: string, command: string | undefined): void {
  const tpl = command && command.trim() ? command.trim() : "code {path}";
  const quoted = `"${path.replace(/"/g, '\\"')}"`;
  const cmd = tpl.includes("{path}") ? tpl.replace("{path}", quoted) : `${tpl} ${quoted}`;
  // Windows: shell:true runs `cmd.exe /d /s /c "<cmd>"` with the command line passed verbatim, so the quotes around
  // the path survive (quoting it ourselves through the args array produced a stray quote in the path).
  // macOS: a login shell, because GUI apps start with a minimal PATH and `code` lives in /usr/local/bin.
  const child =
    process.platform === "win32"
      ? spawn(cmd, [], { shell: true, detached: true, stdio: "ignore", windowsHide: true })
      : spawn("/bin/sh", ["-lc", cmd], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    /* handled below via exit code */
  });
  child.on("exit", (code) => {
    if (code !== 0 && process.platform === "darwin" && tpl.startsWith("code")) {
      spawn("open", ["-a", "Visual Studio Code", path], { detached: true, stdio: "ignore" }).unref();
    }
  });
  child.unref();
}

