/**
 * Unity serialized YAML (scenes, prefabs, assets): a `%YAML`/`%TAG` preamble, then documents
 * `--- !u!<classId> &<fileID>[ stripped]`, each one mapping `TypeName:` written in Unity's fixed block style
 * (2-space indents, list items at the indent of their key, `{x: 0, y: 1}` inline mappings).
 *
 * Not a general YAML parser: it keeps exactly what the emitter needs to write the same text back (scalars stay raw,
 * multi-line ones included), so a merge only changes the lines of what it merged. Round trip is tested on real files.
 */

export type YNode = YScalar | YMap | YSeq;

/** Raw text after `key:` or `-` (the separating space included), continuation lines of a multi-line scalar joined by \n. */
export interface YScalar {
  k: "s";
  raw: string;
}

export interface YMap {
  k: "m";
  e: [string, YNode][];
  /** written inline: {x: 0, y: 1} */
  flow?: boolean;
  /** the key line ends with a space ("key: ") */
  sp?: boolean;
}

/** Block sequence; empty ones are written `key: []`. */
export interface YSeq {
  k: "q";
  items: YNode[];
  sp?: boolean;
}

export interface UnityDoc {
  classId: string;
  fileId: string;
  /** rest of the header line after the anchor, e.g. " stripped" */
  tail: string;
  type: string;
  body: YNode;
  /** blank lines after the document (not written by Unity, kept for an exact round trip) */
  trail?: number;
}

export interface UnityFile {
  preamble: string[];
  docs: UnityDoc[];
  eol: "\n" | "\r\n";
  finalNewline: boolean;
}

export class UnityYamlError extends Error {}

const HEADER = /^--- !u!(-?\d+) &(-?\d+)(.*)$/;
/** `key: value` / `key:` — a plain key never starts with a YAML indicator and holds no quote; quoted keys stay quoted */
const KEY = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s:{}[\]'"!&*#|>%@`,-][^:'"]*?):( .*)?$/;

interface Cursor {
  a: string[];
  i: number;
  /** line number of a[0] in the file, for errors */
  off: number;
}

const lead = (s: string): number => s.length - s.trimStart().length;
const blank = (s: string | undefined): boolean => s !== undefined && s.trim() === "";
const isItem = (s: string, ind: number): boolean => lead(s) === ind && s[ind] === "-" && (s.length === ind + 1 || s[ind + 1] === " ");

function fail(c: Cursor, msg: string): never {
  throw new UnityYamlError(`line ${c.off + c.i + 1}: ${msg}`);
}

export function parseUnityYaml(text: string): UnityFile {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = /\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop();
  const preamble: string[] = [];
  let i = 0;
  while (i < lines.length && !lines[i]!.startsWith("--- ")) preamble.push(lines[i++]!);
  if (i === lines.length || !preamble.some((l) => l.startsWith("%YAML"))) throw new UnityYamlError("not a Unity YAML file");
  const docs: UnityDoc[] = [];
  while (i < lines.length) {
    const m = HEADER.exec(lines[i]!);
    if (!m) throw new UnityYamlError(`line ${i + 1}: expected a document header, got "${lines[i]!.slice(0, 60)}"`);
    const start = ++i;
    while (i < lines.length && !lines[i]!.startsWith("--- ")) i++;
    docs.push(parseDoc(m, lines.slice(start, i), start));
  }
  return { preamble, docs, eol, finalNewline };
}

function parseDoc(m: RegExpExecArray, body: string[], off: number): UnityDoc {
  const c: Cursor = { a: body, i: 0, off };
  const root = parseMap(c, 0);
  let trail = 0;
  while (c.i < body.length && blank(body[c.i])) {
    trail++;
    c.i++;
  }
  if (c.i < body.length) fail(c, `unexpected "${body[c.i]!.trim().slice(0, 60)}"`);
  const entry = root.e[0];
  if (root.e.length !== 1 || !entry) fail(c, "a document holds one object");
  const doc: UnityDoc = { classId: m[1]!, fileId: m[2]!, tail: m[3]!, type: entry[0], body: entry[1] };
  if (trail) doc.trail = trail;
  return doc;
}

