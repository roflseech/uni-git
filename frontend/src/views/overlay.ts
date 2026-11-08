import type { AccountInfo, Group, RepoAuthView, RepoEntry, SshKeyInfo, TaskTemplate } from "@uni-git/shared";
import { BUILT_IN_PRESETS, buildBranchName, commitPrefix, mergePlan, planCommands, taskLink } from "@uni-git/shared";
import type { App } from "../app.js";
import { cls, h, type Child } from "../dom.js";
import { repoNameFromUrl } from "../format.js";
import { updateStatusText } from "./updatebar.js";

/** Kind of the dialog rendered last time: inputs are focused only when a dialog has just opened, not on every keystroke re-render. */
let prevDialogKind: string | null = null;
let freshDialog = false;

/** Everything floating: Repositories / Open in Code menus, context menu, dialogs, job log panel, toasts. */
export function renderOverlay(app: App): (HTMLElement | null)[] {
  const s = app.state;
  const kind = s.dialog?.kind ?? null;
  freshDialog = kind !== null && kind !== prevDialogKind;
  prevDialogKind = kind;
  return [
    s.openMenu === "repos" ? reposMenu(app) : null,
    s.openMenu === "code" ? codeMenu(app) : null,
    s.openMenu === "merge" ? mergeMenu(app) : null,
    s.openMenu === "push" ? pushMenu(app) : null,
    s.openMenu === "pull" ? pullMenu(app) : null,
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
        { class: "group repo-group", oncontextmenu: (e: MouseEvent) => groupContext(app, g, e) },
        h("span", { class: "gname" }, g.name),
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

function menuLeft(name: string): number {
  const btn = document.querySelector<HTMLElement>(`[data-menu-button="${name}"]`);
  return btn ? Math.max(10, Math.round(btn.getBoundingClientRect().left)) : 10;
}

/** Branch menu (mockup 04, extended): checks and the three merge scenarios; hovering an item previews the git commands. */
function mergeMenu(app: App): HTMLElement {
  const s = app.state;
  const main = s.status?.mainBranch ?? "main";
  const cur = s.status?.branch ?? "current";
  const remote = s.refs?.remotes.includes("origin") ? "origin" : (s.refs?.remotes[0] ?? "origin");
  const stash = s.config?.settings.mergeStash === true;
  const onMain = cur === main;
  const left = menuLeft("merge");

  const t = s.template;
  const previews: Record<string, { title: string; lines: string[] }> = {
    create: {
      title: "Create a branch",
      lines: [`git switch -c <name> ${cur}`, t ? `name by the task template (${t.branchTemplate}) or typed by hand` : "any name; a task template can be set in Repo Settings"],
    },
    "check-merged": { title: `Is ${cur} merged into ${main}?`, lines: [`git merge-base --is-ancestor ${cur} ${main}`, "exit code 0 = yes, 1 = no"] },
    "check-commit": { title: "Is a commit in a branch?", lines: ["git merge-base --is-ancestor <commit> <branch>", "exit code 0 = yes, 1 = no"] },
    main: { title: `Merge ${main} into ${cur}`, lines: planCommands(mergePlan("main", { main, current: cur, remote, stash })) },
    "force-main": { title: `Update ${main} from ${remote}, then merge into ${cur}`, lines: planCommands(mergePlan("force-main", { main, current: cur, remote, stash })) },
    "into-main": { title: `Merge ${cur} into ${main} and push`, lines: planCommands(mergePlan("into-main", { main, current: cur, remote, stash })) },
  };
  // unavailable items stay hoverable (the preview explains them) but are dimmed and say why instead of "…"
  const item = (id: string, label: Child[], onclick: () => void, disabledWhy: string | null = null) =>
    h(
      "div",
      {
        class: cls("item", disabledWhy !== null && "disabled", s.menuHover === id && "hover"),
        title: disabledWhy ?? undefined,
        onmouseenter: () => app.store.set({ menuHover: id }),
        onclick: () => disabledWhy === null && onclick(),
      },
      h("span", { class: "lbl" }, ...label),
      h("span", { class: "meta" }, disabledWhy ?? "…"),
    );
  /** a branch name inside a label, highlighted */
  const bn = (name: string) => h("span", { class: "bn" }, name);
  const onMainWhy = onMain ? `you are on ${main}` : null;
  const hovered = s.menuHover ? previews[s.menuHover] : undefined;
  // the preview sits to the right of the menu, or to the left when the window is too narrow for that
  const pvLeft = left + 424 + 440 <= window.innerWidth ? left + 424 : Math.max(10, left - 450);
  const preview = hovered
    ? h("div", { class: "cmdpreview", style: `left:${pvLeft}px;top:48px` }, h("div", { class: "ttl" }, hovered.title), h("pre", null, hovered.lines.join("\n")))
    : null;

  return h(
    "div",
    { class: "menuwrap" },
    h(
      "div",
      { class: "menu wide", style: `left:${left}px;top:48px`, onmouseleave: () => app.store.set({ menuHover: null }) },
      h("div", { class: "group" }, h("span", null, "Branch"), h("span", { class: "meta" }, "main branch ", bn(main), " · hover an item to see the commands")),
      item("create", ["Create branch…"], () => app.openNewBranch()),
      h("div", { class: "sep" }),
      // on main the check is still useful for other branches (the dialog picks them)
      item("check-merged", onMain ? ["Is a branch merged into ", bn(main), "?"] : ["Is ", bn(cur), " merged into ", bn(main), "?"], () => app.openCheckMerged()),
      item("check-commit", ["Is a commit in a branch?"], () => app.openCheckCommit()),
      h("div", { class: "sep" }),
      item("main", ["Merge ", bn(main), " into ", bn(cur)], () => app.mergeScenario("main"), onMainWhy),
      item("force-main", ["Update ", bn(main), ` from ${remote} and merge into `, bn(cur)], () => app.mergeScenario("force-main")),
      item("into-main", ["Merge ", bn(cur), " into ", bn(main), " and push"], () => app.mergeScenario("into-main"), onMainWhy),
      h("div", { class: "sep" }),
      h(
        "div",
        { class: "item" },
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: stash, onchange: (e: Event) => app.setMergeStash((e.target as HTMLInputElement).checked) }), "Stash uncommitted changes before, restore after"),
      ),
    ),
    preview,
  );
}

