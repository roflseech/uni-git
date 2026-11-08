/**
 * Everything git for one repository: quick reads (status, refs, diff, log) run directly,
 * mutations go through the job queue so the UI can show progress and lock the repository.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type {
  ChangeArea,
  ChangeKind,
  GlobalSettings,
  UnityChoice,
  UnityObjectRef,
  UnityPreview,
  CommitDetails,
  ConfigScope,
  RepoSettings,
  RepoSettingsView,
  TaskPreset,
  TaskTemplate,
  RemoteInfo,
  MergeMode,
  CommitInfo,
  FileDiff,
  FileRef,
  JobInfo,
  RepoEntry,
  RepoOperation,
  RepoRefs,
  RepoStatus,
  Snapshot,
} from "@uni-git/shared";
import { GitError, git, gitOut, type GitResult } from "./git.js";
import { MERGE_TITLES, isUnityYamlPath, mergePlan } from "@uni-git/shared";
import type { JobContext, JobManager, JobTarget } from "./jobs.js";
import { diffForNewFile, looksBinary, parseUnifiedDiff } from "./parse/diff.js";
import { LOG_FORMAT, REFS_FORMAT, parseLog, parseRefs, parseStashes, parseSubmodules } from "./parse/log.js";
import { parseNameStatus, parseStatus } from "./parse/status.js";
import { emitUnityYaml, parseUnityYaml, type UnityFile } from "./parse/unityYaml.js";
import { UnityNames, diffUnity, mergeUnity } from "./parse/unityMerge.js";
import { YAML_MERGE_ARGS, defaultAttributesFile, findUnityYamlMerge, runTool, unityMergeEnv } from "./unity.js";

const MAX_NEW_FILE_BYTES = 4 * 1024 * 1024;
const LOG_PAGE_MAX = 500;
/**
 * Path lists longer than this (characters) do not go on git's command line: Windows limits a whole command line to
 * 32 767 characters (spawn fails with ENAMETOOLONG), and "Stage all" in a big project easily has more.
 */
const PATHS_ON_COMMAND_LINE = 8000;
/** Batches for `clean`, which cannot read paths from stdin: as large as the command line safely allows. */
const CLEAN_BATCH = 24000;

const pathsLength = (paths: string[]): number => paths.reduce((n, p) => n + p.length + 3, 0);

/** NUL-terminated list for `--stdin -z` / `--index-info -z`. */
const nulList = (items: string[]): string => items.map((p) => `${p}\0`).join("");

/**
 * Pathspec for commands that read `--pathspec-from-file` (checkout, restore, add): short lists on the command line
 * (readable in the job log), long ones NUL-separated through stdin. Every pathspec is matched against every index
 * entry, about 9 ns per pair: fine for folders or conflicts; for "Stage all" of 12 000 files it is 3 s on top in a
 * 30 000-file index and about 30 s in a 300 000-file one. Exact file lists go through update-index / checkout-index.
 */
function pathspec(paths: string[]): { args: string[]; opts: { input?: string } } {
  if (pathsLength(paths) <= PATHS_ON_COMMAND_LINE) return { args: ["--", ...paths], opts: {} };
  return { args: ["--pathspec-from-file=-", "--pathspec-file-nul"], opts: { input: paths.join("\0") } };
}

/** For commands without `--pathspec-from-file` (clean): batches that each fit the command line. */
function batches(paths: string[], limit = CLEAN_BATCH): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const p of paths) {
    if (cur.length && len + p.length + 3 > limit) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.length + 3;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Does an index path fall under one of the given paths (the path itself or a file inside a folder path)? */
function underAny(paths: string[]): (p: string) => boolean {
  const set = new Set(paths.map((p) => p.replace(/\/+$/, "")));
  return (p) => {
    if (set.has(p)) return true;
    for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) if (set.has(p.slice(0, i))) return true;
    return false;
  };
}

/** Folders among the paths (`dir/` as status lists a nested repository, or a folder on disk) and everything else. */
async function splitFolders(root: string, paths: string[]): Promise<{ dirs: string[]; files: string[] }> {
  const dirs: string[] = [];
  const files: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const p = paths[next++]!;
      // a path that vanished counts as a file: update-index drops it from the index or skips it
      const dir = p.endsWith("/") || (await lstat(join(root, p)).then((s) => s.isDirectory(), () => false));
      (dir ? dirs : files).push(p);
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, paths.length) }, worker));
  return { dirs, files };
}
/** a Unity scene/prefab version larger than this is not parsed for the preview */
const MAX_UNITY_BYTES = 48 * 1024 * 1024;

export class RepoService {
  private gitDir: string | null = null;
  private readonly cacheDir: string;
  /** script guid → class name (null: not found), from the .cs.meta files of the repository */
  private readonly scripts = new Map<string, string | null>();

  constructor(
    readonly entry: RepoEntry,
    private readonly dataDir: string,
    private readonly jobs: JobManager,
    private readonly globalSettings: () => GlobalSettings = () => ({}),
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

  async status(dataDir?: string): Promise<RepoStatus> {
    const r = await gitOut(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], this.path);
    const status = parseStatus(r);
    status.operation = await this.operation();
    if (dataDir) status.template = readRepoSettings(dataDir, this.entry.id).template ?? null;
    if (dataDir && status.head) {
      // ahead/behind of the main branch, always visible in the toolbar (plan: "questions about branches")
      try {
        const main = await this.mainBranch(dataDir);
        status.mainBranch = main.name;
        if (main.name !== status.branch) {
          const lr = await git(["rev-list", "--left-right", "--count", `${main.name}...HEAD`], { cwd: this.path, allowFailure: true });
          const m = /^(\d+)\s+(\d+)/.exec(lr.stdout.trim());
          if (lr.code === 0 && m) {
            status.behindMain = Number(m[1]);
            status.aheadOfMain = Number(m[2]);
          }
        }
      } catch {
        /* no main branch yet */
      }
    }
    this.writeCache("status.json", status);
    return status;
  }