function parseMap(c: Cursor, indent: number): YMap {
  const e: [string, YNode][] = [];
  while (c.i < c.a.length) {
    const line = c.a[c.i]!;
    if (blank(line) || lead(line) !== indent || line[indent] === "-") break;
    const km = KEY.exec(line.slice(indent));
    if (!km) fail(c, `expected "key:", got "${line.trim().slice(0, 60)}"`);
    c.i++;
    e.push([km[1]!, parseValue(c, indent, km[2])]);
  }
  return { k: "m", e };
}

/** Value of `key:` at `indent`; `rest` is what follows the colon (undefined: nothing, not even a space). */
function parseValue(c: Cursor, indent: number, rest: string | undefined): YNode {
  if (rest === undefined || rest === " ") {
    const next = c.a[c.i];
    if (next !== undefined && !blank(next)) {
      const ni = lead(next);
      const sp = rest === " " ? { sp: true as const } : {};
      if (ni === indent && isItem(next, indent)) return { ...parseSeq(c, indent), ...sp };
      if (ni > indent) {
        if (isItem(next, ni)) return { ...parseSeq(c, ni), ...sp };
        if (KEY.test(next.slice(ni))) return { ...parseMap(c, ni), ...sp };
      }
    }
  }
  const raw = rest ?? "";
  if (raw === " []") return { k: "q", items: [] };
  return scalar(c, indent, raw);
}

/** Does `text` (from `from` on) close a scalar quoted with `q`? '' and \" are escapes. */
function closesQuote(text: string, q: string, from: number): boolean {
  for (let i = from; i < text.length; i++) {
    if (q === '"' && text[i] === "\\") i++;
    else if (text[i] === q) {
      if (q === "'" && text[i + 1] === "'") i++;
      else return true;
    }
  }
  return false;
}

/**
 * A scalar and its continuation lines: anything indented deeper than its key, blank lines inside included.
 * A quoted one runs to its closing quote whatever the indentation (Unity puts a lone `'` at column 0).
 */
function scalar(c: Cursor, indent: number, first: string): YNode {
  let raw = first;
  const t = first.trimStart();
  const q = t[0];
  if ((q === "'" || q === '"') && !closesQuote(t, q, 1)) {
    while (c.i < c.a.length) {
      const line = c.a[c.i++]!;
      raw += "\n" + line;
      if (closesQuote(line, q, 0)) break;
    }
    return { k: "s", raw };
  }
  while (c.i < c.a.length) {
    const line = c.a[c.i]!;
    if (blank(line)) {
      let j = c.i;
      while (j < c.a.length && blank(c.a[j])) j++;
      if (j >= c.a.length || lead(c.a[j]!) <= indent) break;
      raw += "\n" + c.a.slice(c.i, j).join("\n");
      c.i = j;
      continue;
    }
    if (lead(line) <= indent) break;
    raw += "\n" + line;
    c.i++;
  }
  return raw.includes("\n") ? { k: "s", raw } : flowMap(raw) ?? { k: "s", raw };
}

/**
 * `{x: 0, y: 1}` → a mapping, so a merge can take x from one branch and y from the other. References
 * (`{fileID: …, guid: …}`) stay one value: half of a reference is meaningless.
 */
