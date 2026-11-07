/**
 * Unity scenes/prefabs as objects: a 2-way diff for the preview of a change and a 3-way merge for conflicts that
 * UnityYAMLMerge left (or when it is not installed). Objects are matched by fileID, properties by key;
 * lists are merged item by item when only different positions changed, otherwise they become an array conflict
 * with ours / theirs / combine / unique / by-position resolutions. PrefabInstance modifications are matched by
 * target + propertyPath, like a dictionary.
 */
import type { UnityChange, UnityChoice, UnityConflict, UnityConflictOption, UnityObjectDiff, UnityObjectRef } from "@uni-git/shared";
import { get, nodeText, refId, same, str, type UnityDoc, type UnityFile, type YNode, type YSeq } from "./unityYaml.js";

const stripped = (d: UnityDoc): boolean => d.tail.includes("stripped");

function byId(f: UnityFile | undefined): Map<string, UnityDoc> {
  return new Map((f?.docs ?? []).map((d) => [d.fileId, d]));
}

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/** Who an object is: its class, the hierarchy path of its GameObject, the script of a MonoBehaviour. */
export class UnityNames {
  private readonly docs = new Map<string, UnityDoc>();
  /** GameObject fileID → its Transform */
  private readonly transformOf = new Map<string, string>();
  private readonly paths = new Map<string, string>();
  /** script guid → class name, filled by the caller from the .cs.meta files */
  readonly scripts = new Map<string, string>();

  /** Earlier files win when several versions have the object (ours before theirs before base). */
  constructor(files: (UnityFile | undefined)[]) {
    for (const f of files) for (const d of f?.docs ?? []) if (!this.docs.has(d.fileId)) this.docs.set(d.fileId, d);
    for (const d of this.docs.values()) {
      if ((d.type === "Transform" || d.type === "RectTransform") && !stripped(d)) {
        const go = refId(d.body, "m_GameObject");
        if (go !== "0" && !this.transformOf.has(go)) this.transformOf.set(go, d.fileId);
      }
    }
  }

  ref(d: UnityDoc): UnityObjectRef {
    const r: UnityObjectRef = { fileId: d.fileId, type: d.type, owner: this.owner(d) };
    const guid = this.scriptGuid(d);
    const script = guid ? this.scripts.get(guid) : undefined;
    if (script) r.script = script;
    return r;
  }

  scriptGuid(d: UnityDoc): string | undefined {
    return d.type === "MonoBehaviour" ? /guid: ([0-9a-f]{32})/.exec(str(d.body, "m_Script"))?.[1] : undefined;
  }

  /** Script guid of the MonoBehaviour with this fileID. */
  guidOf(fileId: string): string | undefined {
    const d = this.docs.get(fileId);
    return d ? this.scriptGuid(d) : undefined;
  }

  private owner(d: UnityDoc): string {
    if (stripped(d)) return this.instancePath(refId(d.body, "m_PrefabInstance"));
    if (d.type === "GameObject") return this.goPath(d.fileId);
    if (d.type === "PrefabInstance" || d.type === "Prefab") return this.instancePath(d.fileId);
    const go = refId(d.body, "m_GameObject");
    if (go !== "0") return this.goPath(go);
    return str(d.body, "m_Name");
  }

  /** Name a prefab instance gets in the hierarchy: its m_Name override, else a placeholder. */
  private instanceName(id: string): string {
    const mods = get(get(this.docs.get(id)?.body, "m_Modification"), "m_Modifications");
    const name = mods?.k === "q" ? mods.items.find((it) => str(it, "propertyPath") === "m_Name") : undefined;
    return name ? str(name, "value") : "Prefab instance";
  }

  private instancePath(id: string): string {
    const parent = refId(get(this.docs.get(id)?.body, "m_Modification"), "m_TransformParent");
    const up = parent !== "0" ? this.transformPath(parent) : "";
    return up ? `${up}/${this.instanceName(id)}` : this.instanceName(id);
  }

