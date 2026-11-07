/**
 * Application: state, backend calls, event handling and the top-level layout.
 * Views live in ./views and rebuild their container when their slice of state changes.
 */
import type { AppConfig, AskpassRequest, CommitInfo, FileRef, JobInfo, RepoEntry, RepoRefs, RepoStatus, ServerEvent, Theme, UiLayout } from "@epic-git/shared";
import { applyTheme, hunkPatch } from "./format.js";
import { BUILT_IN_PRESETS, buildBranchName, sameTemplate, taskCodeFromBranch, type TaskTemplate } from "@epic-git/shared";
import { ApiClient } from "./api.js";
import { h, replaceChildren, setupSplitter, watchDoubleClicks } from "./dom.js";
import { findSession, hasShell } from "./session.js";
import { Store } from "./store.js";
import { initialState, isActive, repoBusy, type BranchSel, type Dialog, type FileSel, type State, type View } from "./state.js";
import { renderOps, renderToolbar } from "./views/toolbar.js";
import { markSelectedBranch, renderSeg, renderTree } from "./views/sidebar.js";
import { ChangesView } from "./views/changes.js";
import { CommitsView } from "./views/commits.js";
import { renderOverlay } from "./views/overlay.js";

const LOG_PAGE = 100;

function emptyTemplate(): TaskTemplate {
  return { codePattern: "", branchTemplate: "{name}", types: [], commitTemplate: "", linkTemplate: "" };
}

/** Name of the preset a template equals, else "Custom". */
function presetNameFor(t: TaskTemplate, presets: { name: string; template: TaskTemplate }[]): string {
  return [...presets, ...BUILT_IN_PRESETS].find((p) => sameTemplate(p.template, t))?.name ?? "Custom";
}

/** `origin/feature/x` → `feature/x`; a local name stays as it is. */
function localBranchName(name: string): string {
  return name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
}

