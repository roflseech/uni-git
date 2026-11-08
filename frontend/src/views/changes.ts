import type { FileChange, JobInfo, UiLayout } from "@uni-git/shared";
import type { App } from "../app.js";
import { cls, h, onRowDoubleClick, replaceChildren, setupSplitter, watchDoubleClicks } from "../dom.js";
import { baseName, groupFiles } from "../format.js";
import type { FileSel, State } from "../state.js";
import { renderDiff } from "./diff.js";
import { renderUnity } from "./unity.js";
import { commitPrefix, INSTALL_COMMANDS, isUnityYamlPath, taskCodeFromBranch } from "@uni-git/shared";

const KIND_CLASS: Record<string, string> = { A: "a", "?": "a", M: "m", T: "m", R: "m", C: "m", D: "d", U: "c" };

/** "Preview" over the diff of a Unity scene/prefab: objects and properties instead of the YAML. */
export function unityToggle(app: App): HTMLElement {
  return h(
    "label",
    { class: "check", title: "Show the scene/prefab as objects and properties; untick for the raw YAML diff" },
    h("input", { type: "checkbox", checked: app.state.unityPreview, onchange: (e: Event) => app.setUnityPreview((e.target as HTMLInputElement).checked) }),
    "Preview",
  );
}

/** Changes view: unstaged/staged trees on the left, diff + commit form on the right. Inputs persist across updates. */
export class ChangesView {
  private readonly elFiles = h("div", { class: "col files-col" });
  private readonly elDiffHead = h("div", { class: "colhead" });
  private readonly elDiff = h("div", { class: "diffwrap" });
  private readonly subject = h("input", { class: "field", placeholder: "Commit subject" });
  private readonly desc = h("textarea", { class: "field desc", placeholder: "Description" });
  private readonly amend = h("input", { type: "checkbox" });
  private readonly btnCommit = h("button", { class: "btn primary" }, "Commit");
  private readonly btnCommitPush = h("button", { class: "btn" }, "Commit & Push");
  private readonly btnTaskCode = h("button", { class: "btn small", title: "Insert the task code prefix from the branch name" }, "Insert task code");
  /** file rows by area:path, to move the selection highlight without a rebuild */
  private readonly rows = new Map<string, HTMLElement>();
  /** files in the order they are shown, for shift-click ranges */
  private rowOrder: FileSel[] = [];
  private shownJobsKey = "";
  private shownBodyKey = "";
  /** branch the current prefix was inserted for, so a cleared prefix is not forced back */
  private prefixedFor: string | null = null;
  private readonly elForm: HTMLElement;
  private readonly elRoot: HTMLElement;
  private readonly applySplit: (saved: number | undefined) => void;

