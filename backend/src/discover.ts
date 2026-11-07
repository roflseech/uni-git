/**
 * Finds git repositories directly inside a folder (depth 1: Root/Repo1 is found, Root/Repo1/Repo2 is not).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredRepo } from "@uni-git/shared";

export function isGitRepo(path: string): boolean {
  try {
    const s = statSync(join(path, ".git"));
    return s.isDirectory() || s.isFile(); // .git file = worktree or submodule
  } catch {
    return false;
  }
}

export function discoverRepos(root: string): DiscoveredRepo[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const found: DiscoveredRepo[] = [];
  for (const name of entries.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    const path = join(root, name);
    if (isGitRepo(path)) found.push({ path, name });
  }
  return found;
}