function pullMenu(app: App): HTMLElement {
  return h(
    "div",
    { class: "menu narrow", style: `left:${menuLeft("pull")}px;top:48px` },
    h("div", { class: "item", onclick: () => app.pull() }, h("span", { class: "lbl" }, "Pull")),
    h("div", { class: "sep" }),
    h("div", { class: "item", onclick: () => app.pull(true) }, h("span", { class: "lbl danger" }, "Discard changes and pull…")),
  );
}

function pushMenu(app: App): HTMLElement {
  return h(
    "div",
    { class: "menu narrow", style: `left:${menuLeft("push")}px;top:48px` },
    h("div", { class: "item", onclick: () => app.push() }, h("span", { class: "lbl" }, "Push")),
    h("div", { class: "item", onclick: () => app.push(false, true) }, h("span", { class: "lbl" }, "Push all tags")),
    h("div", { class: "sep" }),
    h("div", { class: "item", onclick: () => app.push(true) }, h("span", { class: "lbl danger" }, "Force push with lease…")),
  );
}

/** Repo Settings → Authentication: the account and the SSH key this repository uses, written to .git/config. */
function repoAuthTab(app: App, auth: RepoAuthView | null, username: string, sshKey: string, busy: boolean): HTMLElement {
  if (!auth) return h("div", { class: "empty" }, "Reading remotes and asking the credential helper…");
  const httpsHosts = [...new Set(auth.remotes.filter((r) => r.protocol === "https").map((r) => r.host))];
  const sshHosts = [...new Set(auth.remotes.filter((r) => r.protocol === "ssh").map((r) => r.host))];
  const known = auth.accounts.filter((a) => a.signedIn && a.username).map((a) => a.username!);
  const options = [...new Set([...known, ...(username && !known.includes(username) ? [username] : [])])];
  return h(
    "div",
    { class: "form" },
    h("label", null, "Remotes"),
    h(
      "div",
      { class: "plain" },
      ...(auth.remotes.length ? auth.remotes.map((r) => h("div", { class: "mono", title: r.url }, `${r.name} · ${r.protocol} · ${r.host}`)) : [h("span", { class: "muted" }, "no remotes")]),
    ),
    h("label", null, "Account"),
    h(
      "div",
      { class: "withsrc" },
      h(
        "select",
        { class: "field", disabled: !httpsHosts.length, onchange: (e: Event) => app.updateDialog({ authUsername: (e.target as HTMLSelectElement).value }) },
        h("option", { value: "", selected: !username }, "whatever the credential helper picks"),
        ...options.map((u) => h("option", { value: u, selected: u === username }, u)),
      ),
      h("input", { class: "field mono", style: "flex:0 0 160px", value: username, placeholder: "or type a login", oninput: (e: Event) => app.updateDialog({ authUsername: (e.target as HTMLInputElement).value }) }),
    ),
    h(
      "div",
      { class: "hint" },
      httpsHosts.length
        ? `Sets credential.username for this repository: with several accounts for ${httpsHosts.join(", ")} the helper then uses this one. Sign in on Global Settings → Accounts.`
        : "No https remote, the account is not used.",
    ),
    h("label", null, "SSH key"),
    h(
      "select",
      { class: "field mono", disabled: !sshHosts.length && !sshKey, onchange: (e: Event) => app.updateDialog({ authSshKey: (e.target as HTMLSelectElement).value }) },
      h("option", { value: "", selected: !sshKey }, "ssh default (agent, ~/.ssh/id_*)"),
      ...auth.keys.map((k) => {
        const priv = k.file.replace(/\.pub$/, "");
        return h("option", { value: priv, selected: priv.replace(/\\/g, "/") === sshKey.replace(/\\/g, "/") }, `${k.name} · ${k.comment || k.type}`);
      }),
    ),
    h("div", { class: "hint" }, sshHosts.length ? `Sets core.sshCommand = ssh -i <key> -o IdentitiesOnly=yes for ${sshHosts.join(", ")}.` : "No ssh remote, the key is not used."),
    h("label", null, ""),
    h("div", { class: "inlinebtns" }, h("button", { class: "btn small", disabled: busy, onclick: () => app.testRepoAuth() }, "Test connection"), h("span", { class: "muted" }, " runs git ls-remote for every remote (save first)")),
  );
}