  /** Message git prepared for the merge in progress (MERGE_MSG), for the commit form. */
  async mergeMessage(): Promise<string> {
    const dir = await this.resolveGitDir();
    if (!dir) return "";
    for (const f of ["MERGE_MSG", "SQUASH_MSG"]) {
      const p = join(dir, f);
      if (existsSync(p)) return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => !l.startsWith("#")).join("\n").trim();
    }
    return "";
  }

  async stashSha(ref: string): Promise<string> {
    return (await gitOut(["rev-parse", ref], this.path)).trim();
  }

  async remoteUrl(name: string): Promise<string> {
    const r = await git(["remote", "get-url", name], { cwd: this.path, allowFailure: true });
    return r.code === 0 ? r.stdout.trim() : "";
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
    if (file.area === "conflict" && isUnityYamlPath(file.path)) {
      // UnityYAMLMerge leaves no conflict markers in the working copy: the raw view of a scene/prefab is ours → theirs
      const r = await git(["diff", "--no-ext-diff", "-U3", `:2:${file.path}`, `:3:${file.path}`], { cwd: this.path, allowFailure: true, maxOutput: 8 * 1024 * 1024 });
      const parsed = parseUnifiedDiff(r.stdout, file.path);
      if (r.code === 0 && parsed.hunks.length) {
        if (r.truncated) parsed.truncated = true;
        parsed.note = "Raw YAML: ours (left) → theirs (right)";
        return parsed;
      }
    }
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

  async log(skip: number, limit: number, text?: string, author?: string, ref?: string, task?: string): Promise<{ commits: CommitInfo[]; hasMore: boolean }> {
    const n = Math.min(Math.max(limit, 1), LOG_PAGE_MAX);
    const args = ["log", `--format=${LOG_FORMAT}`, `--skip=${Math.max(skip, 0)}`, `--max-count=${n + 1}`, "--decorate=short"];
    if (text) args.push("-i", `--grep=${text}`);
    if (task) args.push("-i", `--grep=${task}`);
    if (text && task) args.push("--all-match");
    if (author) args.push("-i", `--author=${author}`);
    args.push(ref?.trim() ? ref.trim() : "HEAD", "--");
    const r = await git(args, { cwd: this.path, allowFailure: true });
    if (r.code !== 0) {
      // unborn branch or no HEAD yet
      return { commits: [], hasMore: false };
    }
    const commits = parseLog(r.stdout);
    const hasMore = commits.length > n;
    const page = hasMore ? commits.slice(0, n) : commits;
    if (skip === 0 && !text && !author && !ref && !task) this.writeCache("log.json", page);
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

  // ───────────── Unity scenes / prefabs ─────────────

  /** A blob (`HEAD:path`, `:2:path`…), undefined when it does not exist. */
  private async blob(rev: string): Promise<string | undefined> {
    const r = await git(["cat-file", "blob", rev], { cwd: this.path, allowFailure: true, maxOutput: MAX_UNITY_BYTES });
    if (r.truncated) throw new Error(`Too large to preview (over ${MAX_UNITY_BYTES >> 20} MB)`);
    return r.code === 0 ? r.stdout : undefined;
  }

  private async workingText(path: string): Promise<string | undefined> {
    const full = join(this.path, path);
    try {
      if ((await stat(full)).size > MAX_UNITY_BYTES) throw new Error(`Too large to preview (over ${MAX_UNITY_BYTES >> 20} MB)`);
      return await readFile(full, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /** Index stages of a conflicted file: base (absent when both added it), ours, theirs. */
  private async stages(path: string): Promise<[string | undefined, string | undefined, string | undefined]> {
    const [b, o, t] = await Promise.all([1, 2, 3].map((n) => this.blob(`:${n}:${path}`)));
    return [b, o, t];
  }

  /** UnityYAMLMerge for this repository, null when switched off or not installed. */
  yamlMergeTool(): string | null {
    const s = this.globalSettings();
    return s.unityMerge === false ? null : findUnityYamlMerge(this.path, s.unityYamlMerge);
  }

  /**
   * Objects and properties instead of text. Conflicted: merged from the index stages, with the conflicts left;
   * otherwise the versions the text diff compares (index ↔ working copy, HEAD ↔ index, a commit ↔ its first parent).
   */
  async unityPreview(path: string, area?: ChangeArea, kind?: ChangeKind, sha?: string): Promise<UnityPreview> {
    const result = (mode: UnityPreview["mode"], extra: Partial<UnityPreview> = {}): UnityPreview => ({ path, mode, objects: [], conflicts: [], total: 0, ...extra });
    if (!isUnityYamlPath(path)) return result("diff", { error: "Not a Unity scene, prefab or asset" });
    const parse = (text: string | undefined): UnityFile | undefined => (text === undefined ? undefined : parseUnityYaml(text));
    try {
      if (area === "conflict") {
        const yamlMerge = this.yamlMergeTool();
        const [b, o, t] = await this.stages(path);
        if (o === undefined || t === undefined) return result("merge", { yamlMerge, error: `${o === undefined ? "Deleted on our side" : "Deleted on their side"} and changed on the other: take ours or theirs` });
        const [bf, of, tf] = [parse(b), parse(o)!, parse(t)!];
        const names = new UnityNames([of, tf, bf]);
        const m = mergeUnity(bf, of, tf, names);
        // what the merge brings into ours; conflicts hold ours until chosen
        const objects = diffUnity(of, m.file, names);
        await this.nameScripts(names, [...objects, ...m.conflicts]);
        return result("merge", { yamlMerge, objects, conflicts: m.conflicts, total: of.docs.length });
      }
      let before: string | undefined;
      let after: string | undefined;
      if (sha) {
        [before, after] = await Promise.all([this.blob(`${sha}^1:${path}`), this.blob(`${sha}:${path}`)]);
      } else if (area === "staged") {
        [before, after] = await Promise.all([kind === "A" ? undefined : this.blob(`HEAD:${path}`), kind === "D" ? undefined : this.blob(`:${path}`)]);
      } else {
        [before, after] = await Promise.all([kind === "?" ? undefined : this.blob(`:${path}`), kind === "D" ? undefined : this.workingText(path)]);
      }
      const [bf, af] = [parse(before), parse(after)];
      const names = new UnityNames([af, bf]);
      const objects = diffUnity(bf, af, names);
      await this.nameScripts(names, objects);
      return result("diff", { objects, total: af?.docs.length ?? 0 });
    } catch (e) {
      return result(area === "conflict" ? "merge" : "diff", { error: (e as Error).message });
    }
  }

  /** Fills `script` of MonoBehaviours: the .cs.meta with the guid of their m_Script (git grep, cached). */
  private async nameScripts(names: UnityNames, refs: UnityObjectRef[]): Promise<void> {
    const want = refs.filter((r) => r.type === "MonoBehaviour" && !r.script);
    const guids = [...new Set(want.map((r) => names.guidOf(r.fileId)).filter((g): g is string => !!g))];
    const missing = guids.filter((g) => !this.scripts.has(g)).slice(0, 300);
    if (missing.length) {
      const r = await git(["grep", "-l", "-F", ...missing.flatMap((g) => ["-e", `guid: ${g}`]), "--", "*.cs.meta"], { cwd: this.path, allowFailure: true });
      for (const g of missing) this.scripts.set(g, null);
      for (const file of r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 600)) {
        try {
          const g = /guid: ([0-9a-f]{32})/.exec(await readFile(join(this.path, file), "utf8"))?.[1];
          if (g && this.scripts.has(g)) this.scripts.set(g, basename(file).replace(/\.cs\.meta$/i, ""));
        } catch {
          /* file vanished */
        }
      }
    }
    for (const r of want) {
      const g = names.guidOf(r.fileId);
      const name = g ? this.scripts.get(g) : null;
      if (name) r.script = name;
    }
  }

  /** Writes the merge of a conflicted Unity file with the given choices (every conflict needs one) and stages it. */
  unityResolve(path: string, choices: Record<string, UnityChoice>): JobInfo {
    return this.jobs.enqueue(
      this.target,
      `resolve ${basename(path)}`,
      async (ctx) => {
        const [b, o, t] = await this.stages(path);
        if (o === undefined || t === undefined) throw new Error("One side deleted the file: take ours or theirs");
        const [bf, of, tf] = [b === undefined ? undefined : parseUnityYaml(b), parseUnityYaml(o), parseUnityYaml(t)];
        const m = mergeUnity(bf, of, tf, new UnityNames([of, tf, bf]), choices);
        if (m.open) throw new Error(`${m.open} conflict${m.open === 1 ? "" : "s"} in ${basename(path)} still need a choice`);
        // keep the line endings the working copy has (autocrlf)
        const current = await this.workingText(path).catch(() => undefined);
        await writeFile(join(this.path, path), emitUnityYaml({ ...m.file, eol: current?.includes("\r\n") ? "\r\n" : of.eol }));
        ctx.log(`${path}: merged, ${m.conflicts.length} conflict${m.conflicts.length === 1 ? "" : "s"} resolved by choice`);
        await ctx.git(["add", "--", path]);
      },
      true,
    );
  }

  /** Runs UnityYAMLMerge on conflicted files; what it merges cleanly is written and staged, the rest stays conflicted. */
  unityYamlMerge(paths: string[]): JobInfo {
    return this.jobs.enqueue(this.target, `UnityYAMLMerge ${describePaths(paths)}`, async (ctx) => {
      const tool = findUnityYamlMerge(this.path, this.globalSettings().unityYamlMerge);
      if (!tool) throw new Error("UnityYAMLMerge not found: install the project's Unity version in Unity Hub or set its path in Global Settings");
      const dir = await mkdtemp(join(tmpdir(), "unigit-yaml-"));
      const merged: string[] = [];
      const left: string[] = [];
      try {
        for (const path of paths) {
          ctx.setStep(basename(path));
          const [b, o, t] = await this.stages(path);
          if (b === undefined || o === undefined || t === undefined) {
            ctx.log(`${path}: added or deleted on one side, skipped`);
            left.push(path);
            continue;
          }
          const f = (name: string) => join(dir, `${name}${extname(path)}`);
          await Promise.all([writeFile(f("base"), b), writeFile(f("theirs"), t), writeFile(f("ours"), o)]);
          const r = await runTool(tool, [...YAML_MERGE_ARGS, f("base"), f("theirs"), f("ours"), f("merged")], ctx.signal);
          ctx.log(`$ UnityYAMLMerge ${path} → exit ${r.code}\n${r.output.trim()}`);
          if (r.code !== 0) {
            left.push(path);
            continue;
          }
          const out = await readFile(f("merged"), "utf8");
          const current = await this.workingText(path).catch(() => undefined);
          await writeFile(join(this.path, path), current?.includes("\r\n") ? out.replace(/\r?\n/g, "\r\n") : out);
          await ctx.git(["add", "--", path]);
          merged.push(path);
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      if (left.length) ctx.log(`left conflicted: ${left.join(", ")}`);
      if (!merged.length) throw new Error(`UnityYAMLMerge could not merge ${left.length === 1 ? basename(left[0]!) : `${left.length} files`}: pick the resolutions in the preview`);
    });
  }

  /**
   * Environment for a git command that may merge: UnityYAMLMerge becomes git's merge driver for scenes/prefabs
   * (nothing is written to the repository). {} when switched off or not installed.
   */
  private async mergeEnv(): Promise<Record<string, string>> {
    const tool = this.yamlMergeTool();
    if (!tool) return {};
    const r = await git(["config", "--get", "core.attributesFile"], { cwd: this.path, allowFailure: true });
    const own = r.code === 0 ? r.stdout.trim().replace(/^~(?=[\\/])/, homedir()) : "";
    return unityMergeEnv(this.dataDir, tool, own || defaultAttributesFile());
  }

  /** Job log: which scenes/prefabs UnityYAMLMerge merged ("Auto-merging x" without a CONFLICT for x). */
  private logUnityMerges(ctx: JobContext, r: GitResult, env: Record<string, string>): void {
    if (!env.GIT_CONFIG_COUNT) return;
    const out = `${r.stdout}\n${r.stderr}`;
    const auto = [...out.matchAll(/^Auto-merging (.+)$/gm)].map((m) => m[1]!.trim()).filter(isUnityYamlPath);
    if (!auto.length) return;
    const conflicted = new Set([...out.matchAll(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/gm)].map((m) => m[1]!.trim()));
    const merged = auto.filter((p) => !conflicted.has(p));
    const left = auto.filter((p) => conflicted.has(p));
    if (merged.length) ctx.log(`UnityYAMLMerge merged ${merged.join(", ")}`);
    if (left.length) ctx.log(`UnityYAMLMerge left conflicts in ${left.join(", ")}: the Changes view lists them object by object (Preview)`);
  }

  // ───────────── settings ─────────────

  private async configWithScope(key: string): Promise<{ value: string; scope: ConfigScope }> {
    const r = await git(["config", "--show-scope", "--get", key], { cwd: this.path, allowFailure: true });
    if (r.code !== 0) return { value: "", scope: "none" };
    const line = r.stdout.trimEnd().split(/\r?\n/).pop() ?? "";
    const tab = line.indexOf("\t");
    if (tab < 0) return { value: line.trim(), scope: "none" };
    return { value: line.slice(tab + 1), scope: line.slice(0, tab) as ConfigScope };
  }

  private async localBranches(): Promise<string[]> {
    return (await gitOut(["for-each-ref", "--format=%(refname:short)", "refs/heads"], this.path)).split(/\r?\n/).filter(Boolean);
  }

  /** The branch the user picked in Repo Settings, else a detected one (origin/HEAD, main, master, develop). */
  async mainBranch(dataDir: string): Promise<{ name: string; auto: boolean }> {
    const explicit = readRepoSettings(dataDir, this.entry.id).mainBranch;
    const refs = await this.localBranches();
    if (explicit && refs.includes(explicit)) return { name: explicit, auto: false };
    const originHead = await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: this.path, allowFailure: true });
    const fromRemote = originHead.code === 0 ? originHead.stdout.trim().replace(/^origin\//, "") : "";
    for (const candidate of [fromRemote, "main", "master", "develop"]) {
      if (candidate && refs.includes(candidate)) return { name: candidate, auto: true };
    }
    return { name: refs[0] ?? "master", auto: true };
  }

  async settings(dataDir: string, presets: TaskPreset[]): Promise<RepoSettingsView> {
    const saved = readRepoSettings(dataDir, this.entry.id);
    const [name, email, main, branches] = await Promise.all([
      this.configWithScope("user.name"),
      this.configWithScope("user.email"),
      this.mainBranch(dataDir),
      this.localBranches(),
    ]);
    return {
      path: this.path,
      groupId: this.entry.groupId,
      mainBranch: main.name,
      mainBranchAuto: main.auto,
      userName: name.value,
      userNameScope: name.scope,
      userEmail: email.value,
      userEmailScope: email.scope,
      branches,
      template: saved.template ?? null,
      presetName: saved.presetName ?? null,
      presets,
    };
  }

  /** Main branch and task template go to data/repos/<id>.json; user.name / user.email go to .git/config when they changed. */
  async saveSettings(
    dataDir: string,
    mainBranch: string | null,
    userName: string,
    userEmail: string,
    template: TaskTemplate | null,
    presetName: string | null,
  ): Promise<void> {
    const next: RepoSettings = { ...readRepoSettings(dataDir, this.entry.id) };
    if (mainBranch) next.mainBranch = mainBranch;
    else delete next.mainBranch;
    if (template) next.template = template;
    else delete next.template;
    if (presetName) next.presetName = presetName;
    else delete next.presetName;
    writeRepoSettings(dataDir, this.entry.id, next);
    const [name, email] = await Promise.all([this.configWithScope("user.name"), this.configWithScope("user.email")]);
    await this.writeConfig("user.name", userName.trim(), name);
    await this.writeConfig("user.email", userEmail.trim(), email);
  }

  private async writeConfig(key: string, value: string, current: { value: string; scope: ConfigScope }): Promise<void> {
    if (value === current.value) return;
    if (value) await git(["config", "--local", key, value], { cwd: this.path });
    else if (current.scope === "local") await git(["config", "--local", "--unset", key], { cwd: this.path, allowFailure: true });
  }

  /** "Is branch A merged into B?" for several B at once. */
  async mergedInto(branch: string, into: string[]): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    await Promise.all(
      into.map(async (target) => {
        const r = await git(["merge-base", "--is-ancestor", branch, target], { cwd: this.path, allowFailure: true });
        out[target] = r.code === 0;
      }),
    );
    return out;
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
        // the listed files only: "Stage all" must not mark conflicted files resolved, which a bare `git add -A` would
        await this.addPaths(ctx, paths);
      },
      true,
    );
  }

  /**
   * Stages exactly these paths, new, modified or deleted, like `git add -A -- <paths>`, with two differences that
   * matter in a big project. A path that vanished since the status was read (an editor's temporary file) is skipped;
   * `git add` fails the whole list with "pathspec did not match" and stages nothing. And update-index looks each path
   * up instead of matching every index entry against every pathspec (see pathspec()). Writing the new blobs costs the
   * same either way (3–7 ms per new file on Windows, file system and antivirus). Folders (a submodule, a nested
   * repository, a folder an API caller names) still go through `git add`, which expands them.
   */
  private async addPaths(ctx: JobContext, paths: string[]): Promise<void> {
    const { dirs, files } = await splitFolders(this.path, paths);
    if (files.length) {
      if (files.length > 1) ctx.log(`${files.length} paths through stdin`);
      // --replace: a file may take the place of a folder (and back); skip-worktree entries are never removed
      await ctx.git(["update-index", "--add", "--remove", "--replace", "--ignore-skip-worktree-entries", "-z", "--stdin"], { input: nulList(files) });
    }
    if (dirs.length) {
      const ps = pathspec(dirs);
      await ctx.git(["add", "-A", ...ps.args], ps.opts);
    }
  }

  unstage(paths: string[]): JobInfo {
    return this.jobs.enqueue(
      this.target,
      `unstage ${describePaths(paths)}`,
      async (ctx) => {
        // with paths: a bare `git reset` would also end a merge in progress and drop the conflict stages
        await this.resetPaths(ctx, paths);
      },
      true,
    );
  }

  /**
   * Index entries of these paths (files, or everything inside folder paths) back to HEAD, as `git reset -- <paths>`
   * does, in time linear in the number of paths: one `diff-index --cached` lists what is staged and
   * `update-index --index-info` writes the HEAD side back. Before the first commit the entries leave the index.
   */
  private async resetPaths(ctx: JobContext, paths: string[]): Promise<void> {
    const wanted = underAny(paths);
    const head = await ctx.git(["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true });
    if (head.code !== 0) {
      const listed = await ctx.git(["ls-files", "-z"]);
      const drop = [...new Set(listed.stdout.split("\0").filter((p) => p && wanted(p)))];
      if (drop.length) await ctx.git(["update-index", "--force-remove", "-z", "--stdin"], { input: nulList(drop) });
      return;
    }
    // ":<HEAD mode> <index mode> <HEAD oid> <index oid> <status>" NUL path NUL, for every staged change
    const staged = (await ctx.git(["diff-index", "--cached", "-z", "--no-renames", "HEAD", "--"])).stdout.split("\0");
    const info: string[] = [];
    for (let i = 0; i + 1 < staged.length; i += 2) {
      const meta = staged[i]!;
      const path = staged[i + 1]!;
      if (!meta.startsWith(":") || !wanted(path)) continue;
      const [headMode = "", , headOid = ""] = meta.slice(1).split(" ");
      // not in HEAD (added): mode 0 removes the entry; the oid is diff-index's all-zero one, of the repository's length
      info.push(`${/^0+$/.test(headMode) ? "0" : headMode} ${headOid}\t${path}`);
    }
    if (!info.length) return;
    if (info.length > 1) ctx.log(`${info.length} paths through stdin`);
    await ctx.git(["update-index", "-z", "--index-info"], { input: nulList(info) });
  }

  commit(message: string, amend: boolean, push: boolean): JobInfo {
    return this.jobs.enqueue(this.target, push ? "commit & push" : amend ? "amend" : "commit", async (ctx) => {
      ctx.setStep("commit");
      // a merge/cherry-pick in progress is concluded by this commit; --allow-empty keeps "nothing new" merges committable
      const op = await this.operation();
      const args = ["commit", "-F", "-"];
      if (op === "merge") args.push("--allow-empty");
      if (amend) args.push("--amend");
      await ctx.git(args, { input: message });
      if (push) {
        ctx.setStep("push");
        await this.pushCommand(ctx);
      }
    });
  }

  /** Switches branches in the background. Remote branch → local tracking branch of the same name (created if missing). */
  checkout(branch: string, remote: boolean, stash: boolean, discard = false): JobInfo {
    const local = remote ? branch.slice(branch.indexOf("/") + 1) : branch;
    return this.jobs.enqueue(this.target, `switch to ${local}`, async (ctx) => {
      let stashed = false;
      if (discard) {
        ctx.setStep("discard changes");
        await this.discardAll(ctx);
      }
      if (stash) {
        ctx.setStep("stash changes");
        const r = await ctx.git(["stash", "push", "--include-untracked", "-m", `uni-git: before switching to ${local}`]);
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
        await ctx.git(["stash", "pop"], { env: await this.mergeEnv() });
      }
    });
  }

  createBranch(name: string, from: string, checkout: boolean): JobInfo {
    return this.jobs.enqueue(this.target, `new branch ${name}`, async (ctx) => {
      if (checkout) await ctx.git(["switch", "-c", name, from]);
      else await ctx.git(["branch", name, from]);
    });
  }

  deleteBranch(name: string, remote: boolean, force: boolean): JobInfo {
    if (remote) {
      const slash = name.indexOf("/");
      const remoteName = name.slice(0, slash);
      const branch = name.slice(slash + 1);
      return this.jobs.enqueue(this.target, `delete ${name}`, async (ctx) => {
        // full ref: a bare name would be ambiguous on a remote that also has a tag of that name
        await ctx.git(["push", "--progress", remoteName, "--delete", `refs/heads/${branch}`]);
      });
    }
    return this.jobs.enqueue(
      this.target,
      `delete branch ${name}`,
      async (ctx) => {
        await ctx.git(["branch", force ? "-D" : "-d", name]);
      },
      true,
    );
  }

  renameBranch(from: string, to: string): JobInfo {
    return this.jobs.enqueue(
      this.target,
      `rename ${from} to ${to}`,
      async (ctx) => {
        await ctx.git(["branch", "-m", from, to]);
      },
      true,
    );
  }

  merge(branch: string): JobInfo {
    return this.jobs.enqueue(this.target, `merge ${branch}`, async (ctx) => {
      const env = await this.mergeEnv();
      const r = await ctx.git(["merge", "--no-edit", branch], { allowFailure: true, env });
      this.logUnityMerges(ctx, r, env);
      if (r.code !== 0) {
        const conflicts = (await ctx.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
        if (conflicts) throw new Error(`Merge stopped with conflicts in ${conflicts.split(/\r?\n/).length} file(s), resolve them in Changes`);
        throw new Error(GitError.describe(["merge", branch], r));
      }
    });
  }

  /** Throws away working-copy changes of the given paths: tracked files are restored, untracked ones deleted. */
  /** Working copy and index back to HEAD, untracked files deleted (`reset --hard` + `clean -fd`). */
  private async discardAll(ctx: JobContext): Promise<void> {
    const head = await ctx.git(["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true });
    if (head.code === 0) await ctx.git(["reset", "-q", "--hard"]);
    else await ctx.git(["rm", "-r", "-q", "--cached", "--", "."], { allowFailure: true });
    await ctx.git(["clean", "-f", "-d", "-q"]);
  }

  discard(paths: string[], all = false): JobInfo {
    return this.jobs.enqueue(
      this.target,
      all ? "discard all changes" : `discard ${describePaths(paths)}`,
      async (ctx) => {
        if (all) {
          await this.discardAll(ctx);
          return;
        }
        // tracked files under the paths: ls-files of the paths, or of everything when they do not fit one command line
        const short = pathsLength(paths) <= PATHS_ON_COMMAND_LINE;
        const listed = await ctx.git(["ls-files", "-z", ...(short ? ["--", ...paths] : [])], { allowFailure: true });
        const wanted = underAny(paths);
        const tracked = [...new Set(listed.stdout.split("\0").filter((p) => p && wanted(p)))];
        if (tracked.length) await this.restoreFromHead(ctx, tracked);
        // a folder path counts as tracked when a tracked file is inside it; the rest is untracked
        const trackedSet = new Set(tracked);
        const trackedDirs = new Set<string>();
        for (const t of tracked) for (let i = t.indexOf("/"); i > 0; i = t.indexOf("/", i + 1)) trackedDirs.add(t.slice(0, i));
        const untracked = paths.filter((p) => !trackedSet.has(p) && !trackedDirs.has(p.replace(/\/+$/, "")));
        // clean has no --pathspec-from-file; it never deletes ignored files or nested repositories
        for (const batch of batches(untracked)) await ctx.git(["clean", "-f", "-d", "--", ...batch]);
      },
      true,
    );
  }

  /**
   * Working copy of these tracked files back to HEAD, the index left as it is (`git restore --worktree --source=HEAD`).
   * A file whose index entry equals HEAD's (the usual case) is written from the index by `checkout-index -u`, which
   * also stores the new file size and time in the index. `restore --worktree --source=HEAD` does not: with autocrlf
   * the restored file gets CRLF, its size no longer matches the index, and git then reports it modified without
   * reading it, so discarded files stayed in the list. Only files with staged changes or conflicts go through restore
   * (whose pathspec matching also costs paths × index size, see pathspec()).
   */
  private async restoreFromHead(ctx: JobContext, files: string[]): Promise<void> {
    let viaRestore = files;
    let viaIndex: string[] = [];
    const head = await ctx.git(["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true });
    if (head.code === 0) {
      const staged = new Set<string>();
      const out = (await ctx.git(["diff-index", "--cached", "-z", "--no-renames", "HEAD", "--"])).stdout.split("\0");
      for (let i = 0; i + 1 < out.length; i += 2) if (out[i]!.startsWith(":")) staged.add(out[i + 1]!);
      viaIndex = files.filter((p) => !staged.has(p));
      viaRestore = files.filter((p) => staged.has(p));
    }
    if (viaIndex.length) {
      if (viaIndex.length > 1) ctx.log(`${viaIndex.length} paths through stdin`);
      // -u: the new size and time go into the index (see above), the file is not reported modified afterwards
      await ctx.git(["checkout-index", "-u", "-f", "-z", "--stdin"], { input: nulList(viaIndex) });
    }
    if (viaRestore.length) {
      const ps = pathspec(viaRestore);
      await ctx.git(["restore", "--worktree", "--source=HEAD", ...ps.args], ps.opts);
    }
  }

  /** Appends patterns to the .gitignore at the repository root. */
  ignore(patterns: string[]): JobInfo {
    return this.jobs.enqueue(
      this.target,
      `ignore ${patterns.length === 1 ? patterns[0] : `${patterns.length} patterns`}`,
      async (ctx) => {
        const file = join(this.path, ".gitignore");
        const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
        const lines = new Set(existing.split(/\r?\n/));
        const fresh = patterns.filter((p) => !lines.has(p));
        if (!fresh.length) return;
        const eol = existing.includes("\r\n") ? "\r\n" : "\n";
        const prefix = existing && !existing.endsWith("\n") ? eol : "";
        appendFileSync(file, prefix + fresh.join(eol) + eol);
        ctx.log(`added to .gitignore: ${fresh.join(", ")}`);
      },
      true,
    );
  }

  /** Stage or unstage part of a file: the UI sends a unified diff built from the hunks it shows. */
  applyPatch(patch: string, reverse: boolean): JobInfo {
    return this.jobs.enqueue(
      this.target,
      reverse ? "unstage hunk" : "stage hunk",
      async (ctx) => {
        const args = ["apply", "--cached", "--whitespace=nowarn"];
        if (reverse) args.push("--reverse");
        await ctx.git(args, { input: patch });
      },
      true,
    );
  }

  fetch(): JobInfo {
    return this.jobs.enqueue(this.target, "fetch", async (ctx) => {
      await ctx.git(["fetch", "--all", "--prune", "--progress"]);
    });
  }

  pull(discard = false): JobInfo {
    return this.jobs.enqueue(this.target, discard ? "discard & pull" : "pull", async (ctx) => {
      if (discard) {
        ctx.setStep("discard changes");
        await this.discardAll(ctx);
        ctx.setStep("pull");
      }
      const env = await this.mergeEnv();
      const r = await ctx.git(["pull", "--no-rebase", "--progress"], { allowFailure: true, env });
      this.logUnityMerges(ctx, r, env);
      if (r.code !== 0) throw new GitError(["pull"], r);
    });
  }

  push(force = false, tags = false): JobInfo {
    const title = tags ? "push tags" : force ? "force push" : "push";
    return this.jobs.enqueue(this.target, title, async (ctx) => {
      if (tags) {
        const remote = await this.defaultRemote(ctx);
        await ctx.git(["push", "--progress", "--tags", remote]);
        return;
      }
      await this.pushCommand(ctx, force);
    });
  }

  private async defaultRemote(ctx: JobContext): Promise<string> {
    const remotes = (await ctx.git(["remote"])).stdout.split(/\r?\n/).filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) throw new Error("No remote configured");
    return remote;
  }

  // ───────────── merge scenarios (plan, section 3) ─────────────

  mergeScenario(dataDir: string, mode: MergeMode, stash: boolean): JobInfo {
    return this.jobs.enqueue(this.target, MERGE_TITLES[mode], async (ctx) => {
      const main = (await this.mainBranch(dataDir)).name;
      const current = (await ctx.git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      if (current === "HEAD") throw new Error("HEAD is detached, switch to a branch first");
      if (current === main && mode !== "force-main") throw new Error(`Already on ${main}`);
      const remote = mode === "main" ? "origin" : await this.defaultRemote(ctx);
      // the same plan the UI previews on hover
      const steps = mergePlan(mode, { main, current, remote, stash });
      const conflicted = async () => (await ctx.git(["diff", "--name-only", "--diff-filter=U"])).stdout.trim().length > 0;
      // scenes and prefabs merge with UnityYAMLMerge in every step that merges (merge, pull, stash pop)
      const env = await this.mergeEnv();
      let stashed = false;
      let n = 0;
      for (const step of steps) {
        if (step.kind === "unstash" && !stashed) continue;
        ctx.setStep(`step ${++n} of ${steps.length}: ${step.label}`);
        if (step.kind === "stash") {
          const r = await ctx.git(step.args);
          stashed = !/No local changes to save/i.test(r.stdout + r.stderr);
          continue;
        }
        if (step.kind === "merge") {
          const r = await ctx.git(step.args, { allowFailure: true, env });
          this.logUnityMerges(ctx, r, env);
          if (r.code !== 0 || (await conflicted())) {
            const where = mode === "into-main" ? ` on ${main}; push was not done` : "";
            throw new Error(`Merge stopped with conflicts${where}, resolve them in Changes${stashed ? " (your stash is kept)" : ""}`);
          }
          continue;
        }
        const r = await ctx.git(step.args, { env });
        this.logUnityMerges(ctx, r, env);
      }
    });
  }

  // ───────────── authentication profile of this repository (.git/config) ─────────────

  async authRemotes(): Promise<RemoteInfo[]> {
    const r = await git(["remote", "-v"], { cwd: this.path, allowFailure: true });
    const out: RemoteInfo[] = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const [name, url, kind] = line.split(/\s+/);
      if (!name || !url || kind !== "(fetch)") continue;
      const local = /^([A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|file:)/.test(url);
      const https = local ? null : /^https?:\/\/(?:[^@\/]+@)?([^\/:]+)/.exec(url);
      const ssh = local || https ? null : /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)(?::|\/)/.exec(url);
      out.push({ name, url, protocol: https ? "https" : ssh ? "ssh" : "other", host: local ? "local path" : (https?.[1] ?? ssh?.[1] ?? "").toLowerCase() });
    }
    return out;
  }

  async authConfig(): Promise<{ username: string; sshKey: string }> {
    const u = await git(["config", "--local", "--get", "credential.username"], { cwd: this.path, allowFailure: true });
    const c = await git(["config", "--local", "--get", "core.sshCommand"], { cwd: this.path, allowFailure: true });
    const key = c.code === 0 ? (/-i\s+"([^"]+)"|-i\s+(\S+)/.exec(c.stdout.trim())?.[1] ?? /-i\s+(\S+)/.exec(c.stdout.trim())?.[1] ?? "") : "";
    return { username: u.code === 0 ? u.stdout.trim() : "", sshKey: key };
  }

  /** Empty values remove the setting so git falls back to the helper / ssh defaults. */
  async saveAuth(username: string, sshKey: string): Promise<void> {
    if (username.trim()) await git(["config", "--local", "credential.username", username.trim()], { cwd: this.path });
    else await git(["config", "--local", "--unset", "credential.username"], { cwd: this.path, allowFailure: true });
    if (sshKey.trim()) {
      const p = sshKey.trim().replace(/\\/g, "/");
      await git(["config", "--local", "core.sshCommand", `ssh -i "${p}" -o IdentitiesOnly=yes`], { cwd: this.path });
    } else {
      await git(["config", "--local", "--unset", "core.sshCommand"], { cwd: this.path, allowFailure: true });
    }
  }

  testRemotes(): JobInfo {
    return this.jobs.enqueue(this.target, "test connection", async (ctx) => {
      const remotes = await this.authRemotes();
      if (!remotes.length) throw new Error("No remotes configured");
      for (const r of remotes) {
        ctx.setStep(`${r.name} (${r.host})`);
        await ctx.git(["ls-remote", "--exit-code", r.name, "HEAD"]);
        ctx.log(`${r.name}: ok`);
      }
    });
  }

  // ───────────── conflicts / operations in progress ─────────────

  resolveConflict(paths: string[], take: "ours" | "theirs" | "mark"): JobInfo {
    const label = take === "mark" ? "mark resolved" : `take ${take}`;
    return this.jobs.enqueue(
      this.target,
      `${label}: ${describePaths(paths)}`,
      async (ctx) => {
        if (take !== "mark") {
          // --no-overlay: a file the chosen side deleted is deleted. A plain `checkout --ours` refuses the whole list
          // when one file lacks that side, and staging the files as they are would then commit the conflict markers of
          // all the others; so a failure here stops the job before anything is staged.
          const ps = pathspec(paths);
          await ctx.git(["checkout", "--no-overlay", `--${take}`, ...ps.args], ps.opts);
        }
        await this.addPaths(ctx, paths);
      },
      true,
    );
  }

  abortOperation(): JobInfo {
    return this.jobs.enqueue(this.target, "abort", async (ctx) => {
      const op = await this.operation();
      if (op === "merge") await ctx.git(["merge", "--abort"]);
      else if (op === "cherry-pick") await ctx.git(["cherry-pick", "--abort"]);
      else if (op === "revert") await ctx.git(["revert", "--abort"]);
      else if (op === "rebase") await ctx.git(["rebase", "--abort"]);
      else throw new Error("No operation in progress");
    });
  }

  continueOperation(): JobInfo {
    return this.jobs.enqueue(this.target, "continue", async (ctx) => {
      const op = await this.operation();
      const env = { GIT_EDITOR: "true" };
      if (op === "merge") await ctx.git(["commit", "--no-edit"], { env });
      else if (op === "cherry-pick") await ctx.git(["cherry-pick", "--continue"], { env });
      else if (op === "revert") await ctx.git(["revert", "--continue"], { env });
      else if (op === "rebase") await ctx.git(["rebase", "--continue"], { env });
      else throw new Error("No operation in progress");
    });
  }

  cherryPick(shas: string[]): JobInfo {
    const title = shas.length === 1 ? `cherry-pick ${shas[0]?.slice(0, 7)}` : `cherry-pick ${shas.length} commits`;
    return this.jobs.enqueue(this.target, title, async (ctx) => {
      const env = await this.mergeEnv();
      const r = await ctx.git(["cherry-pick", ...shas], { allowFailure: true, env: { ...env, GIT_EDITOR: "true" } });
      this.logUnityMerges(ctx, r, env);
      if (r.code !== 0) throw new Error("Cherry-pick stopped with conflicts, resolve them in Changes");
    });
  }

  // ───────────── stash ─────────────

  stashSave(message: string, includeUntracked: boolean): JobInfo {
    return this.jobs.enqueue(this.target, "stash", async (ctx) => {
      const args = ["stash", "push"];
      if (includeUntracked) args.push("--include-untracked");
      if (message.trim()) args.push("-m", message.trim());
      const r = await ctx.git(args);
      if (/No local changes to save/i.test(r.stdout + r.stderr)) throw new Error("No local changes to stash");
    });
  }

  stashApply(ref: string, pop: boolean): JobInfo {
    return this.jobs.enqueue(this.target, `${pop ? "pop" : "apply"} ${ref}`, async (ctx) => {
      const r = await ctx.git(["stash", pop ? "pop" : "apply", ref], { allowFailure: true, env: await this.mergeEnv() });
      if (r.code !== 0) {
        const why = (r.stderr + r.stdout).trim().split(/\r?\n/).find((l) => /error|conflict|exists/i.test(l)) ?? "";
        throw new Error(`Stash could not be applied cleanly${why ? `: ${why}` : ""}${pop ? " (the stash is kept)" : ""}`);
      }
    });
  }

  stashDrop(ref: string): JobInfo {
    return this.jobs.enqueue(
      this.target,
      `drop ${ref}`,
      async (ctx) => {
        await ctx.git(["stash", "drop", ref]);
      },
      true,
    );
  }

  // ───────────── tags ─────────────

  tagCreate(name: string, sha: string, message: string, push: boolean): JobInfo {
    return this.jobs.enqueue(this.target, `tag ${name}`, async (ctx) => {
      const args = ["tag"];
      if (message.trim()) args.push("-a", "-m", message.trim());
      args.push(name, sha || "HEAD");
      await ctx.git(args);
      if (push) {
        ctx.setStep("push tag");
        await ctx.git(["push", "--progress", await this.defaultRemote(ctx), name]);
      }
    });
  }

  tagDelete(name: string, remote: boolean): JobInfo {
    return this.jobs.enqueue(this.target, `delete tag ${name}${remote ? " on remote" : ""}`, async (ctx) => {
      if (remote) await ctx.git(["push", "--progress", await this.defaultRemote(ctx), "--delete", `refs/tags/${name}`]);
      else await ctx.git(["tag", "-d", name]);
    });
  }

  tagPush(name: string): JobInfo {
    return this.jobs.enqueue(this.target, `push tag ${name}`, async (ctx) => {
      await ctx.git(["push", "--progress", await this.defaultRemote(ctx), name]);
    });
  }

  // ───────────── remotes / submodules ─────────────

  remoteAdd(name: string, url: string): JobInfo {
    return this.jobs.enqueue(this.target, `add remote ${name}`, async (ctx) => {
      await ctx.git(["remote", "add", name, url]);
      ctx.setStep("fetch");
      await ctx.git(["fetch", "--progress", name]);
    });
  }

  remoteRemove(name: string): JobInfo {
    return this.jobs.enqueue(
      this.target,
      `remove remote ${name}`,
      async (ctx) => {
        await ctx.git(["remote", "remove", name]);
      },
      true,
    );
  }

  submoduleUpdate(): JobInfo {
    return this.jobs.enqueue(this.target, "submodule update", async (ctx) => {
      await ctx.git(["submodule", "update", "--init", "--recursive", "--progress"]);
    });
  }

  private async pushCommand(ctx: JobContext, force = false): Promise<void> {
    const upstream = await ctx.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
      allowFailure: true,
    });
    // --force-if-includes: the lease alone passes after a fetch brought in someone else's push; this also refuses
    // when the commits being overwritten were never part of the local branch
    const forceArgs = force ? ["--force-with-lease", "--force-if-includes"] : [];
    if (upstream.code === 0) {
      await ctx.git(["push", "--progress", ...forceArgs]);
      return;
    }
    const remotes = (await ctx.git(["remote"])).stdout.split(/\r?\n/).filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) throw new Error("No remote configured");
    ctx.log(`No upstream, pushing to ${remote} and setting it as upstream`);
    await ctx.git(["push", "--progress", ...forceArgs, "-u", remote, "HEAD"]);
  }
}

// ───────────── per-repository settings (data/repos/<id>.json) ─────────────

export function readRepoSettings(dataDir: string, id: string): RepoSettings {
  try {
    return JSON.parse(readFileSync(join(dataDir, "repos", `${id}.json`), "utf8")) as RepoSettings;
  } catch {
    return {};
  }
}

export function writeRepoSettings(dataDir: string, id: string, settings: RepoSettings): void {
  mkdirSync(join(dataDir, "repos"), { recursive: true });
  writeFileSync(join(dataDir, "repos", `${id}.json`), JSON.stringify(settings, null, 2) + "\n");
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
    const existed = existsSync(dest);
    const args = ["clone", "--progress"];
    if (recurse) args.push("--recurse-submodules");
    args.push("--", url, dest);
    try {
      await ctx.git(args);
    } catch (e) {
      // a cancel kills the clone, and a killed git cannot remove its half-made folder (a failing one does that itself);
      // only a folder this clone created is removed
      if (!existed && ctx.signal.aborted) await rm(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
      throw e;
    }
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
