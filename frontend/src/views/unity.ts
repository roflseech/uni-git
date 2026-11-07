import type { UnityChange, UnityChoice, UnityConflict, UnityObjectDiff, UnityObjectRef, UnityPreview } from "@uni-git/shared";
import type { App } from "../app.js";
import { cls, h, type Child } from "../dom.js";

/** Huge scenes: the first ones are shown, All ours / All theirs covers the rest. */
const MAX_CONFLICTS = 300;
const MAX_OBJECTS = 400;
const MAX_CHANGES = 80;
const MAX_ITEMS = 60;

export interface UnityViewOptions {
  /** conflicts can be resolved here (Changes view) */
  resolvable: boolean;
  busy: boolean;
}

/**
 * A Unity scene/prefab as objects: the changed objects grouped by GameObject with "old → new" properties, and for a
 * conflicted file the conflicts with their resolutions (lists: ours / theirs / combine / unique / by position).
 */
export function renderUnity(app: App, u: UnityPreview | null, loading: boolean, choices: Record<string, UnityChoice>, opts: UnityViewOptions): HTMLElement {
  const box = h("div", { class: cls("unity", loading && u && "loading") });
  if (!u) {
    box.append(h("div", { class: "empty" }, loading ? "Reading objects…" : "No preview"));
    return box;
  }
  if (u.mode === "merge") box.append(mergeBar(app, u, choices, opts));
  if (u.error) {
    box.append(h("div", { class: "empty" }, u.error, h("div", { class: "muted" }, "Untick Preview to see the YAML.")));
    return box;
  }
  if (u.mode === "merge") {
    if (u.conflicts.length) {
      box.append(h("div", { class: "u-head" }, `Conflicts ${u.conflicts.length}`, h("span", { class: "muted" }, " · both branches changed these; pick a resolution for each")));
      for (const c of u.conflicts.slice(0, MAX_CONFLICTS)) box.append(conflictCard(app, c, choices[c.id], opts));
      if (u.conflicts.length > MAX_CONFLICTS) box.append(h("div", { class: "u-more" }, `… ${u.conflicts.length - MAX_CONFLICTS} more conflicts: All ours / All theirs resolves them too`));
    } else {
      box.append(h("div", { class: "u-note" }, "No conflicts left at the object level: everything below merges cleanly."));
    }
    box.append(h("div", { class: "u-head" }, u.objects.length ? `From theirs, merged without a question · ${summary(u.objects)}` : "Theirs brings nothing else"));
  } else {
    box.append(h("div", { class: "u-head" }, u.objects.length ? summary(u.objects) : "No object changed (only formatting or order)", h("span", { class: "muted" }, ` · ${u.total} objects in the file`)));
  }
  box.append(objectList(u.objects));
  return box;
}

