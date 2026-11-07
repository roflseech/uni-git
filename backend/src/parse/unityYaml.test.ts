import { describe, expect, it } from "vitest";
import { emitUnityYaml, nodeText, parseUnityYaml, type UnityFile } from "./unityYaml.js";
import { combine, diffUnity, mergeUnity, positions, unique, UnityNames } from "./unityMerge.js";

const PREFAB = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  m_Component:
  - component: {fileID: 400}
  m_Layer: 0
  m_Name: Root
  m_TagString:
  m_IsActive: 1
--- !u!4 &400
Transform:
  m_GameObject: {fileID: 100}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_Children:
  - {fileID: 401}
  m_Father: {fileID: 0}
--- !u!1 &101
GameObject:
  m_Component:
  - component: {fileID: 401}
  - component: {fileID: 11400}
  m_Name: Child
--- !u!4 &401
Transform:
  m_GameObject: {fileID: 101}
  m_LocalPosition: {x: 1, y: 2, z: 3}
  m_Children: []
  m_Father: {fileID: 400}
--- !u!114 &11400
MonoBehaviour:
  m_GameObject: {fileID: 101}
  m_Script: {fileID: 11500000, guid: 0123456789abcdef0123456789abcdef, type: 3}
  m_Text: 'Hello

    world

'
  items:
  - id: 1
    tags:
    - a
    - b
  - id: 2
    tags: []
  values:
  - 1
  - 2
  - 3
--- !u!1001 &5000
PrefabInstance:
  m_ObjectHideFlags: 0
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 400}
    m_Modifications:
    - target: {fileID: 7, guid: aaaa0000aaaa0000aaaa0000aaaa0000, type: 3}
      propertyPath: m_Name
      value: Door
      objectReference: {fileID: 0}
    - target: {fileID: 7, guid: aaaa0000aaaa0000aaaa0000aaaa0000, type: 3}
      propertyPath: m_LocalPosition.x
      value: 5
      objectReference: {fileID: 0}
    m_RemovedComponents: []
  m_SourcePrefab: {fileID: 100100000, guid: aaaa0000aaaa0000aaaa0000aaaa0000, type: 3}
--- !u!4 &6000 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: 7, guid: aaaa0000aaaa0000aaaa0000aaaa0000, type: 3}
  m_PrefabInstance: {fileID: 5000}
  m_PrefabAsset: {fileID: 0}
