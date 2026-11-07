import type {
  AppConfig,
  AskpassRequest,
  GlobalSettingsView,
  RepoSettingsView,
  Theme,
  TaskPreset,
  TaskTemplate,
  AccountInfo,
  SshKeyInfo,
  RepoAuthView,
  ChangeArea,
  ChangeKind,
  CommitDetails,
  CommitInfo,
  DiscoveredRepo,
  FileDiff,
  JobInfo,
  RepoRefs,
  RepoStatus,
} from "@epic-git/shared";

export type View = "changes" | "commits";
export type DiffMode = "side" | "inline";

export interface FileSel {
  area: ChangeArea;
  path: string;
  kind: ChangeKind;
}

export type Dialog =
  | {
      kind: "add-folder-group";
      root: string;
      name: string;
      found: DiscoveredRepo[];
      hidden: Set<string>;
      scanning: boolean;
      error?: string;
    }
  | { kind: "add-manual-group"; name: string; error?: string }
  | { kind: "clone"; url: string; groupId: string; dest: string; destTouched: boolean; recurse: boolean; error?: string }
  | { kind: "confirm"; title: string; text: string; okLabel: string; danger: boolean; onOk: () => void }
  | { kind: "checkout"; branch: string; remote: boolean; changes: number; stash: boolean }
  | { kind: "askpass"; request: AskpassRequest; value: string }
  | {
      kind: "repo-settings";
      view: RepoSettingsView;
      groupId: string;
      /** null = detect automatically */
      mainBranch: string | null;
      userName: string;
      userEmail: string;
      tab: "general" | "template" | "auth";
      auth: RepoAuthView | null;
      authUsername: string;
      authSshKey: string;
      template: TaskTemplate | null;
      /** name of the preset the template matches, "Custom" when edited, "None" when null */
      presetName: string;
      saving: boolean;
      error?: string;
    }
  | {
      kind: "global-settings";
      view: GlobalSettingsView;
      tab: "general" | "presets" | "accounts";
      accounts: AccountInfo[] | null;
      sshHosts: string[];
      keys: SshKeyInfo[];
      gitPath: string;
      editorCommand: string;
      theme: Theme;
      taskPresets: Record<string, TaskTemplate>;
      saving: boolean;
      error?: string;
    }
  | {
      kind: "new-branch";
      name: string;
      type: string;
      code: string;
      from: string;
      checkout: boolean;
      starts: string[];
      template: TaskTemplate | null;
      /** with a template: type the whole name by hand instead of building it from the template */
      custom: boolean;
      error?: string;
    }
  | { kind: "rename-branch"; from: string; to: string; error?: string }
  | { kind: "prompt"; title: string; label: string; value: string; okLabel: string; mono: boolean; onOk: (value: string) => void }
  | { kind: "stash-save"; message: string; includeUntracked: boolean }
  | { kind: "add-token"; host: string; username: string; token: string; error?: string }
  | { kind: "check-merged"; branch: string; into: string; branches: string[]; result: string | null }
  | { kind: "check-commit"; sha: string; branch: string; branches: string[]; result: string | null }
  | { kind: "tag-create"; name: string; sha: string; shaLabel: string; message: string; push: boolean; error?: string }
  | { kind: "remote-add"; name: string; url: string; error?: string }
  | { kind: "pick-branch"; title: string; branches: string[]; picked: string; onPick: (branch: string) => void };

export interface BranchSel {
  /** local name, or `origin/name` for a remote branch */
  name: string;
  remote: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind: "error" | "info";
  jobId?: string;
}

export interface ContextMenu {
  x: number;
  y: number;
  items: { label: string; danger?: boolean; onClick: () => void }[];
}

export interface State {
  boot: "starting" | "ready" | "failed";
  bootMessage: string;
  connected: boolean;

  config: AppConfig | null;
  repoId: string | null;
  view: View;

  status: RepoStatus | null;
  refs: RepoRefs | null;
  /** status/refs shown are from the cache or older than a running job */
  stale: boolean;
  user: { name: string; email: string } | null;
  /** task template of the current repository (from status), null = none */
  template: TaskTemplate | null;
  presets: TaskPreset[];
  selectedBranch: BranchSel | null;

  /** the file whose diff is shown */
  selectedFile: FileSel | null;
  /** every selected file (ctrl/shift-click) for stage/unstage/discard of many at once; contains selectedFile */
  selectedFiles: FileSel[];
  diff: FileDiff | null;
  diffLoading: boolean;
  diffMode: DiffMode;

  commits: CommitInfo[];
  commitsHasMore: boolean;
  commitsLoading: boolean;
  /** task: only commits whose message contains the task code of the viewed branch */
  commitFilter: { text: string; author: string; mine: boolean; task: boolean };
  /** branch whose commits the Commits view lists (name as in the tree, e.g. origin/x); null = HEAD */
  logBranch: string | null;
  selectedSha: string | null;
  /** every selected commit (ctrl/shift-click), primary first */
  selectedShas: string[];
  details: CommitDetails | null;
  detailBranches: string[] | null;
  detailFile: string | null;
  detailDiff: FileDiff | null;

  jobs: JobInfo[];
  jobLogs: Record<string, string>;
  logJobId: string | null;

  openMenu: "repos" | "code" | "merge" | "push" | "pull" | null;
  /** Branch menu: item under the cursor, for the command preview */
  menuHover: string | null;
  contextMenu: ContextMenu | null;
  dialog: Dialog | null;
  toasts: Toast[];
  /** prompts from git/ssh waiting for an answer, oldest first */
  askpass: AskpassRequest[];
  sideFilter: string;
  amend: boolean;
  collapsedDirs: Set<string>;
}

export function initialState(): State {
  return {
    boot: "starting",
    bootMessage: "Starting backend…",
    connected: false,
    config: null,
    repoId: null,
    view: "changes",
    status: null,
    refs: null,
    stale: false,
    user: null,
    template: null,
    presets: [],
    selectedBranch: null,
    selectedFile: null,
    selectedFiles: [],
    diff: null,
    diffLoading: false,
    diffMode: (localStorage.getItem("epic-git.diffMode") as DiffMode | null) ?? "side",
    commits: [],
    commitsHasMore: false,
    commitsLoading: false,
    commitFilter: { text: "", author: "", mine: false, task: false },
    logBranch: null,
    selectedSha: null,
    selectedShas: [],
    details: null,
    detailBranches: null,
    detailFile: null,
    detailDiff: null,
    jobs: [],
    jobLogs: {},
    logJobId: null,
    openMenu: null,
    menuHover: null,
    contextMenu: null,
    dialog: null,
    toasts: [],
    askpass: [],
    sideFilter: "",
    amend: false,
    collapsedDirs: new Set(),
  };
}

export function isActive(j: JobInfo): boolean {
  return j.state === "queued" || j.state === "running";
}

/**
 * Busy = a job that blocks the repository's actions. Quiet jobs (stage/unstage) do not: the backend runs the jobs of a
 * repository one after another anyway, and their result is shown locally at once, so the next click need not wait.
 */
export function repoBusy(s: State, repoId: string | null = s.repoId): boolean {
  if (!repoId) return false;
  return s.jobs.some((j) => j.repoId === repoId && !j.quiet && isActive(j));
}
