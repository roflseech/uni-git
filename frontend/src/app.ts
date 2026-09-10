/**
 * Application: state, backend calls, event handling and the top-level layout.
 * Views live in ./views and rebuild their container when their slice of state changes.
 */
import type { AppConfig, CommitInfo, FileRef, JobInfo, RepoEntry, RepoRefs, ServerEvent } from "@epic-git/shared";
import { ApiClient } from "./api.js";
import { h, replaceChildren } from "./dom.js";
import { findSession, hasShell } from "./session.js";
import { Store } from "./store.js";
import { initialState, isActive, repoBusy, type BranchSel, type Dialog, type FileSel, type State, type View } from "./state.js";
import { renderOps, renderToolbar } from "./views/toolbar.js";
import { renderSeg, renderTree } from "./views/sidebar.js";
import { ChangesView } from "./views/changes.js";
import { CommitsView } from "./views/commits.js";
import { renderOverlay } from "./views/overlay.js";

const LOG_PAGE = 100;

function refsKey(r: RepoRefs): string {
  const { at: _at, ...rest } = r;
  return JSON.stringify(rest);
}

export class App {
  readonly store = new Store<State>(initialState());
  api: ApiClient | null = null;

  private readonly elToolbar = h("div", { class: "toolbar" });
  private readonly elOps = h("div", { class: "ops", hidden: true });
  private readonly elSide = h("div", { class: "side" });
  private readonly elSeg = h("div", { class: "segwrap" });
  /** Persistent so typing does not lose focus when the tree re-renders. */
  private readonly elSideFilter = h("input", { class: "field", placeholder: "Filter branches, tags, stashes" });
  private readonly elTree = h("div", { class: "treewrap" });
  private readonly elSplit = h("div", { class: "splitter", title: "Drag to resize the side panel" });
  private readonly elMain = h("div", { class: "main" });
  private readonly elLayout = h("div", { class: "layout" });
  private readonly elOverlay = h("div", { class: "overlay" });
  private readonly changes: ChangesView;
  private readonly commits: CommitsView;
  private mountedView: View | null = null;
  private opsTimer: number | null = null;
  private refreshTimer: number | null = null;
  private toastSeq = 0;

