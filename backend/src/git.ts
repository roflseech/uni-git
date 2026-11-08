/**
 * Thin wrapper over the git CLI. Git never waits for terminal input here (GIT_TERMINAL_PROMPT=0); prompts of jobs
 * go to the UI through askpass (askpass.ts).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitRunOptions {
  cwd: string;
  /**
   * Cancel. Only commands that just talk to a remote (INTERRUPTIBLE) are stopped mid-way; anything that writes the
   * index, the working copy or refs runs to its end and the job stops before its next command.
   */
  signal?: AbortSignal;
  /** Receives stderr chunks as they arrive (progress of clone/fetch/push). */
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  /** Written to stdin, then stdin is closed. */
  input?: string;
  /** Resolve with the non-zero exit code instead of rejecting. */
  allowFailure?: boolean;
  env?: Record<string, string>;
  /** Read-only commands: stop collecting stdout after this many bytes (the process is killed, `truncated` is set). */
  maxOutput?: number;
}

/**
 * Commands a cancel may kill: they only transfer data or wait for a credential prompt, and a killed one leaves nothing
 * half-done in the repository. Killing a command that writes locally is not safe: Windows terminates without cleanup
 * (index.lock stays behind and blocks every later command), and on macOS a checkout or merge stops with the working
 * copy half updated. `pull` merges after fetching, so it is not in the list either.
 */
const INTERRUPTIBLE = new Set(["fetch", "push", "clone", "ls-remote", "credential"]);

/** The git subcommand of an argument list (after any `-c key=value`). */
export function gitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c" || a === "-C") i++;
    else if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/**
 * Ends the process and everything it started. On Windows `git` usually is Git for Windows' launcher (cmd\git.exe):
 * killing it alone leaves the real git.exe and its helpers (remote-https, index-pack, ssh, git-lfs) running, so a
 * "cancelled" fetch went on to the end. `group`: the child leads its own process group (POSIX, spawned detached).
 */
function killTree(child: ChildProcess, group: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const taskkill = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
    const k = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.on("error", () => child.kill());
    return;
  }
  try {
    if (group) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout was cut at maxOutput */
  truncated: boolean;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(GitError.describe(args, result));
    this.name = "GitError";
  }

  /** The line a user needs: fatal/error/CONFLICT first, then anything that is not a warning or a hint. */
  static describe(args: string[], r: GitResult): string {
    const lines = `${r.stderr}\n${r.stdout}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const pick =
      lines.find((l) => /^(fatal|error):/i.test(l)) ??
      lines.find((l) => /^CONFLICT|^Automatic merge failed|rejected|not possible/i.test(l)) ??
      lines.find((l) => !/^(warning|hint):/i.test(l)) ??
      lines[0];
    const cmd = "git " + args.filter((a) => !a.startsWith("-c") && a !== "core.quotepath=false").slice(0, 3).join(" ");
    return pick ? pick : `${cmd} failed with code ${r.code}`;
  }
}

let gitExecutable = "git";

export function setGitExecutable(path: string | undefined): void {
  gitExecutable = path && path.trim() ? path.trim() : "git";
}

export function getGitExecutable(): string {
  return gitExecutable;
}

const BASE_ARGS = ["-c", "core.quotepath=false", "-c", "color.ui=never"];

export function git(args: string[], opts: GitRunOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const interruptible = INTERRUPTIBLE.has(gitSubcommand(args) ?? "");
    // POSIX: an interruptible command leads its own process group, so a cancel also ends ssh / remote helpers
    const group = interruptible && process.platform !== "win32";
    const child = spawn(gitExecutable, [...BASE_ARGS, ...args], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
        LANG: "C",
        ...opts.env,
      },
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: group,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    // no default limit: a silently cut status or file list is worse than a big one
    const max = opts.maxOutput ?? Infinity;
    let killed = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      outBytes += chunk.length;
      if (outBytes > max) {
        truncated = true;
        killTree(child, group);
        return;
      }
      out.push(chunk);
      if (opts.onStdout) opts.onStdout(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err.push(chunk);
      if (opts.onStderr) opts.onStderr(chunk.toString("utf8"));
    });

    const onAbort = () => {
      if (!interruptible) return; // finishes; the job stops before its next command
      killed = true;
      killTree(child, group);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      let hint = e.message;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        // Node reports ENOENT both for a missing executable and for a missing working directory.
        hint = existsSync(opts.cwd)
          ? `git executable not found (${gitExecutable}). Install Git or set the path in Global Settings.`
          : `repository folder not found: ${opts.cwd}`;
      }
      reject(new Error(hint));
    });

    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      const result: GitResult = {
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        truncated,
      };
      if (killed) {
        reject(new Error("cancelled"));
        return;
      }
      if (result.code !== 0 && !opts.allowFailure && !truncated) {
        reject(new GitError(args, result));
        return;
      }
      resolve(result);
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        /* git exited early; the close handler reports it */
      });
      child.stdin.end(opts.input);
    }
  });
}

/** Convenience: stdout of a successful command. */
export async function gitOut(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const r = await git(args, signal ? { cwd, signal } : { cwd });
  return r.stdout;
}
