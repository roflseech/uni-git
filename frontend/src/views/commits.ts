import type { App } from "../app.js";
import { cls, h, replaceChildren } from "../dom.js";
import { longDate, parseDecorations, shortDate } from "../format.js";
import type { State } from "../state.js";
import { renderDiff } from "./diff.js";

const KIND_CLASS: Record<string, string> = { A: "a", M: "m", T: "m", R: "m", C: "m", D: "d" };
/** Ref badges shown per commit row; the rest collapse into "+N" with a tooltip. */
const MAX_BADGES = 3;

/** Commits view: linear history of the current branch with filter, details of the selected commit and its file diff. */
export class CommitsView {
  private readonly text = h("input", { class: "field", placeholder: "Search in messages" });
  private readonly author = h("input", { class: "field author", placeholder: "Author" });
  private readonly mine = h("input", { type: "checkbox" });
  private readonly elList = h("ul", { class: "commits" });
  private readonly elListWrap = h("div", { class: "scroll" }, this.elList);
  private readonly elDetails = h("div", { class: "col details-col" });
  private readonly elRoot: HTMLElement;
  private filterTimer: number | null = null;

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
    this.elRoot = h("div", { class: "main-grid commits-grid" }, h("div", { class: "col" }, filterBar, this.elListWrap), this.elDetails);
  }

  mount(): HTMLElement {
    return this.elRoot;
  }

  update(changed: Set<keyof State>, force: boolean): void {
    if (this.app.state.view !== "commits") return;
    const any = (...keys: (keyof State)[]) => force || keys.some((k) => changed.has(k));
    if (any("commits", "selectedSha", "commitsLoading", "commitsHasMore", "repoId", "boot")) this.renderList();
    if (any("details", "detailBranches", "detailFile", "detailDiff", "selectedSha", "diffMode")) this.renderDetails();
    if (force) {
      this.text.value = this.app.state.commitFilter.text;
      this.author.value = this.app.state.commitFilter.author;
      this.mine.checked = this.app.state.commitFilter.mine;
      this.author.disabled = this.mine.checked;
    }
  }

  private renderList(): void {
    const app = this.app;
    const s = app.state;
    this.author.disabled = s.commitFilter.mine;
    const rows: HTMLElement[] = [];
    for (const c of s.commits) {
      const deco = parseDecorations(c.refs);
      rows.push(
        h(
          "li",
          { class: cls(c.sha === s.selectedSha && "sel"), onclick: () => void app.selectCommit(c.sha), title: c.subject },
          h("span", { class: "dot" }),
          h(
            "span",
            { class: "msg" },
            deco.head ? h("span", { class: "ref head" }, "HEAD") : null,
            ...deco.names.slice(0, MAX_BADGES).map((n) => h("span", { class: cls("ref", n.kind === "tag" && "tag"), title: n.name }, n.kind === "tag" ? `⌂ ${n.name}` : n.name)),
            deco.names.length > MAX_BADGES
              ? h("span", { class: "ref more", title: deco.names.slice(MAX_BADGES).map((n) => n.name).join(", ") }, `+${deco.names.length - MAX_BADGES}`)
              : null,
            h("span", { class: "t" }, c.subject),
          ),
          h("span", { class: "au", title: c.email }, c.author),
          h("span", { class: "sha" }, c.shortSha),
          h("span", { class: "dt num" }, shortDate(c.date)),
        ),
      );
    }
    if (!s.commits.length) {
      rows.push(h("li", { class: "more" }, h("span", { class: "muted" }, s.commitsLoading ? "Loading…" : s.repoId ? "No commits" : "")));
    } else if (s.commitsHasMore || s.commitsLoading) {
      rows.push(h("li", { class: "more" }, h("span", { class: "muted" }, s.commitsLoading ? "Loading…" : "Scroll for older commits")));
    }
    replaceChildren(this.elList, rows);
  }

  private renderDetails(): void {
    const app = this.app;
    const s = app.state;
    const d = s.details;
    if (!s.selectedSha) {
      replaceChildren(this.elDetails, h("div", { class: "empty" }, "Select a commit"));
      return;
    }
    if (!d) {
      replaceChildren(this.elDetails, h("div", { class: "empty" }, "Loading…"));
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
    const files = h("ul", { class: "files" });
    for (const f of d.files) {
      files.append(
        h(
          "li",
          { class: cls(f.path === s.detailFile && "sel"), onclick: () => void app.selectCommitFile(f.path), title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path },
          h("span", { class: cls("flag", KIND_CLASS[f.kind] ?? "m") }, f.kind),
          h("span", { class: "name" }, f.path),
        ),
      );
    }
    if (!d.files.length) files.append(h("li", { class: "muted" }, h("span", { class: "name" }, "No file changes")));
    const modeBtn = (label: string, mode: "side" | "inline") =>
      h("button", { class: cls("btn small", s.diffMode === mode && "on"), onclick: () => app.setDiffMode(mode) }, label);
    replaceChildren(
      this.elDetails,
      dl,
      h("div", { class: "subject", title: d.subject }, d.subject),
      d.body ? h("pre", { class: "body" }, d.body) : null,
      h("div", { class: "fileswrap" }, files),
      h("div", { class: "colhead" }, h("span", { class: "file" }, s.detailFile ?? ""), h("span", { class: "tools" }, modeBtn("Side by side", "side"), modeBtn("Inline", "inline"))),
      h("div", { class: "diffwrap" }, renderDiff(s.detailDiff, s.diffMode, s.detailFile !== null && s.detailDiff === null)),
    );
  }
}
