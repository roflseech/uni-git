/**
 * Types shared by the frontend and the backend: API contracts, config shapes, job/event models.
 * Kept free of runtime dependencies so both sides can import it.
 */
export const APP_NAME = "epic-git";
export const API_VERSION = 1;

/** Written by the backend to data/session.json so the shell can find it. */
export interface SessionInfo {
  apiVersion: number;
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

// ───────────────────────── config (data/config.json) ─────────────────────────

export interface FolderGroup {
  id: string;
  kind: "folder";
  name: string;
  /** Root folder; git repositories are discovered at depth 1. */
  root: string;
  /** Discovered repositories the user chose to hide (absolute paths). */
  hidden: string[];
}

export interface ManualGroup {
  id: string;
  kind: "manual";
  name: string;
}

export type Group = FolderGroup | ManualGroup;

export interface RepoEntry {
  id: string;
  groupId: string;
  name: string;
  /** Absolute path of the working tree. */
  path: string;
  /** Added by hand into a folder group from outside its root. */
  external?: boolean;
}

export interface GlobalSettings {
  gitPath?: string;
  editorCommand?: string;
}

export interface AppConfig {
  version: 1;
  groups: Group[];
  repos: RepoEntry[];
  lastRepoId?: string;
  settings: GlobalSettings;
}

// ───────────────────────── working copy ─────────────────────────

/** A = added, M = modified, D = deleted, R = renamed, C = copied, T = type change, U = unmerged, ? = untracked */
export type ChangeKind = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "?";
export type ChangeArea = "unstaged" | "staged" | "conflict";

export interface FileChange {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  area: ChangeArea;
}

export type RepoOperation = "none" | "merge" | "cherry-pick" | "revert" | "rebase";

export interface RepoStatus {
  /** null when HEAD is detached */
  branch: string | null;
  /** null for an unborn branch */
  head: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  operation: RepoOperation;
  unstaged: FileChange[];
  staged: FileChange[];
  conflicts: FileChange[];
  /** ms since epoch when this status was computed */
  at: number;
}

export interface BranchRef {
  /** short name: feature/x or origin/feature/x */
  name: string;
  fullName: string;
  sha: string;
  current: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  gone?: boolean;
}

export interface TagRef {
  name: string;
  sha: string;
}

export interface StashInfo {
  index: number;
  ref: string;
  message: string;
}

export interface RepoRefs {
  branches: BranchRef[];
  remoteBranches: BranchRef[];
  remotes: string[];
  tags: TagRef[];
  stashes: StashInfo[];
  submodules: string[];
  at: number;
}

// ───────────────────────── diff ─────────────────────────

export type DiffLineType = "ctx" | "add" | "del";

export interface DiffLine {
  t: DiffLineType;
  o?: number;
  n?: number;
  text: string;
  /** "\ No newline at end of file" applies to this line */
  noNewline?: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  hunks: DiffHunk[];
  binary: boolean;
  truncated?: boolean;
  /** Summary line when there is nothing to show (e.g. mode change only) */
  note?: string;
}

// ───────────────────────── history ─────────────────────────

export interface CommitInfo {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  /** unix seconds */
  date: number;
  subject: string;
  body: string;
  /** decorations: HEAD -> master, origin/master, tag: v1 */
  refs: string[];
}

export interface CommitDetails extends CommitInfo {
  files: FileChange[];
}

// ───────────────────────── jobs ─────────────────────────

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobInfo {
  id: string;
  repoId: string;
  repoName: string;
  title: string;
  step?: string;
  state: JobState;
  /** Short operations (stage/unstage) are hidden from the ops bar unless they take long. */
  quiet: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

// ───────────────────────── websocket events ─────────────────────────

export type ServerEvent =
  | { type: "hello"; pid: number; jobs: JobInfo[] }
  | { type: "job"; job: JobInfo }
  | { type: "jobLog"; jobId: string; chunk: string }
  | { type: "repoChanged"; repoId: string }
  | { type: "configChanged"; config: AppConfig };

// ───────────────────────── HTTP API ─────────────────────────

export interface DiscoveredRepo {
  path: string;
  name: string;
  /** name of the group this path is already registered in */
  knownIn?: string;
}

export interface Snapshot {
  status: RepoStatus | null;
  refs: RepoRefs | null;
  commits: CommitInfo[] | null;
}

export interface FileRef {
  path: string;
  area: ChangeArea;
  kind: ChangeKind;
}

export interface ApiError {
  error: string;
  code?: string;
}

/** Request bodies (POST, JSON) and response bodies by route. */
export interface Api {
  "/ping": { req: Record<string, never>; res: { pid: number; startedAt: number; apiVersion: number } };
  "/config": { req: Record<string, never>; res: AppConfig };
  "/config/select": { req: { repoId: string | null }; res: AppConfig };
  "/groups/scan": { req: { root: string }; res: { repos: DiscoveredRepo[] } };
  "/groups/add-folder": { req: { root: string; name: string; hidden: string[] }; res: AppConfig };
  "/groups/add-manual": { req: { name: string }; res: AppConfig };
  "/groups/rescan": { req: { groupId: string }; res: AppConfig };
  "/groups/remove": { req: { groupId: string }; res: AppConfig };
  "/repos/open": { req: { path: string; groupId: string }; res: AppConfig };
  "/repos/remove": { req: { repoId: string }; res: AppConfig };
  "/repos/clone": { req: { url: string; dest: string; groupId: string; recurse: boolean }; res: { job: JobInfo } };
  "/repo/snapshot": { req: { repoId: string }; res: Snapshot };
  "/repo/status": { req: { repoId: string }; res: RepoStatus };
  "/repo/refs": { req: { repoId: string }; res: RepoRefs };
  "/repo/diff": { req: { repoId: string; file: FileRef }; res: FileDiff };
  "/repo/stage": { req: { repoId: string; paths: string[] }; res: { job: JobInfo } };
  "/repo/unstage": { req: { repoId: string; paths: string[] }; res: { job: JobInfo } };
  "/repo/commit": { req: { repoId: string; message: string; amend: boolean; push: boolean }; res: { job: JobInfo } };
  "/repo/log": {
    req: { repoId: string; skip: number; limit: number; text?: string; author?: string };
    res: { commits: CommitInfo[]; hasMore: boolean };
  };
  "/repo/commit-details": { req: { repoId: string; sha: string }; res: CommitDetails };
  "/repo/commit-branches": { req: { repoId: string; sha: string }; res: { branches: string[] } };
  "/repo/commit-diff": { req: { repoId: string; sha: string; path: string }; res: FileDiff };
  /** remote=true: `branch` is `origin/name`; a local tracking branch is created unless it exists. stash: stash before, pop after. */
  "/repo/checkout": { req: { repoId: string; branch: string; remote: boolean; stash: boolean }; res: { job: JobInfo } };
  "/repo/fetch": { req: { repoId: string }; res: { job: JobInfo } };
  "/repo/pull": { req: { repoId: string }; res: { job: JobInfo } };
  "/repo/push": { req: { repoId: string }; res: { job: JobInfo } };
  "/repo/last-message": { req: { repoId: string }; res: { message: string } };
  "/repo/user": { req: { repoId: string }; res: { name: string; email: string } };
  "/jobs": { req: Record<string, never>; res: { jobs: JobInfo[] } };
  "/jobs/log": { req: { jobId: string }; res: { log: string } };
  "/jobs/cancel": { req: { jobId: string }; res: { ok: boolean } };
  "/os/open-in-editor": { req: { path: string }; res: { ok: boolean } };
  "/shutdown": { req: Record<string, never>; res: { ok: boolean } };
}

export type ApiRoute = keyof Api;