  private goPath(id: string): string {
    const cached = this.paths.get(id);
    if (cached !== undefined) return cached;
    const d = this.docs.get(id);
    const t = this.transformOf.get(id);
    const p = d && stripped(d) ? this.instancePath(refId(d.body, "m_PrefabInstance")) : t ? this.transformPath(t) : (d && str(d.body, "m_Name")) || "";
    this.paths.set(id, p);
    return p;
  }

  /** Names up the Transform parents; parents inside nested prefab instances are named after the instance. */
  private transformPath(id: string): string {
    const names: string[] = [];
    const seen = new Set<string>();
    let cur = id;
    while (cur !== "0" && !seen.has(cur) && names.length < 40) {
      seen.add(cur);
      const t = this.docs.get(cur);
      if (!t) break;
      if (stripped(t)) {
        const inst = refId(t.body, "m_PrefabInstance");
        names.unshift(this.instanceName(inst));
        cur = refId(get(this.docs.get(inst)?.body, "m_Modification"), "m_TransformParent");
      } else {
        const go = this.docs.get(refId(t.body, "m_GameObject"));
        names.unshift((go && str(go.body, "m_Name")) || "?");
        cur = refId(t.body, "m_Father");
      }
    }
    return names.join("/");
  }
}

// ───────────── lists of PrefabInstance modifications: matched by target + propertyPath ─────────────

interface Keyed {
  items: Map<string, YNode>;
  labels: Map<string, string>;
}

function keyed(q: YSeq | undefined): Keyed | null {
  if (!q || !q.items.length) return q ? { items: new Map(), labels: new Map() } : null;
  if (!q.items.every((it) => it.k === "m" && !it.flow && get(it, "target") && get(it, "propertyPath"))) return null;
  const items = new Map<string, YNode>();
  const labels = new Map<string, string>();
  const count = new Map<string, number>();
  for (const it of q.items) count.set(str(it, "propertyPath"), (count.get(str(it, "propertyPath")) ?? 0) + 1);
  for (const it of q.items) {
    const prop = str(it, "propertyPath");
    const key = `${prop}|${str(it, "target")}`;
    if (items.has(key)) return null;
    items.set(key, it);
    // the target is an object of the source prefab (not in this file): its id only tells same-named paths apart
    labels.set(key, (count.get(prop) ?? 0) > 1 ? `${prop} @${refId(it, "target").slice(-4)}` : prop);
  }
  return { items, labels };
}

/** A modification shows as its value (or the object it references). */
function modText(n: YNode | undefined): string | undefined {
  if (!n) return undefined;
  const ref = str(n, "objectReference");
  return ref && !/fileID: 0[,}]/.test(ref) ? ref : str(n, "value");
}

/** Keys of two ordered lists: ours' order, theirs-only keys after the key that precedes them in theirs. */
function unionOrder(ours: string[], theirs: string[]): string[] {
  const inOurs = new Set(ours);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const k of theirs) {
    if (inOurs.has(k)) {
      anchor = k;
      continue;
    }
    const list = after.get(anchor) ?? [];
    list.push(k);
    after.set(anchor, list);
  }
  const res = [...(after.get(null) ?? [])];
  for (const k of ours) {
    res.push(k);
    res.push(...(after.get(k) ?? []));
  }
  return res;
}

// ───────────── diff ─────────────

export function diffUnity(a: UnityFile | undefined, b: UnityFile | undefined, names: UnityNames): UnityObjectDiff[] {
  const A = byId(a);
  const B = byId(b);
  const out: UnityObjectDiff[] = [];
  for (const d of b?.docs ?? []) {
    const old = A.get(d.fileId);
    if (!old) {
      out.push({ ...names.ref(d), state: "added", changes: [] });
      continue;
    }
    if (old.tail === d.tail && same(old.body, d.body)) continue;
    const changes: UnityChange[] = [];
    if (old.tail !== d.tail) changes.push({ path: "(document)", old: old.tail.trim() || "-", new: d.tail.trim() || "-" });
    diffNode(old.body, d.body, "", changes);
    out.push({ ...names.ref(d), state: "changed", changes });
  }
  for (const d of a?.docs ?? []) if (!B.has(d.fileId)) out.push({ ...names.ref(d), state: "removed", changes: [] });
  return out;
}