function summary(objects: UnityObjectDiff[]): string {
  const n = (state: UnityObjectDiff["state"]) => objects.filter((o) => o.state === state).length;
  const parts = [n("changed") && `${n("changed")} changed`, n("added") && `${n("added")} added`, n("removed") && `${n("removed")} removed`].filter(Boolean);
  return `${objects.length} object${objects.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/** "…/Hub/Editor/2022.3.62f3/Editor/Data/Tools/UnityYAMLMerge.exe" → "2022.3.62f3" */
function editorVersion(tool: string): string {
  return /[\\/](\d+\.\d+\.\d+[a-z]\d+)[\\/]/i.exec(tool)?.[1] ?? "";
}

function mergeBar(app: App, u: UnityPreview, choices: Record<string, UnityChoice>, opts: UnityViewOptions): HTMLElement {
  const all = u.conflicts.length;
  const chosen = u.conflicts.filter((c) => choices[c.id]).length;
  const ready = !u.error && chosen === all;
  const tool = u.yamlMerge ?? null;
  const off = !opts.resolvable || opts.busy;
  return h(
    "div",
    { class: "u-bar" },
    h("span", { class: "u-tool", title: tool ?? "Install the project's Unity version in Unity Hub or set the path in Global Settings" }, tool ? `UnityYAMLMerge ${editorVersion(tool)}` : "UnityYAMLMerge not found"),
    tool && opts.resolvable ? h("button", { class: "btn small", disabled: off, title: "Run UnityYAMLMerge on this file: if it merges it cleanly, the result is staged", onclick: () => app.yamlMerge([u.path]) }, "Run it") : null,
    h("span", { class: "grow" }),
    all ? h("span", { class: "muted" }, `${chosen} of ${all} chosen`) : null,
    all && opts.resolvable ? h("button", { class: "btn small", disabled: off, onclick: () => app.chooseAllUnity("ours") }, "All ours") : null,
    all && opts.resolvable ? h("button", { class: "btn small", disabled: off, onclick: () => app.chooseAllUnity("theirs") }, "All theirs") : null,
    opts.resolvable && !u.error
      ? h("button", { class: "btn small primary", disabled: off || !ready, title: ready ? "Write the merged file and mark it resolved" : "Pick a resolution for every conflict first", onclick: () => app.applyUnity() }, all ? "Apply & mark resolved" : "Merge & mark resolved")
      : null,
  );
}

function objTitle(r: UnityObjectRef, path?: string): HTMLElement {
  return h(
    "div",
    { class: "u-title", title: `fileID ${r.fileId}` },
    h("span", { class: "u-type" }, r.type, r.script ? h("span", { class: "u-script" }, ` (${r.script})`) : null),
    r.owner ? h("span", { class: "u-owner", title: r.owner }, r.owner) : null,
    path ? h("span", { class: "u-path mono", title: path }, path) : null,
  );
}

/** Values of one side; `mark` colours items missing from `against` (new on this side / gone from the other). */
function column(title: string, lines: string[] | undefined, mark?: { against: string[] | undefined; klass: string }, extra?: string): HTMLElement {
  const other = new Set(mark?.against ?? []);
  const body: Child[] =
    lines === undefined
      ? [h("div", { class: "u-none" }, "absent")]
      : !lines.length
        ? [h("div", { class: "u-none" }, "empty")]
        : [
            ...lines.slice(0, MAX_ITEMS).map((l) => h("div", { class: cls("u-val", mark && mark.against && !other.has(l) && mark.klass), title: l }, l)),
            lines.length > MAX_ITEMS ? h("div", { class: "u-none" }, `… ${lines.length - MAX_ITEMS} more`) : null,
          ];
  return h("div", { class: cls("u-col", extra) }, h("div", { class: "u-coltitle" }, title), ...body);
}

function conflictCard(app: App, c: UnityConflict, choice: UnityChoice | undefined, opts: UnityViewOptions): HTMLElement {
  const list = c.kind === "array";
  const card = h(
    "div",
    { class: cls("u-conf", choice && "done") },
    objTitle(c, c.path || "the whole object"),
    h(
      "div",
      { class: "u-cols" },
      // lists: base items one side dropped are red, items a side added are green
      column("Base", c.base, list ? { against: intersect(c.ours, c.theirs), klass: "gone" } : undefined),
      column("Ours", c.ours, list ? { against: c.base, klass: "new" } : undefined),
      column("Theirs", c.theirs, list ? { against: c.base, klass: "new" } : undefined),
    ),
    h(
      "div",
      { class: "u-opts" },
      ...c.options.map((o) =>
        h(
          "label",
          { class: cls("u-opt", choice === o.choice && "on"), title: o.result.join("\n") },
          h("input", { type: "radio", name: `u:${c.id}`, checked: choice === o.choice, disabled: !opts.resolvable || opts.busy, onchange: () => app.chooseUnity(c.id, o.choice) }),
          o.label,
        ),
      ),
    ),
  );
  const picked = list && choice ? c.options.find((o) => o.choice === choice) : undefined;
  if (picked) card.append(h("div", { class: "u-cols" }, column(`Result · ${picked.result.length} item${picked.result.length === 1 ? "" : "s"}`, picked.result, undefined, "result")));
  return card;
}

/** Items both sides still have (base items outside it were removed by someone). */
function intersect(a: string[] | undefined, b: string[] | undefined): string[] {
  const inB = new Set(b ?? []);
  return (a ?? []).filter((x) => inB.has(x));
}

function objectList(objects: UnityObjectDiff[]): HTMLElement {
  const wrap = h("div", { class: "u-objs" });
  const groups = new Map<string, UnityObjectDiff[]>();
  for (const o of objects.slice(0, MAX_OBJECTS)) {
    const g = groups.get(o.owner) ?? [];
    g.push(o);
    groups.set(o.owner, g);
  }
  // hierarchy paths sort parents before their children
  for (const owner of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    wrap.append(
      h(
        "div",
        { class: "u-group" },
        h("div", { class: "u-ghead", title: owner }, owner || "(not on a GameObject)"),
        ...groups.get(owner)!.map((o) =>
          h(
            "div",
            { class: "u-obj" },
            h(
              "div",
              { class: "u-orow", title: `fileID ${o.fileId}` },
              h("span", { class: cls("flag", o.state === "added" ? "a" : o.state === "removed" ? "d" : "m") }, o.state === "added" ? "A" : o.state === "removed" ? "D" : "M"),
              h("span", { class: "u-type" }, o.type, o.script ? h("span", { class: "u-script" }, ` (${o.script})`) : null),
              o.state !== "changed" ? h("span", { class: "muted" }, o.state) : null,
            ),
            ...o.changes.slice(0, MAX_CHANGES).map(changeRow),
            o.changes.length > MAX_CHANGES ? h("div", { class: "u-none" }, `… ${o.changes.length - MAX_CHANGES} more properties`) : null,
          ),
        ),
      ),
    );
  }
  if (objects.length > MAX_OBJECTS) wrap.append(h("div", { class: "u-more" }, `… ${objects.length - MAX_OBJECTS} more objects (untick Preview for the full YAML)`));
  return wrap;
}

function changeRow(c: UnityChange): HTMLElement {
  const values: Child[] =
    c.added || c.removed
      ? [...(c.removed ?? []).slice(0, MAX_ITEMS).map((t) => h("div", { class: "u-old", title: t }, `− ${t}`)), ...(c.added ?? []).slice(0, MAX_ITEMS).map((t) => h("div", { class: "u-new", title: t }, `+ ${t}`))]
      : [h("span", { class: "u-old", title: c.old ?? "" }, c.old ?? "—"), h("span", { class: "u-arrow" }, "→"), h("span", { class: "u-new", title: c.new ?? "" }, c.new ?? "—")];
  return h("div", { class: "u-change" }, h("span", { class: "u-path mono", title: c.path }, c.path), h("div", { class: cls("u-vals", (c.added || c.removed) && "list") }, ...values));
}