/** Global Settings → Accounts (mockup 09): hosts with their sign-in state, SSH keys. */
function accountsTab(app: App, accounts: AccountInfo[] | null, sshHosts: string[], keys: SshKeyInfo[]): HTMLElement {
  if (!accounts) return h("div", { class: "empty" }, "Asking the credential helper…");
  const rows = accounts.map((a) =>
    h(
      "div",
      { class: "row" },
      h("span", { class: cls("led", !a.signedIn && "off") }),
      h("span", { class: "lbl" }, a.host),
      h(
        "span",
        { class: "meta" },
        a.signedIn ? `signed in${a.username ? ` as ${a.username}` : ""} · ` : "not signed in · ",
        a.signedIn ? h("a", { onclick: () => app.signOut(a.host, a.username) }, "sign out") : h("a", { onclick: () => app.signIn(a.host) }, "sign in with browser"),
        " · ",
        h("a", { onclick: () => app.openAddToken(a.host) }, "add token"),
      ),
    ),
  );
  const keyRows = keys.map((k) =>
    h(
      "div",
      { class: "row" },
      h("span", { class: "lbl mono" }, k.name),
      h("span", { class: "meta mono", title: k.publicKey }, `${k.type} · ${k.fingerprint || "?"}${k.comment ? ` · ${k.comment}` : ""}`),
      h("button", { class: "btn small", onclick: () => void navigator.clipboard?.writeText(k.publicKey).then(() => app.toast("Public key copied", "info")) }, "copy public"),
    ),
  );
  const testHost = h("select", { class: "field mono", style: "width:auto" }, ...sshHosts.map((hst) => h("option", { value: hst }, hst)));
  return h(
    "div",
    { class: "accounts" },
    ...rows,
    h("div", { class: "hint" }, "Sign in with browser runs Git Credential Manager for this host now, instead of in the middle of a push. Hosts come from the remotes of your repositories plus the usual ones."),
    h("div", { class: "row head" }, h("span", { class: "lbl" }, "SSH keys")),
    ...(keyRows.length ? keyRows : [h("div", { class: "row muted" }, "no keys in ~/.ssh")]),
    h(
      "div",
      { class: "row" },
      h("button", { class: "btn small", onclick: () => app.generateSshKey() }, "Generate new key"),
      h("span", { class: "meta" }, "test connection to ", testHost, " ", h("button", { class: "btn small", onclick: () => app.testSsh(testHost.value) }, "test")),
    ),
  );
}

