import { describe, expect, it } from "vitest";
import type { FileChange } from "@epic-git/shared";
import { groupByPrefix, groupFiles, parseDecorations, repoNameFromUrl } from "./format.js";

const ch = (path: string): FileChange => ({ path, kind: "M", area: "unstaged" });

describe("groupFiles", () => {
  it("collapses single-child directory chains and keeps root files first", () => {
    const g = groupFiles([ch("Assets/dev/Scripts/A/x.cs"), ch("Assets/dev/Scripts/B/y.cs"), ch("README.md"), ch("Assets/Prefabs/p.prefab")]);
    expect(g.map((x) => x.dir)).toEqual(["", "Assets"]);
    // directories sort case-insensitively (locale compare): dev before Prefabs
    expect(g[1]?.files.map((f) => f.rel)).toEqual(["dev/Scripts/A/x.cs", "dev/Scripts/B/y.cs", "Prefabs/p.prefab"]);
  });

  it("collapses deep chains fully", () => {
    const g = groupFiles([ch("a/b/c/d.txt"), ch("a/b/c/e.txt")]);
    expect(g).toHaveLength(1);
    expect(g[0]?.dir).toBe("a/b/c");
    expect(g[0]?.files.map((f) => f.rel)).toEqual(["d.txt", "e.txt"]);
  });
});

describe("groupByPrefix", () => {
  it("groups by first path segment, singletons stay plain", () => {
    const r = groupByPrefix(["master", "feature/a", "feature/b", "fix/only", "rc-1.1"]);
    expect(r.groups).toEqual([{ prefix: "feature", names: ["feature/a", "feature/b"] }]);
    expect(r.plain).toEqual(["fix/only", "master", "rc-1.1"]);
  });
});

describe("parseDecorations", () => {
  it("splits HEAD, branches, remotes and tags", () => {
    const d = parseDecorations(["HEAD -> master", "origin/master", "tag: v1.0"]);
    expect(d.head).toBe(true);
    expect(d.names).toEqual([
      { name: "master", kind: "local" },
      { name: "origin/master", kind: "remote" },
      { name: "v1.0", kind: "tag" },
    ]);
  });
});

describe("repoNameFromUrl", () => {
  it("handles ssh and https", () => {
    expect(repoNameFromUrl("git@gitlab.example.net:clm/tools.git")).toBe("tools");
    expect(repoNameFromUrl("https://github.com/org/repo")).toBe("repo");
    expect(repoNameFromUrl("https://github.com/org/repo.git/")).toBe("repo");
  });
});
