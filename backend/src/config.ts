/**
 * data/config.json: groups, repositories, global settings. Portable, lives next to the app.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import type { AppConfig, Group, RepoEntry } from "@epic-git/shared";

export function newId(): string {
  return randomBytes(5).toString("hex");
}

const DEFAULT_CONFIG: AppConfig = { version: 1, groups: [], repos: [], settings: {} };

export class ConfigStore {
  private config: AppConfig;
  private readonly file: string;
  private listeners = new Set<(c: AppConfig) => void>();

  constructor(readonly dataDir: string) {
    this.file = join(dataDir, "config.json");
    this.config = this.load();
  }

  private load(): AppConfig {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_CONFIG);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<AppConfig>;
      return {
        version: 1,
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        repos: Array.isArray(parsed.repos) ? parsed.repos : [],
        settings: parsed.settings ?? {},
        ...(parsed.lastRepoId ? { lastRepoId: parsed.lastRepoId } : {}),
      };
    } catch (e) {
      console.error(`config.json is unreadable, starting with defaults: ${(e as Error).message}`);
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  get(): AppConfig {
    return this.config;
  }

  onChange(fn: (c: AppConfig) => void): void {
    this.listeners.add(fn);
  }

  update(mutate: (c: AppConfig) => void): AppConfig {
    mutate(this.config);
    this.save();
    for (const l of this.listeners) l(this.config);
    return this.config;
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.config, null, 2) + "\n", "utf8");
    renameSync(tmp, this.file);
  }

  repo(id: string): RepoEntry | undefined {
    return this.config.repos.find((r) => r.id === id);
  }

  group(id: string): Group | undefined {
    return this.config.groups.find((g) => g.id === id);
  }

  repoByPath(path: string): RepoEntry | undefined {
    const key = normalizePath(path);
    return this.config.repos.find((r) => normalizePath(r.path) === key);
  }

  addRepo(path: string, groupId: string, external: boolean): RepoEntry {
    const existing = this.repoByPath(path);
    if (existing) return existing;
    const entry: RepoEntry = { id: newId(), groupId, name: basename(path), path };
    if (external) entry.external = true;
    this.update((c) => c.repos.push(entry));
    return entry;
  }
}

/** Path key for comparisons: forward slashes, no trailing slash, case-folded on Windows/macOS. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32" || process.platform === "darwin") s = s.toLowerCase();
  return s;
}
