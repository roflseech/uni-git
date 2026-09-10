/**
 * Filesystem watcher for the active repository: any change in the working tree or in the relevant
 * parts of .git triggers a debounced "changed" callback. Recursive fs.watch works on Windows and macOS.
 */
import { watch, type FSWatcher } from "node:fs";

const DEBOUNCE_MS = 300;

export class RepoWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private path: string | null = null;

  constructor(private readonly onChange: (repoPath: string) => void) {}

  watch(repoPath: string): void {
    if (this.path === repoPath && this.watcher) return;
    this.close();
    this.path = repoPath;
    try {
      this.watcher = watch(repoPath, { recursive: true, persistent: false }, (_event, filename) => {
        if (!isRelevant(filename)) return;
        this.schedule();
      });
      this.watcher.on("error", () => this.close());
    } catch (e) {
      console.error(`watch failed for ${repoPath}: ${(e as Error).message}`);
      this.watcher = null;
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.path) this.onChange(this.path);
    }, DEBOUNCE_MS);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    this.path = null;
  }
}

/** Filters out noise inside .git: object store, lock files, logs. */
export function isRelevant(filename: string | Buffer | null): boolean {
  if (filename === null) return true;
  const name = (typeof filename === "string" ? filename : filename.toString()).replace(/\\/g, "/");
  if (name.endsWith(".lock")) return false;
  // Build output that is never tracked but changes constantly (Unity, .NET, node): skip it at the repository root.
  if (/^(Library|Temp|Logs|obj|node_modules|\.vs|\.idea|\.tmp)(\/|$)/.test(name)) return false;
  const gitIdx = name === ".git" ? 0 : name.indexOf(".git/");
  if (gitIdx === -1 && name.indexOf("/.git") === -1) return true;
  const inside = name.slice(name.indexOf(".git") + 5);
  if (inside === "" || inside === "index" || inside === "HEAD" || inside === "packed-refs" || inside === "ORIG_HEAD") return true;
  if (inside.startsWith("refs/")) return true;
  if (/^(MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|MERGE_MSG|FETCH_HEAD)$/.test(inside)) return true;
  if (inside.startsWith("rebase-")) return true;
  return false;
}
