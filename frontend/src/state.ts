import type {
  AppConfig,
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
  | { kind: "checkout"; branch: string; remote: boolean; changes: number; stash: boolean };

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
  selectedBranch: BranchSel | null;

  selectedFile: FileSel | null;
  diff: FileDiff | null;
  diffLoading: boolean;
  diffMode: DiffMode;

  commits: CommitInfo[];
  commitsHasMore: boolean;
  commitsLoading: boolean;
  commitFilter: { text: string; author: string; mine: boolean };
  selectedSha: string | null;
  details: CommitDetails | null;
  detailBranches: string[] | null;
  detailFile: string | null;
  detailDiff: FileDiff | null;

  jobs: JobInfo[];
  jobLogs: Record<string, string>;
  logJobId: string | null;

  openMenu: "repos" | "code" | null;
  contextMenu: ContextMenu | null;
  dialog: Dialog | null;
  toasts: Toast[];
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
    selectedBranch: null,
    selectedFile: null,
    diff: null,
    diffLoading: false,
    diffMode: (localStorage.getItem("epic-git.diffMode") as DiffMode | null) ?? "side",
    commits: [],
    commitsHasMore: false,
    commitsLoading: false,
    commitFilter: { text: "", author: "", mine: false },
    selectedSha: null,
    details: null,
    detailBranches: null,
    detailFile: null,
    detailDiff: null,
    jobs: [],
    jobLogs: {},
    logJobId: null,
    openMenu: null,
    contextMenu: null,
    dialog: null,
    toasts: [],
    sideFilter: "",
    amend: false,
    collapsedDirs: new Set(),
  };
}

export function isActive(j: JobInfo): boolean {
  return j.state === "queued" || j.state === "running";
}

export function repoBusy(s: State, repoId: string | null = s.repoId): boolean {
  if (!repoId) return false;
  return s.jobs.some((j) => j.repoId === repoId && isActive(j));
}