function flowMap(raw: string): YMap | null {
  const t = raw.startsWith(" ") ? raw.slice(1) : raw;
  if (!t.startsWith("{") || !t.endsWith("}") || raw !== " " + t) return null;
  const inner = t.slice(1, -1);
  if (/[{}[\]'"]/.test(inner) || /\bfileID:/.test(inner)) return null;
  if (!inner) return { k: "m", e: [], flow: true };
  const e: [string, YNode][] = [];
  for (const part of inner.split(", ")) {
    const colon = part.indexOf(": ");
    if (colon <= 0 || part.slice(0, colon).includes(":")) return null;
    e.push([part.slice(0, colon), { k: "s", raw: part.slice(colon + 1) }]);
  }
  return { k: "m", e, flow: true };
}

function parseSeq(c: Cursor, ind: number): YSeq {
  const items: YNode[] = [];
  while (c.i < c.a.length) {
    const line = c.a[c.i]!;
    if (blank(line) || !isItem(line, ind)) break;
    const after = line.slice(ind + 2);
    if (KEY.test(after)) {
      // "- key: value" opens a mapping whose entries continue at ind + 2: parse it as if the dash were spaces
      c.a[c.i] = " ".repeat(ind + 2) + after;
      items.push(parseMap(c, ind + 2));
    } else {
      c.i++;
      items.push(scalar(c, ind, line.slice(ind + 1)));
    }
  }
  return { k: "q", items };
}

// ───────────── writing ─────────────

export function emitUnityYaml(f: UnityFile): string {
  const out: string[] = [...f.preamble];
  for (const d of f.docs) {
    out.push(`--- !u!${d.classId} &${d.fileId}${d.tail}`);
    emitEntry(d.type, d.body, 0, out);
    for (let i = 0; i < (d.trail ?? 0); i++) out.push("");
  }
  return out.join(f.eol) + (f.finalNewline ? f.eol : "");
}

function pushRaw(out: string[], text: string): void {
  for (const l of text.split("\n")) out.push(l);
}

export function flowText(m: YMap): string {
  return `{${m.e.map(([k, v]) => `${k}:${v.k === "s" ? v.raw : ` ${nodeText(v)}`}`).join(", ")}}`;
}

function emitEntry(key: string, node: YNode, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (node.k === "s") {
    pushRaw(out, `${pad}${key}:${node.raw}`);
  } else if (node.k === "m" && node.flow) {
    out.push(`${pad}${key}: ${flowText(node)}`);
  } else if (node.k === "q" && !node.items.length) {
    out.push(`${pad}${key}: []`);
  } else if (node.k === "q") {
    out.push(`${pad}${key}:${node.sp ? " " : ""}`);
    emitItems(node, indent, out);
  } else {
    out.push(`${pad}${key}:${node.sp ? " " : ""}`);
    for (const [k, v] of node.e) emitEntry(k, v, indent + 2, out);
  }
}

function emitItems(q: YSeq, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  for (const it of q.items) {
    if (it.k === "s") pushRaw(out, `${pad}-${it.raw}`);
    else if (it.k === "m" && it.flow) out.push(`${pad}- ${flowText(it)}`);
    else if (it.k === "m" && it.e.length) {
      const start = out.length;
      for (const [k, v] of it.e) emitEntry(k, v, indent + 2, out);
      out[start] = `${pad}- ${out[start]!.slice(indent + 2)}`;
    } else out.push(`${pad}- ${nodeText(it)}`);
  }
}

// ───────────── reading values ─────────────

/** Deep equality; scalars compare by their raw text. */
export function same(a: YNode | undefined, b: YNode | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.k !== b.k) return false;
  if (a.k === "s") return a.raw === (b as YScalar).raw;
  if (a.k === "m") {
    const bm = b as YMap;
    if (!!a.flow !== !!bm.flow || a.e.length !== bm.e.length) return false;
    return a.e.every(([k, v], i) => bm.e[i]![0] === k && same(v, bm.e[i]![1]));
  }
  const bq = b as YSeq;
  return a.items.length === bq.items.length && a.items.every((v, i) => same(v, bq.items[i]));
}

const MAX_TEXT = 240;

/** One-line display text of a value. */
export function nodeText(n: YNode | undefined): string {
  if (!n) return "";
  let t: string;
  if (n.k === "s") t = n.raw.split("\n").map((l) => l.trim()).join(" ");
  else if (n.k === "m" && n.flow) t = flowText(n);
  else if (n.k === "m") t = `{${n.e.map(([k, v]) => `${k}: ${nodeText(v)}`).join(", ")}}`;
  else t = `[${n.items.map(nodeText).join(", ")}]`;
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}… (${t.length} chars)` : t;
}

export function get(n: YNode | undefined, key: string): YNode | undefined {
  return n?.k === "m" ? n.e.find(([k]) => k === key)?.[1] : undefined;
}

/** Text of a scalar field ("" when absent). */
export function str(n: YNode | undefined, key: string): string {
  const v = get(n, key);
  return v?.k === "s" ? v.raw.trim() : "";
}

/** fileID of a reference field `{fileID: 123, …}`, "0" when absent. */
export function refId(n: YNode | undefined, key: string): string {
  return /fileID: (-?\d+)/.exec(str(n, key))?.[1] ?? "0";
}
