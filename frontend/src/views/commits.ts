import type { App } from "../app.js";
import { cls, h, replaceChildren, setupSplitter } from "../dom.js";
import { longDate, parseDecorations, shortDate } from "../format.js";
import type { State } from "../state.js";
import { renderDiff } from "./diff.js";
import { unityToggle } from "./changes.js";
import { renderUnity } from "./unity.js";
import { findTaskCodes, isUnityYamlPath, taskLink, type UiLayout } from "@uni-git/shared";

/** Subject text with task codes turned into tracker chips (mockup 02, note 2). */
function subjectWithCodes(app: App, text: string): (string | HTMLElement)[] {
  const t = app.state.template;
  const codes = findTaskCodes(t, text);
  if (!codes.length) return [text];
  const out: (string | HTMLElement)[] = [text];
  for (const code of codes) {
    const link = taskLink(t, code);
    out.push(
      h(
        "a",
        {
          class: "tagchip",
          title: link ?? code,
          onclick: (e: Event) => {
            e.stopPropagation();
            if (link) app.openExternal(link);
          },
        },
        link ? `${code} ↗` : code,
      ),
    );
  }
  return out;
}

const KIND_CLASS: Record<string, string> = { A: "a", M: "m", T: "m", R: "m", C: "m", D: "d" };
/** Ref badges shown per commit row; the rest collapse into "+N" with a tooltip. */
const MAX_BADGES = 3;

/** Commits view: linear history of the current branch with filter, details of the selected commit and its file diff. */
export class CommitsView {
  private readonly text = h("input", { class: "field", placeholder: "Search in messages" });
  private readonly author = h("input", { class: "field author", placeholder: "Author" });
  private readonly mine = h("input", { type: "checkbox" });
  /** "Commits of <branch>" with the task code, back-to-HEAD button and the task filter */
  private readonly elLogBar = h("div", { class: "logbar" });
  private readonly elList = h("ul", { class: "commits" });
  private readonly elListWrap = h("div", { class: "scroll" }, this.elList);
  // The details column is made of parts that are rebuilt separately, so a click rebuilds only what it changes.
  private readonly elMeta = h("div", { class: "commit-meta" });
  private readonly elFiles = h("ul", { class: "files" });
  private readonly elDiffHead = h("div", { class: "colhead" });
  private readonly elDiff = h("div", { class: "diffwrap" });
  private readonly elEmpty = h("div", { class: "empty" });
  private readonly elFilesWrap = h("div", { class: "fileswrap" }, this.elFiles);
  private readonly elFilesSplit = h("div", { class: "splitter h", title: "Drag to resize the file list, double-click to reset" });
  private readonly elDetails = h("div", { class: "col details-col" }, this.elEmpty, this.elMeta, this.elFilesWrap, this.elFilesSplit, this.elDiffHead, this.elDiff);
  private readonly elRoot: HTMLElement;
  private readonly applySplit: (saved: number | undefined) => void;
  private readonly applyFilesSplit: (saved: number | undefined) => void;
  private filterTimer: number | null = null;
  /** commit rows by sha, to move the selection highlight without rebuilding the list */
  private readonly rows = new Map<string, HTMLElement>();
  private readonly fileRows = new Map<string, HTMLElement>();

