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
import type { Api, ApiRoute, AppConfig, FolderGroup, GlobalSettingsView, ServerEvent, UiLayout } from "@uni-git/shared";
import { API_VERSION, BUILT_IN_PRESETS, type TaskPreset } from "@uni-git/shared";
import { ConfigStore, newId, normalizePath } from "./config.js";
import { discoverRepos, isGitRepo } from "./discover.js";
import { getGitExecutable, git, setGitExecutable } from "./git.js";
import { AskpassBroker } from "./askpass.js";
import { generateSshKey, listAccounts, listSshKeys, probeHosts, signOut, storeToken } from "./accounts.js";
import { homedir } from "node:os";
import { JobManager } from "./jobs.js";
import { RepoService, enqueueClone } from "./repo.js";
import { Updater } from "./updater.js";
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
  /** folder of the installed app (shell binary, resources.neu, extensions/): what the updater replaces */
  appDir: string;
  /** version of this build (version.ts) */
  version: string;
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
  private askpass: AskpassBroker | null = null;
  private readonly updater: Updater;

  constructor(private readonly opts: BackendOptions) {
    this.config = new ConfigStore(opts.dataDir);
    this.updater = new Updater({
      appDir: opts.appDir,
      version: opts.version,
      log: opts.log,
      onState: (update) => this.broadcast({ type: "update", update }),
    });
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
        this.startAskpass(addr.port);
        // first check a few seconds later, off the startup path
        this.updater.start();
        resolvePort(addr.port);
      });
    });
  }

  /** Askpass environment for a non-git child process of a job (ssh test). */
  private askpassEnvFor(jobId: string): Record<string, string> {
    return this.jobs.jobEnv(jobId);
  }

  /** Prompts from git/ssh inside jobs go to the UI; jobs get the environment that routes them here. */
  private startAskpass(port: number): void {
    const broker = new AskpassBroker(
      this.opts.dataDir,
      port,
      (request) => this.broadcast({ type: "askpass", request }),
      (id) => this.broadcast({ type: "askpassDone", id }),
      (jobId) => {
        const j = this.jobs.info(jobId);
        return j ? { repoName: j.repoName, title: j.title } : undefined;
      },
    );
    this.askpass = broker;
    this.jobs.jobEnv = (jobId) => broker.env(jobId);
    this.jobs.on("cancel", (jobId) => broker.cancelJob(jobId));
  }

  close(): void {
    if (this.orphanTimer) clearTimeout(this.orphanTimer);
    this.updater.stop();
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
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // /askpass is called by the helper script with its own token inside the body
    if (auth !== `Bearer ${this.opts.token}` && url.pathname !== "/askpass") {
      this.json(res, 401, { error: "unauthorized" });
      return;
    }
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

  /** Built-in presets first, then the user's saved ones. */
  private presets(): TaskPreset[] {
    const custom = this.config.get().settings.taskPresets ?? {};
    return [...BUILT_IN_PRESETS, ...Object.entries(custom).map(([name, template]) => ({ name, template, builtIn: false }))];
  }

  private async globalSettings(): Promise<GlobalSettingsView> {
    const s = this.config.get().settings;
    const version = await git(["--version"], { cwd: process.cwd(), allowFailure: true }).catch(() => null);
    const gitVersion = version && version.code === 0 ? (/git version (\S+)/.exec(version.stdout)?.[1] ?? version.stdout.trim()) : null;
    const gcm = await git(["credential-manager", "--version"], { cwd: process.cwd(), allowFailure: true }).catch(() => null);
    const gcmVersion = gcm && gcm.code === 0 ? (gcm.stdout.trim().split(/\r?\n/)[0]?.split("+")[0] ?? null) : null;
    return { ...s, dataDir: this.opts.dataDir, gitVersion, gitResolved: getGitExecutable(), gcmVersion };
  }

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
      "/ping": () => ({ pid: process.pid, startedAt: this.opts.startedAt, apiVersion: API_VERSION, version: this.opts.version }),

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
      "/repo/status": ({ repoId }) => this.repo(repoId).status(this.opts.dataDir),
      "/repo/refs": ({ repoId }) => this.repo(repoId).refs(),
      "/repo/diff": ({ repoId, file }) => this.repo(repoId).diff(file),
      "/repo/stage": ({ repoId, paths }) => ({ job: this.repo(repoId).stage(requirePaths(paths)) }),
      "/repo/unstage": ({ repoId, paths }) => ({ job: this.repo(repoId).unstage(requirePaths(paths)) }),
      "/repo/commit": ({ repoId, message, amend, push }) => {
        if (!message.trim()) throw new HttpError(400, "commit message is empty");
        return { job: this.repo(repoId).commit(message, amend, push) };
      },
      "/repo/log": ({ repoId, skip, limit, text, author, ref, task }) => this.repo(repoId).log(skip, limit, text, author, ref, task),
      "/repo/commit-details": ({ repoId, sha }) => this.repo(repoId).commitDetails(sha),
      "/repo/commit-branches": async ({ repoId, sha }) => ({ branches: await this.repo(repoId).commitBranches(sha) }),
      "/repo/commit-diff": ({ repoId, sha, path }) => this.repo(repoId).commitDiff(sha, path),
      "/repo/checkout": ({ repoId, branch, remote, stash, discard }) => {
        if (!branch.trim()) throw new HttpError(400, "branch name is empty");
        return { job: this.repo(repoId).checkout(branch.trim(), remote, stash, discard === true) };
      },
      "/repo/fetch": ({ repoId }) => ({ job: this.repo(repoId).fetch() }),
      "/repo/pull": ({ repoId, discard }) => ({ job: this.repo(repoId).pull(discard === true) }),
      "/repo/push": ({ repoId, force, tags }) => ({ job: this.repo(repoId).push(force === true, tags === true) }),
      "/repo/merge-scenario": ({ repoId, mode, stash }) => {
        cfg.update((c) => {
          c.settings.mergeStash = stash;
        });
        return { job: this.repo(repoId).mergeScenario(this.opts.dataDir, mode, stash) };
      },
      "/repo/conflict/resolve": ({ repoId, paths, take }) => ({ job: this.repo(repoId).resolveConflict(requirePaths(paths), take) }),
      "/repo/operation/abort": ({ repoId }) => ({ job: this.repo(repoId).abortOperation() }),
      "/repo/operation/continue": ({ repoId }) => ({ job: this.repo(repoId).continueOperation() }),
      "/repo/cherry-pick": ({ repoId, shas }) => ({ job: this.repo(repoId).cherryPick(requirePaths(shas)) }),
      "/repo/stash/save": ({ repoId, message, includeUntracked }) => ({ job: this.repo(repoId).stashSave(message, includeUntracked) }),
      "/repo/stash/apply": ({ repoId, ref, pop }) => ({ job: this.repo(repoId).stashApply(ref, pop) }),
      "/repo/stash/drop": ({ repoId, ref }) => ({ job: this.repo(repoId).stashDrop(ref) }),
      "/repo/stash/sha": async ({ repoId, ref }) => ({ sha: await this.repo(repoId).stashSha(ref) }),
      "/repo/tag/create": ({ repoId, name, sha, message, push }) => {
        if (!name.trim()) throw new HttpError(400, "tag name is empty");
        return { job: this.repo(repoId).tagCreate(name.trim(), sha, message, push) };
      },
      "/repo/tag/delete": ({ repoId, name, remote }) => ({ job: this.repo(repoId).tagDelete(name, remote) }),
      "/repo/tag/push": ({ repoId, name }) => ({ job: this.repo(repoId).tagPush(name) }),
      "/repo/remote/add": ({ repoId, name, url }) => {
        if (!name.trim() || !url.trim()) throw new HttpError(400, "remote name and URL are required");
        return { job: this.repo(repoId).remoteAdd(name.trim(), url.trim()) };
      },
      "/repo/remote/remove": ({ repoId, name }) => ({ job: this.repo(repoId).remoteRemove(name) }),
      "/repo/remote/url": async ({ repoId, name }) => ({ url: await this.repo(repoId).remoteUrl(name) }),
      "/repo/submodule/update": ({ repoId }) => ({ job: this.repo(repoId).submoduleUpdate() }),
      "/repo/merge-message": async ({ repoId }) => ({ message: await this.repo(repoId).mergeMessage() }),
      "/repo/last-message": async ({ repoId }) => ({ message: await this.repo(repoId).lastMessage() }),
      "/repo/user": ({ repoId }) => this.repo(repoId).user(),
      "/repo/settings": ({ repoId }) => this.repo(repoId).settings(this.opts.dataDir, this.presets()),
      "/repo/auth": async ({ repoId }) => {
        const svc = this.repo(repoId);
        const [remotes, cfgAuth, keys] = await Promise.all([svc.authRemotes(), svc.authConfig(), listSshKeys()]);
        const hosts = [...new Set(remotes.filter((r) => r.protocol === "https").map((r) => r.host))];
        const accounts = hosts.length ? await probeHosts(hosts) : [];
        return { remotes, username: cfgAuth.username, sshKey: cfgAuth.sshKey, accounts, keys };
      },
      "/repo/auth/save": async ({ repoId, username, sshKey }) => {
        await this.repo(repoId).saveAuth(username, sshKey);
        return { ok: true };
      },
      "/repo/auth/test": ({ repoId }) => ({ job: this.repo(repoId).testRemotes() }),
      "/repo/settings/save": async ({ repoId, groupId, mainBranch, userName, userEmail, template, presetName }) => {
        const svc = this.repo(repoId);
        if (!cfg.group(groupId)) throw new HttpError(404, "group not found");
        if (template) {
          try {
            new RegExp(template.codePattern);
          } catch {
            throw new HttpError(400, "task code pattern is not a valid regular expression");
          }
        }
        await svc.saveSettings(this.opts.dataDir, mainBranch, userName, userEmail, template, presetName);
        this.broadcast({ type: "repoChanged", repoId });
        if (svc.entry.groupId !== groupId) {
          cfg.update((c) => {
            const r = c.repos.find((x) => x.id === repoId);
            if (r) {
              r.groupId = groupId;
              const g = c.groups.find((x) => x.id === groupId);
              if (g?.kind === "folder" && normalizePath(resolve(r.path, "..")) === normalizePath(g.root)) delete r.external;
              else if (g?.kind === "folder") r.external = true;
              else delete r.external;
            }
          });
        }
        return { ok: true };
      },
      "/repo/branch/create": ({ repoId, name, from, checkout }) => {
        const n = name.trim();
        if (!n) throw new HttpError(400, "branch name is empty");
        return { job: this.repo(repoId).createBranch(n, from.trim() || "HEAD", checkout) };
      },
      "/repo/branch/delete": ({ repoId, name, remote, force }) => ({ job: this.repo(repoId).deleteBranch(name.trim(), remote, force) }),
      "/repo/branch/rename": ({ repoId, from, to }) => {
        if (!to.trim()) throw new HttpError(400, "new name is empty");
        return { job: this.repo(repoId).renameBranch(from.trim(), to.trim()) };
      },
      "/repo/merge": ({ repoId, branch }) => ({ job: this.repo(repoId).merge(branch.trim()) }),
      "/repo/merged-into": async ({ repoId, branch, into }) => ({ merged: await this.repo(repoId).mergedInto(branch, into) }),
      "/repo/discard": ({ repoId, paths, all }) => ({ job: all === true ? this.repo(repoId).discard([], true) : this.repo(repoId).discard(requirePaths(paths)) }),
      "/repo/ignore": ({ repoId, patterns }) => ({ job: this.repo(repoId).ignore(requirePaths(patterns)) }),
      "/repo/apply-patch": ({ repoId, patch, reverse }) => {
        if (!patch.trim()) throw new HttpError(400, "empty patch");
        return { job: this.repo(repoId).applyPatch(patch, reverse) };
      },
      "/settings/global": () => this.globalSettings(),
      "/settings/global/save": async ({ settings }) => {
        cfg.update((c) => {
          c.settings = {
            ...(settings.gitPath?.trim() ? { gitPath: settings.gitPath.trim() } : {}),
            ...(settings.editorCommand?.trim() ? { editorCommand: settings.editorCommand.trim() } : {}),
            ...(settings.theme && settings.theme !== "system" ? { theme: settings.theme } : {}),
            ...((settings.mergeStash ?? c.settings.mergeStash) ? { mergeStash: true } : {}),
            ...(Object.keys(settings.taskPresets ?? c.settings.taskPresets ?? {}).length ? { taskPresets: settings.taskPresets ?? c.settings.taskPresets } : {}),
            // the layout is not part of the settings dialog: it only changes through /settings/ui/save
            ...(c.settings.ui ? { ui: c.settings.ui } : {}),
          };
        });
        return this.globalSettings();
      },
      "/settings/ui/save": ({ ui }) => {
        const next: UiLayout = { ...cfg.get().settings.ui };
        for (const key of ["sideWidth", "changesSplit", "commitsSplit", "commitFilesSplit"] as const) {
          const v = ui[key];
          if (v === undefined) continue;
          if (typeof v === "number" && Number.isFinite(v) && v > 0) next[key] = v;
          else delete next[key];
        }
        cfg.update((c) => {
          if (Object.keys(next).length) c.settings.ui = next;
          else delete c.settings.ui;
        });
        return { ui: next };
      },
      "/accounts/list": async () => {
        const paths = cfg.get().repos.map((r) => r.path);
        const [{ accounts, sshHosts }, keys] = await Promise.all([listAccounts(paths), listSshKeys()]);
        return { accounts, sshHosts, keys };
      },
      "/accounts/login": ({ host }) => {
        const h = host.trim().toLowerCase();
        if (!h) throw new HttpError(400, "host is empty");
        const target = { id: "accounts", name: "accounts", path: homedir() };
        const job = this.jobs.enqueue(target, `sign in to ${h}`, async (ctx) => {
          ctx.log("Asking the credential helper; Git Credential Manager opens the browser or a dialog for this host.");
          const fill = await ctx.git(["credential", "fill"], { input: `protocol=https\nhost=${h}\n\n` });
          if (!/^password=/m.test(fill.stdout)) throw new Error("No credentials were returned");
          ctx.setStep("store");
          await ctx.git(["credential", "approve"], { input: fill.stdout + "\n" });
          const user = /^username=(.*)$/m.exec(fill.stdout)?.[1] ?? "";
          ctx.log(`Signed in to ${h}${user ? ` as ${user}` : ""}`);
        });
        return { job };
      },
      "/accounts/token": async ({ host, username, token }) => {
        if (!host.trim() || !token.trim()) throw new HttpError(400, "host and token are required");
        await storeToken(host.trim().toLowerCase(), username.trim() || "token", token.trim());
        return { ok: true };
      },
      "/accounts/logout": async ({ host, username }) => {
        await signOut(host.trim().toLowerCase(), username);
        return { ok: true };
      },
      "/ssh/generate": async ({ comment }) => ({ key: await generateSshKey(comment) }),
      "/ssh/test": ({ host }) => {
        const h = host.trim().toLowerCase();
        if (!h) throw new HttpError(400, "host is empty");
        const target = { id: "accounts", name: "ssh", path: homedir() };
        const job = this.jobs.enqueue(target, `test ssh ${h}`, async (ctx) => {
          // ssh is not git, but our askpass env still serves passphrase and host-key prompts
          await new Promise<void>((resolve, reject) => {
            const child = spawn("ssh", ["-T", "-o", "StrictHostKeyChecking=accept-new", `git@${h}`], {
              env: { ...process.env, ...this.askpassEnvFor(job.id) },
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let text = "";
            child.stdout.on("data", (d: Buffer) => (text += d.toString("utf8")));
            child.stderr.on("data", (d: Buffer) => {
              text += d.toString("utf8");
              ctx.log(d.toString("utf8"));
            });
            ctx.signal.addEventListener("abort", () => child.kill(), { once: true });
            child.on("error", (e) => reject(new Error(e.message)));
            child.on("close", () => {
              if (/success|welcome|authenticated|logged in/i.test(text)) resolve();
              else reject(new Error(text.trim().split(/\r?\n/).pop() || "ssh did not authenticate"));
            });
          });
        });
        return { job };
      },
      "/askpass": async ({ token, jobId, prompt }) => ({ value: this.askpass ? await this.askpass.ask(token, jobId, prompt) : null }),
      "/askpass/answer": ({ id, value }) => {
        // cancelling a prompt cancels the whole operation: the job ends as "cancelled", not as a cryptic git failure
        const request = this.askpass?.list().find((r) => r.id === id);
        const ok = this.askpass?.answer(id, value) ?? false;
        if (ok && value === null && request) this.jobs.cancel(request.jobId);
        return { ok };
      },
      "/askpass/pending": () => ({ requests: this.askpass?.list() ?? [] }),

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

      "/update/status": () => this.updater.get(),
      "/update/check": () => this.updater.check(),

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