/** Content of a status/refs answer without its timestamp. */
function refsKey(r: RepoRefs | RepoStatus): string {
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
  private renderedBusy = false;
  private readonly applySideWidth: (saved: number | undefined) => void;
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
    this.applySideWidth = setupSplitter(this.elSplit, this.elSide, this.elLayout, { name: "--side-w", min: 160, max: 600, onChange: (sideWidth) => this.saveLayout({ sideWidth }) });
    watchDoubleClicks(this.elTree);
    this.store.subscribe((changed) => this.render(changed));
    this.render(new Set(Object.keys(this.store.state) as (keyof State)[]));

    document.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (this.store.state.openMenu && !t.closest(".menu") && !t.closest("[data-menu-button]")) this.store.set({ openMenu: null, menuHover: null });
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
      applyTheme(config.settings.theme);
      // the remembered layout is applied once: afterwards it only changes from this window
      const ui = config.settings.ui ?? {};
      this.applySideWidth(ui.sideWidth);
      this.changes.applyLayout(ui);
      this.commits.applyLayout(ui);
      this.store.set({ config, boot: "ready" });
      void api.call("/askpass/pending", {}).then(({ requests }) => requests.forEach((r) => this.onAskpass(r))).catch(() => {});
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
        if (e.job.repoId === "accounts" && (e.job.state === "done" || e.job.state === "failed")) {
          if (e.job.state === "done") this.toast(`${e.job.title}: ok`, "info");
          if (this.state.dialog?.kind === "global-settings") void this.loadAccounts();
        }
        // not the quiet "stage src/commit.ts"
        if (e.job.state === "done" && !e.job.quiet && e.job.repoId === s.repoId && /commit/.test(e.job.title)) this.changes.clearForm();
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
      case "askpass":
        this.onAskpass(e.request);
        break;
      case "askpassDone":
        this.dropAskpass(e.id);
        break;
      case "configChanged":
        applyTheme(e.config.settings.theme);
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
    }, 50);
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
      template: null,
      selectedBranch: null,
      selectedFile: null,
      selectedFiles: [],
      diff: null,
      logBranch: null,
      commits: [],
      commitsHasMore: false,
      selectedSha: null,
      selectedShas: [],
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
    this.store.set({ repoId: null, status: null, refs: null, commits: [], selectedFile: null, selectedFiles: [], logBranch: null, diff: null, details: null });
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
    // a stage/unstage is on its way: its result is already shown, and the end of the job asks for a refresh again
    if (this.movingFiles(repoId)) return;
    try {
      const [fresh, refs] = await Promise.all([api.call("/repo/status", { repoId }), api.call("/repo/refs", { repoId })]);
      if (this.state.repoId !== repoId || this.movingFiles(repoId)) return;
      // keep the old objects when nothing but the timestamp changed, so that nothing is rebuilt (rebuilds eat clicks and flicker)
      const sameRefs = this.state.refs && refsKey(this.state.refs) === refsKey(refs);
      const status = this.state.status && refsKey(this.state.status) === refsKey(fresh) ? this.state.status : fresh;
      this.store.set({ status, refs: sameRefs ? this.state.refs : refs, stale: false, template: status.template ?? null });
      // the viewed branch became the current one (switched to it): back to HEAD
      if (this.state.logBranch !== null && localBranchName(this.state.logBranch) === status.branch) this.store.set({ logBranch: null });
      this.reconcileSelection();
      await this.reloadLog(true);
    } catch (e) {
      if (this.state.repoId === repoId) this.toast((e as Error).message, "error");
    }
  }

  /** Keeps the selected file if it still exists after a refresh, reloads its diff. */
  private reconcileSelection(): void {
    const s = this.state;
    if (!s.status) return;
    const st = s.status;
    const listOf = (area: FileSel["area"]) => (area === "staged" ? st.staged : area === "conflict" ? st.conflicts : st.unstaged);
    // files that vanished (committed, discarded, reverted on disk) leave the selection
    const kept = s.selectedFiles.filter((f) => listOf(f.area).some((x) => x.path === f.path));
    if (kept.length !== s.selectedFiles.length) this.store.set({ selectedFiles: kept });
    if (!s.selectedFile) return;
    const match = listOf(s.selectedFile.area).find((f) => f.path === s.selectedFile?.path);
    if (match) void this.selectFile({ area: match.area, path: match.path, kind: match.kind }, true);
    else this.store.set({ selectedFile: kept[0] ?? null, diff: null });
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
      this.store.set({ selectedFile: null, selectedFiles: [], diff: null });
      return;
    }
    const prev = this.state.selectedFile;
    const samePlace = prev?.path === sel.path && prev.area === sel.area;
    const same = keepIfSame && samePlace;
    // the same selection keeps its object, so the file list is not rebuilt for nothing
    const file0 = samePlace && prev.kind === sel.kind ? prev : sel;
    this.store.set({ selectedFile: file0, diffLoading: !same });
    if (!keepIfSame) this.store.set({ selectedFiles: [file0] });
    const repoId = this.state.repoId;
    const file: FileRef = { path: sel.path, area: sel.area, kind: sel.kind };
    try {
      const diff = await this.api.call("/repo/diff", { repoId, file });
      const cur = this.state.selectedFile;
      if (this.state.repoId !== repoId || !cur || cur.path !== sel.path || cur.area !== sel.area) return;
      // a refresh that found the same diff leaves the pane (and its scroll position) alone
      const unchanged = same && this.state.diff !== null && JSON.stringify(this.state.diff) === JSON.stringify(diff);
      this.store.set(unchanged ? { diffLoading: false } : { diff, diffLoading: false });
    } catch (e) {
      this.store.set({ diff: { path: sel.path, hunks: [], binary: false, note: (e as Error).message }, diffLoading: false });
    }
  }

  /** Click = select; ctrl adds/removes; shift selects the range from the primary file in the shown `order`. The primary one shows its diff. */
  clickFile(sel: FileSel, mods: { ctrl: boolean; shift: boolean }, order: FileSel[]): void {
    const s = this.state;
    const same = (a: FileSel, b: FileSel) => a.path === b.path && a.area === b.area;
    let files: FileSel[];
    let primary = sel;
    if (mods.shift && s.selectedFile) {
      const anchor = s.selectedFile;
      const a = order.findIndex((x) => same(x, anchor));
      const b = order.findIndex((x) => same(x, sel));
      files = a < 0 || b < 0 ? [sel] : order.slice(Math.min(a, b), Math.max(a, b) + 1);
      primary = anchor;
    } else if (mods.ctrl) {
      files = s.selectedFiles.some((x) => same(x, sel)) ? s.selectedFiles.filter((x) => !same(x, sel)) : [...s.selectedFiles, sel];
      if (!files.length) files = [sel];
      primary = files.some((x) => same(x, sel)) ? sel : (files[files.length - 1] ?? sel);
    } else {
      files = [sel];
    }
    if (!s.selectedFile || !same(s.selectedFile, primary)) void this.selectFile(primary);
    this.store.set({ selectedFiles: files });
  }

  /** Paths an action on `path` applies to: the whole selection of that area when the file is part of it, else the file alone. */
  selectedPathsIn(area: FileSel["area"], path: string): string[] {
    const sel = this.state.selectedFiles.filter((f) => f.area === area);
    return sel.some((f) => f.path === path) ? sel.map((f) => f.path) : [path];
  }

  /** Delete key in Changes: discard the selected files (with the confirmation). */
  discardSelected(): void {
    const files = this.state.selectedFiles.filter((f) => f.area !== "conflict");
    if (!files.length || this.isBusy()) return;
    this.discard(
      files.map((f) => f.path),
      files.every((f) => f.kind === "?"),
    );
  }

  /** "Discard all": working copy and index back to HEAD, untracked files deleted. */
  discardAll(): void {
    const st = this.state.status;
    if (!st) return;
    const n = st.unstaged.length + st.staged.length + st.conflicts.length;
    this.openDialog({
      kind: "confirm",
      title: `Discard all ${n} uncommitted changes?`,
      text: "Every modified file goes back to the last commit, staged changes included, and untracked files are deleted. This cannot be undone.",
      okLabel: "Discard all",
      danger: true,
      onOk: () => void this.mutate("/repo/discard", { paths: [], all: true }),
    });
  }

  stage(paths: string[]): void {
    this.moveLocally(paths, "unstaged");
    this.sendMove("/repo/stage", paths);
  }

  unstage(paths: string[]): void {
    this.moveLocally(paths, "staged");
    this.sendMove("/repo/unstage", paths);
  }

  /** stage/unstage requests whose job is not in the state yet */
  private movesInFlight = 0;

  private sendMove(route: "/repo/stage" | "/repo/unstage", paths: string[]): void {
    this.movesInFlight++;
    void this.mutate(route, { paths }).then((ok) => {
      this.movesInFlight--;
      // no job (or one that ended before this answer came): no refresh will follow from its end, so ask for one
      const repoId = this.state.repoId;
      if (!ok || (repoId && !this.movingFiles(repoId))) this.scheduleRefresh();
    });
  }

  /** A stage/unstage is queued or running; a status read now could still show the state before it. */
  private movingFiles(repoId: string): boolean {
    return this.movesInFlight > 0 || this.state.jobs.some((j) => j.repoId === repoId && j.quiet && isActive(j));
  }

  /**
   * Stage/unstage show at once: the files change lists locally, the real status follows when the job is done
   * (and puts things right if git decided otherwise). The selection follows its file, so the diff pane stays put.
   */
  private moveLocally(paths: string[], from: "unstaged" | "staged"): void {
    const st = this.state.status;
    if (!st) return;
    const to = from === "unstaged" ? "staged" : "unstaged";
    const set = new Set(paths);
    const moved = st[from].filter((f) => set.has(f.path));
    if (!moved.length) return;
    const target = new Map(st[to].map((f) => [f.path, f]));
    for (const f of moved) {
      const there = target.get(f.path);
      if (to === "staged") {
        if (!there) target.set(f.path, { path: f.path, kind: f.kind === "?" ? "A" : f.kind, area: to });
        else if (f.kind === "D" && there.kind === "A") target.delete(f.path);
        else if (f.kind === "D") target.set(f.path, { ...there, kind: "D" });
      } else {
        const kind = f.kind === "A" || f.kind === "R" || f.kind === "C" ? "?" : f.kind;
        if (!there) target.set(f.path, { path: f.path, kind, area: to });
        else if (kind === "?") target.set(f.path, { ...there, kind });
      }
    }
    const list = [...target.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const status: RepoStatus = { ...st, [from]: st[from].filter((f) => !set.has(f.path)), [to]: list };
    const sel = this.state.selectedFile;
    const follow = sel && sel.area === from && set.has(sel.path) ? target.get(sel.path) : undefined;
    const moveSel = (f: FileSel): FileSel => {
      const t = f.area === from && set.has(f.path) ? target.get(f.path) : undefined;
      return t ? { area: to, path: t.path, kind: t.kind } : f;
    };
    this.store.set({ status, selectedFile: follow ? { area: to, path: follow.path, kind: follow.kind } : sel, selectedFiles: this.state.selectedFiles.map(moveSel) });
  }

  commit(message: string, amend: boolean, push: boolean): void {
    void this.mutate("/repo/commit", { message, amend, push });
  }

  fetch(): void {
    void this.mutate("/repo/fetch", {});
  }
  /** Pull; `discard` first throws every uncommitted change away (asked once). */
  pull(discard = false): void {
    this.store.set({ openMenu: null });
    if (!discard) {
      void this.mutate("/repo/pull", {});
      return;
    }
    const st = this.state.status;
    const n = st ? st.unstaged.length + st.staged.length + st.conflicts.length : 0;
    this.openDialog({
      kind: "confirm",
      title: n ? `Discard ${n} uncommitted changes and pull?` : "Discard changes and pull?",
      text: "Every modified file goes back to the last commit, staged changes included, and untracked files are deleted. Then the current branch is pulled. This cannot be undone.",
      okLabel: "Discard and pull",
      danger: true,
      onOk: () => void this.mutate("/repo/pull", { discard: true }),
    });
  }
  push(force = false, tags = false): void {
    this.store.set({ openMenu: null });
    if (!force) {
      void this.mutate("/repo/push", { tags });
      return;
    }
    const branch = this.state.status?.branch ?? "the current branch";
    this.openDialog({
      kind: "confirm",
      title: `Force push ${branch}?`,
      text: "Uses --force-with-lease: the remote branch is overwritten only if nobody pushed to it since your last fetch. Colleagues who have the old commits will need to reset.",
      okLabel: "Force push",
      danger: true,
      onOk: () => void this.mutate("/repo/push", { force: true }),
    });
  }

  // ───────────── Branch menu: checks with an inline result ─────────────

  openCheckMerged(): void {
    const s = this.state;
    if (!s.refs || !s.status) return;
    const branches = [...s.refs.branches.map((b) => b.name), ...s.refs.remoteBranches.map((b) => b.name)];
    this.openDialog({ kind: "check-merged", branch: s.status.branch ?? branches[0] ?? "", into: s.status.mainBranch ?? "main", branches, result: null });
  }

  openCheckCommit(): void {
    const s = this.state;
    if (!s.refs || !s.status) return;
    const branches = [...s.refs.branches.map((b) => b.name), ...s.refs.remoteBranches.map((b) => b.name)];
    this.openDialog({ kind: "check-commit", sha: s.selectedSha ?? "", branch: s.status.mainBranch ?? branches[0] ?? "", branches, result: null });
  }

  async runCheck(): Promise<void> {
    const d = this.state.dialog;
    if (d?.kind !== "check-merged" && d?.kind !== "check-commit") return;
    const what = d.kind === "check-merged" ? d.branch : d.sha.trim();
    const into = d.kind === "check-merged" ? d.into : d.branch;
    if (!what || !into) return;
    this.updateDialog({ result: "checking…" });
    const r = await this.mergedInto(what, [into]);
    const yes = r[into] === true;
    const label = d.kind === "check-merged" ? `${what} is ${yes ? "" : "NOT "}merged into ${into}` : `${what.slice(0, 12)} is ${yes ? "" : "NOT "}in ${into}`;
    if (this.state.dialog?.kind === d.kind) this.updateDialog({ result: (yes ? "yes: " : "no: ") + label });
  }

  // ───────────── Repo Settings → Authentication ─────────────

  async loadRepoAuth(): Promise<void> {
    const repoId = this.state.repoId;
    const d = this.state.dialog;
    if (!this.api || !repoId || d?.kind !== "repo-settings") return;
    this.updateDialog({ tab: "auth" });
    if (d.auth) return;
    try {
      const auth = await this.api.call("/repo/auth", { repoId });
      if (this.state.dialog?.kind === "repo-settings") this.updateDialog({ auth, authUsername: auth.username, authSshKey: auth.sshKey });
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  testRepoAuth(): void {
    void this.mutate("/repo/auth/test", {});
  }

  // ───────────── merge menu (plan, section 3) ─────────────

  mergeScenario(mode: "main" | "force-main" | "into-main"): void {
    const s = this.state;
    this.store.set({ openMenu: null });
    if (!s.status || this.isBusy()) return;
    if (s.status.operation !== "none") {
      this.toast(`Finish or abort the current ${s.status.operation} first`, "error");
      return;
    }
    void this.mutate("/repo/merge-scenario", { mode, stash: s.config?.settings.mergeStash === true });
  }

  setMergeStash(on: boolean): void {
    const cfg = this.state.config;
    if (!cfg || !this.api) return;
    const settings = { ...cfg.settings, mergeStash: on };
    this.store.set({ config: { ...cfg, settings } });
    void this.api.call("/settings/global/save", { settings }).catch((e: Error) => this.toast(e.message, "error"));
  }

  // ───────────── conflicts / operation in progress ─────────────

  resolveConflict(paths: string[], take: "ours" | "theirs" | "mark"): void {
    void this.mutate("/repo/conflict/resolve", { paths, take });
  }

  abortOperation(): void {
    const op = this.state.status?.operation ?? "operation";
    this.openDialog({
      kind: "confirm",
      title: `Abort the ${op}?`,
      text: "The working copy and the index go back to the state before it started. Resolved conflicts are lost.",
      okLabel: `Abort ${op}`,
      danger: true,
      onOk: () => void this.mutate("/repo/operation/abort", {}),
    });
  }

  continueOperation(): void {
    void this.mutate("/repo/operation/continue", {});
  }

  cherryPick(shas: string[]): void {
    const s = this.state;
    if (!s.status || this.isBusy()) return;
    if (s.status.operation !== "none") {
      this.toast(`Finish or abort the current ${s.status.operation} first`, "error");
      return;
    }
    void this.mutate("/repo/cherry-pick", { shas });
  }

  async mergeMessage(): Promise<string> {
    if (!this.api || !this.state.repoId) return "";
    try {
      return (await this.api.call("/repo/merge-message", { repoId: this.state.repoId })).message;
    } catch {
      return "";
    }
  }

  // ───────────── stash ─────────────

  openStashSave(): void {
    this.openDialog({ kind: "stash-save", message: "", includeUntracked: true });
  }

  stashSave(): void {
    const d = this.state.dialog;
    if (d?.kind !== "stash-save") return;
    this.store.set({ dialog: null });
    void this.mutate("/repo/stash/save", { message: d.message, includeUntracked: d.includeUntracked });
  }

  stashApply(ref: string, pop: boolean): void {
    void this.mutate("/repo/stash/apply", { ref, pop });
  }

  stashDrop(ref: string, message: string): void {
    this.openDialog({
      kind: "confirm",
      title: `Drop stash "${message}"?`,
      text: "The stashed changes are deleted. This cannot be undone.",
      okLabel: "Drop",
      danger: true,
      onOk: () => void this.mutate("/repo/stash/drop", { ref }),
    });
  }

  async stashShow(ref: string): Promise<void> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return;
    try {
      const { sha } = await this.api.call("/repo/stash/sha", { repoId, ref });
      this.setView("commits");
      await this.selectCommit(sha);
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  // ───────────── tags / remotes / submodules ─────────────

  openTagCreate(sha: string, shaLabel: string): void {
    this.openDialog({ kind: "tag-create", name: "", sha, shaLabel, message: "", push: false });
  }

  tagCreate(): void {
    const d = this.state.dialog;
    if (d?.kind !== "tag-create") return;
    const name = d.name.trim();
    if (!name) return;
    if (/[\s~^:?*[\\]|\.\.|@\{|^-/.test(name)) {
      this.updateDialog({ error: "Not a valid tag name" });
      return;
    }
    this.store.set({ dialog: null });
    void this.mutate("/repo/tag/create", { name, sha: d.sha, message: d.message, push: d.push });
  }

  tagDelete(name: string, remote: boolean): void {
    this.openDialog({
      kind: "confirm",
      title: remote ? `Delete tag ${name} on the remote?` : `Delete tag ${name}?`,
      text: remote ? "The tag is removed from origin for everyone; your local tag stays." : "Only the local tag is removed. Use “Delete on remote” to remove it from origin too.",
      okLabel: "Delete",
      danger: true,
      onOk: () => void this.mutate("/repo/tag/delete", { name, remote }),
    });
  }

  tagPush(name: string): void {
    void this.mutate("/repo/tag/push", { name });
  }

  openRemoteAdd(): void {
    this.openDialog({ kind: "remote-add", name: this.state.refs?.remotes.length ? "" : "origin", url: "" });
  }

  remoteAdd(): void {
    const d = this.state.dialog;
    if (d?.kind !== "remote-add" || !d.name.trim() || !d.url.trim()) return;
    this.store.set({ dialog: null });
    void this.mutate("/repo/remote/add", { name: d.name.trim(), url: d.url.trim() });
  }

  remoteRemove(name: string): void {
    this.openDialog({
      kind: "confirm",
      title: `Remove remote ${name}?`,
      text: "Remote-tracking branches of this remote are deleted locally. Nothing changes on the server.",
      okLabel: "Remove",
      danger: true,
      onOk: () => void this.mutate("/repo/remote/remove", { name }),
    });
  }

  async copyRemoteUrl(name: string): Promise<void> {
    if (!this.api || !this.state.repoId) return;
    try {
      const { url } = await this.api.call("/repo/remote/url", { repoId: this.state.repoId, name });
      await navigator.clipboard?.writeText(url);
      this.toast(`Copied ${url}`, "info");
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  submoduleUpdate(): void {
    void this.mutate("/repo/submodule/update", {});
  }

  /** "Is commit X in branch Y?" from the commit menu: pick a branch, get a yes/no toast. */
  askIsInBranch(sha: string, subject: string): void {
    const refs = this.state.refs;
    if (!refs) return;
    const branches = [...refs.branches.map((b) => b.name), ...refs.remoteBranches.map((b) => b.name)];
    const main = this.state.status?.mainBranch ?? branches[0] ?? "";
    this.openDialog({
      kind: "pick-branch",
      title: `Is ${sha.slice(0, 7)} “${subject.slice(0, 40)}” in branch…`,
      branches,
      picked: main,
      onPick: (branch) =>
        void this.mergedInto(sha, [branch]).then((r) => this.toast(`${sha.slice(0, 7)} is ${r[branch] ? "" : "NOT "}in ${branch}`, r[branch] ? "info" : "error")),
    });
  }

  private async mutate(
    route:
      | "/repo/stage"
      | "/repo/unstage"
      | "/repo/commit"
      | "/repo/checkout"
      | "/repo/fetch"
      | "/repo/pull"
      | "/repo/push"
      | "/repo/branch/create"
      | "/repo/branch/delete"
      | "/repo/branch/rename"
      | "/repo/merge"
      | "/repo/discard"
      | "/repo/ignore"
      | "/repo/apply-patch"
      | "/repo/merge-scenario"
      | "/repo/conflict/resolve"
      | "/repo/operation/abort"
      | "/repo/operation/continue"
      | "/repo/cherry-pick"
      | "/repo/stash/save"
      | "/repo/stash/apply"
      | "/repo/stash/drop"
      | "/repo/tag/create"
      | "/repo/tag/delete"
      | "/repo/tag/push"
      | "/repo/remote/add"
      | "/repo/remote/remove"
      | "/repo/submodule/update"
      | "/repo/auth/test",
    body: Record<string, unknown>,
  ): Promise<boolean> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return false;
    try {
      const { job } = await this.api.call(route, { repoId, ...body } as never);
      // the websocket may have been faster: its copy of the job is newer than this answer
      const jobs = this.state.jobs.some((j) => j.id === job.id) ? this.state.jobs : [...this.state.jobs, job];
      // quiet jobs (stage/unstage) are shown locally at once, nothing on screen is stale
      this.store.set(job.quiet ? { jobs } : { jobs, stale: true });
      return true;
    } catch (e) {
      this.toast((e as Error).message, "error");
      return false;
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

  /** `show`: also list that branch's commits in the Commits view (a left click in the tree). */
  selectBranch(sel: BranchSel | null, show = false): void {
    this.store.set({ selectedBranch: sel });
    if (show && sel) this.showBranchCommits(sel.name);
  }

  /** Commits view lists `name` instead of HEAD (null = back to the current branch) without switching branches. */
  showBranchCommits(name: string | null): void {
    const s = this.state;
    const ref = name !== null && name === s.status?.branch ? null : name;
    const changed = ref !== s.logBranch;
    this.store.set({ logBranch: ref, view: "commits" });
    if (changed) {
      this.store.set({ selectedSha: null, selectedShas: [], details: null, detailBranches: null, detailFile: null, detailDiff: null });
      void this.reloadLog();
    }
  }

  /** Task code of the branch the Commits view lists (the viewed one, else the current one). */
  logTaskCode(): string | null {
    const s = this.state;
    return taskCodeFromBranch(s.template, s.logBranch ?? s.status?.branch ?? null);
  }

  private logRequest(skip: number): { repoId: string; skip: number; limit: number; text?: string; author?: string; ref?: string; task?: string } {
    const s = this.state;
    const f = s.commitFilter;
    const req: ReturnType<App["logRequest"]> = { repoId: s.repoId ?? "", skip, limit: LOG_PAGE };
    if (f.text.trim()) req.text = f.text.trim();
    const author = f.mine ? s.user?.email || s.user?.name || "" : f.author.trim();
    if (author) req.author = author;
    if (s.logBranch) req.ref = s.logBranch;
    const code = f.task ? this.logTaskCode() : null;
    if (code) req.task = code;
    return req;
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

  checkout(sel: BranchSel, stash: boolean, discard = false): void {
    this.store.set({ dialog: null });
    void this.mutate("/repo/checkout", { branch: sel.name, remote: sel.remote, stash, ...(discard ? { discard: true } : {}) });
  }

  /** A splitter was dragged (0 = back to the default). Kept in data/ by the backend: localStorage does not survive a restart of the shell. */
  saveLayout(ui: UiLayout): void {
    void this.api?.call("/settings/ui/save", { ui }).catch((e: Error) => this.toast(e.message, "error"));
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

  /** `background`: a refresh of what is already shown, without the loading state and without a rebuild when nothing changed. */
  async reloadLog(background = false): Promise<void> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return;
    // a background refresh leaves a running "load more" alone unless the history really changed
    const seq = background ? this.logSeq : ++this.logSeq;
    const req = this.logRequest(0);
    if (!background || !this.state.commits.length) this.store.set({ commitsLoading: true });
    try {
      const { commits, hasMore } = await this.api.call("/repo/log", req);
      if (seq !== this.logSeq || this.state.repoId !== repoId) return;
      // same first page: keep the list as it is, with the pages loaded below it and the scroll position
      const have = this.state.commits;
      const samePage = background && have.length >= commits.length && commits.length > 0 && JSON.stringify(have.slice(0, commits.length)) === JSON.stringify(commits);
      if (!samePage) {
        if (background) this.logSeq++;
        this.store.set({ commits, commitsHasMore: hasMore, commitsLoading: false });
      }
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
    const req = this.logRequest(s.commits.length);
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

  /** Click = select; ctrl adds/removes; shift selects the range from the primary commit. The primary one shows its details. */
  clickCommit(sha: string, mods: { ctrl: boolean; shift: boolean }): void {
    const s = this.state;
    const order = s.commits.map((c) => c.sha);
    let shas: string[];
    if (mods.shift && s.selectedSha) {
      const a = order.indexOf(s.selectedSha);
      const b = order.indexOf(sha);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      shas = [s.selectedSha, ...order.slice(lo, hi + 1).filter((x) => x !== s.selectedSha)];
    } else if (mods.ctrl) {
      shas = s.selectedShas.includes(sha) ? s.selectedShas.filter((x) => x !== sha) : [...s.selectedShas, sha];
      if (!shas.length) shas = [sha];
    } else {
      shas = [sha];
    }
    this.store.set({ selectedShas: shas });
    if (!mods.ctrl || !s.selectedShas.includes(sha)) void this.selectCommit(shas[0] === sha ? sha : (s.selectedSha ?? sha));
  }

  /** Selected commits oldest first, the order cherry-pick wants. */
  selectedCommitsOldestFirst(): string[] {
    const order = this.state.commits.map((c) => c.sha);
    return [...this.state.selectedShas].sort((a, b) => order.indexOf(b) - order.indexOf(a));
  }

  async selectCommit(sha: string, refresh = false): Promise<void> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return;
    const api = this.api;
    const loadBranches = () =>
      void api
        .call("/repo/commit-branches", { repoId, sha })
        .then(({ branches }) => {
          if (this.state.selectedSha !== sha) return;
          if (JSON.stringify(branches) !== JSON.stringify(this.state.detailBranches)) this.store.set({ detailBranches: branches });
        })
        .catch(() => {});
    if (!refresh) {
      const shas = this.state.selectedShas.includes(sha) ? this.state.selectedShas : [sha];
      // the previous commit stays on screen (dimmed by the view) until this one is loaded: no flash of "Loading…"
      this.store.set({ selectedSha: sha, selectedShas: shas });
      if (this.state.details?.sha === sha) return;
    } else if (this.state.details?.sha === sha) {
      // a commit never changes; only the branches that contain it do
      loadBranches();
      return;
    }
    try {
      const details = await api.call("/repo/commit-details", { repoId, sha });
      if (this.state.selectedSha !== sha || this.state.repoId !== repoId) return;
      this.store.set({ details, detailBranches: null });
      const file = details.files[0]?.path ?? null;
      if (file) void this.selectCommitFile(file);
      else this.store.set({ detailFile: null, detailDiff: null });
      loadBranches();
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  async selectCommitFile(path: string): Promise<void> {
    const s = this.state;
    const repoId = s.repoId;
    const sha = s.selectedSha;
    if (!this.api || !repoId || !sha || s.details?.sha !== sha) return;
    const key = `${sha}:${path}`;
    if (s.detailFile === path && s.detailDiff && this.detailDiffKey === key) return;
    // the old diff stays (dimmed) until the new one is there
    this.store.set({ detailFile: path });
    try {
      const diff = await this.api.call("/repo/commit-diff", { repoId, sha, path });
      if (this.state.selectedSha !== sha || this.state.detailFile !== path) return;
      this.detailDiffKey = key;
      this.store.set({ detailDiff: diff });
    } catch (e) {
      if (this.state.selectedSha !== sha || this.state.detailFile !== path) return;
      this.detailDiffKey = key;
      this.store.set({ detailDiff: { path, hunks: [], binary: false, note: (e as Error).message } });
    }
  }

  /** `sha:path` the shown commit diff belongs to; differs from the selection while the next one is loading. */
  detailDiffKey: string | null = null;

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

  // ───────────── askpass ─────────────

  private onAskpass(r: AskpassRequest): void {
    if (this.state.askpass.some((x) => x.id === r.id)) return;
    this.store.set({ askpass: [...this.state.askpass, r] });
    this.showNextAskpass();
  }

  private dropAskpass(id: string): void {
    this.store.set({ askpass: this.state.askpass.filter((x) => x.id !== id) });
    const d = this.state.dialog;
    if (d?.kind === "askpass" && d.request.id === id) this.store.set({ dialog: null });
    this.showNextAskpass();
  }

  /** Prompts are answered one at a time; a prompt dialog takes precedence over other dialogs. */
  private showNextAskpass(): void {
    const next = this.state.askpass[0];
    const d = this.state.dialog;
    if (!next || (d?.kind === "askpass" && d.request.id === next.id)) return;
    this.store.set({ dialog: { kind: "askpass", request: next, value: "" }, openMenu: null, contextMenu: null });
  }

  answerAskpass(id: string, value: string | null): void {
    void this.api?.call("/askpass/answer", { id, value }).catch(() => {});
    this.dropAskpass(id);
  }

  // ───────────── settings ─────────────

  async openRepoSettings(): Promise<void> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return;
    try {
      const view = await this.api.call("/repo/settings", { repoId });
      this.store.set({ presets: view.presets });
      this.openDialog({
        kind: "repo-settings",
        view,
        groupId: view.groupId,
        mainBranch: view.mainBranchAuto ? null : view.mainBranch,
        userName: view.userName,
        userEmail: view.userEmail,
        tab: "general",
        auth: null,
        authUsername: "",
        authSshKey: "",
        template: view.template,
        presetName: view.template ? (view.presetName ?? presetNameFor(view.template, view.presets)) : "None",
        saving: false,
      });
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  async saveRepoSettings(): Promise<void> {
    const d = this.state.dialog;
    const repoId = this.state.repoId;
    if (!this.api || !repoId || d?.kind !== "repo-settings") return;
    this.updateDialog({ saving: true });
    try {
      await this.api.call("/repo/settings/save", {
        repoId,
        groupId: d.groupId,
        mainBranch: d.mainBranch,
        userName: d.userName,
        userEmail: d.userEmail,
        template: d.template,
        presetName: d.template ? d.presetName : null,
      });
      this.store.set({ template: d.template });
      if (d.auth) await this.api.call("/repo/auth/save", { repoId, username: d.authUsername, sshKey: d.authSshKey });
      this.store.set({ dialog: null });
      void this.api.call("/repo/user", { repoId }).then((user) => this.store.set({ user })).catch(() => {});
      this.toast("Repository settings saved", "info");
    } catch (e) {
      this.updateDialog({ saving: false, error: (e as Error).message });
    }
  }

  async openGlobalSettings(): Promise<void> {
    if (!this.api) return;
    try {
      const view = await this.api.call("/settings/global", {});
      this.openDialog({
        kind: "global-settings",
        view,
        tab: "general",
        gitPath: view.gitPath ?? "",
        editorCommand: view.editorCommand ?? "",
        theme: view.theme ?? "system",
        taskPresets: { ...(view.taskPresets ?? {}) },
        accounts: null,
        sshHosts: [],
        keys: [],
        saving: false,
      });
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  previewTheme(theme: Theme): void {
    applyTheme(theme);
    this.updateDialog({ theme });
  }

  async saveGlobalSettings(): Promise<void> {
    const d = this.state.dialog;
    if (!this.api || d?.kind !== "global-settings") return;
    this.updateDialog({ saving: true });
    try {
      const view = await this.api.call("/settings/global/save", { settings: { gitPath: d.gitPath, editorCommand: d.editorCommand, theme: d.theme, taskPresets: d.taskPresets } });
      applyTheme(view.theme);
      this.store.set({ dialog: null });
      if (d.gitPath.trim() && view.gitVersion === null) this.toast(`git was not found at ${d.gitPath}`, "error");
      else this.toast("Settings saved", "info");
    } catch (e) {
      this.updateDialog({ saving: false, error: (e as Error).message });
    }
  }

  closeGlobalSettings(): void {
    // revert a previewed theme
    applyTheme(this.state.config?.settings.theme);
    this.closeDialog();
  }

  // ───────────── branch operations ─────────────

  openNewBranch(from?: string): void {
    const s = this.state;
    if (!s.refs || !s.status) return;
    const starts = [...s.refs.branches.map((b) => b.name), ...s.refs.remoteBranches.map((b) => b.name)];
    const t = s.template;
    this.openDialog({
      kind: "new-branch",
      name: "",
      type: t?.types[0] ?? "",
      code: "",
      from: from ?? s.status.branch ?? starts[0] ?? "HEAD",
      checkout: true,
      starts,
      template: t,
      custom: false,
    });
  }

  /** The branch name the dialog will create: by template when the repository has one, else the name as typed. */
  branchNameFromDialog(): string {
    const d = this.state.dialog;
    if (d?.kind !== "new-branch") return "";
    if (!d.template || d.custom) return d.name.trim();
    if (!d.name.trim() && !d.code.trim()) return "";
    return buildBranchName(d.template, { type: d.type, name: d.name, code: d.code });
  }

  /** Repo Settings → Task template: choose a preset (built-in or saved), "None" or keep "Custom". */
  applyPreset(name: string): void {
    const d = this.state.dialog;
    if (d?.kind !== "repo-settings") return;
    if (name === "None") {
      this.updateDialog({ template: null, presetName: "None" });
      return;
    }
    if (name === "Custom") {
      this.updateDialog({ template: d.template ?? { ...(BUILT_IN_PRESETS[0]?.template ?? emptyTemplate()) }, presetName: "Custom" });
      return;
    }
    const p = this.state.presets.find((x) => x.name === name) ?? BUILT_IN_PRESETS.find((x) => x.name === name);
    if (p) this.updateDialog({ template: { ...p.template, types: [...p.template.types] }, presetName: p.name });
  }

  editTemplate(patch: Partial<TaskTemplate>): void {
    const d = this.state.dialog;
    if (d?.kind !== "repo-settings" || !d.template) return;
    const template = { ...d.template, ...patch };
    this.updateDialog({ template, presetName: presetNameFor(template, this.state.presets) });
  }

  /** "Save as preset": stores the current template under a name in Global Settings. */
  saveTemplateAsPreset(): void {
    const d = this.state.dialog;
    if (d?.kind !== "repo-settings" || !d.template) return;
    const template = d.template;
    const dialogBefore = d;
    this.openDialog({
      kind: "prompt",
      title: "Save as preset",
      label: "Preset name",
      value: d.presetName === "Custom" || d.presetName === "None" ? "" : d.presetName,
      okLabel: "Save",
      mono: false,
      onOk: (name) => {
        const n = name.trim();
        if (BUILT_IN_PRESETS.some((p) => p.name === n)) {
          this.toast(`${n} is a built-in preset, choose another name`, "error");
          this.store.set({ dialog: dialogBefore });
          return;
        }
        const cfg = this.state.config;
        const taskPresets = { ...(cfg?.settings.taskPresets ?? {}), [n]: template };
        void this.api
          ?.call("/settings/global/save", { settings: { ...(cfg?.settings ?? {}), taskPresets } })
          .then(() => {
            const presets = [...BUILT_IN_PRESETS, ...Object.entries(taskPresets).map(([name, t]) => ({ name, template: t, builtIn: false }))];
            this.store.set({ presets, dialog: { ...dialogBefore, presetName: n } });
            this.toast(`Preset ${n} saved`, "info");
          })
          .catch((e: Error) => this.toast(e.message, "error"));
      },
    });
  }

  // ───────────── accounts (Global Settings → Accounts) ─────────────

  async loadAccounts(): Promise<void> {
    if (!this.api) return;
    const d = this.state.dialog;
    if (d?.kind !== "global-settings") return;
    this.updateDialog({ tab: "accounts" });
    try {
      const r = await this.api.call("/accounts/list", {});
      if (this.state.dialog?.kind === "global-settings") this.updateDialog({ accounts: r.accounts, sshHosts: r.sshHosts, keys: r.keys });
    } catch (e) {
      this.toast((e as Error).message, "error");
    }
  }

  signIn(host: string): void {
    void this.api
      ?.call("/accounts/login", { host })
      .then(({ job }) => this.store.set({ jobs: [...this.state.jobs.filter((j) => j.id !== job.id), job] }))
      .catch((e: Error) => this.toast(e.message, "error"));
  }

  signOut(host: string, username?: string): void {
    void this.api
      ?.call("/accounts/logout", username ? { host, username } : { host })
      .then(() => {
        this.toast(`Signed out of ${host}`, "info");
        void this.loadAccounts();
      })
      .catch((e: Error) => this.toast(e.message, "error"));
  }

  openAddToken(host: string): void {
    const back = this.state.dialog;
    this.openDialog({ kind: "add-token", host, username: "", token: "" });
    this.tokenReturnTo = back;
  }

  private tokenReturnTo: Dialog | null = null;

  async saveToken(): Promise<void> {
    const d = this.state.dialog;
    if (!this.api || d?.kind !== "add-token") return;
    try {
      await this.api.call("/accounts/token", { host: d.host, username: d.username, token: d.token });
      this.toast(`Token for ${d.host} stored in the credential manager`, "info");
      this.store.set({ dialog: this.tokenReturnTo });
      this.tokenReturnTo = null;
      void this.loadAccounts();
    } catch (e) {
      this.updateDialog({ error: (e as Error).message });
    }
  }

  cancelToken(): void {
    this.store.set({ dialog: this.tokenReturnTo });
    this.tokenReturnTo = null;
  }

  generateSshKey(): void {
    const comment = this.state.user?.email || "epic-git";
    void this.api
      ?.call("/ssh/generate", { comment })
      .then(({ key }) => {
        this.toast(`Generated ${key.name}. Copy the public key to your git host.`, "info");
        void this.loadAccounts();
      })
      .catch((e: Error) => this.toast(e.message, "error"));
  }

  testSsh(host: string): void {
    void this.api
      ?.call("/ssh/test", { host })
      .then(({ job }) => this.store.set({ jobs: [...this.state.jobs.filter((j) => j.id !== job.id), job] }))
      .catch((e: Error) => this.toast(e.message, "error"));
  }

  deletePreset(name: string): void {
    const d = this.state.dialog;
    if (d?.kind !== "global-settings") return;
    const taskPresets = { ...d.taskPresets };
    delete taskPresets[name];
    this.updateDialog({ taskPresets });
  }

  openExternal(url: string): void {
    if (hasShell()) void Neutralino.os.open(url).catch(() => window.open(url, "_blank"));
    else window.open(url, "_blank");
  }

  createBranch(): void {
    const d = this.state.dialog;
    if (d?.kind !== "new-branch") return;
    const name = this.branchNameFromDialog();
    if (!name) return;
    if (/[\s~^:?*[\\]|\.\.|@\{|^\/|\/$|\.lock$|^-/.test(name)) {
      this.updateDialog({ error: "Not a valid branch name (no spaces, ~ ^ : ? * [ \\ or ..)" });
      return;
    }
    this.store.set({ dialog: null });
    void this.mutate("/repo/branch/create", { name, from: d.from, checkout: d.checkout });
  }

  openRenameBranch(from: string): void {
    this.openDialog({ kind: "rename-branch", from, to: from });
  }

  renameBranch(): void {
    const d = this.state.dialog;
    if (d?.kind !== "rename-branch") return;
    const to = d.to.trim();
    if (!to || to === d.from) return this.closeDialog();
    this.store.set({ dialog: null });
    void this.mutate("/repo/branch/rename", { from: d.from, to });
  }

  deleteBranch(name: string, remote: boolean): void {
    const local = remote ? name.slice(name.indexOf("/") + 1) : name;
    this.openDialog({
      kind: "confirm",
      title: remote ? `Delete ${name} on the remote?` : `Delete branch ${local}?`,
      text: remote
        ? "The branch is removed from the remote for everyone. Local branches that track it stay."
        : "Unmerged commits on this branch stay reachable only through the reflog. The branch is deleted even if it is not merged.",
      okLabel: "Delete",
      danger: true,
      onOk: () => void this.mutate("/repo/branch/delete", { name, remote, force: !remote }),
    });
  }

  mergeBranch(name: string): void {
    const s = this.state;
    if (!s.status || this.isBusy()) return;
    if (s.status.operation !== "none") {
      this.toast(`Finish or abort the current ${s.status.operation} first`, "error");
      return;
    }
    void this.mutate("/repo/merge", { branch: name });
  }

  async mergedInto(branch: string, into: string[]): Promise<Record<string, boolean>> {
    const repoId = this.state.repoId;
    if (!this.api || !repoId) return {};
    try {
      return (await this.api.call("/repo/merged-into", { repoId, branch, into })).merged;
    } catch {
      return {};
    }
  }

  // ───────────── files ─────────────

  discard(paths: string[], untracked: boolean): void {
    const n = paths.length;
    this.openDialog({
      kind: "confirm",
      title: n === 1 ? `Discard changes in ${paths[0]}?` : `Discard changes in ${n} files?`,
      text: untracked
        ? "Untracked files are deleted from disk. This cannot be undone."
        : "The working copy goes back to the last commit. Untracked files among the selection are deleted. This cannot be undone.",
      okLabel: "Discard",
      danger: true,
      onOk: () => void this.mutate("/repo/discard", { paths }),
    });
  }

  ignore(pattern: string): void {
    this.openDialog({
      kind: "prompt",
      title: "Add to .gitignore",
      label: "Pattern",
      value: pattern,
      okLabel: "Add",
      mono: true,
      onOk: (value) => void this.mutate("/repo/ignore", { patterns: [value.trim()] }),
    });
  }

  stageHunk(index: number, reverse: boolean): void {
    const d = this.state.diff;
    if (!d) return;
    const patch = hunkPatch(d, index);
    if (!patch) return;
    void this.mutate("/repo/apply-patch", { patch, reverse });
  }

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
    const s = this.state;
    const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select") != null;
    if (e.key === "Delete" && !typing && s.view === "changes" && !s.dialog && !s.contextMenu && !s.openMenu) {
      e.preventDefault();
      this.discardSelected();
      return;
    }
    if (e.key === "Escape") {
      const s = this.state;
      if (s.contextMenu) this.store.set({ contextMenu: null });
      else if (s.openMenu) this.store.set({ openMenu: null });
      else if (s.logJobId) this.store.set({ logJobId: null });
      else if (s.dialog?.kind === "askpass") this.answerAskpass(s.dialog.request.id, null);
      else if (s.dialog?.kind === "global-settings") this.closeGlobalSettings();
      else if (s.dialog) this.closeDialog();
    }
  }

  // ───────────── render ─────────────

  private render(changed: Set<keyof State>): void {
    const s = this.state;
    const any = (...keys: (keyof State)[]) => keys.some((k) => changed.has(k));

    // of the jobs the toolbar only shows "busy": job progress events must not rebuild the buttons under the cursor
    const busy = this.isBusy();
    const busyChanged = busy !== this.renderedBusy;
    this.renderedBusy = busy;
    if (busyChanged || any("boot", "bootMessage", "config", "repoId", "status", "template", "connected", "stale", "view")) {
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
    if (any("refs", "sideFilter", "collapsedDirs", "repoId", "boot")) {
      const top = this.elTree.scrollTop;
      replaceChildren(this.elTree, renderTree(this));
      this.elTree.scrollTop = top;
    } else if (any("selectedBranch")) markSelectedBranch(this.elTree, s.selectedBranch);
    if (any("view", "repoId", "boot") || this.mountedView !== s.view) {
      this.mountedView = s.view;
      replaceChildren(this.elMain, s.view === "changes" ? this.changes.mount() : this.commits.mount());
      this.changes.update(changed, true);
      this.commits.update(changed, true);
    } else {
      this.changes.update(changed, false);
      this.commits.update(changed, false);
    }
    if (any("openMenu", "menuHover", "contextMenu", "dialog", "toasts", "logJobId", "jobLogs", "jobs", "config", "repoId", "status")) {
      // Dialogs are rebuilt on every keystroke: remember which field had the focus (by position) and the caret, then restore.
      const active = document.activeElement;
      const fields = () => [...this.elOverlay.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")];
      const index = active && this.elOverlay.contains(active) ? fields().indexOf(active as HTMLInputElement) : -1;
      const sel: [number | null, number | null] | null =
        index >= 0 && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) ? [active.selectionStart, active.selectionEnd] : null;
      replaceChildren(this.elOverlay, renderOverlay(this));
      if (index >= 0) {
        const again = fields()[index];
        if (again) {
          again.focus();
          if (sel && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement) && sel[0] !== null && sel[1] !== null) {
            try {
              again.setSelectionRange(sel[0], sel[1]);
            } catch {
              /* not a text input */
            }
          }
        }
      }
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