  constructor(private readonly app: App) {
    const schedule = () => {
      if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
      this.filterTimer = window.setTimeout(() => {
        this.filterTimer = null;
        app.setCommitFilter({ text: this.text.value, author: this.author.value, mine: this.mine.checked });
      }, 300);
    };
    this.text.addEventListener("input", schedule);
    this.author.addEventListener("input", schedule);
    this.mine.addEventListener("change", schedule);
    this.elListWrap.addEventListener("scroll", () => {
      const el = this.elListWrap;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) void app.loadMoreCommits();
    });
    const filterBar = h("div", { class: "filterbar" }, this.text, this.author, h("label", { class: "check" }, this.mine, "Only mine"));
    const left = h("div", { class: "col" }, this.elLogBar, filterBar, this.elListWrap);
    const split = h("div", { class: "splitter", title: "Drag to resize, double-click to reset" });
    this.elRoot = h("div", { class: "main-grid commits-grid" }, left, split, this.elDetails);
    this.applySplit = setupSplitter(split, left, this.elRoot, { name: "--left-w", min: 20, max: 85, percent: true, onChange: (commitsSplit) => app.saveLayout({ commitsSplit }) });
    this.applyFilesSplit = setupSplitter(this.elFilesSplit, this.elFilesWrap, this.elDetails, { name: "--files-h", min: 5, max: 80, percent: true, vertical: true, onChange: (commitFilesSplit) => app.saveLayout({ commitFilesSplit }) });
  }

  applyLayout(ui: UiLayout): void {
    this.applySplit(ui.commitsSplit);
    this.applyFilesSplit(ui.commitFilesSplit);
  }

  mount(): HTMLElement {
    return this.elRoot;
  }

  update(changed: Set<keyof State>, force: boolean): void {
    if (this.app.state.view !== "commits") return;
    const any = (...keys: (keyof State)[]) => force || keys.some((k) => changed.has(k));
    if (any("status", "template", "logBranch", "commitFilter", "repoId", "boot")) this.renderLogBar();
    if (any("commits", "commitsLoading", "commitsHasMore", "repoId", "boot")) this.renderList();
    else if (any("selectedSha", "selectedShas")) this.markSelected();
    if (any("details", "detailBranches", "selectedSha")) this.renderMeta();
    if (any("details")) this.renderFiles();
    else if (any("detailFile")) this.markFile();
    if (any("detailFile", "diffMode", "unityPreview")) this.renderDiffHead();
    if (any("detailDiff", "diffMode", "detailUnity", "unityPreview") || (changed.has("detailFile") && (!this.app.state.detailDiff || this.app.unityShown(this.app.state.detailFile)))) this.renderDiff();
    if (any("details", "detailFile", "detailDiff", "selectedSha")) this.markLoading();
    if (force) {
      this.text.value = this.app.state.commitFilter.text;
      this.author.value = this.app.state.commitFilter.author;
      this.mine.checked = this.app.state.commitFilter.mine;
      this.author.disabled = this.mine.checked;
    }
  }

  private renderLogBar(): void {
    const app = this.app;
    const s = app.state;
    const st = s.status;
    const viewing = s.logBranch;
    const name = viewing ?? (st ? (st.branch ?? (st.head ? `detached ${st.head.slice(0, 7)}` : "no commits yet")) : "");
    const code = app.logTaskCode();
    const link = code ? taskLink(s.template, code) : null;
    // the task code inside the branch name is a chip that opens the tracker
    const at = code ? name.indexOf(code) : -1;
    // the text around the chip truncates, the chip itself never does
    const txt = (t: string) => (t ? h("span", { class: "txt" }, t) : null);
    const nameParts: (HTMLElement | null)[] =
      at >= 0 && code
        ? [txt(name.slice(0, at)), h("a", { class: "tagchip", title: link ?? code, onclick: () => link && app.openExternal(link) }, code), txt(name.slice(at + code.length))]
        : [txt(name)];
    replaceChildren(
      this.elLogBar,
      h("span", { class: "muted" }, "Commits of"),
      viewing ? null : h("span", { class: "ref head" }, "HEAD"),
      h("span", { class: "name", title: name }, ...nameParts),
      viewing ? h("button", { class: "btn small", title: "Back to the commits of the current branch", onclick: () => app.showBranchCommits(null) }, "↩ current branch") : null,
      code
        ? h(
            "label",
            { class: "check task", title: `Only commits whose message contains ${code}` },
            h("input", { type: "checkbox", checked: s.commitFilter.task, onchange: (e: Event) => app.setCommitFilter({ task: (e.target as HTMLInputElement).checked }) }),
            `Task ${code} commits`,
          )
        : null,
    );
  }

  private renderList(): void {
    const app = this.app;
    const s = app.state;
    this.author.disabled = s.commitFilter.mine;
    const rows: HTMLElement[] = [];
    this.rows.clear();
    for (const c of s.commits) {
      const deco = parseDecorations(c.refs);
      rows.push(
        h(
          "li",
          {
            // on press, like a native list: no wait for the release, and a rebuild in between cannot eat the click
            onmousedown: (e: MouseEvent) => {
              if (e.button !== 0 || (e.target as HTMLElement).closest("a")) return;
              if (e.shiftKey) e.preventDefault();
              app.clickCommit(c.sha, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
            },
            title: c.subject,
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              if (!s.selectedShas.includes(c.sha)) void app.selectCommit(c.sha);
              const many = s.selectedShas.length > 1 && s.selectedShas.includes(c.sha);
              const picks = many ? app.selectedCommitsOldestFirst() : [c.sha];
              const items = many
                ? [
                    { label: `Cherry-pick ${picks.length} commits into ${s.status?.branch ?? "current"} (oldest first)`, onClick: () => app.cherryPick(picks) },
                    { label: "Copy SHAs", onClick: () => void navigator.clipboard?.writeText(picks.join("\n")) },
                  ]
                : [
                { label: `Cherry-pick into ${s.status?.branch ?? "current"}`, onClick: () => app.cherryPick([c.sha]) },
                { label: "New branch here…", onClick: () => app.openNewBranch(c.sha) },
                { label: "New tag here…", onClick: () => app.openTagCreate(c.sha, `${c.shortSha} ${c.subject}`) },
                { label: "Is in branch…", onClick: () => app.askIsInBranch(c.sha, c.subject) },
                { label: "Copy SHA", onClick: () => void navigator.clipboard?.writeText(c.sha) },
                { label: "Copy message", onClick: () => void navigator.clipboard?.writeText(c.body ? `${c.subject}\n\n${c.body}` : c.subject) },
              ];
              app.store.set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
            },
          },
          h("span", { class: "dot" }),
          h(
            "span",
            { class: "msg" },
            deco.head ? h("span", { class: "ref head" }, "HEAD") : null,
            ...deco.names.slice(0, MAX_BADGES).map((n) => h("span", { class: cls("ref", n.kind === "tag" && "tag"), title: n.name }, n.kind === "tag" ? `⌂ ${n.name}` : n.name)),
            deco.names.length > MAX_BADGES
              ? h("span", { class: "ref more", title: deco.names.slice(MAX_BADGES).map((n) => n.name).join(", ") }, `+${deco.names.length - MAX_BADGES}`)
              : null,
            h("span", { class: "t" }, c.subject, ...subjectWithCodes(app, c.subject).slice(1)),
          ),
          h("span", { class: "au", title: c.email }, c.author),
          h("span", { class: "sha" }, c.shortSha),
          h("span", { class: "dt num" }, shortDate(c.date)),
        ),
      );
      this.rows.set(c.sha, rows[rows.length - 1]!);
    }
    if (!s.commits.length) {
      rows.push(h("li", { class: "more" }, h("span", { class: "muted" }, s.commitsLoading ? "Loading…" : s.repoId ? "No commits" : "")));
    } else if (s.commitsHasMore || s.commitsLoading) {
      rows.push(h("li", { class: "more" }, h("span", { class: "muted" }, s.commitsLoading ? "Loading…" : "Scroll for older commits")));
    }
    // emptying the list resets the scroll position
    const top = this.elListWrap.scrollTop;
    replaceChildren(this.elList, rows);
    this.elListWrap.scrollTop = top;
    this.markSelected();
  }

  /** Moves the selection highlight without rebuilding the rows. */
  private markSelected(): void {
    const s = this.app.state;
    for (const el of this.elList.querySelectorAll("li.sel")) el.classList.remove("sel", "primary");
    for (const sha of s.selectedShas) this.rows.get(sha)?.classList.add("sel");
    if (s.selectedSha) this.rows.get(s.selectedSha)?.classList.add("primary");
  }

  private markFile(): void {
    const file = this.app.state.detailFile;
    for (const el of this.elFiles.querySelectorAll("li.sel")) el.classList.remove("sel");
    if (file !== null) this.fileRows.get(file)?.classList.add("sel");
  }

  /** While the next commit or diff is on its way the previous one stays, dimmed after a moment (see .loading in the styles). */
  private markLoading(): void {
    const app = this.app;
    const s = app.state;
    const commitLoading = !!s.selectedSha && s.details?.sha !== s.selectedSha;
    const diffLoading = commitLoading || (s.detailFile !== null && s.detailDiff !== null && app.detailDiffKey !== `${s.selectedSha}:${s.detailFile}`);
    this.elDetails.classList.toggle("loading", commitLoading);
    this.elDiff.classList.toggle("loading", diffLoading);
  }

  private renderMeta(): void {
    const app = this.app;
    const s = app.state;
    const d = s.details;
    // nothing selected, or the very first commit is still loading: a placeholder instead of the parts
    const empty = !s.selectedSha || !d;
    this.elEmpty.hidden = !empty;
    for (const el of [this.elMeta, this.elFilesWrap, this.elFilesSplit, this.elDiffHead, this.elDiff]) el.hidden = empty;
    if (!s.selectedSha || !d) {
      this.elEmpty.textContent = s.selectedSha ? "Loading…" : "Select a commit";
      return;
    }
    const copy = h(
      "button",
      { class: "btn small", onclick: () => void navigator.clipboard?.writeText(d.sha).then(() => app.toast("SHA copied", "info")) },
      "copy",
    );
    const dl = h(
      "dl",
      { class: "details" },
      h("dt", null, "Author"),
      h("dd", null, d.author, " ", h("span", { class: "mono muted" }, d.email)),
      h("dt", null, "Date"),
      h("dd", { class: "num" }, longDate(d.date)),
      h("dt", null, "SHA"),
      h("dd", { class: "mono" }, d.sha.slice(0, 16), "… ", copy),
      h("dt", null, "Parents"),
      h("dd", { class: "mono" }, d.parents.length ? d.parents.map((p) => p.slice(0, 7)).join(" · ") : "none (root commit)"),
      h("dt", null, "In branches"),
      h("dd", { title: s.detailBranches?.join(", ") ?? "" }, s.detailBranches ? (s.detailBranches.length ? s.detailBranches.join(", ") : "none") : "…"),
    );
    replaceChildren(
      this.elMeta,
      dl,
      h("div", { class: "subject", title: d.subject }, ...subjectWithCodes(app, `${d.subject}\n${d.body}`).map((x, i) => (i === 0 ? d.subject : x))),
      d.body ? h("pre", { class: "body" }, d.body) : null,
    );
  }

  private renderFiles(): void {
    const app = this.app;
    const d = app.state.details;
    const rows: HTMLElement[] = [];
    this.fileRows.clear();
    for (const f of d?.files ?? []) {
      const row = h(
        "li",
        { onmousedown: (e: MouseEvent) => e.button === 0 && void app.selectCommitFile(f.path), title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path },
        h("span", { class: cls("flag", KIND_CLASS[f.kind] ?? "m") }, f.kind),
        h("span", { class: "name" }, f.path),
      );
      this.fileRows.set(f.path, row);
      rows.push(row);
    }
    if (d && !d.files.length) rows.push(h("li", { class: "muted" }, h("span", { class: "name" }, "No file changes")));
    replaceChildren(this.elFiles, rows);
    this.markFile();
  }

  private renderDiffHead(): void {
    const app = this.app;
    const s = app.state;
    const modeBtn = (label: string, mode: "side" | "inline") =>
      h("button", { class: cls("btn small", s.diffMode === mode && "on"), onclick: () => app.setDiffMode(mode) }, label);
    const unity = !!s.detailFile && isUnityYamlPath(s.detailFile);
    replaceChildren(
      this.elDiffHead,
      h("span", { class: "file" }, s.detailFile ?? ""),
      h("span", { class: "tools" }, unity ? unityToggle(app) : null, unity && s.unityPreview ? null : [modeBtn("Side by side", "side"), modeBtn("Inline", "inline")]),
    );
  }

  private renderDiff(): void {
    const app = this.app;
    const s = app.state;
    if (app.unityShown(s.detailFile)) {
      const u = s.detailUnity?.path === s.detailFile ? s.detailUnity : null;
      replaceChildren(this.elDiff, renderUnity(app, u, !u, {}, { resolvable: false, busy: false }));
      return;
    }
    replaceChildren(this.elDiff, renderDiff(s.detailDiff, s.diffMode, s.detailFile !== null && s.detailDiff === null));
  }
}
