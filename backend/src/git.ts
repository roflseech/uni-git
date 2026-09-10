/**
 * Thin wrapper over the git CLI. Git never waits for terminal input here (GIT_TERMINAL_PROMPT=0);
 * askpass through the UI arrives in a later iteration.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Receives stderr chunks as they arrive (progress of clone/fetch/push). */
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  /** Written to stdin, then stdin is closed. */
  input?: string;
  /** Resolve with the non-zero exit code instead of rejecting. */
  allowFailure?: boolean;
  env?: Record<string, string>;
  /** Stop collecting stdout after this many bytes (the process is killed). */
  maxOutput?: number;
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

  static describe(args: string[], r: GitResult): string {
    const msg = (r.stderr || r.stdout).trim();
    const cmd = "git " + args.filter((a) => !a.startsWith("-c") && a !== "core.quotepath=false").slice(0, 3).join(" ");
    return msg ? msg : `${cmd} failed with code ${r.code}`;
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
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    const max = opts.maxOutput ?? 64 * 1024 * 1024;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      outBytes += chunk.length;
      if (outBytes > max) {
        truncated = true;
        child.kill();
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
      child.kill();
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
      if (opts.signal?.aborted) {
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