`;

/** Text of the prefab with every [from, to] replaced once (each `from` must exist). */
function edit(...pairs: [string, string][]): string {
  let t = PREFAB;
  for (const [a, b] of pairs) {
    expect(t.includes(a), a).toBe(true);
    t = t.replace(a, b);
  }
  return t;
}

const parse = (t: string): UnityFile => parseUnityYaml(t);

describe("Unity YAML parse / emit", () => {
  it("writes back the exact text, CRLF too", () => {
    expect(emitUnityYaml(parse(PREFAB))).toBe(PREFAB);
    const crlf = PREFAB.replace(/\n/g, "\r\n");
    expect(emitUnityYaml(parse(crlf))).toBe(crlf);
  });

  it("reads documents, flow mappings, lists and quoted multi-line scalars", () => {
    const f = parse(PREFAB);
    expect(f.docs.map((d) => `${d.classId}&${d.fileId}${d.tail}`)).toEqual(["1&100", "4&400", "1&101", "4&401", "114&11400", "1001&5000", "4&6000 stripped"]);
    const t = f.docs[1]!.body;
    expect(t.k === "m" && t.e.map(([k]) => k)).toEqual(["m_GameObject", "m_LocalPosition", "m_Children", "m_Father"]);
    const pos = t.k === "m" ? t.e[1]![1] : undefined;
    expect(pos?.k === "m" && pos.flow && pos.e.map(([k]) => k)).toEqual(["x", "y", "z"]);
    const mb = f.docs[4]!.body;
    const text = mb.k === "m" ? mb.e.find(([k]) => k === "m_Text")?.[1] : undefined;
    expect(nodeText(text)).toBe("'Hello  world  '");
  });

  it("rejects text that is not Unity YAML", () => {
    expect(() => parse("hello: 1\n")).toThrow(/not a Unity YAML/);
  });
});

describe("Unity diff", () => {
  it("names objects by hierarchy path and lists property changes", () => {
    const a = parse(PREFAB);
    const b = parse(edit(["m_LocalPosition: {x: 1, y: 2, z: 3}", "m_LocalPosition: {x: 1.5, y: 2, z: 3}"], ["  - 3\n", "  - 3\n  - 4\n"], ["value: Door", "value: Gate"]));
    const names = new UnityNames([b, a]);
    names.scripts.set("0123456789abcdef0123456789abcdef", "Spawner");
    const d = diffUnity(a, b, names);
    expect(d.map((o) => `${o.state} ${o.owner} ${o.type}${o.script ? ` (${o.script})` : ""}`)).toEqual(["changed Root/Child Transform", "changed Root/Child MonoBehaviour (Spawner)", "changed Root/Gate PrefabInstance"]);
    expect(d[0]!.changes).toEqual([{ path: "m_LocalPosition.x", old: "1", new: "1.5" }]);
    expect(d[1]!.changes).toEqual([{ path: "values", added: ["4"], removed: [] }]);
    expect(d[2]!.changes).toEqual([{ path: "m_Modification.m_Modifications[m_Name]", old: "Door", new: "Gate" }]);
  });

  it("reports added and removed objects", () => {
    const a = parse(PREFAB);
    const b = parse(PREFAB.replace(/--- !u!4 &6000 stripped[\s\S]*$/, "--- !u!1 &102\nGameObject:\n  m_Name: New\n"));
    const d = diffUnity(a, b, new UnityNames([b, a]));
    expect(d.map((o) => `${o.state} ${o.type} ${o.owner}`)).toEqual(["added GameObject New", "removed Transform Root/Door"]);
  });
});

describe("Unity 3-way merge", () => {
  it("merges changes of different objects and of different fields of one value", () => {
    const base = parse(PREFAB);
    const ours = parse(edit(["m_LocalPosition: {x: 1, y: 2, z: 3}", "m_LocalPosition: {x: 9, y: 2, z: 3}"], ["m_Layer: 0", "m_Layer: 5"]));
    const theirs = parse(edit(["m_LocalPosition: {x: 1, y: 2, z: 3}", "m_LocalPosition: {x: 1, y: 7, z: 3}"], ["m_Name: Child", "m_Name: Kid"]));
    const r = mergeUnity(base, ours, theirs, new UnityNames([ours, theirs, base]));
    expect(r.open).toBe(0);
    expect(emitUnityYaml(r.file)).toBe(edit(["m_LocalPosition: {x: 1, y: 2, z: 3}", "m_LocalPosition: {x: 9, y: 7, z: 3}"], ["m_Layer: 0", "m_Layer: 5"], ["m_Name: Child", "m_Name: Kid"]));
  });

  it("asks about a value both changed, then applies the choice", () => {
    const base = parse(PREFAB);
    const ours = parse(edit(["m_Name: Root", "m_Name: Ours"]));
    const theirs = parse(edit(["m_Name: Root", "m_Name: Theirs"]));
    const names = new UnityNames([ours, theirs, base]);
    const r = mergeUnity(base, ours, theirs, names);
    expect(r.open).toBe(1);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect([c.id, c.kind, c.owner, c.type, c.base, c.ours, c.theirs]).toEqual(["100:m_Name", "value", "Ours", "GameObject", ["Root"], ["Ours"], ["Theirs"]]);
    expect(emitUnityYaml(r.file)).toBe(edit(["m_Name: Root", "m_Name: Ours"]));
    const chosen = mergeUnity(base, ours, theirs, names, { "100:m_Name": "theirs" });
    expect(chosen.open).toBe(0);
    expect(emitUnityYaml(chosen.file)).toBe(edit(["m_Name: Root", "m_Name: Theirs"]));
  });

  it("offers combine / unique / by-position for a list both changed", () => {
    const base = parse(PREFAB);
    const ours = parse(edit(["  - 2\n  - 3\n", "  - 2\n  - 3\n  - 4\n"]));
    const theirs = parse(edit(["  - 1\n  - 2\n", "  - 1\n  - 9\n"], ["  - 3\n", "  - 3\n  - 5\n"]));
    const names = new UnityNames([ours, theirs, base]);
    const r = mergeUnity(base, ours, theirs, names);
    expect(r.open).toBe(1);
    const c = r.conflicts[0]!;
    expect([c.id, c.kind, c.base, c.ours, c.theirs]).toEqual(["11400:values", "array", ["1", "2", "3"], ["1", "2", "3", "4"], ["1", "9", "3", "5"]]);
    const result = (choice: string) => c.options.find((o) => o.choice === choice)?.result;
    // theirs replaced 2 by 9 and added 5 after 3; ours added 4 at the end
    expect(result("combine")).toEqual(["1", "9", "3", "5", "4"]);
    expect(result("unique")).toEqual(["1", "2", "3", "4", "9", "5"]);
    expect(result("positions")).toEqual(["1", "9", "3", "5"]);
    const chosen = mergeUnity(base, ours, theirs, names, { "11400:values": "unique" });
    expect(chosen.open).toBe(0);
    expect(emitUnityYaml(chosen.file)).toContain("  values:\n  - 1\n  - 2\n  - 3\n  - 4\n  - 9\n  - 5\n--- !u!1001");
  });

  it("merges list items that changed at different positions, mappings inside them too", () => {
    const base = parse(PREFAB);
    const ours = parse(edit(["  - id: 1", "  - id: 10"]));
    const theirs = parse(edit(["    tags: []", "    tags:\n    - c"]));
    const r = mergeUnity(base, ours, theirs, new UnityNames([ours, theirs, base]));
    expect(r.open).toBe(0);
    expect(emitUnityYaml(r.file)).toBe(edit(["  - id: 1", "  - id: 10"], ["    tags: []", "    tags:\n    - c"]));
  });

  it("matches prefab modifications by target and property path", () => {
    const base = parse(PREFAB);
    const added = "    - target: {fileID: 8, guid: aaaa0000aaaa0000aaaa0000aaaa0000, type: 3}\n      propertyPath: m_IsActive\n      value: 0\n      objectReference: {fileID: 0}\n";
    const ours = parse(edit(["value: 5", "value: 6"]));
    const theirs = parse(edit(["    m_RemovedComponents: []", added + "    m_RemovedComponents: []"], ["value: Door", "value: Gate"]));
    const r = mergeUnity(base, ours, theirs, new UnityNames([ours, theirs, base]));
    expect(r.open).toBe(0);
    expect(emitUnityYaml(r.file)).toBe(edit(["value: 5", "value: 6"], ["    m_RemovedComponents: []", added + "    m_RemovedComponents: []"], ["value: Door", "value: Gate"]));
    const both = parse(edit(["value: 5", "value: 7"]));
    const c = mergeUnity(base, ours, both, new UnityNames([ours, both, base]));
    expect(c.conflicts.map((x) => [x.id, x.ours, x.theirs])).toEqual([["5000:m_Modification.m_Modifications[m_LocalPosition.x].value", ["6"], ["7"]]]);
  });

  it("asks about an object deleted on one side and changed on the other", () => {
    const base = parse(PREFAB);
    const ours = parse(edit(["m_LocalPosition: {x: 0, y: 0, z: 0}", "m_LocalPosition: {x: 3, y: 0, z: 0}"]));
    const theirs = parse(PREFAB.replace(/--- !u!4 &400\n[\s\S]*?(?=--- !u!1 &101)/, ""));
    const names = new UnityNames([ours, theirs, base]);
    const r = mergeUnity(base, ours, theirs, names);
    expect(r.conflicts.map((c) => [c.id, c.kind, c.ours, c.theirs])).toEqual([["400:", "object", ["Transform changed"], ["Transform deleted"]]]);
    expect(emitUnityYaml(mergeUnity(base, ours, theirs, names, { "400:": "delete" }).file)).not.toContain("&400\n");
    expect(emitUnityYaml(mergeUnity(base, ours, theirs, names, { "400:": "keep" }).file)).toContain("m_LocalPosition: {x: 3, y: 0, z: 0}");
  });

  it("list helpers", () => {
    const s = (...v: string[]) => v.map((x) => ({ k: "s" as const, raw: ` ${x}` }));
    const t = (list: { raw: string }[]) => list.map((x) => x.raw.trim());
    expect(t(combine(s("a", "b", "c"), s("a", "c", "d"), s("b", "c", "e")) as { raw: string }[])).toEqual(["c", "e", "d"]);
    expect(t(unique(s("a", "b"), s("b", "c", "a")) as { raw: string }[])).toEqual(["a", "b", "c"]);
    expect(t(positions(s("a", "b", "c"), s("x", "b"), s("a", "y", "c", "z")) as { raw: string }[])).toEqual(["x", "y", "z"]);
  });
});
