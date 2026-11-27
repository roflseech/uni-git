import type { DiffLine, FileDiff } from "@uni-git/shared";
import { cls, h } from "../dom.js";
import { langForPath, tokenize, type Lang } from "../highlight.js";

/** Highlighting is skipped for very large diffs to keep rendering instant. */
const HIGHLIGHT_MAX_LINES = 6000;
let currentLang: Lang = "text";

/**
 * Read-only inline diff viewer. Every hunk is one CSS grid whose cells are the line numbers and texts, so the
 * columns stay aligned across lines.
 */
export interface HunkAction {
  label: string;
  disabled: boolean;
  onClick: (hunkIndex: number) => void;
}

export function renderDiff(diff: FileDiff | null, loading: boolean, hunkAction?: HunkAction): HTMLElement {
  const box = h("div", { class: "diff" });
  if (loading && !diff) {
    box.append(h("div", { class: "empty" }, "Loading diff…"));
    return box;
  }
  if (!diff) {
    box.append(h("div", { class: "empty" }, "Select a file to see its diff"));
    return box;
  }
  if (diff.binary) {
    box.append(h("div", { class: "empty" }, "Binary file"));
    return box;
  }
  if (diff.note && !diff.hunks.length) {
    box.append(h("div", { class: "empty" }, diff.note));
    return box;
  }
  if (!diff.hunks.length) {
    box.append(h("div", { class: "empty" }, "No changes to show"));
    return box;
  }
  if (diff.note) box.append(h("div", { class: "hunk" }, diff.note));

  const total = diff.hunks.reduce((n, hk) => n + hk.lines.length, 0);
  currentLang = total <= HIGHLIGHT_MAX_LINES ? langForPath(diff.path) : "text";

  for (const hunk of diff.hunks) {
    const index = diff.hunks.indexOf(hunk);
    box.append(
      h(
        "div",
        { class: "hunk" },
        h("span", { class: "hdr" }, hunk.header),
        hunkAction ? h("button", { class: "btn small", disabled: hunkAction.disabled, onclick: () => hunkAction.onClick(index) }, hunkAction.label) : null,
      ),
    );
    const grid = h("div", { class: "rows" });
    for (const l of hunk.lines) grid.append(num(l.o, bgClass(l)), num(l.n, bgClass(l)), text(l));
    box.append(grid);
  }
  if (diff.truncated) box.append(h("div", { class: "hunk" }, "… diff truncated, the file is very large"));
  return box;
}

function num(n: number | undefined, klass?: string): HTMLElement {
  return h("div", { class: cls("n", klass) }, n === undefined ? "" : String(n));
}

function text(line: DiffLine): HTMLElement {
  const klass = line.t === "add" ? "add" : line.t === "del" ? "del" : "ctx";
  const el = h("div", { class: klass }, ...(currentLang === "text" ? [line.text] : tokenize(line.text, currentLang).map((tk) => (tk.t === "p" ? tk.text : h("span", { class: `tok-${tk.t}` }, tk.text)))));
  if (line.noNewline) el.append(h("span", { class: "nonl", title: "No newline at end of file" }, " ⏎"));
  return el;
}

function bgClass(line: DiffLine): string | undefined {
  return line.t === "add" ? "add" : line.t === "del" ? "del" : undefined;
}
