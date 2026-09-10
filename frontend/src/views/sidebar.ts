import type { App } from "../app.js";
import { cls, h, type Child } from "../dom.js";
import { groupByPrefix } from "../format.js";
import type { BranchSel } from "../state.js";

/** Rows shown per remote / tag list before a "use the filter" hint; keeps huge repositories responsive. */
const MAX_ROWS = 400;

/** Changes / Commits switch with the change counter. */
export function renderSeg(app: App): HTMLElement {
  const s = app.state;
  const changesCount = s.status ? s.status.unstaged.length + s.status.staged.length + s.status.conflicts.length : 0;
  return h(
    "div",
    { class: "seg" },
    h("div", { class: cls(s.view === "changes" && "on"), onclick: () => app.setView("changes") }, changesCount ? `Changes ${changesCount}` : "Changes"),
    h("div", { class: cls(s.view === "commits" && "on"), onclick: () => app.setView("commits") }, "Commits"),
  );
}

/** Branches (grouped by prefix), Remotes, Tags, Stashes, Submodules. Rebuilt only when refs, filter, selection or folds change. */
export function renderTree(app: App): HTMLElement {
  const s = app.state;
  const filter = s.sideFilter.trim().toLowerCase();
  const tree = h("ul", { class: "tree" });
  const refs = s.refs;
  const add = (...items: Child[]) => tree.append(...(items.filter(Boolean) as Node[]));
  const head = (label: string, count?: number) => h("li", { class: "head" }, h("span", null, label), count !== undefined ? h("span", { class: "ab" }, String(count)) : null);
  const matches = (name: string) => !filter || name.toLowerCase().includes(filter);
  const more = (n: number) => h("li", { class: "d2 muted" }, h("span", null, `… ${n} more, narrow down with the filter`));

  if (!refs) {
    add(head("Branches"), h("li", { class: "d1 muted" }, h("span", null, s.repoId ? "loading…" : "no repository")));
    return tree;
  }

  const current = refs.branches.find((b) => b.current)?.name ?? s.status?.branch ?? null;
  const byName = new Map(refs.branches.map((b) => [b.name, b]));
  const isSelected = (sel: BranchSel) => s.selectedBranch?.name === sel.name && s.selectedBranch.remote === sel.remote;
  /** A fold is open by default when it holds the current branch; a click inverts the default. Filtering opens everything. */
  const isOpen = (key: string, defaultOpen: boolean) => !!filter || defaultOpen !== s.collapsedDirs.has(key);
  const foldRow = (key: string, label: string, count: number, open: boolean, depth: 1 | 2 = 1) =>
    h(
      "li",
      { class: `d${depth} dir`, onclick: () => app.toggleFold(key) },
      h("span", null, `${open ? "▾" : "▸"} ${label}`),
      h("span", { class: "ab" }, String(count)),
    );

  /** Single click selects, double click switches, right click opens the branch menu. */
  const branchHandlers = (sel: BranchSel) => ({
    onclick: () => app.selectBranch(sel),
    ondblclick: () => app.requestCheckout(sel),
    oncontextmenu: (e: MouseEvent) => {
      e.preventDefault();
      app.selectBranch(sel);
      const local = sel.remote ? sel.name.slice(sel.name.indexOf("/") + 1) : sel.name;
      const cur = app.state.status?.branch;
      app.store.set({
        contextMenu: {
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: local === cur ? "Current branch" : app.isBusy() ? "Repository is busy" : `Switch to ${local}`, onClick: () => app.requestCheckout(sel) },
            { label: "Copy branch name", onClick: () => void navigator.clipboard?.writeText(sel.name) },
          ],
        },
      });
    },
  });

  const branchRow = (name: string, depth: 1 | 2) => {
    const b = byName.get(name);
    const ab: string[] = [];
    if (b?.ahead) ab.push(`↑${b.ahead}`);
    if (b?.behind) ab.push(`↓${b.behind}`);
    if (b?.gone) ab.push("gone");
    const isCur = name === current;
    const sel: BranchSel = { name, remote: false };
    return h(
      "li",
      {
        class: cls(`d${depth}`, "branch", isCur && "cur", isSelected(sel) && "sel"),
        title: `${name}${b?.upstream ? ` → ${b.upstream}` : ""}${isCur ? " (current)" : ". Double-click to switch"}`,
        ...branchHandlers(sel),
      },
      h("span", null, `${isCur ? "✓ " : ""}${depth === 2 ? name.slice(name.indexOf("/") + 1) : name}`),
      ab.length ? h("span", { class: "ab" }, ab.join(" ")) : null,
    );
  };

  // Branches
  const names = refs.branches.map((b) => b.name).filter(matches);
  const { groups, plain } = groupByPrefix(names);
  add(head("Branches", refs.branches.length));
  for (const g of groups) {
    const open = isOpen(`branch:${g.prefix}`, g.names.includes(current ?? ""));
    add(foldRow(`branch:${g.prefix}`, g.prefix, g.names.length, open));
    if (open) for (const n of g.names) add(branchRow(n, 2));
  }
  for (const n of plain) add(branchRow(n, 1));
  if (!names.length) add(h("li", { class: "d1 muted" }, h("span", null, filter ? "no match" : "no branches")));

  // Remotes
  add(head("Remotes", refs.remotes.length));
  for (const r of refs.remotes) {
    const list = refs.remoteBranches.filter((b) => b.name.startsWith(`${r}/`) && matches(b.name));
    const open = isOpen(`remote:${r}`, false);
    add(foldRow(`remote:${r}`, r, list.length, open));
    if (!open) continue;
    for (const b of list.slice(0, MAX_ROWS)) {
      const sel: BranchSel = { name: b.name, remote: true };
      add(
        h(
          "li",
          { class: cls("d2", "branch", isSelected(sel) && "sel"), title: `${b.name}. Double-click to check out as a local branch`, ...branchHandlers(sel) },
          h("span", null, b.name.slice(r.length + 1)),
        ),
      );
    }
    if (list.length > MAX_ROWS) add(more(list.length - MAX_ROWS));
  }
  if (!refs.remotes.length) add(h("li", { class: "d1 muted" }, h("span", null, "none")));

  // Tags
  const tags = refs.tags.filter((t) => matches(t.name));
  add(head("Tags", refs.tags.length));
  if (tags.length) {
    const open = isOpen("tags", false);
    add(foldRow("tags", `${tags.length} tags`, tags.length, open));
    if (open) {
      for (const t of tags.slice(0, MAX_ROWS)) add(h("li", { class: "d2", title: t.sha }, h("span", null, t.name)));
      if (tags.length > MAX_ROWS) add(more(tags.length - MAX_ROWS));
    }
  } else add(h("li", { class: "d1 muted" }, h("span", null, "none")));

  // Stashes
  add(head("Stashes", refs.stashes.length));
  for (const st of refs.stashes.filter((x) => matches(x.message))) add(h("li", { class: "d1", title: st.ref }, h("span", null, st.message)));
  if (!refs.stashes.length) add(h("li", { class: "d1 muted" }, h("span", null, "none")));

  // Submodules
  add(head("Submodules", refs.submodules.length));
  for (const sm of refs.submodules.filter(matches)) add(h("li", { class: "d1" }, h("span", null, sm)));
  if (!refs.submodules.length) add(h("li", { class: "d1 muted" }, h("span", null, "none")));

  return tree;
}
