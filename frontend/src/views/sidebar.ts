import type { App } from "../app.js";
import { cls, h, onRowDoubleClick, type Child } from "../dom.js";
import { groupByPrefix } from "../format.js";
import type { BranchSel } from "../state.js";

function branchKey(sel: BranchSel): string {
  return `${sel.remote ? "remote" : "local"}:${sel.name}`;
}

/** Moves the selection highlight; the tree can hold thousands of rows and is not rebuilt for that. */
export function markSelectedBranch(tree: HTMLElement, sel: BranchSel | null): void {
  for (const el of tree.querySelectorAll("li.sel")) el.classList.remove("sel");
  if (!sel) return;
  const key = branchKey(sel);
  for (const el of tree.querySelectorAll<HTMLElement>("li[data-branch]")) {
    if (el.dataset.branch === key) {
      el.classList.add("sel");
      return;
    }
  }
}

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

  /** Press selects and lists the branch in Commits, double click switches (see watchDoubleClicks: the tree may be rebuilt between the clicks), right click opens the branch menu. */
  const branchRowOf = (sel: BranchSel, row: HTMLElement) => onRowDoubleClick(row, branchKey(sel), () => app.requestCheckout(sel));
  const branchHandlers = (sel: BranchSel) => ({
    "data-branch": branchKey(sel),
    onmousedown: (e: MouseEvent) => e.button === 0 && app.selectBranch(sel, true),
    oncontextmenu: (e: MouseEvent) => {
      e.preventDefault();
      app.selectBranch(sel);
      const local = sel.remote ? sel.name.slice(sel.name.indexOf("/") + 1) : sel.name;
      const cur = app.state.status?.branch;
      const isCur = !sel.remote && local === cur;
      const items: { label: string; danger?: boolean; onClick: () => void }[] = [];
      if (!isCur) items.push({ label: sel.remote ? `Check out ${local}` : `Switch to ${local}`, onClick: () => app.requestCheckout(sel) });
      if (!isCur && cur) items.push({ label: `Merge ${sel.name} into ${cur}`, onClick: () => app.mergeBranch(sel.name) });
      items.push({ label: "New branch from here…", onClick: () => app.openNewBranch(sel.name) });
      if (!sel.remote) items.push({ label: "Rename…", onClick: () => app.openRenameBranch(sel.name) });
      const mergedLabel = "Merged into…";
      items.push({ label: mergedLabel, onClick: () => {} });
      items.push({ label: "Copy name", onClick: () => void navigator.clipboard?.writeText(sel.name) });
      if (!isCur) items.push({ label: sel.remote ? "Delete remote branch…" : "Delete branch…", danger: true, onClick: () => app.deleteBranch(sel.name, sel.remote) });
      if (app.isBusy()) for (const it of items) it.onClick = () => app.toast("Repository is busy", "error");
      app.store.set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
      // "Merged into…" is answered in place: main branch candidates + the current branch
      const refsNow = app.state.refs;
      const names = new Set(refsNow?.branches.map((b) => b.name) ?? []);
      const targets = [...["main", "master", "develop"].filter((n) => names.has(n) && n !== local), ...(cur && cur !== local && !["main", "master", "develop"].includes(cur) ? [cur] : [])].slice(0, 3);
      if (targets.length) {
        void app.mergedInto(sel.name, targets).then((merged) => {
          const m = app.state.contextMenu;
          const row = m?.items.find((it) => it.label === mergedLabel);
          if (!m || !row) return;
          row.label = "Merged into " + targets.map((t) => `${t}: ${merged[t] ? "yes" : "no"}`).join(" · ");
          app.store.set({ contextMenu: { ...m, items: [...m.items] } });
        });
      }
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
    return branchRowOf(
      sel,
      h(
        "li",
        {
          class: cls(`d${depth}`, "branch", isCur && "cur", isSelected(sel) && "sel"),
          title: `${name}${b?.upstream ? ` → ${b.upstream}` : ""}${isCur ? " (current)" : ". Double-click to switch"}`,
          ...branchHandlers(sel),
        },
        h("span", null, `${isCur ? "✓ " : ""}${depth === 2 ? name.slice(name.indexOf("/") + 1) : name}`),
        ab.length ? h("span", { class: "ab" }, ab.join(" ")) : null,
      ),
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
  const remotesHead = head("Remotes", refs.remotes.length);
  remotesHead.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    app.store.set({ contextMenu: { x: e.clientX, y: e.clientY, items: [{ label: "Add remote…", onClick: () => app.openRemoteAdd() }] } });
  });
  remotesHead.title = "Right-click to add a remote";
  add(remotesHead);
  for (const r of refs.remotes) {
    const list = refs.remoteBranches.filter((b) => b.name.startsWith(`${r}/`) && matches(b.name));
    const open = isOpen(`remote:${r}`, false);
    const row = foldRow(`remote:${r}`, r, list.length, open);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      app.store.set({
        contextMenu: {
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: "Fetch", onClick: () => app.fetch() },
            { label: "Copy URL", onClick: () => void app.copyRemoteUrl(r) },
            { label: "Add remote…", onClick: () => app.openRemoteAdd() },
            { label: `Remove remote ${r}…`, danger: true, onClick: () => app.remoteRemove(r) },
          ],
        },
      });
    });
    add(row);
    if (!open) continue;
    for (const b of list.slice(0, MAX_ROWS)) {
      const sel: BranchSel = { name: b.name, remote: true };
      add(
        branchRowOf(
          sel,
          h(
            "li",
            { class: cls("d2", "branch", isSelected(sel) && "sel"), title: `${b.name}. Double-click to check out as a local branch`, ...branchHandlers(sel) },
            h("span", null, b.name.slice(r.length + 1)),
          ),
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
      for (const t of tags.slice(0, MAX_ROWS)) {
        add(
          h(
            "li",
            {
              class: "d2 branch",
              title: `${t.name} → ${t.sha}`,
              oncontextmenu: (e: MouseEvent) => {
                e.preventDefault();
                const items = [
                  { label: "New branch from here…", onClick: () => app.openNewBranch(t.name) },
                  { label: "Push tag to origin", onClick: () => app.tagPush(t.name) },
                  { label: "Copy name", onClick: () => void navigator.clipboard?.writeText(t.name) },
                  { label: "Delete tag…", danger: true, onClick: () => app.tagDelete(t.name, false) },
                  { label: "Delete on remote…", danger: true, onClick: () => app.tagDelete(t.name, true) },
                ];
                if (app.isBusy()) for (const it of items) it.onClick = () => app.toast("Repository is busy", "error");
                app.store.set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
              },
            },
            h("span", null, t.name),
          ),
        );
      }
      if (tags.length > MAX_ROWS) add(more(tags.length - MAX_ROWS));
    }
  } else add(h("li", { class: "d1 muted" }, h("span", null, "none")));

  // Stashes
  add(head("Stashes", refs.stashes.length));
  for (const st of refs.stashes.filter((x) => matches(x.message))) {
    add(
      onRowDoubleClick(h(
        "li",
        {
          class: "d1 branch",
          title: `${st.ref}. Double-click to show its changes`,
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            const busyItems = app.isBusy();
            const items = [
              { label: "Apply", onClick: () => app.stashApply(st.ref, false) },
              { label: "Pop (apply and drop)", onClick: () => app.stashApply(st.ref, true) },
              { label: "Show changes", onClick: () => void app.stashShow(st.ref) },
              { label: "Drop…", danger: true, onClick: () => app.stashDrop(st.ref, st.message) },
            ];
            if (busyItems) for (const it of items) it.onClick = () => app.toast("Repository is busy", "error");
            app.store.set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
          },
        },
        h("span", null, st.message),
      ), `stash:${st.ref}`, () => void app.stashShow(st.ref)),
    );
  }
  if (!refs.stashes.length) add(h("li", { class: "d1 muted" }, h("span", null, "none")));

  // Submodules
  const subHead = head("Submodules", refs.submodules.length);
  const subMenu = (e: MouseEvent) => {
    e.preventDefault();
    app.store.set({ contextMenu: { x: e.clientX, y: e.clientY, items: [{ label: "Init & update all (recursive)", onClick: () => app.submoduleUpdate() }] } });
  };
  if (refs.submodules.length) subHead.addEventListener("contextmenu", subMenu);
  add(subHead);
  for (const sm of refs.submodules.filter(matches)) add(h("li", { class: "d1 branch", title: "Right-click: init & update", oncontextmenu: subMenu }, h("span", null, sm)));
  if (!refs.submodules.length) add(h("li", { class: "d1 muted" }, h("span", null, "none")));

  return tree;
}
