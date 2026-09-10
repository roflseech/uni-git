import type { Group, RepoEntry } from "@epic-git/shared";
import type { App } from "../app.js";
import { cls, h } from "../dom.js";
import { repoNameFromUrl } from "../format.js";

/** Everything floating: Repositories / Open in Code menus, context menu, dialogs, job log panel, toasts. */
export function renderOverlay(app: App): (HTMLElement | null)[] {
  const s = app.state;
  return [
    s.openMenu === "repos" ? reposMenu(app) : null,
    s.openMenu === "code" ? codeMenu(app) : null,
    s.contextMenu ? contextMenu(app) : null,
    s.logJobId ? logPanel(app) : null,
    s.dialog ? dialog(app) : null,
    toasts(app),
  ];
}

function reposMenu(app: App): HTMLElement {
  const s = app.state;
  const cfg = app.configOrEmpty();
  const menu = h("div", { class: "menu", style: "left:10px;top:48px" });

  const item = (label: string, meta: string | HTMLElement | null, opts: { on?: boolean; led?: "ok" | "busy" | "off"; onclick?: () => void; muted?: boolean; oncontextmenu?: (e: MouseEvent) => void }) =>
    h(
      "div",
      { class: cls("item", opts.on && "on", opts.muted && "muted"), onclick: opts.onclick, oncontextmenu: opts.oncontextmenu },
      opts.led ? h("span", { class: cls("led", opts.led !== "ok" && opts.led) }) : null,
      h("span", { class: "lbl" }, label),
      meta ? h("span", { class: "meta" }, meta) : null,
    );

  for (const g of cfg.groups) {
    menu.append(
      h(
        "div",
        { class: "group", oncontextmenu: (e: MouseEvent) => groupContext(app, g, e) },
        h("span", null, g.name),
        h("span", { class: "meta" }, g.kind === "folder" ? `${g.root} · folder group` : "manual group"),
      ),
    );
    const repos = cfg.repos.filter((r) => r.groupId === g.id);
    for (const r of repos) {
      const busy = app.isBusy(r.id);
      const job = busy ? app.jobsFor(r.id)[0] : undefined;
      const meta = job ? `${job.title} running` : r.id === s.repoId && s.status ? (s.status.branch ?? "detached") : r.external ? "external" : "";
      menu.append(
        item(r.name, meta, {
          on: r.id === s.repoId,
          led: busy ? "busy" : r.external ? "off" : "ok",
          onclick: () => {
            app.store.set({ openMenu: null });
            void app.selectRepo(r.id);
          },
          oncontextmenu: (e) => repoContext(app, r, e),
        }),
      );
    }
    if (!repos.length) menu.append(item("no repositories yet", null, { muted: true }));
    // every group gets its own "Add repo" row; folder groups also get rescan / open in editor
    menu.append(
      h(
        "div",
        { class: "item muted" },
        h("span", { class: "lbl" }, "Add repo"),
        h(
          "span",
          { class: "meta" },
          h("a", { onclick: () => void app.openFolderDialog(g.id) }, "Open folder"),
          " · ",
          h("a", { onclick: () => app.openDialog({ kind: "clone", url: "", groupId: g.id, dest: g.kind === "folder" ? g.root : "", destTouched: false, recurse: false }) }, "Clone"),
        ),
      ),
    );
    if (g.kind === "folder") {
      menu.append(
        h(
          "div",
          { class: "item muted" },
          h("a", { class: "lbl", onclick: () => void app.rescanGroup(g.id) }, "Rescan folder"),
          h("span", { class: "meta" }, h("a", { onclick: () => app.openInEditor(g.root) }, "Open group in Code")),
        ),
      );
    }
    menu.append(h("div", { class: "sep" }));
  }
  if (!cfg.groups.length) menu.append(h("div", { class: "desc" }, "No groups yet. Add a folder group to find all repositories inside a folder, or an empty group and add repositories one by one."), h("div", { class: "sep" }));

  menu.append(
    h(
      "div",
      { class: "item" },
      h("span", { class: "lbl" }, "Add group"),
      h("span", { class: "meta" }, h("a", { onclick: () => void app.startAddFolderGroup() }, "From folder"), " · ", h("a", { onclick: () => app.openDialog({ kind: "add-manual-group", name: "" }) }, "Empty")),
    ),
  );
  return menu;
}