  constructor(private readonly app: App) {
    this.amend.addEventListener("change", () => void this.onAmend());
    this.btnCommit.addEventListener("click", () => this.commit(false));
    this.btnCommitPush.addEventListener("click", () => this.commit(true));
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.commit(false);
      }
    };
    this.subject.addEventListener("keydown", onKey);
    this.desc.addEventListener("keydown", onKey);
    this.subject.addEventListener("input", () => this.updateButtons());
    this.btnTaskCode.addEventListener("click", () => this.insertTaskCode(true));

    this.elForm = h(
      "div",
      { class: "commitform" },
      h("div", { class: "row" }, this.subject, this.btnTaskCode),
      this.desc,
      h(
        "div",
        { class: "row" },
        h("label", { class: "check" }, this.amend, "Amend last commit"),
        h("span", { style: "flex:1" }),
        this.btnCommitPush,
        this.btnCommit,
      ),
    );
    const split = h("div", { class: "splitter", title: "Drag to resize, double-click to reset" });
    this.elRoot = h("div", { class: "main-grid" }, this.elFiles, split, h("div", { class: "col" }, this.elDiffHead, this.elDiff, this.elForm));
    this.applySplit = setupSplitter(split, this.elFiles, this.elRoot, { name: "--left-w", min: 15, max: 80, percent: true, onChange: (changesSplit) => app.saveLayout({ changesSplit }) });
    watchDoubleClicks(this.elFiles);
  }

  applyLayout(ui: UiLayout): void {
    this.applySplit(ui.changesSplit);
  }

  mount(): HTMLElement {
    return this.elRoot;
  }

  focusSubject(): void {
    this.subject.focus();
  }

  clearForm(): void {
    this.subject.value = "";
    this.desc.value = "";
    this.amend.checked = false;
    this.prefixedFor = null;
    this.app.store.set({ amend: false });
    this.updateButtons();
    this.insertTaskCode(false);
  }

  /** Prefix from the task template, e.g. "[869eu8fkw] ". Automatic once per branch; the button forces it. */
  private insertTaskCode(force: boolean): void {
    const s = this.app.state;
    const branch = s.status?.branch ?? null;
    const code = taskCodeFromBranch(s.template, branch);
    const prefix = commitPrefix(s.template, code);
    this.btnTaskCode.hidden = !code;
    this.btnTaskCode.title = code ? `Insert ${prefix.trim() || code}` : "";
    if (!code) return;
    const key = `${s.repoId}:${branch}`;
    if (!force && (this.prefixedFor === key || this.subject.value.trim())) return;
    this.prefixedFor = key;
    const insert = prefix || `${code} `;
    if (!this.subject.value.startsWith(insert.trim())) this.subject.value = insert + this.subject.value.replace(/^\s+/, "");
    this.updateButtons();
    if (force) this.subject.focus();
  }

  update(changed: Set<keyof State>, force: boolean): void {
    if (this.app.state.view !== "changes") return;
    const any = (...keys: (keyof State)[]) => force || keys.some((k) => changed.has(k));
    // Rebuilding rows under the cursor eats clicks and flickers, so each part is rebuilt only when what it shows changed:
    // of the jobs that is "busy" and the banner text, of the selection the highlighted row.
    const s = this.app.state;
    const jobsChanged = changed.has("jobs") && this.jobsKey() !== this.shownJobsKey;
    if (any("status", "collapsedDirs", "repoId", "boot") || jobsChanged) this.renderFiles();
    else if (changed.has("selectedFile") || changed.has("selectedFiles")) this.markSelected();
    if (any("selectedFile", "diffMode", "unityPreview") || jobsChanged) this.renderDiffHead();
    const sel = s.selectedFile;
    const unity = this.app.unityShown(sel?.path);
    const bodyKey = `${sel?.area}:${sel?.kind}:${unity ? `unity:${sel?.path}` : s.diffLoading && !s.diff}`;
    const bodyInputs: (keyof State)[] = unity ? ["unity", "unityLoading", "unityChoices"] : ["diff", "diffMode"];
    if (any(...bodyInputs) || jobsChanged || bodyKey !== this.shownBodyKey) this.renderDiffBody(bodyKey);
    if (any("status", "jobs", "repoId", "amend", "boot")) this.updateButtons();
    if (changed.has("status")) void this.prefillMergeMessage();
    if (any("status", "template", "repoId")) this.insertTaskCode(false);
  }

  /** The job the busy banner names: the running one, else the first queued. Quiet jobs (stage/unstage) block nothing. */
  private bannerJob(): JobInfo | undefined {
    return this.app.busyJob();
  }

  /** What this view shows of the jobs. */
  private jobsKey(): string {
    return `${this.app.isBusy()}:${this.bannerJob()?.title ?? ""}`;
  }

  private static rowKey(area: string, path: string): string {
    return `${area}:${path}`;
  }

  /** Moves the highlight without rebuilding the list. */
  private markSelected(): void {
    const want = new Set(this.app.state.selectedFiles.map((f) => ChangesView.rowKey(f.area, f.path)));
    for (const [key, row] of this.rows) row.classList.toggle("sel", want.has(key));
  }

  private renderFiles(): void {
    const app = this.app;
    const s = this.app.state;
    const st = s.status;
    const busy = this.app.isBusy();
    const parts: (HTMLElement | null)[] = [];
    this.shownJobsKey = this.jobsKey();
    this.rows.clear();
    this.rowOrder = [];

    const job = this.bannerJob();
    if (job) {
      parts.push(
        h(
          "div",
          { class: "banner" },
          h("span", { class: "spin" }),
          h("span", null, `Repository is busy: ${job.title}. Data below may be stale and actions are unavailable until it finishes. You can switch to another repository meanwhile.`),
        ),
      );
    }

    if (!st) {
      parts.push(h("div", { class: "empty" }, s.repoId ? "Loading status…" : s.boot === "ready" ? "Add a repository from the Repositories menu" : s.bootMessage));
      if (s.boot === "failed") {
        // the backend lives in its own file: if an update left it unable to start, the installer puts every file back
        const command = typeof NL_OS === "string" && NL_OS === "Darwin" ? INSTALL_COMMANDS.mac : INSTALL_COMMANDS.windows;
        parts.push(h("div", { class: "empty" }, "If it keeps failing, reinstall uni-git (settings stay):", h("div", { class: "mono reinstall" }, command)));
      }
      replaceChildren(this.elFiles, parts);
      return;
    }

    if (st.conflicts.length) {
      parts.push(this.section("Conflicts", st.conflicts, "conflict", busy, st.operation !== "none" ? `during ${st.operation}` : undefined));
    }
    if (st.operation !== "none" && !st.conflicts.length && !busy) {
      const op = st.operation;
      parts.push(
        h(
          "div",
          { class: "banner ok" },
          h("span", null, `${op[0]?.toUpperCase()}${op.slice(1)} in progress, all conflicts resolved. ${op === "merge" ? "Commit below to finish it" : "Continue to finish it"}, or abort.`),
          h("span", { style: "flex:1" }),
          op === "merge" ? null : h("button", { class: "btn small", onclick: () => app.continueOperation() }, "Continue"),
          h("button", { class: "btn small", onclick: () => app.abortOperation() }, `Abort ${op}`),
        ),
      );
    }
    parts.push(this.section("Unstaged", st.unstaged, "unstaged", busy));
    parts.push(this.section("Staged", st.staged, "staged", busy));
    // emptying the container resets its scroll position
    const top = this.elFiles.scrollTop;
    replaceChildren(this.elFiles, parts);
    this.elFiles.scrollTop = top;
  }

  private section(title: string, files: FileChange[], area: "unstaged" | "staged" | "conflict", busy: boolean, note?: string): HTMLElement {
    const app = this.app;
    const s = app.state;
    const all = files.map((f) => f.path);
    const unityConflicts = area === "conflict" ? all.filter(isUnityYamlPath) : [];
    const actionAll =
      area === "unstaged"
        ? [
            h("button", { class: "btn small", disabled: busy || !(files.length || s.status?.staged.length), title: "Stash all uncommitted changes", onclick: () => app.openStashSave() }, "Stash…"),
            h("button", { class: "btn small", disabled: busy || !files.length, onclick: () => app.stage(all) }, "Stage all"),
            h("button", { class: "btn small warn", disabled: busy || !(files.length || s.status?.staged.length), title: "Discard every uncommitted change, untracked files included", onclick: () => app.discardAll() }, "Discard all…"),
          ]
        : area === "staged"
          ? h("button", { class: "btn small", disabled: busy || !files.length, onclick: () => app.unstage(all) }, "Unstage all")
          : [
              unityConflicts.length
                ? h("button", { class: "btn small", disabled: busy, title: `Run UnityYAMLMerge on ${unityConflicts.length} scene/prefab file(s): what it merges cleanly is staged`, onclick: () => app.yamlMerge(unityConflicts) }, "UnityYAMLMerge")
                : null,
              h("button", { class: "btn small", disabled: busy || !files.length, onclick: () => app.resolveConflict(all, "ours") }, "Take ours"),
              h("button", { class: "btn small", disabled: busy || !files.length, onclick: () => app.resolveConflict(all, "theirs") }, "Take theirs"),
              h("button", { class: "btn small", disabled: busy, onclick: () => app.abortOperation() }, `Abort ${s.status?.operation ?? ""}`),
            ];
    const head = h(
      "div",
      { class: "colhead" },
      h("span", null, `${title} ${files.length}`, note ? h("span", { class: "muted" }, ` ${note}`) : null),
      h("span", { class: "tools" }, actionAll),
    );
    const list = h("ul", { class: "files" });
    if (!files.length) {
      list.append(h("li", { class: "muted" }, h("span", { class: "name" }, area === "staged" ? "Nothing staged" : "No local changes")));
    }
    for (const g of groupFiles(files)) {
      const key = `${area}:${g.dir}`;
      const collapsed = s.collapsedDirs.has(key);
      if (g.dir) {
        const dirPaths = g.files.map((f) => f.change.path);
        list.append(
          h(
            "li",
            {
              class: "dirrow",
              onclick: () => app.toggleDir(area, g.dir),
              oncontextmenu: (e: MouseEvent) => {
                e.preventDefault();
                const items: { label: string; danger?: boolean; onClick: () => void }[] = [];
                if (area === "unstaged") items.push({ label: `Stage folder (${dirPaths.length})`, onClick: () => app.stage(dirPaths) });
                if (area === "staged") items.push({ label: `Unstage folder (${dirPaths.length})`, onClick: () => app.unstage(dirPaths) });
                if (area !== "conflict") {
                  const allUntracked = g.files.every((f) => f.change.kind === "?");
                  items.push({ label: allUntracked ? `Delete ${dirPaths.length} untracked files…` : `Discard changes in folder (${dirPaths.length})…`, danger: true, onClick: () => app.discard(dirPaths, allUntracked) });
                }
                items.push({ label: `Add to .gitignore: ${g.dir}/`, onClick: () => app.ignore(`${g.dir}/`) });
                items.push({ label: "Copy path", onClick: () => void navigator.clipboard?.writeText(g.dir) });
                if (busy) for (const it of items) it.onClick = () => app.toast("Repository is busy", "error");
                app.store.set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
              },
            },
            h("span", { class: "dir" }, `${collapsed ? "▸" : "▾"} ${g.dir}`),
            h("span", { class: "hover-tools" }, this.rowAction(area, dirPaths, busy)),
          ),
        );
        if (collapsed) continue;
      }
      for (const f of g.files) {
        const sel = s.selectedFiles.some((x) => x.path === f.change.path && x.area === area);
        const kind = f.change.kind;
        const rowKey = ChangesView.rowKey(area, f.change.path);
        const fileSel: FileSel = { area, path: f.change.path, kind };
        this.rowOrder.push(fileSel);
        const row = onRowDoubleClick(
          h(
            "li",
            {
              class: cls(g.dir && "d1", sel && "sel"),
              title: f.change.oldPath ? `${f.change.oldPath} → ${f.change.path}` : f.change.path,
              // on press, like a native list: no wait for the release, and a rebuild in between cannot eat the click
              onmousedown: (e: MouseEvent) => {
                if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
                if (mods.shift) e.preventDefault();
                const cur = app.state.selectedFile;
                const already = cur?.path === f.change.path && cur.area === area && app.state.selectedFiles.length === 1;
                if (!already || mods.ctrl || mods.shift) app.clickFile(fileSel, mods, this.rowOrder);
              },
              oncontextmenu: (e: MouseEvent) => {
                e.preventDefault();
                // a right click on a file outside the selection selects it alone; inside, the menu acts on the whole selection
                if (!app.state.selectedFiles.some((x) => x.path === f.change.path && x.area === area)) app.clickFile(fileSel, { ctrl: false, shift: false }, this.rowOrder);
                const p = f.change.path;
                const ps = app.selectedPathsIn(area, p);
                const n = ps.length > 1 ? ` (${ps.length})` : "";
                const untracked = ps.length > 1 ? app.state.selectedFiles.filter((x) => x.area === area).every((x) => x.kind === "?") : kind === "?";
                const dot = baseName(p).lastIndexOf(".");
                const ext = dot > 0 ? baseName(p).slice(dot) : "";
                const items: { label: string; danger?: boolean; onClick: () => void }[] = [];
                if (area === "unstaged") items.push({ label: `Stage${n}`, onClick: () => app.stage(ps) });
                if (area === "staged") items.push({ label: `Unstage${n}`, onClick: () => app.unstage(ps) });
                if (area !== "conflict") items.push({ label: untracked ? `Delete untracked file${ps.length > 1 ? "s" : ""}${n}…` : `Discard changes${n}…`, danger: true, onClick: () => app.discard(ps, untracked) });
                items.push({ label: `Add to .gitignore: ${p}`, onClick: () => app.ignore(p) });
                if (ext) items.push({ label: `Add to .gitignore: *${ext}`, onClick: () => app.ignore(`*${ext}`) });
                items.push({ label: "Copy path", onClick: () => void navigator.clipboard?.writeText(p) });
                if (busy) items.forEach((it) => (it.onClick = () => app.toast("Repository is busy", "error")));
                app.store.set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
              },
            },
            h("span", { class: cls("flag", KIND_CLASS[kind] ?? "m") }, kind === "?" ? "A" : kind),
            h("span", { class: "name" }, f.rel),
            f.change.oldPath ? h("span", { class: "note" }, `← ${baseName(f.change.oldPath)}`) : null,
            h("span", { class: "hover-tools" }, this.rowAction(area, () => app.selectedPathsIn(area, f.change.path), busy)),
          ),
          rowKey,
          () => {
            if (app.isBusy()) return;
            if (area === "unstaged") app.stage([f.change.path]);
            else if (area === "staged") app.unstage([f.change.path]);
          },
        );
        this.rows.set(rowKey, row);
        list.append(row);
      }
    }
    return h("div", { class: "section" }, head, list);
  }

  /** `paths` as a function: resolved at click time (the selection may have grown since the row was built). */
  private rowAction(area: "unstaged" | "staged" | "conflict", pathsOrFn: string[] | (() => string[]), busy: boolean): HTMLElement | null {
    const app = this.app;
    const paths = typeof pathsOrFn === "function" ? pathsOrFn() : pathsOrFn;
    if (area === "conflict") {
      return h(
        "span",
        { class: "tools" },
        h("button", { class: "btn small", disabled: busy, title: "Keep our version (current branch)", onclick: (e: Event) => (e.stopPropagation(), app.resolveConflict(paths, "ours")) }, "Ours"),
        h("button", { class: "btn small", disabled: busy, title: "Take their version (branch being merged)", onclick: (e: Event) => (e.stopPropagation(), app.resolveConflict(paths, "theirs")) }, "Theirs"),
        h("button", { class: "btn small", disabled: busy, title: "Mark as resolved (stage the file as it is on disk)", onclick: (e: Event) => (e.stopPropagation(), app.resolveConflict(paths, "mark")) }, "Resolved"),
      );
    }
    const label = area === "unstaged" ? "Stage" : "Unstage";
    return h(
      "button",
      {
        class: "btn small",
        disabled: busy,
        onclick: (e: Event) => {
          e.stopPropagation();
          const ps = typeof pathsOrFn === "function" ? pathsOrFn() : pathsOrFn;
          if (area === "unstaged") app.stage(ps);
          else app.unstage(ps);
        },
      },
      label,
    );
  }

  private renderDiffHead(): void {
    const app = this.app;
    const s = app.state;
    const sel = s.selectedFile;
    const busy = app.isBusy();
    const modeBtn = (label: string, mode: "side" | "inline") =>
      h("button", { class: cls("btn small", s.diffMode === mode && "on"), onclick: () => app.setDiffMode(mode) }, label);
    const actions: HTMLElement[] = [];
    if (sel && sel.area === "unstaged") actions.push(h("button", { class: "btn small", disabled: busy, onclick: () => app.stage([sel.path]) }, "Stage file"));
    if (sel && sel.area === "staged") actions.push(h("button", { class: "btn small", disabled: busy, onclick: () => app.unstage([sel.path]) }, "Unstage file"));
    const unity = !!sel && isUnityYamlPath(sel.path);
    replaceChildren(
      this.elDiffHead,
      h("span", { class: "file", title: sel?.path ?? "" }, sel ? sel.path : "No file selected"),
      h(
        "span",
        { class: "tools" },
        unity ? unityToggle(app) : null,
        unity && s.unityPreview ? null : [modeBtn("Side by side", "side"), modeBtn("Inline", "inline")],
        ...actions,
      ),
    );
  }

  /** The diff itself can be thousands of highlighted lines: rebuilt when the diff changes, not on every click in the file list. */
  private renderDiffBody(key: string): void {
    const app = this.app;
    const s = app.state;
    const sel = s.selectedFile;
    const busy = app.isBusy();
    const sameBody = this.shownBodyKey === key;
    this.shownBodyKey = key;
    if (app.unityShown(sel?.path)) {
      // picking a resolution re-renders the preview: it keeps its scroll position
      const top = sameBody ? this.elDiff.scrollTop : 0;
      replaceChildren(this.elDiff, renderUnity(app, s.unity?.path === sel?.path ? s.unity : null, s.unityLoading, s.unityChoices, { resolvable: sel?.area === "conflict", busy }));
      this.elDiff.scrollTop = top;
      return;
    }
    // hunk staging only for modified tracked files (new/deleted/renamed files are all-or-nothing)
    const hunkAction =
      sel && s.diff && !s.diff.binary && (sel.area === "unstaged" || sel.area === "staged") && (sel.kind === "M" || sel.kind === "T")
        ? { label: sel.area === "unstaged" ? "Stage hunk" : "Unstage hunk", disabled: busy, onClick: (i: number) => app.stageHunk(i, sel.area === "staged") }
        : undefined;
    replaceChildren(this.elDiff, renderDiff(s.diff, s.diffMode, s.diffLoading, hunkAction));
  }

  private updateButtons(): void {
    const s = this.app.state;
    const busy = this.app.isBusy();
    const hasStaged = !!s.status && s.status.staged.length > 0;
    const hasConflicts = !!s.status && s.status.conflicts.length > 0;
    const mergeDone = !!s.status && s.status.operation === "merge" && !hasConflicts;
    // the lists already show a stage/unstage that is still running: commit once it is done, so that the commit holds
    // what the lists show (a failed stage would otherwise leave the commit with less, or nothing)
    const staging = !!s.repoId && this.app.movingFiles(s.repoId);
    const can = !!s.status && !busy && !staging && !hasConflicts && (hasStaged || s.amend || mergeDone) && this.subject.value.trim().length > 0;
    this.btnCommit.disabled = !can;
    this.btnCommitPush.disabled = !can;
    this.amend.disabled = !s.status || busy || !s.status.head;
    this.subject.disabled = !s.status;
    this.desc.disabled = !s.status;
    this.btnCommit.title = hasConflicts ? "Resolve conflicts first" : staging ? "Staging is still running" : !hasStaged && !s.amend ? "Stage changes first" : "";
  }

  /** A merge in progress: the commit form starts with git's own merge message. */
  private prefilledFor: string | null = null;
  private async prefillMergeMessage(): Promise<void> {
    const st = this.app.state.status;
    const key = st ? `${this.app.state.repoId}:${st.operation}` : null;
    if (!st || st.operation !== "merge") {
      this.prefilledFor = null;
      return;
    }
    if (this.prefilledFor === key || this.subject.value.trim()) return;
    this.prefilledFor = key;
    const msg = await this.app.mergeMessage();
    if (!msg || this.subject.value.trim()) return;
    const nl = msg.indexOf("\n");
    this.subject.value = nl >= 0 ? msg.slice(0, nl) : msg;
    this.desc.value = nl >= 0 ? msg.slice(nl + 1).replace(/^\n+/, "") : "";
    this.updateButtons();
  }

  private async onAmend(): Promise<void> {
    const on = this.amend.checked;
    this.app.store.set({ amend: on });
    if (on && !this.subject.value.trim() && !this.desc.value.trim()) {
      const msg = await this.app.lastCommitMessage();
      if (!this.amend.checked) return;
      const nl = msg.indexOf("\n");
      this.subject.value = nl >= 0 ? msg.slice(0, nl) : msg;
      this.desc.value = nl >= 0 ? msg.slice(nl + 1).replace(/^\n+/, "") : "";
    }
    this.updateButtons();
  }

  private commit(push: boolean): void {
    if (this.btnCommit.disabled) return;
    const subject = this.subject.value.trim();
    const body = this.desc.value.trim();
    const message = body ? `${subject}\n\n${body}` : subject;
    this.app.commit(message, this.amend.checked, push);
  }
}