function diffNode(a: YNode | undefined, b: YNode | undefined, path: string, out: UnityChange[]): void {
  if (same(a, b)) return;
  if (a?.k === "m" && b?.k === "m" && !!a.flow === !!b.flow) {
    const keys = unionOrder(
      b.e.map(([k]) => k),
      a.e.map(([k]) => k),
    );
    const inner: UnityChange[] = [];
    for (const k of keys) diffNode(get(a, k), get(b, k), join(path, k), inner);
    // a vector/colour with several fields changed reads better whole: {x: 1, y: 1} → {x: 2, y: 2}
    if (a.flow && inner.length > 1) out.push({ path, old: nodeText(a), new: nodeText(b) });
    else out.push(...inner);
    return;
  }
  if (a?.k === "q" && b?.k === "q") {
    const ka = keyed(a);
    const kb = keyed(b);
    if (ka && kb) {
      for (const key of unionOrder([...kb.items.keys()], [...ka.items.keys()])) {
        const ia = ka.items.get(key);
        const ib = kb.items.get(key);
        if (same(ia, ib)) continue;
        const at = `${path}[${kb.labels.get(key) ?? ka.labels.get(key)}]`;
        const c: UnityChange = { path: at };
        const ta = modText(ia);
        const tb = modText(ib);
        if (ta !== undefined) c.old = ta;
        if (tb !== undefined) c.new = tb;
        if (ta === tb) diffNode(ia, ib, at, out);
        else out.push(c);
      }
      return;
    }
    if (a.items.length === b.items.length) {
      a.items.forEach((it, i) => diffNode(it, b.items[i], `${path}[${i}]`, out));
      return;
    }
    // items added / removed: compare as multisets of their text
    const left = new Map<string, number>();
    for (const it of a.items) left.set(nodeText(it), (left.get(nodeText(it)) ?? 0) + 1);
    const added: string[] = [];
    for (const it of b.items) {
      const t = nodeText(it);
      const n = left.get(t) ?? 0;
      if (n > 0) left.set(t, n - 1);
      else added.push(t);
    }
    const removed = [...left].flatMap(([t, n]) => Array<string>(n).fill(t));
    out.push({ path, added, removed });
    return;
  }
  const c: UnityChange = { path };
  if (a) c.old = nodeText(a);
  if (b) c.new = nodeText(b);
  out.push(c);
}

// ───────────── 3-way merge ─────────────

export interface UnityMergeResult {
  file: UnityFile;
  /** every conflict found, chosen or not, in file order */
  conflicts: UnityConflict[];
  /** conflicts without a choice: the file holds ours for them */
  open: number;
}

const ARRAY_LABELS: Record<string, string> = {
  ours: "Ours",
  theirs: "Theirs",
  combine: "Combine: ours + what theirs added, minus what theirs removed",
  unique: "Unique values from both",
  positions: "By position: positions theirs changed replace ours",
};

/** `base` is absent when both branches added the file. Conflicts without a choice keep ours. */
export function mergeUnity(base: UnityFile | undefined, ours: UnityFile, theirs: UnityFile, names: UnityNames, choices: Record<string, UnityChoice> = {}): UnityMergeResult {
  const m = new Merger(names, choices);
  const B = byId(base);
  const O = byId(ours);
  const T = byId(theirs);
  const docs: UnityDoc[] = [];
  const ids = unionOrder(
    ours.docs.map((d) => d.fileId),
    theirs.docs.map((d) => d.fileId),
  );
  for (const id of ids) {
    const d = m.doc(B.get(id), O.get(id), T.get(id));
    if (d) docs.push(d);
  }
  return { file: { ...ours, docs }, conflicts: m.conflicts, open: m.open };
}

class Merger {
  readonly conflicts: UnityConflict[] = [];
  open = 0;
  /** object being merged; its name is worked out only if it has a conflict */
  private cur: UnityDoc | undefined;
  private curRef: UnityObjectRef | undefined;

  constructor(
    private readonly names: UnityNames,
    private readonly choices: Record<string, UnityChoice>,
  ) {}

