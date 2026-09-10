import type { BranchRef, CommitInfo, RepoRefs, StashInfo, TagRef } from "@epic-git/shared";

/** Format string for `git log`; records end with \x1e, fields are separated by \0. */
export const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x00%D%x1e";

export function parseLog(raw: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const rec of raw.split("\x1e")) {
    const r = rec.replace(/^\r?\n/, "");
    if (!r.trim()) continue;
    const f = r.split("\0");
    const sha = f[0] ?? "";
    if (sha.length < 7) continue;
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      parents: (f[1] ?? "").split(" ").filter(Boolean),
      author: f[2] ?? "",
      email: f[3] ?? "",
      date: Number(f[4] ?? 0),
      subject: f[5] ?? "",
      body: (f[6] ?? "").replace(/\s+$/, ""),
      refs: (f[7] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return commits;
}

/**
 * Format for `git for-each-ref refs/heads refs/remotes refs/tags`:
 * refname, short sha, upstream short, upstream track, HEAD marker.
 */
export const REFS_FORMAT = "%(refname)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)";

export function parseRefs(raw: string, at: number = Date.now()): Omit<RepoRefs, "stashes" | "submodules" | "remotes"> {
  const branches: BranchRef[] = [];
  const remoteBranches: BranchRef[] = [];
  const tags: TagRef[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const [fullName = "", sha = "", upstream = "", track = "", head = ""] = line.split("\0");
    if (fullName.startsWith("refs/heads/")) {
      const b: BranchRef = { name: fullName.slice("refs/heads/".length), fullName, sha, current: head === "*" };
      if (upstream) b.upstream = upstream;
      const t = parseTrack(track);
      if (t.gone) b.gone = true;
      if (t.ahead !== undefined) b.ahead = t.ahead;
      if (t.behind !== undefined) b.behind = t.behind;
      branches.push(b);
    } else if (fullName.startsWith("refs/remotes/")) {
      const name = fullName.slice("refs/remotes/".length);
      if (name.endsWith("/HEAD")) continue;
      remoteBranches.push({ name, fullName, sha, current: false });
    } else if (fullName.startsWith("refs/tags/")) {
      tags.push({ name: fullName.slice("refs/tags/".length), sha });
    }
  }
  return { branches, remoteBranches, tags, at };
}

function parseTrack(track: string): { ahead?: number; behind?: number; gone?: boolean } {
  if (!track) return {};
  if (track.includes("gone")) return { gone: true };
  const out: { ahead?: number; behind?: number } = {};
  const a = /ahead (\d+)/.exec(track);
  const b = /behind (\d+)/.exec(track);
  if (a) out.ahead = Number(a[1]);
  if (b) out.behind = Number(b[1]);
  if (!a && !b && track.trim() === "[]") return { ahead: 0, behind: 0 };
  return out;
}

/** `git stash list --format=%gd%x00%s` */
export function parseStashes(raw: string): StashInfo[] {
  const out: StashInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const [ref = "", message = ""] = line.split("\0");
    const m = /stash@\{(\d+)\}/.exec(ref);
    out.push({ index: m ? Number(m[1]) : out.length, ref, message });
  }
  return out;
}

/** `git config --file .gitmodules --get-regexp path` → paths */
export function parseSubmodules(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/).slice(1).join(" "))
    .filter(Boolean);
}