function contextMenu(app: App): HTMLElement {
  const m = app.state.contextMenu!;
  const el = h(
    "div",
    { class: "ctxmenu", style: `left:${m.x}px;top:${m.y}px` },
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
  // once in the document: keep the whole menu inside the window (labels can be long, lists can be near the bottom)
  queueMicrotask(() => {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - 8 - r.width)}px`;
    if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - 8 - r.height)}px`;
  });
  return el;
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
    if (freshDialog && freshDialog) queueMicrotask(() => input.focus());
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
    if (freshDialog && freshDialog) queueMicrotask(() => urlInput.focus());
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
  } else if (d.kind === "askpass") {
    const r = d.request;
    const secret = r.kind === "password" || r.kind === "passphrase";
    const submit = () => app.answerAskpass(r.id, d.value);
    const input =
      r.kind === "hostkey"
        ? null
        : h("input", {
            class: "field mono",
            type: secret ? "password" : "text",
            value: d.value,
            autocomplete: "off",
            oninput: (e: Event) => app.updateDialog({ value: (e.target as HTMLInputElement).value }),
            onkeydown: (e: KeyboardEvent) => e.key === "Enter" && submit(),
          });
    if (input && freshDialog) queueMicrotask(() => input.focus());
    const label = r.kind === "username" ? "Username" : r.kind === "passphrase" ? "Passphrase" : r.kind === "password" ? "Password" : "Answer";
    box = h(
      "div",
      { class: "dlg w480" },
      h("div", { class: "hd" }, r.repoName || "git", h("span", null, `${r.jobTitle || "operation"} needs your input`)),
      h(
        "div",
        { class: "bd" },
        h("div", { class: "prompt-text" }, r.prompt),
        input ? h("div", { class: "form" }, h("label", null, label), input) : null,
        r.kind === "hostkey" ? h("div", { class: "muted" }, "Check the fingerprint against the one published by the host before trusting it.") : null,
        app.state.askpass.length > 1 ? h("div", { class: "muted" }, `${app.state.askpass.length - 1} more prompt(s) waiting`) : null,
      ),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.answerAskpass(r.id, null) }, `Cancel ${r.jobTitle || "operation"}`),
        r.kind === "hostkey"
          ? h("button", { class: "btn primary", onclick: () => app.answerAskpass(r.id, "yes") }, "Trust and continue")
          : h("button", { class: "btn primary", onclick: submit }, "OK"),
      ),
    );
  } else if (d.kind === "repo-settings") {
    const v = d.view;
    const repoName = app.repo?.name ?? "";
    const scopeTag = (scope: string) => h("span", { class: "src" }, scope === "none" ? "not set" : `from ${scope}`);
    const field = (value: string, oninput: (v: string) => void, placeholder: string, mono = false) =>
      h("input", { class: cls("field", mono && "mono"), value, placeholder, oninput: (e: Event) => oninput((e.target as HTMLInputElement).value) });
    const tab = (id: "general" | "template", label: string) => h("div", { class: cls(d.tab === id && "on"), onclick: () => app.updateDialog({ tab: id }) }, label);
    const authTab = h("div", { class: cls(d.tab === "auth" && "on"), onclick: () => void app.loadRepoAuth() }, "Authentication");

    const general = h(
      "div",
      { class: "form" },
      h("label", null, "Path"),
      h("div", { class: "val ro mono" }, v.path),
      h("label", null, "Group"),
      h(
        "select",
        { class: "field", onchange: (e: Event) => app.updateDialog({ groupId: (e.target as HTMLSelectElement).value }) },
        ...cfg.groups.map((g) => h("option", { value: g.id, selected: g.id === d.groupId }, g.name)),
      ),
      h("label", null, "Main branch"),
      h(
        "select",
        { class: "field", onchange: (e: Event) => app.updateDialog({ mainBranch: (e.target as HTMLSelectElement).value || null }) },
        h("option", { value: "", selected: d.mainBranch === null }, `auto (${v.mainBranchAuto ? v.mainBranch : "detect"})`),
        ...v.branches.map((b) => h("option", { value: b, selected: b === d.mainBranch }, b)),
      ),
      h("div", { class: "hint" }, "Used by the Merge menu and the ahead/behind counter. Detected automatically from origin/HEAD, main or master."),
      h("label", null, "user.name"),
      h("div", { class: "withsrc" }, field(d.userName, (userName) => app.updateDialog({ userName }), "Name for commits"), scopeTag(v.userNameScope)),
      h("label", null, "user.email"),
      h("div", { class: "withsrc" }, field(d.userEmail, (userEmail) => app.updateDialog({ userEmail }), "email for commits"), scopeTag(v.userEmailScope)),
      h("div", { class: "hint" }, "Changed values are saved into .git/config of this repository. Clearing a local value falls back to the global one."),
    );

    // Task template tab (mockup 06): preset dropdown, editable fields, live preview
    const t = d.template;
    const presetNames = ["None", ...app.state.presets.map((p) => p.name), "Custom"];
    const sampleCode = t ? (/^\[0-9a-z\]\{9\}$/.test(t.codePattern) ? "869eu8fkw" : /[A-Z]/.test(t.codePattern) ? "OST-52990" : "TASK-1") : "";
    const preview = t ? buildBranchName(t, { type: t.types[0] ?? "", name: "new gang grades", code: sampleCode }) : "";
    const link = t ? taskLink(t, sampleCode) : null;
    const prefix = t ? commitPrefix(t, sampleCode) : "";
    const tfield = (key: keyof TaskTemplate, placeholder: string) =>
      h("input", {
        class: "field mono",
        value: key === "types" ? (t?.types ?? []).join(", ") : ((t?.[key] as string | undefined) ?? ""),
        placeholder,
        disabled: !t,
        oninput: (e: Event) => {
          const value = (e.target as HTMLInputElement).value;
          if (key === "types") app.editTemplate({ types: value.split(",").map((x) => x.trim()).filter(Boolean) });
          else app.editTemplate({ [key]: value } as Partial<TaskTemplate>);
        },
      });
    const templateTab = h(
      "div",
      { class: "form" },
      h("label", null, "Preset"),
      h(
        "select",
        { class: "field", onchange: (e: Event) => app.applyPreset((e.target as HTMLSelectElement).value) },
        ...presetNames.map((n) => h("option", { value: n, selected: n === d.presetName }, n)),
      ),
      h("div", { class: "hint" }, "None turns everything off: plain branch names, no prefixes, no links. Custom opens the fields for editing; built-in presets can be edited too and become Custom."),
      h("label", null, "Task code pattern"),
      tfield("codePattern", "[A-Z]+-\\d+"),
      h("label", null, "Branch types"),
      tfield("types", "feature, fix (empty = no type field)"),
      h("label", null, "Branch name"),
      tfield("branchTemplate", "{type}/{name}#{code}"),
      h("label", null, "Commit message"),
      tfield("commitTemplate", "[{code}] {message} (empty = commits stay unmarked)"),
      h("label", null, "Task link"),
      tfield("linkTemplate", "https://tracker.example.com/browse/{code}"),
      h("label", null, "Preview"),
      h(
        "div",
        { class: "val ro preview" },
        t ? h("div", { class: "mono" }, preview || "…") : h("div", { class: "muted" }, "no template"),
        t ? h("div", { class: "mono muted" }, prefix ? `commit: ${prefix}message` : "commits stay unmarked") : null,
        link ? h("div", { class: "mono muted", title: link }, link) : null,
      ),
      h("label", null, ""),
      h("div", { class: "inlinebtns" }, h("button", { class: "btn small", disabled: !t, onclick: () => app.saveTemplateAsPreset() }, "Save as preset")),
    );

    // an operation of this repository started while the dialog was open: the edits stay, saving waits for it
    const busyJob = app.busyJob();
    const busyNote = busyJob
      ? h("div", { class: "banner" }, h("span", { class: "spin" }), h("span", null, `Repository is busy: ${busyJob.title}. Settings can be saved when it is done.`))
      : null;
    box = h(
      "div",
      { class: "dlg" },
      h("div", { class: "hd" }, "Repo Settings", h("span", null, repoName)),
      h("div", { class: "tabs" }, tab("general", "General"), tab("template", "Task template"), authTab),
      h("div", { class: "bd" }, busyNote, d.tab === "general" ? general : d.tab === "template" ? templateTab : repoAuthTab(app, d.auth, d.authUsername, d.authSshKey, !!busyJob), err),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"),
        h("button", { class: "btn primary", disabled: d.saving || !!busyJob, title: busyJob ? "Repository is busy" : "", onclick: () => void app.saveRepoSettings() }, d.saving ? "Saving…" : "Save"),
      ),
    );
  } else if (d.kind === "global-settings") {
    const v = d.view;
    const themes: { value: "system" | "light" | "dark"; label: string }[] = [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ];
    const tab = (id: "general" | "presets", label: string) => h("div", { class: cls(d.tab === id && "on"), onclick: () => app.updateDialog({ tab: id }) }, label);
    const general = h(
      "div",
      { class: "form" },
      h("label", null, "git"),
      h(
        "div",
        { class: "withsrc" },
        h("input", { class: "field mono", value: d.gitPath, placeholder: "git (from PATH)", oninput: (e: Event) => app.updateDialog({ gitPath: (e.target as HTMLInputElement).value }) }),
        h("span", { class: "src" }, v.gitVersion ? `${v.gitVersion} found` : "not found"),
      ),
      h("div", { class: "hint" }, `Currently used: ${v.gitResolved}. Leave empty to use git from PATH.`),
      h("label", null, "Credential manager"),
      h("div", { class: "val ro" }, v.gcmVersion ? `Git Credential Manager ${v.gcmVersion} found` : "Git Credential Manager not found: HTTPS logins will ask for a password every time"),
      h("label", null, "Editor command"),
      h("input", { class: "field mono", value: d.editorCommand, placeholder: "code {path}", oninput: (e: Event) => app.updateDialog({ editorCommand: (e.target as HTMLInputElement).value }) }),
      h("div", { class: "hint" }, "Used by Open in Code for a repository and for a group folder. {path} is replaced by the folder. On macOS without the CLI: open -a \"Visual Studio Code\" is tried."),
      h("label", null, "UnityYAMLMerge"),
      h(
        "div",
        { class: "withsrc" },
        h("input", { class: "field mono", value: d.unityYamlMerge, placeholder: "automatic: the project's editor in Unity Hub", oninput: (e: Event) => app.updateDialog({ unityYamlMerge: (e.target as HTMLInputElement).value }) }),
        h("span", { class: "src" }, v.unityYamlMergeFound ? "found" : "not found"),
      ),
      h("label", null, ""),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: d.unityMerge, onchange: (e: Event) => app.updateDialog({ unityMerge: (e.target as HTMLInputElement).checked }) }), "Merge scenes and prefabs with UnityYAMLMerge"),
      h(
        "div",
        { class: "hint" },
        v.unityYamlMergeFound ? `Currently used: ${v.unityYamlMergeFound}. ` : "No Unity editor found in Unity Hub. ",
        "Merges, pulls, cherry-picks and stash pops of this app pass it to git as the merge driver of .unity, .prefab, .asset and other Unity files; nothing is written to the repository. What it cannot merge is listed in Changes → Preview.",
      ),
      h("label", null, "Theme"),
      h(
        "select",
        { class: "field", onchange: (e: Event) => app.previewTheme((e.target as HTMLSelectElement).value as "system" | "light" | "dark") },
        ...themes.map((t) => h("option", { value: t.value, selected: t.value === d.theme }, t.label)),
      ),
      h("label", null, "Data folder"),
      h("div", { class: "val ro mono" }, v.dataDir),
      h("label", null, "Version"),
      versionRow(app),
    );
    const presetRow = (name: string, t: TaskTemplate, builtIn: boolean) =>
      h(
        "div",
        { class: "row" },
        h("span", { class: "lbl" }, name, builtIn ? h("span", { class: "muted" }, " · built-in") : null),
        h("span", { class: "meta mono", title: `${t.codePattern} · ${t.branchTemplate} · ${t.commitTemplate || "unmarked commits"}` }, t.branchTemplate),
        builtIn ? null : h("a", { onclick: () => app.deletePreset(name) }, "delete"),
      );
    const presets = h(
      "div",
      { class: "accounts" },
      ...BUILT_IN_PRESETS.map((p) => presetRow(p.name, p.template, true)),
      ...Object.entries(d.taskPresets).map(([name, t]) => presetRow(name, t, false)),
      h("div", { class: "hint" }, "Presets are picked in Repo Settings → Task template; “Save as preset” there adds to this list. Deleting a preset does not change repositories that use it."),
    );
    box = h(
      "div",
      { class: "dlg" },
      h("div", { class: "hd" }, "Global Settings"),
      h("div", { class: "tabs" }, tab("general", "General"), h("div", { class: cls(d.tab === "accounts" && "on"), onclick: () => void app.loadAccounts() }, "Accounts"), tab("presets", "Task presets")),
      h("div", { class: "bd" }, d.tab === "general" ? general : d.tab === "presets" ? presets : accountsTab(app, d.accounts, d.sshHosts, d.keys), err),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeGlobalSettings() }, "Cancel"),
        h("button", { class: "btn primary", disabled: d.saving, onclick: () => void app.saveGlobalSettings() }, d.saving ? "Saving…" : "Save"),
      ),
    );
  } else if (d.kind === "new-branch") {
    // with a task template the name is built from it, unless "Custom name" is chosen
    const tpl = d.template;
    const t = d.custom ? null : tpl;
    const result = app.branchNameFromDialog();
    const modeBtn = (label: string, custom: boolean) => h("div", { class: cls(d.custom === custom && "on"), onclick: () => app.updateDialog({ custom, error: "" }) }, label);
    const nameInput = h("input", {
      class: "field mono",
      value: d.name,
      placeholder: t ? "new-gang-grades" : "feature/my-change",
      oninput: (e: Event) => app.updateDialog({ name: (e.target as HTMLInputElement).value, error: "" }),
      onkeydown: (e: KeyboardEvent) => e.key === "Enter" && app.createBranch(),
    });
    if (freshDialog && freshDialog) queueMicrotask(() => nameInput.focus());
    const presetLabel = app.state.presets.find((p) => p.template === tpl)?.name ?? (tpl ? "template" : "no template");
    box = h(
      "div",
      { class: "dlg w440" },
      h("div", { class: "hd" }, "New branch", h("span", null, `${app.repo?.name ?? ""} · ${presetLabel}`)),
      h(
        "div",
        { class: "bd" },
        h(
          "div",
          { class: "form" },
          tpl ? h("label", null, "Naming") : null,
          tpl ? h("div", { class: "seg" }, modeBtn("By task template", false), modeBtn("Custom name", true)) : null,
          t && t.types.length ? h("label", null, "Type") : null,
          t && t.types.length
            ? h("select", { class: "field mono", onchange: (e: Event) => app.updateDialog({ type: (e.target as HTMLSelectElement).value }) }, ...t.types.map((x) => h("option", { value: x, selected: x === d.type }, x)))
            : null,
          h("label", null, "Name"),
          nameInput,
          t ? h("label", null, "Task code") : null,
          t ? h("input", { class: "field mono", value: d.code, placeholder: t.codePattern, oninput: (e: Event) => app.updateDialog({ code: (e.target as HTMLInputElement).value }) }) : null,
          h("label", null, "Start from"),
          h(
            "select",
            { class: "field mono", onchange: (e: Event) => app.updateDialog({ from: (e.target as HTMLSelectElement).value }) },
            ...(d.starts.includes(d.from) ? [] : [h("option", { value: d.from, selected: true }, d.from)]),
            ...d.starts.map((b) => h("option", { value: b, selected: b === d.from }, b)),
          ),
          t ? h("label", null, "Result") : null,
          t ? h("div", { class: "val ro mono" }, result || "…") : null,
          t && commitPrefix(t, d.code.trim() || "code") ? h("div", { class: "hint" }, `Commits on this branch get the prefix ${commitPrefix(t, d.code.trim() || "<code>")}`) : null,
          h("label", null, ""),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: d.checkout, onchange: (e: Event) => app.updateDialog({ checkout: (e.target as HTMLInputElement).checked }) }), "Check out after creating"),
        ),
        err,
      ),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"),
        h("button", { class: "btn primary", disabled: !result, onclick: () => app.createBranch() }, "Create branch"),
      ),
    );
  } else if (d.kind === "rename-branch") {
    const input = h("input", {
      class: "field mono",
      value: d.to,
      oninput: (e: Event) => app.updateDialog({ to: (e.target as HTMLInputElement).value }),
      onkeydown: (e: KeyboardEvent) => e.key === "Enter" && app.renameBranch(),
    });
    if (freshDialog) {
      input.focus();
      input.select();

    }
    box = h(
      "div",
      { class: "dlg w440" },
      h("div", { class: "hd" }, "Rename branch", h("span", null, d.from)),
      h("div", { class: "bd" }, h("div", { class: "form" }, h("label", null, "New name"), input), err),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"),
        h("button", { class: "btn primary", disabled: !d.to.trim() || d.to.trim() === d.from, onclick: () => app.renameBranch() }, "Rename"),
      ),
    );
  } else if (d.kind === "prompt") {
    const ok = () => {
      if (!d.value.trim()) return;
      app.closeDialog();
      d.onOk(d.value);
    };
    const input = h("input", {
      class: cls("field", d.mono && "mono"),
      value: d.value,
      oninput: (e: Event) => app.updateDialog({ value: (e.target as HTMLInputElement).value }),
      onkeydown: (e: KeyboardEvent) => e.key === "Enter" && ok(),
    });
    if (freshDialog) {
      input.focus();
      input.select();

    }
    box = h(
      "div",
      { class: "dlg w440" },
      h("div", { class: "hd" }, d.title),
      h("div", { class: "bd" }, h("div", { class: "form" }, h("label", null, d.label), input)),
      h("div", { class: "ft" }, h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"), h("button", { class: "btn primary", disabled: !d.value.trim(), onclick: ok }, d.okLabel)),
    );
  } else if (d.kind === "check-merged" || d.kind === "check-commit") {
    const isMerged = d.kind === "check-merged";
    const sel = (value: string, onchange: (v: string) => void) =>
      h("select", { class: "field mono", onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) }, ...d.branches.map((b) => h("option", { value: b, selected: b === value }, b)));
    const what = isMerged ? d.branch : d.sha.trim() || "<commit>";
    const into = isMerged ? d.into : d.branch;
    const resultEl = d.result ? h("div", { class: cls("checkresult", d.result.startsWith("yes") ? "yes" : d.result.startsWith("no") ? "no" : "") }, d.result) : null;
    box = h(
      "div",
      { class: "dlg w480" },
      h("div", { class: "hd" }, isMerged ? "Is the branch merged?" : "Is the commit in the branch?"),
      h(
        "div",
        { class: "bd" },
        h(
          "div",
          { class: "form" },
          h("label", null, isMerged ? "Branch" : "Commit"),
          isMerged
            ? sel(d.branch, (branch) => app.updateDialog({ branch, result: null }))
            : h("input", { class: "field mono", value: d.sha, placeholder: "sha or ref (select a commit in Commits to prefill)", oninput: (e: Event) => app.updateDialog({ sha: (e.target as HTMLInputElement).value, result: null }) }),
          h("label", null, isMerged ? "Merged into" : "Branch"),
          isMerged ? sel(d.into, (intoV) => app.updateDialog({ into: intoV, result: null })) : sel(d.branch, (branch) => app.updateDialog({ branch, result: null })),
          h("label", null, "Command"),
          h("div", { class: "val ro mono" }, `git merge-base --is-ancestor ${what} ${into}`),
        ),
        resultEl,
      ),
      h("div", { class: "ft" }, h("button", { class: "btn", onclick: () => app.closeDialog() }, "Close"), h("button", { class: "btn primary", onclick: () => void app.runCheck() }, "Check")),
    );
  } else if (d.kind === "add-token") {
    const tokenInput = h("input", {
      class: "field mono",
      type: "password",
      value: d.token,
      placeholder: "personal access token",
      autocomplete: "off",
      oninput: (e: Event) => app.updateDialog({ token: (e.target as HTMLInputElement).value }),
      onkeydown: (e: KeyboardEvent) => e.key === "Enter" && void app.saveToken(),
    });
    box = h(
      "div",
      { class: "dlg w480" },
      h("div", { class: "hd" }, "Add token", h("span", null, d.host)),
      h(
        "div",
        { class: "bd" },
        h(
          "div",
          { class: "form" },
          h("label", null, "Username"),
          h("input", { class: "field mono", value: d.username, placeholder: "your login (GitHub accepts anything)", oninput: (e: Event) => app.updateDialog({ username: (e.target as HTMLInputElement).value }) }),
          h("label", null, "Token"),
          tokenInput,
          h("div", { class: "hint" }, "Stored by Git Credential Manager in the OS credential store, the same place the browser login puts it. Nothing is written by uni-git itself."),
        ),
        err,
      ),
      h("div", { class: "ft" }, h("button", { class: "btn", onclick: () => app.cancelToken() }, "Cancel"), h("button", { class: "btn primary", disabled: !d.token.trim(), onclick: () => void app.saveToken() }, "Save token")),
    );
  } else if (d.kind === "stash-save") {
    const input = h("input", {
      class: "field",
      value: d.message,
      placeholder: "What is in this stash (optional)",
      oninput: (e: Event) => app.updateDialog({ message: (e.target as HTMLInputElement).value }),
      onkeydown: (e: KeyboardEvent) => e.key === "Enter" && app.stashSave(),
    });
    if (freshDialog && freshDialog) queueMicrotask(() => input.focus());
    box = h(
      "div",
      { class: "dlg w440" },
      h("div", { class: "hd" }, "Stash changes"),
      h(
        "div",
        { class: "bd" },
        h("div", { class: "form" }, h("label", null, "Message"), input, h("label", null, ""), h("label", { class: "check" }, h("input", { type: "checkbox", checked: d.includeUntracked, onchange: (e: Event) => app.updateDialog({ includeUntracked: (e.target as HTMLInputElement).checked }) }), "Include untracked files")),
      ),
      h("div", { class: "ft" }, h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"), h("button", { class: "btn primary", onclick: () => app.stashSave() }, "Stash")),
    );
  } else if (d.kind === "tag-create") {
    const input = h("input", {
      class: "field mono",
      value: d.name,
      placeholder: "v1.2.0",
      oninput: (e: Event) => app.updateDialog({ name: (e.target as HTMLInputElement).value, error: "" }),
      onkeydown: (e: KeyboardEvent) => e.key === "Enter" && app.tagCreate(),
    });
    if (freshDialog && freshDialog) queueMicrotask(() => input.focus());
    box = h(
      "div",
      { class: "dlg w440" },
      h("div", { class: "hd" }, "New tag", h("span", null, d.shaLabel)),
      h(
        "div",
        { class: "bd" },
        h(
          "div",
          { class: "form" },
          h("label", null, "Name"),
          input,
          h("label", null, "Message"),
          h("input", { class: "field", value: d.message, placeholder: "empty = lightweight tag", oninput: (e: Event) => app.updateDialog({ message: (e.target as HTMLInputElement).value }) }),
          h("label", null, ""),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: d.push, onchange: (e: Event) => app.updateDialog({ push: (e.target as HTMLInputElement).checked }) }), "Push to origin after creating"),
        ),
        err,
      ),
      h("div", { class: "ft" }, h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"), h("button", { class: "btn primary", disabled: !d.name.trim(), onclick: () => app.tagCreate() }, "Create tag")),
    );
  } else if (d.kind === "remote-add") {
    const nameInput = h("input", { class: "field mono", value: d.name, placeholder: "origin", oninput: (e: Event) => app.updateDialog({ name: (e.target as HTMLInputElement).value }) });
    if (freshDialog && freshDialog) queueMicrotask(() => nameInput.focus());
    box = h(
      "div",
      { class: "dlg w480" },
      h("div", { class: "hd" }, "Add remote"),
      h(
        "div",
        { class: "bd" },
        h(
          "div",
          { class: "form" },
          h("label", null, "Name"),
          nameInput,
          h("label", null, "URL"),
          h("input", { class: "field mono", value: d.url, placeholder: "git@github.com:org/repo.git", oninput: (e: Event) => app.updateDialog({ url: (e.target as HTMLInputElement).value }), onkeydown: (e: KeyboardEvent) => e.key === "Enter" && app.remoteAdd() }),
          h("div", { class: "hint" }, "The remote is fetched right after it is added."),
        ),
        err,
      ),
      h("div", { class: "ft" }, h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"), h("button", { class: "btn primary", disabled: !d.name.trim() || !d.url.trim(), onclick: () => app.remoteAdd() }, "Add remote")),
    );
  } else if (d.kind === "pick-branch") {
    box = h(
      "div",
      { class: "dlg w480" },
      h("div", { class: "hd" }, d.title),
      h(
        "div",
        { class: "bd" },
        h(
          "div",
          { class: "form" },
          h("label", null, "Branch"),
          h("select", { class: "field mono", onchange: (e: Event) => app.updateDialog({ picked: (e.target as HTMLSelectElement).value }) }, ...d.branches.map((b) => h("option", { value: b, selected: b === d.picked }, b))),
        ),
      ),
      h(
        "div",
        { class: "ft" },
        h("button", { class: "btn", onclick: () => app.closeDialog() }, "Cancel"),
        h(
          "button",
          {
            class: "btn primary",
            onclick: () => {
              app.closeDialog();
              d.onPick(d.picked);
            },
          },
          "Check",
        ),
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
        h("span", { style: "flex:1" }),
        h("button", { class: "btn danger", title: "Throw every uncommitted change away (untracked files are deleted), then switch", onclick: () => app.checkout(sel, false, true) }, "Discard and switch"),
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
  // clicking outside closes ordinary dialogs; a git prompt must be answered or cancelled explicitly
  const dismiss = () => {
    if (d.kind === "askpass") return;
    if (d.kind === "global-settings") app.closeGlobalSettings();
    else app.closeDialog();
  };
  return h("div", { class: "scrim", onmousedown: (e: MouseEvent) => e.target === e.currentTarget && dismiss() }, box);
}

/** Global Settings → General: running version, what the updater is doing, "Check now". */
function versionRow(app: App): HTMLElement {
  const u = app.state.update;
  const busy = u?.status === "checking" || u?.status === "downloading";
  return h(
    "div",
    { class: "withsrc" },
    h("div", { class: "val ro mono" }, u?.current ?? "…"),
    h("span", { class: "src upd", title: updateStatusText(u) }, updateStatusText(u)),
    u && u.status !== "disabled" ? h("button", { class: "btn small", disabled: busy, onclick: () => void app.checkForUpdates() }, busy ? "Checking…" : "Check now") : null,
  );
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