function repoContext(app: App, r: RepoEntry, e: MouseEvent): void {
  e.preventDefault();
  app.store.set({
    contextMenu: {
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open in Code", onClick: () => app.openInEditor(r.path) },
        { label: "Remove from list", danger: true, onClick: () => app.removeRepo(r) },
      ],
    },
  });
}

function groupContext(app: App, g: Group, e: MouseEvent): void {
  e.preventDefault();
  app.store.set({
    contextMenu: {
      x: e.clientX,
      y: e.clientY,
      items: [{ label: "Remove group", danger: true, onClick: () => app.removeGroup(g.id) }],
    },
  });
}

function codeMenu(app: App): HTMLElement {
  const repo = app.repo;
  const g = repo ? app.configOrEmpty().groups.find((x) => x.id === repo.groupId) : undefined;
  const btn = document.querySelector<HTMLElement>('[data-menu-button="code"]');
  const left = btn ? Math.max(10, Math.round(btn.getBoundingClientRect().left)) : 10;
  return h(
    "div",
    { class: "menu narrow", style: `left:${left}px;top:48px` },
    repo ? h("div", { class: "item", onclick: () => app.openInEditor(repo.path) }, h("span", { class: "lbl" }, `Open ${repo.name} in Code`)) : null,
    g && g.kind === "folder"
      ? h("div", { class: "item", onclick: () => app.openInEditor(g.root) }, h("span", { class: "lbl" }, `Open group ${g.name} in Code`), h("span", { class: "meta" }, g.root))
      : h("div", { class: "item muted" }, h("span", { class: "lbl" }, "Open group in Code"), h("span", { class: "meta" }, "manual group has no folder")),
  );
}

function contextMenu(app: App): HTMLElement {
  const m = app.state.contextMenu!;
  const x = Math.min(m.x, window.innerWidth - 240);
  const y = Math.min(m.y, window.innerHeight - 40 * m.items.length - 20);
  return h(
    "div",
    { class: "ctxmenu", style: `left:${x}px;top:${y}px` },
    ...m.items.map((it) =>
      h(
        "div",
        {
          class: cls(it.danger && "danger"),
          onclick: () => {
            app.store.set({ contextMenu: null });
            it.onClick();
          },
        },
        it.label,
      ),
    ),
  );
}

function logPanel(app: App): HTMLElement {
  const s = app.state;
  const id = s.logJobId!;
  const job = s.jobs.find((j) => j.id === id);
  const text = s.jobLogs[id] ?? "";
  const pre = h("pre", { class: "log" }, text || "(no output yet)");
  queueMicrotask(() => (pre.scrollTop = pre.scrollHeight));
  return h(
    "div",
    { class: "logpanel" },
    h(
      "div",
      { class: "hd" },
      h("span", null, job ? `${job.repoName}: ${job.title}` : "Job log", job ? h("span", { class: cls("state", job.state) }, ` ${job.state}`) : null),
      h("span", { style: "flex:1" }),
      job && (job.state === "running" || job.state === "queued") ? h("button", { class: "btn small", onclick: () => app.cancelJob(id) }, "Cancel") : null,
      h("button", { class: "btn small", onclick: () => void app.showJobLog(null) }, "Close"),
    ),
    pre,
  );
}

