import { describe, expect, it } from "vitest";
import { parseNameStatus, parseStatus } from "./status.js";
import { diffForNewFile, parseUnifiedDiff } from "./diff.js";
import { parseLog, parseRefs, parseStashes, parseSubmodules } from "./log.js";
import { progressStep } from "../jobs.js";
import { isRelevant } from "../watcher.js";

const NUL = "\0";

describe("parseStatus (porcelain v2 -z)", () => {
  it("reads branch headers and entries", () => {
    const raw = [
      "# branch.oid 1234567",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -5",
      "1 .M N... 100644 100644 100644 abc def src/a.cs",
      "1 A. N... 000000 100644 100644 000 def src/new.cs",
      "1 MM N... 100644 100644 100644 abc def both.txt",
      "2 R. N... 100644 100644 100644 abc abc R100 new name.txt",
      "old name.txt",
      "u UU N... 100644 100644 100644 100644 a b c conflict.prefab",
      "? untracked/file.txt",
    ].join(NUL);
    const s = parseStatus(raw, 1);
    expect(s.branch).toBe("feature/x");
    expect(s.head).toBe("1234567");
    expect(s.upstream).toBe("origin/feature/x");
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(5);
    expect(s.unstaged.map((f) => `${f.kind}:${f.path}`)).toEqual(["M:src/a.cs", "M:both.txt", "?:untracked/file.txt"]);
    expect(s.staged.map((f) => `${f.kind}:${f.path}`)).toEqual(["A:src/new.cs", "M:both.txt", "R:new name.txt"]);
    expect(s.staged[2]?.oldPath).toBe("old name.txt");
    expect(s.conflicts).toEqual([{ path: "conflict.prefab", kind: "U", area: "conflict" }]);
  });

  it("handles detached and unborn", () => {
    const s = parseStatus(["# branch.oid (initial)", "# branch.head (detached)"].join(NUL));
    expect(s.head).toBeNull();
    expect(s.branch).toBeNull();
    expect(s.unstaged).toEqual([]);
  });
});

describe("parseNameStatus", () => {
  it("reads renames with two paths", () => {
    const files = parseNameStatus(["M", "a.txt", "R090", "old.txt", "new.txt", "A", "x/y.cs", ""].join(NUL));
    expect(files).toEqual([
      { path: "a.txt", kind: "M", area: "staged" },
      { path: "new.txt", oldPath: "old.txt", kind: "R", area: "staged" },
      { path: "x/y.cs", kind: "A", area: "staged" },
    ]);
  });
});

describe("parseUnifiedDiff", () => {
  it("numbers lines and keeps hunks", () => {
    const raw = [
      "diff --git a/a.txt b/a.txt",
      "index 1..2 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+2",
      " three",
      "+four",
      "\\ No newline at end of file",
    ].join("\n");
    const d = parseUnifiedDiff(raw, "a.txt");
    expect(d.binary).toBe(false);
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks[0]!;
    expect(h.oldStart).toBe(1);
    expect(h.newLines).toBe(4);
    expect(h.lines).toEqual([
      { t: "ctx", o: 1, n: 1, text: "one" },
      { t: "del", o: 2, text: "two" },
      { t: "add", n: 2, text: "2" },
      { t: "ctx", o: 3, n: 3, text: "three" },
      { t: "add", n: 4, text: "four", noNewline: true },
    ]);
  });

  it("detects binary and renames", () => {
    const d = parseUnifiedDiff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n", "x.png");
    expect(d.binary).toBe(true);
    const r = parseUnifiedDiff("diff --git a/o.txt b/n.txt\nsimilarity index 100%\nrename from o.txt\nrename to n.txt\n", "n.txt");
    expect(r.oldPath).toBe("o.txt");
    expect(r.hunks).toEqual([]);
  });

  it("builds a diff for a new file", () => {
    const d = diffForNewFile("n.txt", "a\nb\n");
    expect(d.hunks[0]?.lines.map((l) => l.text)).toEqual(["a", "b"]);
    expect(d.hunks[0]?.newLines).toBe(2);
  });
});

describe("parseLog / parseRefs", () => {
  it("parses records", () => {
    const rec = ["abcdef1234567", "p1 p2", "Ann", "ann@x.y", "1700000000", "subject", "body\nmore\n", "HEAD -> master, origin/master, tag: v1"].join(NUL) + "\x1e\n";
    const c = parseLog(rec + rec);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ sha: "abcdef1234567", shortSha: "abcdef1", parents: ["p1", "p2"], author: "Ann", date: 1700000000, subject: "subject", body: "body\nmore" });
    expect(c[0]?.refs).toEqual(["HEAD -> master", "origin/master", "tag: v1"]);
  });

  it("parses refs with tracking", () => {
    const raw = [
      ["refs/heads/master", "aaa", "origin/master", "[ahead 1, behind 106]", "*"].join(NUL),
      ["refs/heads/feature/x", "bbb", "origin/feature/x", "[gone]", ""].join(NUL),
      ["refs/heads/local", "ccc", "", "", ""].join(NUL),
      ["refs/remotes/origin/HEAD", "aaa", "", "", ""].join(NUL),
      ["refs/remotes/origin/master", "aaa", "", "", ""].join(NUL),
      ["refs/tags/v1", "ddd", "", "", ""].join(NUL),
    ].join("\n");
    const r = parseRefs(raw, 1);
    expect(r.branches).toHaveLength(3);
    expect(r.branches[0]).toMatchObject({ name: "master", current: true, ahead: 1, behind: 106, upstream: "origin/master" });
    expect(r.branches[1]?.gone).toBe(true);
    expect(r.branches[2]?.upstream).toBeUndefined();
    expect(r.remoteBranches.map((b) => b.name)).toEqual(["origin/master"]);
    expect(r.tags).toEqual([{ name: "v1", sha: "ddd" }]);
  });

  it("parses stashes and submodules", () => {
    expect(parseStashes(`stash@{0}${NUL}On master: test logs\nstash@{1}${NUL}WIP`)).toEqual([
      { index: 0, ref: "stash@{0}", message: "On master: test logs" },
      { index: 1, ref: "stash@{1}", message: "WIP" },
    ]);
    expect(parseSubmodules("submodule.libs.path libs/shared\nsubmodule.x.path tools/x\n")).toEqual(["libs/shared", "tools/x"]);
  });
});

describe("helpers", () => {
  it("progressStep picks git progress lines", () => {
    expect(progressStep("remote: Counting objects: 12% (1/8)\r")).toBe("Counting objects 12%");
    expect(progressStep("Receiving objects:  42% (100/238), 1.2 MiB | 1.1 MiB/s\r")).toBe("Receiving objects 42%");
    expect(progressStep("warning: something")).toBeUndefined();
  });

  it("isRelevant filters .git noise", () => {
    expect(isRelevant("src/a.cs")).toBe(true);
    expect(isRelevant(".git/index")).toBe(true);
    expect(isRelevant(".git\\refs\\heads\\master")).toBe(true);
    expect(isRelevant(".git/objects/ab/cdef")).toBe(false);
    expect(isRelevant(".git/index.lock")).toBe(false);
    expect(isRelevant(".git/logs/HEAD")).toBe(false);
    expect(isRelevant("Library/Artifacts/ab/cd")).toBe(false);
    expect(isRelevant("Temp\\UnityLockfile")).toBe(false);
    expect(isRelevant("Assets/Library/x.cs")).toBe(true);
    expect(isRelevant("LibraryUtils/a.cs")).toBe(true);
  });
});
