import type { JobInfo } from "@epic-git/shared";
import type { App } from "../app.js";
import { cls, h } from "../dom.js";
import { elapsed } from "../format.js";
import { taskCodeFromBranch, taskLink } from "@epic-git/shared";

export function renderToolbar(app: App): HTMLElement[] {
  const s = app.state;
  const repo = app.repo;
  const busy = app.isBusy();
  const ready = s.boot === "ready";
  const hasRepo = ready && !!repo;
  const off = !hasRepo || busy;
  const st = s.status;

  const btn = (label: string, opts: { onclick?: () => void; disabled?: boolean; primary?: boolean; caret?: boolean; count?: string | undefined; menu?: string; title?: string }) =>
    h(
      "button",
      {
        class: cls("btn", opts.primary && "primary"),
        disabled: opts.disabled === true,
        onclick: opts.onclick,
        title: opts.title,
        "data-menu-button": opts.menu,
      },
      label,
      opts.count ? h("span", { class: "count" }, opts.count) : null,
      opts.caret ? h("span", { class: "caret" }, "▼") : null,
    );

  const branchName = st ? (st.branch ?? (st.head ? `detached ${st.head.slice(0, 7)}` : "no commits yet")) : "";
  const ab: string[] = [];
  if (st && st.ahead) ab.push(`↑${st.ahead}`);
  if (st && st.behind) ab.push(`↓${st.behind}`);
  // relation to the main branch is always visible (plan: "questions about branches")
  const vsMain: string[] = [];
  if (st?.mainBranch && st.mainBranch !== st.branch && (st.aheadOfMain !== undefined || st.behindMain !== undefined)) {
    if (st.aheadOfMain) vsMain.push(`↑${st.aheadOfMain}`);
    if (st.behindMain) vsMain.push(`↓${st.behindMain}`);
    if (!vsMain.length) vsMain.push("=");
  }

  return [
    btn("Repositories", { caret: true, disabled: !ready, menu: "repos", onclick: () => app.store.set({ openMenu: s.openMenu === "repos" ? null : "repos", contextMenu: null }) }),
    btn("Repo Settings", { disabled: !hasRepo, onclick: () => void app.openRepoSettings() }),
    btn("Global Settings", { disabled: !ready, onclick: () => void app.openGlobalSettings() }),
    h("span", { class: "gap" }),
    btn("Fetch", { disabled: off, onclick: () => app.fetch() }),
    h(
      "span",
      { class: "split" },
      btn("Pull", { disabled: off, onclick: () => app.pull(), count: st?.behind ? `↓${st.behind}` : undefined }),
      h(
        "button",
        { class: "btn caretbtn", disabled: off, "data-menu-button": "pull", title: "Discard changes and pull", onclick: () => app.store.set({ openMenu: s.openMenu === "pull" ? null : "pull", contextMenu: null }) },
        h("span", { class: "caret" }, "▼"),
      ),
    ),
    h(
      "span",
      { class: "split" },
      btn("Push", { disabled: off, onclick: () => app.push(), count: st?.ahead ? `↑${st.ahead}` : undefined }),
      h(
        "button",
        { class: "btn caretbtn", disabled: off, "data-menu-button": "push", title: "Force push, push tags", onclick: () => app.store.set({ openMenu: s.openMenu === "push" ? null : "push", contextMenu: null }) },
        h("span", { class: "caret" }, "▼"),
      ),
    ),
    btn("Commit", { primary: true, disabled: off, onclick: () => app.setView("changes") }),
    btn("Branch", { caret: true, disabled: off, menu: "merge", title: "New branch, merge with main, checks", onclick: () => app.store.set({ openMenu: s.openMenu === "merge" ? null : "merge", contextMenu: null, menuHover: null }) }),
    h("span", { class: "gap" }),
    btn("Open in Code", { caret: true, disabled: !hasRepo, menu: "code", onclick: () => app.store.set({ openMenu: s.openMenu === "code" ? null : "code", contextMenu: null }) }),
    h(
      "div",
      { class: "branch", title: repo?.path ?? "" },
      !s.connected && ready ? h("span", { class: "ref bad", title: "Backend connection lost, reconnecting…" }, "offline") : null,
      s.stale && hasRepo ? h("span", { class: "ref", title: "Data may be stale" }, "…") : null,
      st ? h("span", { class: "ref head" }, "HEAD") : null,
      h("span", { class: "name" }, hasRepo ? branchName : ready ? "no repository" : ""),
      taskChip(app, st?.branch ?? null),
      ab.length ? h("span", { class: "ab", title: st?.upstream ? `vs ${st.upstream}` : "vs upstream" }, ab.join(" ")) : null,
      vsMain.length && st?.mainBranch ? h("span", { class: "ab main", title: `Relative to ${st.mainBranch}` }, `${vsMain.join(" ")} ${st.mainBranch}`) : null,
    ),
  ];
}

/** "OST-52990 ↗" + a copy button: the task code recognised in the branch name, opens the tracker. */
function taskChip(app: App, branch: string | null): HTMLElement[] | null {
  const t = app.state.template;
  const code = taskCodeFromBranch(t, branch);
  if (!code) return null;
  const link = taskLink(t, code);
  return [
    h("a", { class: "tagchip", title: link ?? "task code from the branch name", onclick: () => link && app.openExternal(link) }, link ? `${code} ↗` : code),
    h("button", { class: "btn small copy", title: `Copy ${code}`, onclick: () => void navigator.clipboard?.writeText(code).then(() => app.toast(`${code} copied`, "info")) }, "copy"),
  ];
}

export function renderOps(app: App, jobs: JobInfo[]): HTMLElement[] {
  return jobs.map((j) =>
    h(
      "span",
      { class: "job" },
      h("span", { class: "spin" }),
      h("b", null, j.repoName),
      " ",
      j.title,
      j.step ? ` · ${j.step}` : "",
      j.state === "queued" ? " · queued" : j.startedAt ? ` · ${elapsed(j.startedAt)}` : "",
      " ",
      h("a", { onclick: () => void app.showJobLog(j.id) }, "log"),
      " ",
      h("a", { onclick: () => app.cancelJob(j.id) }, "cancel"),
    ),
  );
}
