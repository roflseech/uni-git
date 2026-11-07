import type { DiffHunk, DiffLine, FileDiff } from "@uni-git/shared";

const MAX_LINES = 20000;

/**
 * Parses one file's unified diff (`git diff -- path`) into hunks with line numbers.
 * Only the first file section is used; callers ask git for one path at a time.
 */
export function parseUnifiedDiff(raw: string, path: string): FileDiff {
  const result: FileDiff = { path, hunks: [], binary: false };
  if (!raw.trim()) {
    return result;
  }
  const lines = raw.split(/\r?\n/);
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let total = 0;
  let inHeader = true;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!m) continue;
      inHeader = false;
      hunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      result.hunks.push(hunk);
      continue;
    }
    if (inHeader) {
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
        result.binary = true;
      } else if (line.startsWith("rename from ")) {
        result.oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
        result.note = result.note ? `${result.note}, ${line}` : line;
      }
      continue;
    }
    if (!hunk) continue;
    if (line === "") continue; // trailing newline of the output; real context lines start with a space
    if (line.startsWith("\\")) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    if (total >= MAX_LINES) {
      result.truncated = true;
      break;
    }
    const marker = line[0];
    const text = line.slice(1);
    let dl: DiffLine;
    if (marker === "+") {
      dl = { t: "add", n: newNo++, text };
    } else if (marker === "-") {
      dl = { t: "del", o: oldNo++, text };
    } else if (marker === " ") {
      dl = { t: "ctx", o: oldNo++, n: newNo++, text };
    } else {
      // "diff --git" of a following file or unknown noise: stop here
      break;
    }
    hunk.lines.push(dl);
    total++;
  }
  return result;
}

/** Builds an all-added diff for an untracked file. */
export function diffForNewFile(path: string, content: string): FileDiff {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && content.endsWith("\n")) {
    lines.pop();
  }
  const shown = lines.slice(0, MAX_LINES);
  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: shown.map((text, i) => ({ t: "add", n: i + 1, text })),
  };
  const result: FileDiff = { path, hunks: lines.length ? [hunk] : [], binary: false };
  if (shown.length < lines.length) result.truncated = true;
  return result;
}

export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
