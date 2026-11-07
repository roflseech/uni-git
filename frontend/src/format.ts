import type { FileChange, FileDiff } from "@epic-git/shared";

/** A unified diff containing only one hunk of the shown diff, for `git apply --cached [--reverse]`. */
export function hunkPatch(diff: FileDiff, hunkIndex: number): string {
  const h = diff.hunks[hunkIndex];
  if (!h) return "";
  const body = h.lines.map((l) => {
    const prefix = l.t === "add" ? "+" : l.t === "del" ? "-" : " ";
    return prefix + l.text + (l.noNewline ? "\n\\ No newline at end of file" : "");
  });
  return [`--- a/${diff.oldPath ?? diff.path}`, `+++ b/${diff.path}`, h.header, ...body].join("\n") + "\n";
}

/** Theme is applied to <html data-theme>; "system" removes the attribute so the media query decides. */
export function applyTheme(theme: string | undefined): void {
  const t = theme === "dark" || theme === "light" ? theme : "";
  if (t) document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.setItem("epic-git.theme", t);
  } catch {
    /* optional */
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "9 Sep 16:06" this year, "9 Sep 2025" otherwise. */
export function shortDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (d.getFullYear() === now.getFullYear()) return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${day} ${d.getFullYear()}`;
}

export function longDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const tz = `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tz}`;
}

export function elapsed(sinceMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - sinceMs) / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

// ───────── file tree: directories collapsed to one line, files under them with the remaining path ─────────

export interface FileGroup {
  /** "" for files at the repository root */
  dir: string;
  files: { change: FileChange; rel: string }[];
}

interface Node {
  name: string;
  dirs: Map<string, Node>;
  files: FileChange[];
}

export function groupFiles(changes: FileChange[]): FileGroup[] {
  const root: Node = { name: "", dirs: new Map(), files: [] };
  for (const c of changes) {
    const parts = c.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(c);
  }

  const groups: FileGroup[] = [];
  if (root.files.length) groups.push({ dir: "", files: root.files.map((change) => ({ change, rel: change.path })) });

  // Each top-level directory becomes one group; chains of single-child directories are collapsed into its name.
  for (const [name, node] of sortedDirs(root)) {
    let dir = name;
    let cur = node;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const [childName, child] = [...cur.dirs][0]!;
      dir = `${dir}/${childName}`;
      cur = child;
    }
    const files: { change: FileChange; rel: string }[] = [];
    collect(cur, "", files);
    groups.push({ dir, files });
  }
  return groups;
}

function collect(node: Node, prefix: string, out: { change: FileChange; rel: string }[]): void {
  for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) out.push({ change: f, rel: prefix + baseName(f.path) });
  for (const [name, child] of sortedDirs(node)) collect(child, `${prefix}${name}/`, out);
}

function sortedDirs(node: Node): [string, Node][] {
  return [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]));
}

// ───────── branch grouping by prefix (feature/, fix/) ─────────

export interface BranchGroup {
  prefix: string;
  names: string[];
}

export function groupByPrefix(names: string[]): { groups: BranchGroup[]; plain: string[] } {
  const map = new Map<string, string[]>();
  const plain: string[] = [];
  for (const n of names) {
    const i = n.indexOf("/");
    if (i > 0) {
      const p = n.slice(0, i);
      map.set(p, [...(map.get(p) ?? []), n]);
    } else plain.push(n);
  }
  const groups: BranchGroup[] = [];
  for (const [prefix, list] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length === 1) plain.push(list[0]!);
    else groups.push({ prefix, names: list.sort() });
  }
  return { groups, plain: plain.sort() };
}

/** Splits `git log --decorate` refs into badges. */
export function parseDecorations(refs: string[]): { head: boolean; names: { name: string; kind: "local" | "remote" | "tag" }[] } {
  let head = false;
  const names: { name: string; kind: "local" | "remote" | "tag" }[] = [];
  for (const raw of refs) {
    let r = raw;
    if (r.startsWith("HEAD -> ")) {
      head = true;
      r = r.slice(8);
    } else if (r === "HEAD") {
      head = true;
      continue;
    }
    if (r.startsWith("tag: ")) names.push({ name: r.slice(5), kind: "tag" });
    else if (r.includes("/")) names.push({ name: r, kind: "remote" });
    else names.push({ name: r, kind: "local" });
  }
  return { head, names };
}

export function repoNameFromUrl(url: string): string {
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1] ?? "";
}
