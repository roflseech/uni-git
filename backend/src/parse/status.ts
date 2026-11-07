import type { ChangeKind, FileChange, RepoStatus } from "@uni-git/shared";

/**
 * Parses `git status --porcelain=v2 --branch -z --untracked-files=all` output.
 * Operation state (merge/cherry-pick) is detected separately from .git files.
 */
export function parseStatus(raw: string, at: number = Date.now()): RepoStatus {
  const status: RepoStatus = {
    branch: null,
    head: null,
    ahead: 0,
    behind: 0,
    operation: "none",
    unstaged: [],
    staged: [],
    conflicts: [],
    at,
  };

  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;

    if (entry.startsWith("# ")) {
      parseHeader(entry, status);
      continue;
    }

    const type = entry[0];
    if (type === "?") {
      status.unstaged.push({ path: entry.slice(2), kind: "?", area: "unstaged" });
      continue;
    }
    if (type === "!") continue; // ignored files are never requested

    if (type === "1" || type === "2") {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const parts = entry.split(" ");
      const xy = parts[1] ?? "..";
      const fixedFields = type === "1" ? 8 : 9;
      const path = parts.slice(fixedFields).join(" ");
      let oldPath: string | undefined;
      if (type === "2") {
        i++;
        oldPath = tokens[i];
      }
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== ".") {
        const c: FileChange = { path, kind: toKind(x), area: "staged" };
        if (oldPath) c.oldPath = oldPath;
        status.staged.push(c);
      }
      if (y !== ".") {
        status.unstaged.push({ path, kind: toKind(y), area: "unstaged" });
      }
      continue;
    }

    if (type === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = entry.split(" ");
      const path = parts.slice(10).join(" ");
      status.conflicts.push({ path, kind: "U", area: "conflict" });
      continue;
    }
  }

  return status;
}

function parseHeader(line: string, status: RepoStatus): void {
  const body = line.slice(2);
  if (body.startsWith("branch.oid ")) {
    const v = body.slice("branch.oid ".length);
    status.head = v === "(initial)" ? null : v;
  } else if (body.startsWith("branch.head ")) {
    const v = body.slice("branch.head ".length);
    status.branch = v === "(detached)" ? null : v;
  } else if (body.startsWith("branch.upstream ")) {
    status.upstream = body.slice("branch.upstream ".length);
  } else if (body.startsWith("branch.ab ")) {
    const m = /\+(\d+) -(\d+)/.exec(body);
    if (m) {
      status.ahead = Number(m[1]);
      status.behind = Number(m[2]);
    }
  }
}

function toKind(c: string): ChangeKind {
  switch (c) {
    case "A":
    case "M":
    case "D":
    case "R":
    case "C":
    case "T":
    case "U":
      return c;
    default:
      return "M";
  }
}

/** `git diff-tree --name-status -z` / `git show --name-status -z` output. */
export function parseNameStatus(raw: string): FileChange[] {
  const tokens = raw.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code) continue;
    const kind = toKind(code[0] ?? "M");
    if (kind === "R" || kind === "C") {
      const oldPath = tokens[++i] ?? "";
      const path = tokens[++i] ?? "";
      files.push({ path, oldPath, kind, area: "staged" });
    } else {
      const path = tokens[++i] ?? "";
      files.push({ path, kind, area: "staged" });
    }
  }
  return files;
}
