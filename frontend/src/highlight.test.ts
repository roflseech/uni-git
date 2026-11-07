import { describe, expect, it } from "vitest";
import { langForPath, tokenize } from "./highlight.js";

const kinds = (line: string, lang: Parameters<typeof tokenize>[1]) => tokenize(line, lang).map((t) => `${t.t}:${t.text}`);

describe("highlight", () => {
  it("maps extensions", () => {
    expect(langForPath("Assets/Scripts/A.cs")).toBe("cs");
    expect(langForPath("x.prefab")).toBe("yaml");
    expect(langForPath("a/b.tsx")).toBe("ts");
    expect(langForPath("README")).toBe("text");
  });

  it("tokenizes C#", () => {
    expect(kinds('public static string Name = "x"; // hi', "cs")).toEqual(["k:public", "p: ", "k:static", "p: ", "k:string", "p: Name = ", 's:"x"', "p:; ", "c:// hi"]);
    expect(kinds("var n = 0.5f + 0x1F;", "cs")).toEqual(["k:var", "p: n = ", "n:0.5f", "p: + ", "n:0x1F", "p:;"]);
  });

  it("tokenizes yaml keys and comments", () => {
    expect(kinds("  m_Name: Player # comment", "yaml")).toEqual(["p:  ", "k:m_Name", "p::", "p: Player ", "c:# comment"]);
    expect(kinds("- _value: 1.5", "yaml")).toEqual(["p:- ", "k:_value", "p::", "p: ", "n:1.5"]);
  });

  it("keeps plain text untouched", () => {
    expect(kinds("hello world", "text")).toEqual(["p:hello world"]);
    expect(tokenize("", "cs")).toEqual([{ t: "p", text: "" }]);
  });
});
