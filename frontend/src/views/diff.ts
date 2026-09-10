import type { DiffHunk, DiffLine, FileDiff } from "@epic-git/shared";
import { cls, h } from "../dom.js";
import type { DiffMode } from "../state.js";

/**
 * Read-only diff viewer. Every hunk is one CSS grid whose cells are the line numbers and texts, so the
 * columns stay aligned across lines. Side-by-side pairs deletions with additions; inline lists them in order.
 */
export function renderDiff(diff: FileDiff | null, mode: DiffMode, loading: boolean): HTMLElement {
  const box = h("div", { class: cls("diff", mode === "inline" && "inline") });
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

  for (const hunk of diff.hunks) {
    box.append(h("div", { class: "hunk" }, hunk.header));
    const grid = h("div", { class: "rows" });
    if (mode === "inline") renderInline(hunk, grid);
    else renderSide(hunk, grid);
    box.append(grid);
  }
  if (diff.truncated) box.append(h("div", { class: "hunk" }, "… diff truncated, the file is very large"));
  return box;
}

function num(n: number | undefined, klass?: string): HTMLElement {
  return h("div", { class: cls("n", klass) }, n === undefined ? "" : String(n));
}

function text(line: DiffLine | undefined): HTMLElement {
  if (!line) return h("div", { class: "pad" });
  const klass = line.t === "add" ? "add" : line.t === "del" ? "del" : "ctx";
  const el = h("div", { class: klass }, line.text);
  if (line.noNewline) el.append(h("span", { class: "nonl", title: "No newline at end of file" }, " ⏎"));
  return el;
}

function bgClass(line: DiffLine | undefined): string | undefined {
  if (!line) return "pad";
  return line.t === "add" ? "add" : line.t === "del" ? "del" : undefined;
}

function renderInline(hunk: DiffHunk, grid: HTMLElement): void {
  for (const l of hunk.lines) {
    grid.append(num(l.o, bgClass(l)), num(l.n, bgClass(l)), text(l));
  }
}

function renderSide(hunk: DiffHunk, grid: HTMLElement): void {
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.t === "ctx") {
      grid.append(num(l.o), text(l), num(l.n), text(l));
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.t === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.t === "add") adds.push(lines[i++]!);
    const rows = Math.max(dels.length, adds.length);
    for (let r = 0; r < rows; r++) {
      const d = dels[r];
      const a = adds[r];
      grid.append(num(d?.o, bgClass(d)), text(d), num(a?.n, bgClass(a)), text(a));
    }
  }
}
