/**
 * Line-based syntax highlighting for the diff viewer. Small on purpose: comments, strings, numbers and
 * keywords for the languages a Unity/TypeScript shop meets daily. Each line is tokenized on its own, so a
 * block comment that spans lines is only recognised on the line where it starts or ends.
 */

export type Lang = "cs" | "ts" | "json" | "yaml" | "py" | "c" | "sh" | "css" | "xml" | "md" | "text";

const EXT: Record<string, Lang> = {
  cs: "cs",
  js: "ts",
  jsx: "ts",
  ts: "ts",
  tsx: "ts",
  mjs: "ts",
  cjs: "ts",
  json: "json",
  asmdef: "json",
  yaml: "yaml",
  yml: "yaml",
  unity: "yaml",
  prefab: "yaml",
  asset: "yaml",
  mat: "yaml",
  meta: "yaml",
  controller: "yaml",
  anim: "yaml",
  py: "py",
  c: "c",
  h: "c",
  cpp: "c",
  hpp: "c",
  cc: "c",
  java: "c",
  kt: "c",
  go: "c",
  rs: "c",
  shader: "c",
  hlsl: "c",
  cginc: "c",
  compute: "c",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  ps1: "sh",
  css: "css",
  scss: "css",
  html: "xml",
  xml: "xml",
  svg: "xml",
  uxml: "xml",
  uss: "css",
  md: "md",
};

export function langForPath(path: string): Lang {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = m ? m[1]!.toLowerCase() : "";
  if (ext) return EXT[ext] ?? "text";
  const base = path.split("/").pop() ?? "";
  if (/^(Makefile|Dockerfile)$/.test(base)) return "sh";
  return "text";
}

const KW: Record<Lang, Set<string>> = {
  cs: new Set(
    "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await yield get set value where partial record init nameof dynamic".split(
      " ",
    ),
  ),
  ts: new Set(
    "abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface is keyof let module namespace never new null number of package private protected public readonly return set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield".split(
      " ",
    ),
  ),
  json: new Set(["true", "false", "null"]),
  yaml: new Set(["true", "false", "null", "yes", "no", "on", "off"]),
  py: new Set(
    "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self print".split(
      " ",
    ),
  ),
  c: new Set(
    "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace new delete this template typename public private protected virtual override using bool true false nullptr try catch throw fn let mut impl pub match fun val var func package import go defer interface map range Shader SubShader Pass Properties CGPROGRAM ENDCG HLSLPROGRAM ENDHLSL uniform sampler2D float2 float3 float4 half fixed".split(
      " ",
    ),
  ),
  sh: new Set("if then else elif fi for while do done case esac in function return exit export local echo set param foreach".split(" ")),
  css: new Set([]),
  xml: new Set([]),
  md: new Set([]),
  text: new Set([]),
};

export interface Token {
  /** k = keyword, s = string, n = number, c = comment, p = plain */
  t: "k" | "s" | "n" | "c" | "p";
  text: string;
}

const NUMBER = /^-?(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)[fFdDuUlL]*\b/;
const WORD = /^[A-Za-z_$][A-Za-z0-9_$]*/;

export function tokenize(line: string, lang: Lang): Token[] {
  if (lang === "text" || lang === "md" || !line) return [{ t: "p", text: line }];
  const out: Token[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push({ t: "p", text: plain });
      plain = "";
    }
  };
  const lineComment = lang === "py" || lang === "sh" || lang === "yaml" ? "#" : lang === "json" || lang === "css" || lang === "xml" ? "" : "//";
  const kw = KW[lang];

  while (i < line.length) {
    const ch = line[i]!;
    const rest = line.slice(i);

    // comments
    if (lineComment && rest.startsWith(lineComment) && !(lang === "yaml" && i > 0 && line[i - 1] !== " ")) {
      flush();
      out.push({ t: "c", text: rest });
      return out;
    }
    if (lang !== "py" && lang !== "sh" && lang !== "yaml" && rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      flush();
      const text = end >= 0 ? rest.slice(0, end + 2) : rest;
      out.push({ t: "c", text });
      i += text.length;
      continue;
    }
    if (lang === "xml" && rest.startsWith("<!--")) {
      const end = rest.indexOf("-->", 4);
      flush();
      const text = end >= 0 ? rest.slice(0, end + 3) : rest;
      out.push({ t: "c", text });
      i += text.length;
      continue;
    }
    if (lang === "c" && i === 0 && ch === "#") {
      out.push({ t: "k", text: line });
      return out;
    }

    // strings
    if (ch === '"' || ch === "'" || (ch === "`" && lang === "ts")) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      flush();
      out.push({ t: "s", text: line.slice(i, Math.min(j + 1, line.length)) });
      i = j + 1;
      continue;
    }

    // yaml: key at the start of the line
    if (lang === "yaml" && plain.trim() === "" && out.length === 0) {
      const m = /^(\s*-?\s*)([A-Za-z0-9_.\-]+)(\s*:)(\s|$)/.exec(rest);
      if (m) {
        flush();
        if (m[1]) out.push({ t: "p", text: m[1] });
        out.push({ t: "k", text: m[2]! });
        out.push({ t: "p", text: m[3]! });
        i += m[1]!.length + m[2]!.length + m[3]!.length;
        continue;
      }
    }

    // numbers
    const num = NUMBER.exec(rest);
    if (num && (i === 0 || !/[A-Za-z0-9_]/.test(line[i - 1]!))) {
      flush();
      out.push({ t: "n", text: num[0] });
      i += num[0].length;
      continue;
    }

    // words / keywords
    const w = WORD.exec(rest);
    if (w) {
      if (kw.has(w[0])) {
        flush();
        out.push({ t: "k", text: w[0] });
      } else if (lang === "json" && /^\s*:/.test(rest.slice(w[0].length)) === false && plain.endsWith('"')) {
        plain += w[0];
      } else {
        plain += w[0];
      }
      i += w[0].length;
      continue;
    }

    plain += ch;
    i++;
  }
  flush();
  return out;
}
