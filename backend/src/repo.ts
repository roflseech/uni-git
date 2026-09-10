/**
 * Everything git for one repository: quick reads (status, refs, diff, log) run directly,
 * mutations go through the job queue so the UI can show progress and lock the repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  CommitDetails,
  CommitInfo,
  FileDiff,
  FileRef,
  JobInfo,
  RepoEntry,
  RepoOperation,
  RepoRefs,
  RepoStatus,
  Snapshot,
} from "@epic-git/shared";
import { git, gitOut } from "./git.js";
import type { JobContext, JobManager, JobTarget } from "./jobs.js";
import { diffForNewFile, looksBinary, parseUnifiedDiff } from "./parse/diff.js";
import { LOG_FORMAT, REFS_FORMAT, parseLog, parseRefs, parseStashes, parseSubmodules } from "./parse/log.js";
import { parseNameStatus, parseStatus } from "./parse/status.js";

const MAX_NEW_FILE_BYTES = 4 * 1024 * 1024;
const LOG_PAGE_MAX = 500;

export class RepoService {
  private gitDir: string | null = null;
  private readonly cacheDir: string;

  constructor(
    readonly entry: RepoEntry,
    dataDir: string,
    private readonly jobs: JobManager,
  ) {
    this.cacheDir = join(dataDir, "cache", entry.id);
  }

  get path(): string {
    return this.entry.path;
  }

  private get target(): JobTarget {
    return { id: this.entry.id, name: this.entry.name, path: this.entry.path };
  }

  // ───────────── reads ─────────────

  async status(): Promise<RepoStatus> {
    const r = await gitOut(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], this.path);
    const status = parseStatus(r);
    status.operation = await this.operation();
    this.writeCache("status.json", status);
    return status;
  }

  private async operation(): Promise<RepoOperation> {
    const dir = await this.resolveGitDir();
    if (!dir) return "none";
    if (existsSync(join(dir, "MERGE_HEAD"))) return "merge";
    if (existsSync(join(dir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
    if (existsSync(join(dir, "REVERT_HEAD"))) return "revert";
    if (existsSync(join(dir, "rebase-merge")) || existsSync(join(dir, "rebase-apply"))) return "rebase";
    return "none";
  }

  private async resolveGitDir(): Promise<string | null> {
    if (this.gitDir) return this.gitDir;
    try {
      const out = (await gitOut(["rev-parse", "--git-dir"], this.path)).trim();
      this.gitDir = isAbsolute(out) ? out : resolve(this.path, out);
      return this.gitDir;
    } catch {
      return null;
    }
  }

  async refs(): Promise<RepoRefs> {
    const [refsRaw, stashRaw, remotesRaw] = await Promise.all([
      gitOut([`for-each-ref`, `--format=${REFS_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags"], this.path),
      gitOut(["stash", "list", "--format=%gd%x00%s"], this.path).catch(() => ""),
      gitOut(["remote"], this.path).catch(() => ""),
    ]);
    const base = parseRefs(refsRaw);
    let submodules: string[] = [];
    if (existsSync(join(this.path, ".gitmodules"))) {
      const raw = await git(["config", "--file", ".gitmodules", "--get-regexp", "path"], {
        cwd: this.path,
        allowFailure: true,
      });
      submodules = parseSubmodules(raw.stdout);
    }
    const refs: RepoRefs = {
      ...base,
      stashes: parseStashes(stashRaw),
      remotes: remotesRaw.split(/\r?\n/).filter(Boolean),
      submodules,
    };
    this.writeCache("refs.json", refs);
    return refs;
  }

  async diff(file: FileRef): Promise<FileDiff> {
    if (file.area === "unstaged" && file.kind === "?") return this.newFileDiff(file.path);
    if (file.area === "conflict") return this.newFileDiff(file.path, "Conflicted file, working copy with markers");

    const args = ["diff", "--no-ext-diff", "-U3", "-M"];
    if (file.area === "staged") args.push("--cached");
    args.push("--", file.path);
    const r = await git(args, { cwd: this.path, maxOutput: 8 * 1024 * 1024 });
    const parsed = parseUnifiedDiff(r.stdout, file.path);
    if (r.truncated) parsed.truncated = true;
    if (!parsed.hunks.length && !parsed.binary && !parsed.note) {
      if (file.area === "staged" && file.kind === "R") parsed.note = "Renamed, content unchanged";
      else if (file.kind === "A" || file.kind === "D") parsed.note = "Empty file";
    }
    return parsed;
  }

  private async newFileDiff(path: string, note?: string): Promise<FileDiff> {
    const full = join(this.path, path);
    try {
      const s = await stat(full);
      if (s.isDirectory()) return { path, hunks: [], binary: false, note: "Directory" };
      if (s.size > MAX_NEW_FILE_BYTES) return { path, hunks: [], binary: false, note: `File is too large to show (${formatSize(s.size)})` };
      const buf = await readFile(full);
      if (looksBinary(buf)) return { path, hunks: [], binary: true };
      const d = diffForNewFile(path, buf.toString("utf8"));
      if (note) d.note = note;
      return d;
    } catch (e) {
      return { path, hunks: [], binary: false, note: (e as Error).message };
    }
  }

  async log(skip: number, limit: number, text?: string, author?: string): Promise<{ commits: CommitInfo[]; hasMore: boolean }> {
    const n = Math.min(Math.max(limit, 1), LOG_PAGE_MAX);
    const args = ["log", `--format=${LOG_FORMAT}`, `--skip=${Math.max(skip, 0)}`, `--max-count=${n + 1}`, "--decorate=short"];
    if (text) args.push("-i", `--grep=${text}`);
    if (author) args.push("-i", `--author=${author}`);
    args.push("HEAD");
    const r = await git(args, { cwd: this.path, allowFailure: true });
    if (r.code !== 0) {
      // unborn branch or no HEAD yet
      return { commits: [], hasMore: false };
    }
    const commits = parseLog(r.stdout);
    const hasMore = commits.length > n;
    const page = hasMore ? commits.slice(0, n) : commits;
    if (skip === 0 && !text && !author) this.writeCache("log.json", page);
    return { commits: page, hasMore };
  }

  async commitDetails(sha: string): Promise<CommitDetails> {
    const raw = await gitOut(["log", "-1", `--format=${LOG_FORMAT}`, "--decorate=short", sha], this.path);
    const info = parseLog(raw)[0];
    if (!info) throw new Error(`commit ${sha} not found`);
    const args = ["diff-tree", "-r", "-M", "-z", "--name-status", "--no-commit-id"];
    if (info.parents.length) args.push(`${sha}^1`, sha);
    else args.push("--root", sha);
    const files = parseNameStatus(await gitOut(args, this.path));
    return { ...info, files };
  }

  async commitBranches(sha: string): Promise<string[]> {
    const r = await git(["branch", "-a", "--contains", sha, "--format=%(refname:short)"], {
      cwd: this.path,
      allowFailure: true,
    });
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("(HEAD") && !l.endsWith("/HEAD"));
  }

  async commitDiff(sha: string, path: string): Promise<FileDiff> {
    const parents = (await gitOut(["log", "-1", "--format=%P", sha], this.path)).trim();
    const args = parents
      ? ["diff", "--no-ext-diff", "-U3", "-M", `${sha}^1`, sha, "--", path]
      : ["show", "--format=", "--no-ext-diff", "-U3", "-M", sha, "--", path];
    const r = await git(args, { cwd: this.path, maxOutput: 8 * 1024 * 1024 });
    const parsed = parseUnifiedDiff(r.stdout, path);
    if (r.truncated) parsed.truncated = true;
    return parsed;
  }

  async user(): Promise<{ name: string; email: string }> {
    const [n, e] = await Promise.all([
      git(["config", "user.name"], { cwd: this.path, allowFailure: true }),
      git(["config", "user.email"], { cwd: this.path, allowFailure: true }),
    ]);
    return { name: n.stdout.trim(), email: e.stdout.trim() };
  }

  async lastMessage(): Promise<string> {
    const r = await git(["log", "-1", "--format=%B"], { cwd: this.path, allowFailure: true });
    return r.code === 0 ? r.stdout.replace(/\s+$/, "") : "";
  }

  // ───────────── cache for instant first paint ─────────────

  snapshot(): Snapshot {
    return {
      status: this.readCache<RepoStatus>("status.json"),
      refs: this.readCache<RepoRefs>("refs.json"),
      commits: this.readCache<CommitInfo[]>("log.json"),
    };
  }

  private readCache<T>(name: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.cacheDir, name), "utf8")) as T;
    } catch {
      return null;
    }
  }

  private writeCache(name: string, value: unknown): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(join(this.cacheDir, name), JSON.stringify(value));
    } catch {
      /* cache is optional */
    }
  }

  // ───────────── mutations (jobs) ─────────────

  stage(paths: string[]): JobInfo {
    return this.jobs.enqueue(
      this.target,
      `stage ${describePaths(paths)}`,
      async (ctx) => {
        await ctx.git(["add", "-A", "--", ...paths]);
      },
      true,
    );
  }

  unstage(paths: string[]): JobInfo {
    return this.jobs.enqueue(
      this.target,
      `unstage ${describePaths(paths)}`,
      async (ctx) => {
        const head = await ctx.git(["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true });
        if (head.code === 0) await ctx.git(["reset", "-q", "--", ...paths]);
        else await ctx.git(["rm", "-r", "--cached", "-q", "--", ...paths]);
      },
      true,
    );
  }

  commit(message: string, amend: boolean, push: boolean): JobInfo {
    return this.jobs.enqueue(this.target, push ? "commit & push" : amend ? "amend" : "commit", async (ctx) => {
      ctx.setStep("commit");
      const args = ["commit", "-F", "-"];
      if (amend) args.push("--amend");
      await ctx.git(args, { input: message });
      if (push) {
        ctx.setStep("push");
        await this.pushCommand(ctx);
      }
    });
  }

  /** Switches branches in the background. Remote branch → local tracking branch of the same name (created if missing). */
  checkout(branch: string, remote: boolean, stash: boolean): JobInfo {
    const local = remote ? branch.slice(branch.indexOf("/") + 1) : branch;
    return this.jobs.enqueue(this.target, `switch to ${local}`, async (ctx) => {
      let stashed = false;
      if (stash) {
        ctx.setStep("stash changes");
        const r = await ctx.git(["stash", "push", "--include-untracked", "-m", `epic-git: before switching to ${local}`]);
        stashed = !/No local changes to save/i.test(r.stdout + r.stderr);
      }
      ctx.setStep("switch");
      if (remote) {
        const exists = await ctx.git(["rev-parse", "--verify", "-q", `refs/heads/${local}`], { allowFailure: true });
        if (exists.code === 0) await ctx.git(["switch", local]);
        else await ctx.git(["switch", "--track", branch]);
      } else {
        await ctx.git(["switch", branch]);
      }
      if (stashed) {
        ctx.setStep("restore changes");
        await ctx.git(["stash", "pop"]);
      }
    });
  }

  fetch(): JobInfo {
    return this.jobs.enqueue(this.target, "fetch", async (ctx) => {
      await ctx.git(["fetch", "--all", "--prune", "--progress"]);
    });
  }

  pull(): JobInfo {
    return this.jobs.enqueue(this.target, "pull", async (ctx) => {
      await ctx.git(["pull", "--no-rebase", "--progress"]);
    });
  }

  push(): JobInfo {
    return this.jobs.enqueue(this.target, "push", async (ctx) => {
      await this.pushCommand(ctx);
    });
  }

  private async pushCommand(ctx: JobContext): Promise<void> {
    const upstream = await ctx.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
      allowFailure: true,
    });
    if (upstream.code === 0) {
      await ctx.git(["push", "--progress"]);
      return;
    }
    const remotes = (await ctx.git(["remote"])).stdout.split(/\r?\n/).filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) throw new Error("No remote configured");
    ctx.log(`No upstream, pushing to ${remote} and setting it as upstream`);
    await ctx.git(["push", "--progress", "-u", remote, "HEAD"]);
  }
}

/** Clone is a job of a repository that does not exist yet; the target is the destination folder. */
export function enqueueClone(
  jobs: JobManager,
  url: string,
  dest: string,
  recurse: boolean,
  onDone: (dest: string) => void,
): JobInfo {
  const parent = dirname(dest);
  const target: JobTarget = { id: `clone:${dest}`, name: basename(dest), path: parent };
  return jobs.enqueue(target, `clone ${url}`, async (ctx) => {
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const args = ["clone", "--progress"];
    if (recurse) args.push("--recurse-submodules");
    args.push("--", url, dest);
    await ctx.git(args);
    onDone(dest);
  });
}

function describePaths(paths: string[]): string {
  if (paths.length === 1) return basename(paths[0] ?? "");
  return `${paths.length} files`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
