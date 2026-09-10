import type { JobInfo } from "@epic-git/shared";
import type { App } from "../app.js";
import { cls, h } from "../dom.js";
import { elapsed } from "../format.js";

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

  return [
    btn("Repositories", { caret: true, disabled: !ready, menu: "repos", onclick: () => app.store.set({ openMenu: s.openMenu === "repos" ? null : "repos", contextMenu: null }) }),
    btn("Repo Settings", { disabled: true, title: "Stage 1, next iteration" }),
    btn("Global Settings", { disabled: true, title: "Stage 1, next iteration" }),
    h("span", { class: "gap" }),
    btn("Fetch", { disabled: off, onclick: () => app.fetch() }),
    btn("Pull", { disabled: off, onclick: () => app.pull(), count: st?.behind ? `↓${st.behind}` : undefined }),
    btn("Push", { disabled: off, onclick: () => app.push(), count: st?.ahead ? `↑${st.ahead}` : undefined }),
    btn("Commit", { primary: true, disabled: off, onclick: () => app.setView("changes") }),
    btn("Merge", { caret: true, disabled: true, title: "Stage 2" }),
    h("span", { class: "gap" }),
    btn("Open in Code", { caret: true, disabled: !hasRepo, menu: "code", onclick: () => app.store.set({ openMenu: s.openMenu === "code" ? null : "code", contextMenu: null }) }),
    h(
      "div",
      { class: "branch", title: repo?.path ?? "" },
      !s.connected && ready ? h("span", { class: "ref bad", title: "Backend connection lost, reconnecting…" }, "offline") : null,
      s.stale && hasRepo ? h("span", { class: "ref", title: "Data may be stale" }, "…") : null,
      st ? h("span", { class: "ref head" }, "HEAD") : null,
      h("span", { class: "name" }, hasRepo ? branchName : ready ? "no repository" : ""),
      ab.length ? h("span", { class: "ab" }, ab.join(" ")) : null,
    ),
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