function dialog(app: App): HTMLElement {
  const d = app.state.dialog!;
  const cfg = app.configOrEmpty();
  const err = "error" in d && d.error ? h("div", { class: "err" }, d.error) : null;
  let box: HTMLElement;

  if (d.kind === "add-folder-group") {
    box = h(
      "div",
      { class: "dlg" },
      h("div", { class: "hd" }, "Add group from folder"),
      h(
        "div",
        { class: "bd" },
        h(
          "div",
          { class: "form" },
          h("label", null, "Folder"),
          h("div", { class: "val mono" }, d.root, h("span", { class: "src" }, h("button", { class: "btn small", onclick: () => void app.startAddFolderGroup() }, "Browse"))),
          h("label", null, "Name"),
          h("input", { class: "field", value: d.name, oninput: (e: Event) => app.updateDialog({ name: (e.target as HTMLInputElement).value }) }),
          h("label", null, "Found, depth 1"),
          h(
            "div",
            { class: "plain" },
            d.scanning ? h("span", { class: "muted" }, "Scanning…") : null,
            !d.scanning && !d.found.length ? h("span", { class: "muted" }, "No git repositories directly inside this folder") : null,
            ...d.found.map((r) =>
              h(
                "label",
                { class: cls("check", r.knownIn && "muted") },
                h("input", {
                  type: "checkbox",
                  checked: !d.hidden.has(r.path) && !r.knownIn,
                  disabled: !!r.knownIn,
                  onchange: (e: Event) => {
                    const hidden = new Set(d.hidden);
                    if ((e.target as HTMLInputElement).checked) hidden.delete(r.path);
                    else hidden.add(r.path);
                    app.updateDialog({ hidden });
                  },
                }),
                r.name,
                r.knownIn ? h("span", { class: "muted" }, ` already in ${r.knownIn}`) : null,
              ),
            ),
          ),
          h("div", { class: "hint" }, "Only direct subfolders are scanned: Root/Repo1 is found, Root/Repo1/Repo2 is not. Unchecked repositories stay hidden until you rescan and re-add them."),
        ),
        err,
      ),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"),
        h("button", { class: "btn primary", disabled: d.scanning, onclick: () => void app.confirmAddFolderGroup() }, "Add group"),
      ),
    );
  } else if (d.kind === "add-manual-group") {
    const input = h("input", {
      class: "field",
      value: d.name,
      placeholder: "Personal",
      oninput: (e: Event) => app.updateDialog({ name: (e.target as HTMLInputElement).value }),
      onkeydown: (e: KeyboardEvent) => e.key === "Enter" && void app.confirmAddManualGroup(),
    });
    queueMicrotask(() => input.focus());
    box = h(
      "div",
      { class: "dlg w440" },
      h("div", { class: "hd" }, "Add empty group"),
      h("div", { class: "bd" }, h("div", { class: "form" }, h("label", null, "Name"), input, h("div", { class: "hint" }, "Repositories are added one by one from any location: Add repo → Open folder or Clone.")), err),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"),
        h("button", { class: "btn primary", disabled: !d.name.trim(), onclick: () => void app.confirmAddManualGroup() }, "Add group"),
      ),
    );
  } else if (d.kind === "clone") {
    const group = cfg.groups.find((g) => g.id === d.groupId);
    const sep = d.dest.includes("\\") || (typeof NL_OS === "string" && NL_OS === "Windows") ? "\\" : "/";
    const onUrl = (e: Event) => {
      const url = (e.target as HTMLInputElement).value;
      const patch: Partial<typeof d> = { url };
      if (!d.destTouched && group?.kind === "folder") {
        const name = repoNameFromUrl(url);
        patch.dest = name ? `${group.root}${sep}${name}` : group.root;
      }
      app.updateDialog(patch);
    };
    const urlInput = h("input", { class: "field mono", value: d.url, placeholder: "git@github.com:org/repo.git or https://…", oninput: onUrl });
    queueMicrotask(() => urlInput.focus());
    box = h(
      "div",
      { class: "dlg" },
      h("div", { class: "hd" }, "Clone repository"),
      h(
        "div",
        { class: "bd" },
        h(
          "div",
          { class: "form" },
          h("label", null, "URL"),
          urlInput,
          h("label", null, "Into group"),
          h(
            "select",
            { class: "field", onchange: (e: Event) => app.updateDialog({ groupId: (e.target as HTMLSelectElement).value }) },
            ...cfg.groups.map((g) => h("option", { value: g.id, selected: g.id === d.groupId }, g.name)),
          ),
          h("label", null, "Destination"),
          h(
            "div",
            { class: "row" },
            h("input", { class: "field mono", value: d.dest, placeholder: "absolute path of the new folder", oninput: (e: Event) => app.updateDialog({ dest: (e.target as HTMLInputElement).value, destTouched: true }) }),
            h(
              "button",
              {
                class: "btn small",
                onclick: () =>
                  void app.pickFolder("Clone into folder").then((p) => {
                    if (p) app.updateDialog({ dest: `${p}${sep}${repoNameFromUrl(app.state.dialog?.kind === "clone" ? app.state.dialog.url : "") || "repo"}`, destTouched: true });
                  }),
              },
              "Browse",
            ),
          ),
          h("div", { class: "hint" }, group?.kind === "folder" ? "Defaults to the group folder root." : "Manual group: choose any folder."),
          h("label", null, ""),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: d.recurse, onchange: (e: Event) => app.updateDialog({ recurse: (e.target as HTMLInputElement).checked }) }), "Recurse submodules"),
        ),
        err,
      ),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"),
        h("button", { class: "btn primary", disabled: !d.url.trim() || !d.dest.trim(), onclick: () => void app.confirmClone() }, "Clone"),
      ),
    );
  } else if (d.kind === "checkout") {
    const local = d.remote ? d.branch.slice(d.branch.indexOf("/") + 1) : d.branch;
    const sel = { name: d.branch, remote: d.remote };
    box = h(
      "div",
      { class: "dlg w480" },
      h("div", { class: "hd" }, `Switch to ${local}?`, d.remote ? h("span", null, `tracking ${d.branch}`) : null),
      h(
        "div",
        { class: "bd" },
        h(
          "div",
          null,
          `You have ${d.changes} uncommitted ${d.changes === 1 ? "change" : "changes"}. Git carries them over to the new branch when they do not touch files that differ between the branches; otherwise the switch stops and nothing is lost.`,
        ),
        h(
          "label",
          { class: "check" },
          h("input", { type: "checkbox", checked: d.stash, onchange: (e: Event) => app.updateDialog({ stash: (e.target as HTMLInputElement).checked }) }),
          "Stash the changes before switching and restore them after",
        ),
        err,
      ),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"),
        h("button", { class: "btn primary", onclick: () => app.checkout(sel, d.stash) }, d.stash ? "Stash & switch" : "Switch"),
      ),
    );
  } else {
    box = h(
      "div",
      { class: "dlg w440" },
      h("div", { class: "hd" }, d.title),
      h("div", { class: "bd" }, h("div", null, d.text)),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"),
        h(
          "button",
          {
            class: cls("btn", d.danger ? "danger" : "primary"),
            onclick: () => {
              app.closeDialog();
              d.onOk();
            },
          },
          d.okLabel,
        ),
      ),
    );
  }
  return h("div", { class: "scrim", onmousedown: (e: MouseEvent) => e.target === e.currentTarget && app.closeDialog() }, box);
}

function toasts(app: App): HTMLElement | null {
  const list = app.state.toasts;
  if (!list.length) return null;
  return h(
    "div",
    { class: "toasts" },
    ...list.map((t) =>
      h(
        "div",
        { class: cls("toast", t.kind) },
        h("span", { class: "txt" }, t.text),
        t.jobId ? h("a", { onclick: () => void app.showJobLog(t.jobId!) }, "log") : null,
        h("a", { onclick: () => app.dismissToast(t.id) }, "✕"),
      ),
    ),
  );
}