  constructor(private readonly root: HTMLElement) {
    this.changes = new ChangesView(this);
    this.commits = new CommitsView(this);
    replaceChildren(
      root,
      this.elToolbar,
      this.elOps,
      this.elLayout,
      this.elOverlay,
    );
    this.elSide.append(this.elSeg, this.elSideFilter, this.elTree);
    this.elSideFilter.addEventListener("input", () => this.store.set({ sideFilter: this.elSideFilter.value }));
    this.elLayout.append(this.elSide, this.elSplit, this.elMain);
    this.setupSplitter();
    this.store.subscribe((changed) => this.render(changed));
    this.render(new Set(Object.keys(this.store.state) as (keyof State)[]));

    document.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (this.store.state.openMenu && !t.closest(".menu") && !t.closest("[data-menu-button]")) this.store.set({ openMenu: null });
      if (this.store.state.contextMenu && !t.closest(".ctxmenu")) this.store.set({ contextMenu: null });
    });
    document.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea")) e.preventDefault();
    });
  }

  get state(): State {
    return this.store.state;
  }

  // ───────────── startup ─────────────

  async start(): Promise<void> {
    try {
      const session = await findSession((msg) => this.store.set({ bootMessage: msg }));
      const api = new ApiClient(session, hasShell() && typeof NL_PID === "number" ? NL_PID : null);
      this.api = api;
      api.connectEvents(
        (e) => this.onEvent(e),
        (connected) => {
          this.store.set({ connected });
          if (connected && this.state.boot === "ready") this.scheduleRefresh();
        },
      );
      const config = await api.call("/config", {});
      this.store.set({ config, boot: "ready" });
      const first = config.lastRepoId && config.repos.some((r) => r.id === config.lastRepoId) ? config.lastRepoId : config.repos[0]?.id ?? null;
      if (first) await this.selectRepo(first);
      else this.setTitle(null);
    } catch (e) {
      this.store.set({ boot: "failed", bootMessage: (e as Error).message });
    }
  }

  private onEvent(e: ServerEvent): void {
    const s = this.state;
    switch (e.type) {
      case "hello":
        this.store.set({ jobs: e.jobs });
        break;
      case "job": {
        const jobs = s.jobs.filter((j) => j.id !== e.job.id);
        jobs.push(e.job);
        this.store.set({ jobs });
        if (e.job.state === "failed") this.toast(`${e.job.repoName}: ${e.job.title} failed. ${e.job.error ?? ""}`, "error", e.job.id);
        if (e.job.state === "done" && e.job.repoId.startsWith("clone:")) this.toast(`Cloned ${e.job.repoName}`, "info");
        if (e.job.state === "done" && e.job.repoId === s.repoId && /commit/.test(e.job.title)) this.changes.clearForm();
        break;
      }
      case "jobLog": {
        const logs = { ...s.jobLogs, [e.jobId]: (s.jobLogs[e.jobId] ?? "") + e.chunk };
        this.store.set({ jobLogs: logs });
        break;
      }
      case "repoChanged":
        if (e.repoId === s.repoId) this.scheduleRefresh();
        break;
      case "configChanged":
        this.store.set({ config: e.config });
        if (s.repoId && !e.config.repos.some((r) => r.id === s.repoId)) {
          const next = e.config.repos[0]?.id ?? null;
          if (next) void this.selectRepo(next);
          else this.clearRepo();
        }
        break;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAll();
    }, 150);
  }

  // ───────────── repository ─────────────

  get repo(): RepoEntry | null {
    const s = this.state;
    return s.config?.repos.find((r) => r.id === s.repoId) ?? null;
  }

  async selectRepo(repoId: string): Promise<void> {
    if (!this.api) return;
    const s = this.state;
    if (s.repoId === repoId && s.status) return;
    this.store.set({
      repoId,
      status: null,
      refs: null,
      stale: true,
      user: null,
      selectedBranch: null,
      selectedFile: null,
      diff: null,
      commits: [],
      commitsHasMore: false,
      selectedSha: null,
      details: null,
      detailBranches: null,
      detailFile: null,
      detailDiff: null,
      openMenu: null,
      amend: false,
      collapsedDirs: new Set(),
    });
    this.changes.clearForm();
    this.setTitle(this.repo);
    const api = this.api;
    try {
      // cached snapshot first (instant), then fresh data
      const snap = await api.call("/repo/snapshot", { repoId });
      if (this.state.repoId !== repoId) return;
      this.store.set({
        status: snap.status,
        refs: snap.refs,
        commits: snap.commits ?? [],
        commitsHasMore: (snap.commits?.length ?? 0) >= LOG_PAGE,
        stale: true,
      });
      void api.call("/config/select", { repoId }).catch(() => {});
      void api.call("/repo/user", { repoId }).then((user) => this.state.repoId === repoId && this.store.set({ user })).catch(() => {});
      await this.refreshAll();
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  private clearRepo(): void {
    this.store.set({ repoId: null, status: null, refs: null, commits: [], selectedFile: null, diff: null, details: null });
    this.setTitle(null);
  }

  private refreshing = false;
  private refreshAgain = false;

  /** One refresh at a time; a request that arrives while one is running is coalesced into a single follow-up. */
  async refreshAll(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        await this.refreshOnce();
      } while (this.refreshAgain);
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshOnce(): Promise<void> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return;
    const api = this.api;
    try {
      const [status, refs] = await Promise.all([api.call("/repo/status", { repoId }), api.call("/repo/refs", { repoId })]);
      if (this.state.repoId !== repoId) return;
      // keep the old refs object when nothing but the timestamp changed, so the branch tree is not rebuilt
      const sameRefs = this.state.refs && refsKey(this.state.refs) === refsKey(refs);
      this.store.set({ status, refs: sameRefs ? this.state.refs : refs, stale: false });
      this.reconcileSelection();
      await this.reloadLog();
    } catch (e) {
      if (this.state.repoId === repoId) this.toast((e as Error).message, "error");
    }
  }

  /** Keeps the selected file if it still exists after a refresh, reloads its diff. */
  private reconcileSelection(): void {
    const s = this.state;
    if (!s.status || !s.selectedFile) return;
    const list = s.selectedFile.area === "staged" ? s.status.staged : s.selectedFile.area === "conflict" ? s.status.conflicts : s.status.unstaged;
    const match = list.find((f) => f.path === s.selectedFile?.path);
    if (match) void this.selectFile({ area: match.area, path: match.path, kind: match.kind }, true);
    else this.store.set({ selectedFile: null, diff: null });
  }

  setView(view: View): void {
    this.store.set({ view });
  }

  private setTitle(repo: RepoEntry | null): void {
    const title = repo ? `epic-git — ${repo.name}` : "epic-git";
    document.title = title;
    if (hasShell()) void Neutralino.window.setTitle(title).catch(() => {});
  }

  // ───────────── changes ─────────────

  async selectFile(sel: FileSel | null, keepIfSame = false): Promise<void> {
    if (!this.api || !this.state.repoId) return;
    if (!sel) {
      this.store.set({ selectedFile: null, diff: null });
      return;
    }
    const same = keepIfSame && this.state.selectedFile?.path === sel.path && this.state.selectedFile.area === sel.area;
    this.store.set({ selectedFile: sel, diffLoading: !same });
    const repoId = this.state.repoId;
    const file: FileRef = { path: sel.path, area: sel.area, kind: sel.kind };
    try {
      const diff = await this.api.call("/repo/diff", { repoId, file });
      const cur = this.state.selectedFile;
      if (this.state.repoId === repoId && cur && cur.path === sel.path && cur.area === sel.area) this.store.set({ diff, diffLoading: false });
    } catch (e) {
      this.store.set({ diff: { path: sel.path, hunks: [], binary: false, note: (e as Error).message }, diffLoading: false });
    }
  }

  stage(paths: string[]): void {
    void this.mutate("/repo/stage", { paths });
  }

  unstage(paths: string[]): void {
    void this.mutate("/repo/unstage", { paths });
  }

  commit(message: string, amend: boolean, push: boolean): void {
    void this.mutate("/repo/commit", { message, amend, push });
  }

  fetch(): void {
    void this.mutate("/repo/fetch", {});
  }
  pull(): void {
    void this.mutate("/repo/pull", {});
  }
  push(): void {
    void this.mutate("/repo/push", {});
  }

  private async mutate(
    route: "/repo/stage" | "/repo/unstage" | "/repo/commit" | "/repo/checkout" | "/repo/fetch" | "/repo/pull" | "/repo/push",
    body: Record<string, unknown>,
  ): Promise<void> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return;
    try {
      const { job } = await this.api.call(route, { repoId, ...body } as never);
      const jobs = this.state.jobs.filter((j) => j.id !== job.id);
      jobs.push(job);
      this.store.set({ jobs, stale: true });
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  async lastCommitMessage(): Promise<string> {
    if (!this.api || !this.state.repoId) return "";
    try {
      return (await this.api.call("/repo/last-message", { repoId: this.state.repoId })).message;
    } catch {
      return "";
    }
  }

  // ───────────── branches ─────────────

  selectBranch(sel: BranchSel | null): void {
    this.store.set({ selectedBranch: sel });
  }

  /** Double-click / context menu: switch right away, or ask first when the working copy has changes. */
  requestCheckout(sel: BranchSel): void {
    const s = this.state;
    if (!s.status || this.isBusy()) return;
    const local = sel.remote ? sel.name.slice(sel.name.indexOf("/") + 1) : sel.name;
    if (local === s.status.branch) return;
    if (s.status.operation !== "none") {
      this.toast(`Finish or abort the current ${s.status.operation} before switching branches`, "error");
      return;
    }
    const changes = s.status.unstaged.length + s.status.staged.length + s.status.conflicts.length;
    if (changes === 0) {
      this.checkout(sel, false);
      return;
    }
    this.openDialog({ kind: "checkout", branch: sel.name, remote: sel.remote, changes, stash: false });
  }

  checkout(sel: BranchSel, stash: boolean): void {
    this.store.set({ dialog: null });
    void this.mutate("/repo/checkout", { branch: sel.name, remote: sel.remote, stash });
  }

  private setupSplitter(): void {
    const KEY = "epic-git.sideWidth";
    const saved = Number(localStorage.getItem(KEY));
    if (saved >= 160) this.elLayout.style.setProperty("--side-w", `${saved}px`);
    this.elSplit.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.elSide.getBoundingClientRect().width;
      const move = (ev: MouseEvent) => {
        const w = Math.min(600, Math.max(160, startW + ev.clientX - startX));
        this.elLayout.style.setProperty("--side-w", `${w}px`);
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        localStorage.setItem(KEY, String(Math.round(this.elSide.getBoundingClientRect().width)));
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  toggleDir(area: string, dir: string): void {
    this.toggleFold(`${area}:${dir}`);
  }

  /** Inverts the default open/closed state of a fold (file directory, branch prefix, remote, tags). */
  toggleFold(key: string): void {
    const set = new Set(this.state.collapsedDirs);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    this.store.set({ collapsedDirs: set });
  }

  setDiffMode(mode: "side" | "inline"): void {
    localStorage.setItem("epic-git.diffMode", mode);
    this.store.set({ diffMode: mode });
  }

  // ───────────── commits ─────────────

  private logSeq = 0;

  async reloadLog(): Promise<void> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return;
    const seq = ++this.logSeq;
    const f = this.state.commitFilter;
    const req: { repoId: string; skip: number; limit: number; text?: string; author?: string } = { repoId, skip: 0, limit: LOG_PAGE };
    if (f.text.trim()) req.text = f.text.trim();
    const author = f.mine ? this.state.user?.email || this.state.user?.name || "" : f.author.trim();
    if (author) req.author = author;
    this.store.set({ commitsLoading: true });
    try {
      const { commits, hasMore } = await this.api.call("/repo/log", req);
      if (seq !== this.logSeq || this.state.repoId !== repoId) return;
      this.store.set({ commits, commitsHasMore: hasMore, commitsLoading: false });
      const sel = this.state.selectedSha;
      if (sel && !commits.some((c) => c.sha === sel)) this.store.set({ selectedSha: null, details: null, detailFile: null, detailDiff: null, detailBranches: null });
      else if (sel) void this.selectCommit(sel, true);
    } catch (e) {
      this.store.set({ commitsLoading: false });
      this.toast((e as Error).message, "error");
    }
  }

  async loadMoreCommits(): Promise<void> {
    const s = this.state;
    const repoId = s.repoId;
    if (!this.api || !repoId || s.commitsLoading || !s.commitsHasMore) return;
    const seq = this.logSeq;
    const f = s.commitFilter;
    const req: { repoId: string; skip: number; limit: number; text?: string; author?: string } = { repoId, skip: s.commits.length, limit: LOG_PAGE };
    if (f.text.trim()) req.text = f.text.trim();
    const author = f.mine ? s.user?.email || s.user?.name || "" : f.author.trim();
    if (author) req.author = author;
    this.store.set({ commitsLoading: true });
    try {
      const { commits, hasMore } = await this.api.call("/repo/log", req);
      if (seq !== this.logSeq || this.state.repoId !== repoId) return;
      const known = new Set(this.state.commits.map((c) => c.sha));
      const merged: CommitInfo[] = [...this.state.commits, ...commits.filter((c) => !known.has(c.sha))];
      this.store.set({ commits: merged, commitsHasMore: hasMore, commitsLoading: false });
    } catch (e) {
      this.store.set({ commitsLoading: false });
      this.toast((e as Error).message, "error");
    }
  }

  setCommitFilter(patch: Partial<State["commitFilter"]>): void {
    this.store.set({ commitFilter: { ...this.state.commitFilter, ...patch } });
    void this.reloadLog();
  }

  async selectCommit(sha: string, refresh = false): Promise<void> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return;
    if (!refresh) this.store.set({ selectedSha: sha, details: null, detailBranches: null, detailFile: null, detailDiff: null });
    try {
      const details = await this.api.call("/repo/commit-details", { repoId, sha });
      if (this.state.selectedSha !== sha || this.state.repoId !== repoId) return;
      this.store.set({ details });
      const file = this.state.detailFile && details.files.some((f) => f.path === this.state.detailFile) ? this.state.detailFile : details.files[0]?.path ?? null;
      if (file) void this.selectCommitFile(file);
      void this.api
        .call("/repo/commit-branches", { repoId, sha })
        .then(({ branches }) => this.state.selectedSha === sha && this.store.set({ detailBranches: branches }))
        .catch(() => {});
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  async selectCommitFile(path: string): Promise<void> {
    const s = this.state;
    const repoId = s.repoId;
    const sha = s.selectedSha;
    if (!this.api || !repoId || !sha) return;
    this.store.set({ detailFile: path, detailDiff: null });
    try {
      const diff = await this.api.call("/repo/commit-diff", { repoId, sha, path });
      if (this.state.selectedSha === sha && this.state.detailFile === path) this.store.set({ detailDiff: diff });
    } catch (e) {
      this.store.set({ detailDiff: { path, hunks: [], binary: false, note: (e as Error).message } });
    }
  }

  // ───────────── groups & repositories ─────────────

  async pickFolder(title: string): Promise<string | null> {
    if (hasShell()) {
      try {
        const p = await Neutralino.os.showFolderDialog(title);
        return p || null;
      } catch {
        return null;
      }
    }
    return window.prompt(title) || null;
  }

  async openFolderDialog(groupId: string): Promise<void> {
    const folder = await this.pickFolder("Open repository folder");
    if (!folder || !this.api) return;
    try {
      const config = await this.api.call("/repos/open", { path: folder, groupId });
      this.store.set({ config, openMenu: null });
      const entry = config.repos.find((r) => r.path === folder) ?? config.repos[config.repos.length - 1];
      if (entry) await this.selectRepo(entry.id);
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  async startAddFolderGroup(): Promise<void> {
    const root = await this.pickFolder("Choose the folder that contains your repositories");
    if (!root || !this.api) return;
    const name = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root;
    this.store.set({ openMenu: null, dialog: { kind: "add-folder-group", root, name, found: [], hidden: new Set(), scanning: true } });
    try {
      const { repos } = await this.api.call("/groups/scan", { root });
      const d = this.state.dialog;
      if (d?.kind === "add-folder-group" && d.root === root) this.store.set({ dialog: { ...d, found: repos, scanning: false } });
    } catch (e) {
      const d = this.state.dialog;
      if (d?.kind === "add-folder-group") this.store.set({ dialog: { ...d, scanning: false, error: (e as Error).message } });
    }
  }

  async confirmAddFolderGroup(): Promise<void> {
    const d = this.state.dialog;
    if (!this.api || d?.kind !== "add-folder-group") return;
    try {
      const before = new Set(this.state.config?.repos.map((r) => r.id));
      const config = await this.api.call("/groups/add-folder", { root: d.root, name: d.name, hidden: [...d.hidden] });
      this.store.set({ config, dialog: null });
      const added = config.repos.find((r) => !before.has(r.id));
      if (added && !this.state.repoId) await this.selectRepo(added.id);
    } catch (e) {
      this.store.set({ dialog: { ...d, error: (e as Error).message } });
    }
  }

  async confirmAddManualGroup(): Promise<void> {
    const d = this.state.dialog;
    if (!this.api || d?.kind !== "add-manual-group") return;
    try {
      const config = await this.api.call("/groups/add-manual", { name: d.name });
      this.store.set({ config, dialog: null });
    } catch (e) {
      this.store.set({ dialog: { ...d, error: (e as Error).message } });
    }
  }

  async confirmClone(): Promise<void> {
    const d = this.state.dialog;
    if (!this.api || d?.kind !== "clone") return;
    try {
      const { job } = await this.api.call("/repos/clone", { url: d.url, dest: d.dest, groupId: d.groupId, recurse: d.recurse });
      this.store.set({ dialog: null, jobs: [...this.state.jobs.filter((j) => j.id !== job.id), job] });
    } catch (e) {
      this.store.set({ dialog: { ...d, error: (e as Error).message } });
    }
  }

  async rescanGroup(groupId: string): Promise<void> {
    if (!this.api) return;
    try {
      const config = await this.api.call("/groups/rescan", { groupId });
      this.store.set({ config });
      this.toast("Folder rescanned", "info");
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  removeRepo(repo: RepoEntry): void {
    this.openDialog({
      kind: "confirm",
      title: `Remove ${repo.name} from the list?`,
      text: "The repository folder stays on disk; only the entry in epic-git is removed.",
      okLabel: "Remove",
      danger: true,
      onOk: () => void this.api?.call("/repos/remove", { repoId: repo.id }).then((config) => this.store.set({ config })).catch((e: Error) => this.toast(e.message, "error")),
    });
  }

  removeGroup(groupId: string): void {
    const g = this.state.config?.groups.find((x) => x.id === groupId);
    if (!g) return;
    this.openDialog({
      title: `Remove group ${g.name}?`,
      kind: "confirm",
      text: "All its repositories are removed from the list. Nothing is deleted on disk.",
      okLabel: "Remove group",
      danger: true,
      onOk: () => void this.api?.call("/groups/remove", { groupId }).then((config) => this.store.set({ config })).catch((e: Error) => this.toast(e.message, "error")),
    });
  }

  openInEditor(path: string): void {
    this.store.set({ openMenu: null });
    void this.api?.call("/os/open-in-editor", { path }).catch((e: Error) => this.toast(e.message, "error"));
  }

  // ───────────── jobs, dialogs, toasts ─────────────

  cancelJob(id: string): void {
    void this.api?.call("/jobs/cancel", { jobId: id }).catch(() => {});
  }

  async showJobLog(jobId: string | null): Promise<void> {
    this.store.set({ logJobId: jobId });
    if (!jobId || !this.api) return;
    try {
      const { log } = await this.api.call("/jobs/log", { jobId });
      this.store.set({ jobLogs: { ...this.state.jobLogs, [jobId]: log } });
    } catch {
      /* job may be gone */
    }
  }

  openDialog(dialog: Dialog): void {
    this.store.set({ dialog, openMenu: null, contextMenu: null });
  }

  updateDialog(patch: Partial<Dialog>): void {
    const d = this.state.dialog;
    if (d) this.store.set({ dialog: { ...d, ...patch } as Dialog });
  }

  closeDialog(): void {
    this.store.set({ dialog: null });
  }

  toast(text: string, kind: "error" | "info", jobId?: string): void {
    const id = ++this.toastSeq;
    const t = jobId ? { id, text, kind, jobId } : { id, text, kind };
    this.store.set({ toasts: [...this.state.toasts, t] });
    if (kind === "info") window.setTimeout(() => this.dismissToast(id), 4000);
  }

  dismissToast(id: number): void {
    this.store.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      const s = this.state;
      if (s.contextMenu) this.store.set({ contextMenu: null });
      else if (s.openMenu) this.store.set({ openMenu: null });
      else if (s.logJobId) this.store.set({ logJobId: null });
      else if (s.dialog) this.closeDialog();
    }
  }

  // ───────────── render ─────────────

  private render(changed: Set<keyof State>): void {
    const s = this.state;
    const any = (...keys: (keyof State)[]) => keys.some((k) => changed.has(k));

    if (any("boot", "bootMessage", "config", "repoId", "status", "jobs", "connected", "stale", "view")) {
      replaceChildren(this.elToolbar, renderToolbar(this));
    }
    if (any("jobs", "logJobId", "jobLogs")) {
      const active = s.jobs.filter(isActive);
      const visible = active.filter((j) => !j.quiet || (j.startedAt !== undefined && Date.now() - j.startedAt > 600));
      this.elOps.hidden = visible.length === 0;
      replaceChildren(this.elOps, renderOps(this, visible));
      if (active.length && this.opsTimer === null) {
        this.opsTimer = window.setInterval(() => {
          if (!this.state.jobs.some(isActive)) {
            if (this.opsTimer !== null) window.clearInterval(this.opsTimer);
            this.opsTimer = null;
          }
          this.store.touch("jobs");
        }, 1000);
      }
    }
    if (any("view", "status", "boot", "repoId")) replaceChildren(this.elSeg, renderSeg(this));
    // The tree can hold thousands of rows: rebuild it only when its own inputs change (not on every status refresh).
    if (any("refs", "sideFilter", "selectedBranch", "collapsedDirs", "repoId", "boot")) replaceChildren(this.elTree, renderTree(this));
    if (any("view", "repoId", "boot") || this.mountedView !== s.view) {
      this.mountedView = s.view;
      replaceChildren(this.elMain, s.view === "changes" ? this.changes.mount() : this.commits.mount());
      this.changes.update(changed, true);
      this.commits.update(changed, true);
    } else {
      this.changes.update(changed, false);
      this.commits.update(changed, false);
    }
    if (any("openMenu", "contextMenu", "dialog", "toasts", "logJobId", "jobLogs", "jobs", "config", "repoId", "status")) {
      replaceChildren(this.elOverlay, renderOverlay(this));
    }
  }

  isBusy(repoId: string | null = this.state.repoId): boolean {
    return repoBusy(this.state, repoId);
  }

  jobsFor(repoId: string): JobInfo[] {
    return this.state.jobs.filter((j) => j.repoId === repoId && isActive(j));
  }

  configOrEmpty(): AppConfig {
    return this.state.config ?? { version: 1, groups: [], repos: [], settings: {} };
  }
}