  private get ref(): UnityObjectRef {
    this.curRef ??= this.cur ? this.names.ref(this.cur) : { fileId: "", type: "", owner: "" };
    return this.curRef;
  }

  doc(b: UnityDoc | undefined, o: UnityDoc | undefined, t: UnityDoc | undefined): UnityDoc | undefined {
    this.cur = o ?? t ?? b;
    this.curRef = undefined;
    if (o && t) {
      const body = this.node(b?.body, o.body, t.body, "") ?? o.body;
      const tail = b && o.tail === b.tail ? t.tail : o.tail;
      return { ...o, tail, body };
    }
    if (!b) return o ?? t;
    const kept = o ?? t;
    // deleted on both sides, or deleted on one and untouched on the other
    if (!kept || same(b.body, kept.body)) return undefined;
    const type = this.ref.type;
    const choice = this.pick("", {
      kind: "object",
      base: [`${type} exists`],
      ours: [o ? `${type} changed` : `${type} deleted`],
      theirs: [t ? `${type} changed` : `${type} deleted`],
      options: [
        { choice: "keep", label: `Keep it with ${o ? "our" : "their"} changes`, result: [`${type} kept`] },
        { choice: "delete", label: "Delete it", result: [`${type} deleted`] },
      ],
    });
    // without a choice the file holds ours
    return choice === "keep" ? kept : choice === "delete" ? undefined : o;
  }

  /** Records the conflict (chosen or not) and returns the choice. */
  private pick(path: string, c: Omit<UnityConflict, keyof UnityObjectRef | "id" | "path">): UnityChoice | undefined {
    const ref = this.ref;
    const id = `${ref.fileId}:${path}`;
    this.conflicts.push({ ...ref, id, path, ...c });
    const choice = this.choices[id];
    if (!choice || !c.options.some((o) => o.choice === choice)) {
      this.open++;
      return undefined;
    }
    return choice;
  }

  node(b: YNode | undefined, o: YNode | undefined, t: YNode | undefined, path: string): YNode | undefined {
    if (same(o, t)) return o;
    if (same(b, o)) return t;
    if (same(b, t)) return o;
    if (o?.k === "m" && t?.k === "m" && !!o.flow === !!t.flow && (!b || (b.k === "m" && !!b.flow === !!o.flow))) {
      const e: [string, YNode][] = [];
      const keys = unionOrder(
        o.e.map(([k]) => k),
        t.e.map(([k]) => k),
      );
      for (const k of keys) {
        const v = this.node(get(b, k), get(o, k), get(t, k), join(path, k));
        if (v) e.push([k, v]);
      }
      return { ...o, e };
    }
    if (o?.k === "q" && t?.k === "q" && (!b || b.k === "q")) return this.seq(b, o, t, path);
    const vb = b ? [nodeText(b)] : undefined;
    const vo = o ? [nodeText(o)] : undefined;
    const vt = t ? [nodeText(t)] : undefined;
    const choice = this.pick(path, {
      kind: "value",
      ...(vb ? { base: vb } : {}),
      ...(vo ? { ours: vo } : {}),
      ...(vt ? { theirs: vt } : {}),
      options: [
        { choice: "ours", label: "Ours", result: vo ?? ["(none)"] },
        { choice: "theirs", label: "Theirs", result: vt ?? ["(none)"] },
      ],
    });
    return choice === "theirs" ? t : o;
  }

