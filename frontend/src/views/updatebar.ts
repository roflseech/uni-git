import type { UpdateState } from "@uni-git/shared";
import type { App } from "../app.js";
import { h } from "../dom.js";

/**
 * One line under the toolbar once an update is installed (or cannot be): never a dialog, work goes on around it.
 * The new files are already in place, so "Later" only means "on the next launch".
 */
export function renderUpdateBar(app: App): (HTMLElement | null)[] {
  const s = app.state;
  const u = s.update;
  if (!u?.available || s.updateLater === u.available) return [];
  const later = () => app.store.set({ updateLater: u.available ?? null });
  if (u.status === "ready") {
    const busy = app.anyJobActive();
    return [
      h("span", { class: "upd-icon" }, "↑"),
      h("span", { class: "grow", title: (u.notes ?? []).join("\n") }, h("b", null, `uni-git ${u.available}`), " is installed. ", notesLine(u)),
      u.url ? h("a", { onclick: () => app.openExternal(u.url ?? "") }, "What's new") : null,
      h(
        "button",
        {
          class: "btn small primary",
          disabled: busy || s.restarting,
          title: busy ? "Waits until the running git operations finish" : "Takes about a second",
          onclick: () => void app.restartForUpdate(),
        },
        s.restarting ? "Restarting…" : "Restart now",
      ),
      h("button", { class: "btn small", disabled: s.restarting, title: "The update starts with the next launch", onclick: later }, "Later"),
    ];
  }
  if (u.status === "blocked") {
    return [h("span", { class: "upd-icon" }, "!"), h("span", { class: "grow" }, u.message ?? ""), h("button", { class: "btn small", onclick: later }, "Hide")];
  }
  return [];
}

function notesLine(u: UpdateState): string {
  const notes = u.notes ?? [];
  if (!notes.length) return "Restart to use it.";
  return notes.length > 2 ? `${notes.slice(0, 2).join(" · ")} · +${notes.length - 2} more` : notes.join(" · ");
}

/** Version line of Global Settings → General. */
export function updateStatusText(u: UpdateState | null): string {
  if (!u) return "";
  switch (u.status) {
    case "disabled":
      return u.message ?? "updates are off";
    case "idle":
      return "checks for updates a few seconds after start";
    case "checking":
      return "checking for updates…";
    case "downloading":
      return `downloading ${u.available ?? "the update"}…`;
    case "ready":
      return `${u.available ?? "update"} installed: restart to use it`;
    case "uptodate":
      return "up to date";
    case "blocked":
      return u.message ?? "the update cannot be installed";
    case "error":
      return `update check failed: ${u.message ?? "unknown error"}`;
  }
}
