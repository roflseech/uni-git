/**
 * Types shared by the frontend and the backend: API contracts, config shapes, job/event models.
 * Kept free of runtime dependencies so both sides can import it.
 */
import type { TaskPreset, TaskTemplate } from "./tasks.js";
export * from "./tasks.js";
export * from "./mergePlan.js";

export const APP_NAME = "uni-git";
export const API_VERSION = 1;

/** GitHub repository whose releases the app installs and updates from (.github/workflows/release.yml publishes them). */
export const RELEASE_REPO = "roflseech/uni-git";
export const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`;
/** One-line installers; re-running one repairs an installation. */
export const INSTALL_COMMANDS = {
  windows: `irm ${RELEASES_URL}/latest/download/install.ps1 | iex`,
  mac: `curl -fsSL ${RELEASES_URL}/latest/download/install.sh | sh`,
} as const;

/**
 * Self-update (backend/src/updater.ts). disabled: development build, not an installed copy or a read-only folder;
 * ready: the new files are already in place and take effect on restart; blocked: the update needs something the
 * machine lacks (a newer Node.js).
 */
export type UpdateStatus = "disabled" | "idle" | "checking" | "downloading" | "ready" | "uptodate" | "blocked" | "error";

export interface UpdateState {
  /** version of the running app, e.g. "0.1.57"; development builds end in "-dev" */
  current: string;
  status: UpdateStatus;
  /** why updates are off, what blocks the update or what failed */
  message?: string;
  /** newest version found */
  available?: string;
  /** commit subjects of the new version */
  notes?: string[];
  /** release page of the new version */
  url?: string;
  /** ms since epoch of the last finished check */
  checkedAt?: number;
}

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

export type Theme = "system" | "light" | "dark";

/**
 * Window layout remembered between launches. Kept in data/ like every setting: the webview's localStorage does not
 * survive a restart (the shell listens on a random port, so the page origin changes).
 */
export interface UiLayout {
  /** side panel width, px */
  sideWidth?: number;
  /** left column of the Changes / Commits view, % of the view width */
  changesSplit?: number;
  commitsSplit?: number;
  /** file list of the selected commit (Commits view), % of the details column height */
  commitFilesSplit?: number;
}

export interface GlobalSettings {
  ui?: UiLayout;
  gitPath?: string;
  editorCommand?: string;
  theme?: Theme;
  /** Merge menu: stash uncommitted changes before the operation and restore them after. */
  mergeStash?: boolean;
  /** User-saved task template presets by name (built-in Jira/ClickUp are not stored). */
  taskPresets?: Record<string, TaskTemplate>;
}

/** data/repos/<id>.json — per-repository settings that do not belong in .git/config. */
export interface RepoSettings {
  /** Explicit main branch; when absent it is detected (main, master, origin/HEAD). */
  mainBranch?: string;
  /** Task template of this repository; absent/null = no template (plain branch names, unmarked commits). */
  template?: TaskTemplate | null;
  /** Preset the template was taken from, for the dropdown; "Custom" when edited. */
  presetName?: string;
}

export type ConfigScope = "local" | "global" | "system" | "worktree" | "command" | "none";

export interface RepoSettingsView {
  path: string;
  groupId: string;
  mainBranch: string;
  /** true when mainBranch came from detection rather than settings */
  mainBranchAuto: boolean;
  userName: string;
  userNameScope: ConfigScope;
  userEmail: string;
  userEmailScope: ConfigScope;
  branches: string[];
  template: TaskTemplate | null;
  presetName: string | null;
  /** built-in presets followed by the user's saved ones */
  presets: TaskPreset[];
}

export interface GlobalSettingsView extends GlobalSettings {
  dataDir: string;
  /** e.g. "2.53.0", or null when git cannot be run with the configured path */
  gitVersion: string | null;
  gitResolved: string;
  /** Git Credential Manager version, null when not installed */
  gcmVersion: string | null;
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
  /** Task template of the repository (Repo Settings), null when none. */
  template?: TaskTemplate | null;
  /** The repository's main branch (Repo Settings or detected) and how the current branch relates to it. */
  mainBranch?: string;
  aheadOfMain?: number;
  behindMain?: number;
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
  | { type: "configChanged"; config: AppConfig }
  /** git or ssh inside a job needs input (password, passphrase, host key confirmation). */
  | { type: "askpass"; request: AskpassRequest }
  | { type: "askpassDone"; id: string }
  | { type: "update"; update: UpdateState };

export type AskpassKind = "username" | "password" | "passphrase" | "hostkey" | "other";

export interface AskpassRequest {
  id: string;
  jobId: string;
  repoName: string;
  jobTitle: string;
  kind: AskpassKind;
  /** The prompt exactly as git/ssh printed it. */
  prompt: string;
}

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

export interface AccountInfo {
  host: string;
  signedIn: boolean;
  username?: string;
  /** default = well-known host, remote = taken from a repository remote */
  source: "default" | "remote";
}

export interface SshKeyInfo {
  file: string;
  name: string;
  type: string;
  fingerprint: string;
  comment: string;
  publicKey: string;
}

export interface RemoteInfo {
  name: string;
  url: string;
  protocol: "https" | "ssh" | "other";
  host: string;
}

/** Repo Settings → Authentication: which account / key this repository uses (written to .git/config). */
export interface RepoAuthView {
  remotes: RemoteInfo[];
  /** credential.username in .git/config, "" = whatever the helper picks */
  username: string;
  /** private key path from core.sshCommand, "" = ssh default */
  sshKey: string;
  /** accounts of the https hosts of this repository */
  accounts: AccountInfo[];
  keys: SshKeyInfo[];
}

export interface ApiError {
  error: string;
  code?: string;
}

/** Request bodies (POST, JSON) and response bodies by route. */
export interface Api {
  "/ping": { req: Record<string, never>; res: { pid: number; startedAt: number; apiVersion: number; version: string } };
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
    /** ref: branch to list instead of HEAD; task: task code the message must contain (with text: both must match) */
    req: { repoId: string; skip: number; limit: number; text?: string; author?: string; ref?: string; task?: string };
    res: { commits: CommitInfo[]; hasMore: boolean };
  };
  "/repo/commit-details": { req: { repoId: string; sha: string }; res: CommitDetails };
  "/repo/commit-branches": { req: { repoId: string; sha: string }; res: { branches: string[] } };
  "/repo/commit-diff": { req: { repoId: string; sha: string; path: string }; res: FileDiff };
  /** remote=true: `branch` is `origin/name`; a local tracking branch is created unless it exists. stash: stash before, pop after. discard: throw all changes away first (untracked files too). */
  "/repo/checkout": { req: { repoId: string; branch: string; remote: boolean; stash: boolean; discard?: boolean }; res: { job: JobInfo } };
  "/repo/fetch": { req: { repoId: string }; res: { job: JobInfo } };
  /** discard: throw all uncommitted changes away first (untracked files too) */
  "/repo/pull": { req: { repoId: string; discard?: boolean }; res: { job: JobInfo } };
  "/repo/push": { req: { repoId: string; force?: boolean; tags?: boolean }; res: { job: JobInfo } };
  /** main: merge main into current; force-main: fetch origin main:main first; into-main: switch, pull, merge current, push */
  "/repo/merge-scenario": { req: { repoId: string; mode: "main" | "force-main" | "into-main"; stash: boolean }; res: { job: JobInfo } };
  "/repo/auth": { req: { repoId: string }; res: RepoAuthView };
  "/repo/auth/save": { req: { repoId: string; username: string; sshKey: string }; res: { ok: boolean } };
  "/repo/auth/test": { req: { repoId: string }; res: { job: JobInfo } };
  "/repo/conflict/resolve": { req: { repoId: string; paths: string[]; take: "ours" | "theirs" | "mark" }; res: { job: JobInfo } };
  "/repo/operation/abort": { req: { repoId: string }; res: { job: JobInfo } };
  "/repo/operation/continue": { req: { repoId: string }; res: { job: JobInfo } };
  "/repo/cherry-pick": { req: { repoId: string; shas: string[] }; res: { job: JobInfo } };
  "/repo/stash/save": { req: { repoId: string; message: string; includeUntracked: boolean }; res: { job: JobInfo } };
  "/repo/stash/apply": { req: { repoId: string; ref: string; pop: boolean }; res: { job: JobInfo } };
  "/repo/stash/drop": { req: { repoId: string; ref: string }; res: { job: JobInfo } };
  "/repo/stash/sha": { req: { repoId: string; ref: string }; res: { sha: string } };
  "/repo/tag/create": { req: { repoId: string; name: string; sha: string; message: string; push: boolean }; res: { job: JobInfo } };
  "/repo/tag/delete": { req: { repoId: string; name: string; remote: boolean }; res: { job: JobInfo } };
  "/repo/tag/push": { req: { repoId: string; name: string }; res: { job: JobInfo } };
  "/repo/remote/add": { req: { repoId: string; name: string; url: string }; res: { job: JobInfo } };
  "/repo/remote/remove": { req: { repoId: string; name: string }; res: { job: JobInfo } };
  "/repo/remote/url": { req: { repoId: string; name: string }; res: { url: string } };
  "/repo/submodule/update": { req: { repoId: string }; res: { job: JobInfo } };
  "/repo/merge-message": { req: { repoId: string }; res: { message: string } };
  "/repo/last-message": { req: { repoId: string }; res: { message: string } };
  "/repo/user": { req: { repoId: string }; res: { name: string; email: string } };
  "/repo/settings": { req: { repoId: string }; res: RepoSettingsView };
  "/repo/settings/save": {
    req: {
      repoId: string;
      groupId: string;
      mainBranch: string | null;
      userName: string;
      userEmail: string;
      template: TaskTemplate | null;
      presetName: string | null;
    };
    res: { ok: boolean };
  };
  "/repo/branch/create": { req: { repoId: string; name: string; from: string; checkout: boolean }; res: { job: JobInfo } };
  "/repo/branch/delete": { req: { repoId: string; name: string; remote: boolean; force: boolean }; res: { job: JobInfo } };
  "/repo/branch/rename": { req: { repoId: string; from: string; to: string }; res: { job: JobInfo } };
  "/repo/merge": { req: { repoId: string; branch: string }; res: { job: JobInfo } };
  "/repo/merged-into": { req: { repoId: string; branch: string; into: string[] }; res: { merged: Record<string, boolean> } };
  /** all: every uncommitted change, staged or not, untracked files included (paths are ignored) */
  "/repo/discard": { req: { repoId: string; paths: string[]; all?: boolean }; res: { job: JobInfo } };
  "/repo/ignore": { req: { repoId: string; patterns: string[] }; res: { job: JobInfo } };
  /** patch: a unified diff for one file; reverse=true unstages */
  "/repo/apply-patch": { req: { repoId: string; patch: string; reverse: boolean }; res: { job: JobInfo } };
  "/settings/global": { req: Record<string, never>; res: GlobalSettingsView };
  "/settings/global/save": { req: { settings: GlobalSettings }; res: GlobalSettingsView };
  /** Merges the given layout values into settings.ui (a dragged splitter); a value of 0 removes the entry (back to the default). */
  "/settings/ui/save": { req: { ui: UiLayout }; res: { ui: UiLayout } };
  "/accounts/list": { req: Record<string, never>; res: { accounts: AccountInfo[]; sshHosts: string[]; keys: SshKeyInfo[] } };
  /** Runs the helper's interactive flow (GCM opens the browser) as a job; the result is stored by the helper. */
  "/accounts/login": { req: { host: string }; res: { job: JobInfo } };
  "/accounts/token": { req: { host: string; username: string; token: string }; res: { ok: boolean } };
  "/accounts/logout": { req: { host: string; username?: string }; res: { ok: boolean } };
  "/ssh/generate": { req: { comment: string }; res: { key: SshKeyInfo } };
  "/ssh/test": { req: { host: string }; res: { job: JobInfo } };
  "/askpass": { req: { token: string; jobId: string; prompt: string }; res: { value: string | null } };
  "/askpass/answer": { req: { id: string; value: string | null }; res: { ok: boolean } };
  "/askpass/pending": { req: Record<string, never>; res: { requests: AskpassRequest[] } };
  "/jobs": { req: Record<string, never>; res: { jobs: JobInfo[] } };
  "/jobs/log": { req: { jobId: string }; res: { log: string } };
  "/jobs/cancel": { req: { jobId: string }; res: { ok: boolean } };
  "/os/open-in-editor": { req: { path: string }; res: { ok: boolean } };
  "/update/status": { req: Record<string, never>; res: UpdateState };
  /** Checks now (downloads and installs a newer version); answers when the check is over. */
  "/update/check": { req: Record<string, never>; res: UpdateState };
  "/shutdown": { req: Record<string, never>; res: { ok: boolean } };
}

export type ApiRoute = keyof Api;
