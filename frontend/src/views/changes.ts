import type { FileChange } from "@epic-git/shared";
import type { App } from "../app.js";
import { cls, h, replaceChildren } from "../dom.js";
import { baseName, groupFiles } from "../format.js";
import type { State } from "../state.js";
import { renderDiff } from "./diff.js";

const KIND_CLASS: Record<string, string> = { A: "a", "?": "a", M: "m", T: "m", R: "m", C: "m", D: "d", U: "c" };

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
  private readonly elForm: HTMLElement;
  private readonly elRoot: HTMLElement;

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

    this.elForm = h(
      "div",
      { class: "commitform" },
      h("div", { class: "row" }, this.subject),
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
    this.elRoot = h("div", { class: "main-grid" }, this.elFiles, h("div", { class: "col" }, this.elDiffHead, this.elDiff, this.elForm));
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
    this.app.store.set({ amend: false });
    this.updateButtons();
  }

  update(changed: Set<keyof State>, force: boolean): void {
    if (this.app.state.view !== "changes") return;
    const any = (...keys: (keyof State)[]) => force || keys.some((k) => changed.has(k));
    if (any("status", "selectedFile", "jobs", "stale", "collapsedDirs", "repoId", "boot")) this.renderFiles();
    if (any("selectedFile", "diff", "diffLoading", "diffMode")) this.renderDiffPane();
    if (any("status", "jobs", "repoId", "amend", "boot")) this.updateButtons();
  }

  private renderFiles(): void {
    const s = this.app.state;
    const st = s.status;
    const busy = this.app.isBusy();
    const parts: (HTMLElement | null)[] = [];

    if (busy) {
      const job = this.app.jobsFor(s.repoId ?? "").find((j) => j.state === "running") ?? this.app.jobsFor(s.repoId ?? "")[0];
      if (job && !job.quiet) {
        parts.push(
          h(
            "div",
            { class: "banner" },
            h("span", { class: "spin" }),
            h("span", null, `Repository is busy: ${job.title}. Data below may be stale and actions are unavailable until it finishes. You can switch to another repository meanwhile.`),
          ),
        );
      }
    }

    if (!st) {
      parts.push(h("div", { class: "empty" }, s.repoId ? "Loading status…" : s.boot === "ready" ? "Add a repository from the Repositories menu" : s.bootMessage));
      replaceChildren(this.elFiles, parts);
      return;
    }

    if (st.conflicts.length) {
      parts.push(this.section("Conflicts", st.conflicts, "conflict", busy, st.operation !== "none" ? `during ${st.operation}` : undefined));
    }
    parts.push(this.section("Unstaged", st.unstaged, "unstaged", busy));
    parts.push(this.section("Staged", st.staged, "staged", busy));
    replaceChildren(this.elFiles, parts);
  }

  private section(title: string, files: FileChange[], area: "unstaged" | "staged" | "conflict", busy: boolean, note?: string): HTMLElement {
    const app = this.app;
    const s = app.state;
    const all = files.map((f) => f.path);
    const actionAll =
      area === "unstaged"
        ? h("button", { class: "btn small", disabled: busy || !files.length, onclick: () => app.stage(all) }, "Stage all")
        : area === "staged"
          ? h("button", { class: "btn small", disabled: busy || !files.length, onclick: () => app.unstage(all) }, "Unstage all")
          : null;
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
            { class: "dirrow", onclick: () => app.toggleDir(area, g.dir) },
            h("span", { class: "dir" }, `${collapsed ? "▸" : "▾"} ${g.dir}`),
            h("span", { class: "hover-tools" }, this.rowAction(area, dirPaths, busy)),
          ),
        );
        if (collapsed) continue;
      }
      for (const f of g.files) {
        const sel = s.selectedFile && s.selectedFile.path === f.change.path && s.selectedFile.area === area;
        const kind = f.change.kind;
        list.append(
          h(
            "li",
            {
              class: cls(g.dir && "d1", sel && "sel"),
              title: f.change.oldPath ? `${f.change.oldPath} → ${f.change.path}` : f.change.path,
              onclick: () => void app.selectFile({ area, path: f.change.path, kind }),
              ondblclick: () => {
                if (busy) return;
                if (area === "unstaged") app.stage([f.change.path]);
                else if (area === "staged") app.unstage([f.change.path]);
              },
            },
            h("span", { class: cls("flag", KIND_CLASS[kind] ?? "m") }, kind === "?" ? "A" : kind),
            h("span", { class: "name" }, f.rel),
            f.change.oldPath ? h("span", { class: "note" }, `← ${baseName(f.change.oldPath)}`) : null,
            h("span", { class: "hover-tools" }, this.rowAction(area, [f.change.path], busy)),
          ),
        );
      }
    }
    return h("div", { class: "section" }, head, list);
  }

  private rowAction(area: "unstaged" | "staged" | "conflict", paths: string[], busy: boolean): HTMLElement | null {
    const app = this.app;
    if (area === "conflict") return null;
    const label = area === "unstaged" ? "Stage" : "Unstage";
    return h(
      "button",
      {
        class: "btn small",
        disabled: busy,
        onclick: (e: Event) => {
          e.stopPropagation();
          if (area === "unstaged") app.stage(paths);
          else app.unstage(paths);
        },
      },
      label,
    );
  }

  private renderDiffPane(): void {
    const app = this.app;
    const s = app.state;
    const sel = s.selectedFile;
    const busy = app.isBusy();
    const modeBtn = (label: string, mode: "side" | "inline") =>
      h("button", { class: cls("btn small", s.diffMode === mode && "on"), onclick: () => app.setDiffMode(mode) }, label);
    const actions: HTMLElement[] = [];
    if (sel && sel.area === "unstaged") actions.push(h("button", { class: "btn small", disabled: busy, onclick: () => app.stage([sel.path]) }, "Stage file"));
    if (sel && sel.area === "staged") actions.push(h("button", { class: "btn small", disabled: busy, onclick: () => app.unstage([sel.path]) }, "Unstage file"));
    replaceChildren(
      this.elDiffHead,
      h("span", { class: "file", title: sel?.path ?? "" }, sel ? sel.path : "No file selected"),
      h("span", { class: "tools" }, modeBtn("Side by side", "side"), modeBtn("Inline", "inline"), ...actions),
    );
    replaceChildren(this.elDiff, renderDiff(s.diff, s.diffMode, s.diffLoading));
  }

  private updateButtons(): void {
    const s = this.app.state;
    const busy = this.app.isBusy();
    const hasStaged = !!s.status && s.status.staged.length > 0;
    const hasConflicts = !!s.status && s.status.conflicts.length > 0;
    const can = !!s.status && !busy && !hasConflicts && (hasStaged || s.amend) && this.subject.value.trim().length > 0;
    this.btnCommit.disabled = !can;
    this.btnCommitPush.disabled = !can;
    this.amend.disabled = !s.status || busy || !s.status.head;
    this.subject.disabled = !s.status;
    this.desc.disabled = !s.status;
    this.btnCommit.title = hasConflicts ? "Resolve conflicts first" : !hasStaged && !s.amend ? "Stage changes first" : "";
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