  private seq(b: YSeq | undefined, o: YSeq, t: YSeq, path: string): YSeq {
    const kb = b ? keyed(b) : { items: new Map<string, YNode>(), labels: new Map<string, string>() };
    const ko = keyed(o);
    const kt = keyed(t);
    if (kb && ko && kt) {
      const items: YNode[] = [];
      for (const key of unionOrder([...ko.items.keys()], [...kt.items.keys()])) {
        const label = ko.labels.get(key) ?? kt.labels.get(key) ?? key;
        const v = this.node(kb.items.get(key), ko.items.get(key), kt.items.get(key), `${path}[${label}]`);
        if (v) items.push(v);
      }
      return { ...o, items };
    }
    const B = b?.items ?? [];
    const O = o.items;
    const T = t.items;
    if (B.length === O.length && O.length === T.length) {
      // only different positions changed (or mappings changed inside): merge item by item
      const inside = (i: number) => O[i]!.k === "m" && T[i]!.k === "m" && B[i]!.k === "m";
      const trivial = (i: number) => same(O[i], T[i]) || same(B[i], O[i]) || same(B[i], T[i]);
      if (O.every((_, i) => trivial(i) || inside(i))) {
        return { ...o, items: O.map((_, i) => this.node(B[i], O[i], T[i], `${path}[${i}]`) ?? O[i]!) };
      }
    }
    const results: Record<string, YNode[]> = { ours: O, theirs: T, combine: combine(B, O, T), unique: unique(O, T), positions: positions(B, O, T) };
    const options: UnityConflictOption[] = Object.entries(results).map(([choice, items]) => ({ choice: choice as UnityChoice, label: ARRAY_LABELS[choice]!, result: items.map(nodeText) }));
    const choice = this.pick(path, { kind: "array", base: B.map(nodeText), ours: O.map(nodeText), theirs: T.map(nodeText), options });
    return { ...o, items: (choice && results[choice]) || O };
  }
}

const keys = new WeakMap<YNode, string>();
/** Identity of a list item: its exact content. */
function key(n: YNode): string {
  let k = keys.get(n);
  if (k === undefined) {
    k = JSON.stringify(n);
    keys.set(n, k);
  }
  return k;
}

function counts(list: YNode[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of list) m.set(key(n), (m.get(key(n)) ?? 0) + 1);
  return m;
}

/** Ours, minus the items theirs removed from base, plus the items theirs added (placed after their predecessor in theirs). */
export function combine(base: YNode[], ours: YNode[], theirs: YNode[]): YNode[] {
  const inBase = counts(base);
  const inTheirs = counts(theirs);
  const inOurs = counts(ours);
  const removed = new Map<string, number>();
  for (const [k, n] of inBase) if (n > (inTheirs.get(k) ?? 0)) removed.set(k, n - (inTheirs.get(k) ?? 0));
  const res: YNode[] = [];
  for (const n of ours) {
    const r = removed.get(key(n)) ?? 0;
    if (r > 0) removed.set(key(n), r - 1);
    else res.push(n);
  }
  // theirs' additions, minus the same items ours added too
  const added = new Map<string, number>();
  for (const [k, n] of inTheirs) {
    const b = inBase.get(k) ?? 0;
    const left = n - b - Math.max(0, (inOurs.get(k) ?? 0) - b);
    if (left > 0) added.set(k, left);
  }
  const resKeys = res.map(key);
  theirs.forEach((n, i) => {
    const left = added.get(key(n)) ?? 0;
    if (left <= 0) return;
    added.set(key(n), left - 1);
    // right after the item that precedes it in theirs, at the start if it is first there, else at the end
    const at = i === 0 ? 0 : resKeys.lastIndexOf(key(theirs[i - 1]!)) + 1 || res.length;
    res.splice(at, 0, n);
    resKeys.splice(at, 0, key(n));
  });
  return res;
}

/** Every distinct item: ours' items, then theirs' that ours does not have. */
export function unique(ours: YNode[], theirs: YNode[]): YNode[] {
  const seen = new Set<string>();
  const res: YNode[] = [];
  for (const n of [...ours, ...theirs]) {
    if (seen.has(key(n))) continue;
    seen.add(key(n));
    res.push(n);
  }
  return res;
}

/** Position by position: the side that changed a position wins, theirs where both changed it; a shortened list drops its tail. */
export function positions(base: YNode[], ours: YNode[], theirs: YNode[]): YNode[] {
  const res: YNode[] = [];
  const n = Math.max(base.length, ours.length, theirs.length);
  for (let i = 0; i < n; i++) {
    const b = base[i];
    const o = ours[i];
    const t = theirs[i];
    const v = same(o, t) ? o : same(b, o) ? t : same(b, t) ? o : t;
    if (v) res.push(v);
  }
  return res;
}
