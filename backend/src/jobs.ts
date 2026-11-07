/**
 * Per-repository job queue. Jobs of one repository run one after another; different repositories run
 * in parallel. Every job has a log, a step label and can be cancelled (the running git command is killed).
 */
import { EventEmitter } from "node:events";
import type { JobInfo, JobState } from "@epic-git/shared";
import { git, type GitResult, type GitRunOptions } from "./git.js";
import { newId } from "./config.js";

export interface JobContext {
  signal: AbortSignal;
  /** Runs git in the repository, streaming stderr into the job log. */
  git(args: string[], opts?: Partial<Omit<GitRunOptions, "cwd" | "signal">>): Promise<GitResult>;
  setStep(step: string): void;
  log(text: string): void;
}

export type JobRunner = (ctx: JobContext) => Promise<void>;

export interface JobTarget {
  id: string;
  name: string;
  path: string;
}

interface Job {
  info: JobInfo;
  target: JobTarget;
  run: JobRunner;
  controller: AbortController;
  log: string;
}

const LOG_LIMIT = 256 * 1024;
const KEEP_FINISHED = 40;

export interface JobEvents {
  job: [JobInfo];
  cancel: [string];
  log: [string, string];
  repoChanged: [string];
}

export class JobManager extends EventEmitter<JobEvents> {
  /** Extra environment for every git process of a job (askpass wiring); set by the server once it knows its port. */
  jobEnv: (jobId: string) => Record<string, string> = () => ({});
  private jobs = new Map<string, Job>();
  private queues = new Map<string, Job[]>();
  private running = new Map<string, Job>();

  enqueue(target: JobTarget, title: string, run: JobRunner, quiet = false): JobInfo {
    const info: JobInfo = {
      id: newId(),
      repoId: target.id,
      repoName: target.name,
      title,
      state: "queued",
      quiet,
      createdAt: Date.now(),
    };
    const job: Job = { info, target, run, controller: new AbortController(), log: "" };
    this.jobs.set(info.id, job);
    const q = this.queues.get(target.id) ?? [];
    q.push(job);
    this.queues.set(target.id, q);
    this.emit("job", { ...info });
    this.pump(target.id);
    return { ...info };
  }

  private pump(repoId: string): void {
    if (this.running.has(repoId)) return;
    const q = this.queues.get(repoId);
    const job = q?.shift();
    if (!job) return;
    this.running.set(repoId, job);
    void this.execute(job).finally(() => {
      this.running.delete(repoId);
      this.emit("repoChanged", repoId);
      this.trim();
      this.pump(repoId);
    });
  }

  private async execute(job: Job): Promise<void> {
    const { info, controller } = job;
    if (controller.signal.aborted) {
      this.finish(job, "cancelled");
      return;
    }
    info.state = "running";
    info.startedAt = Date.now();
    this.emit("job", { ...info });

    const ctx: JobContext = {
      signal: controller.signal,
      git: (args, opts = {}) => {
        this.appendLog(job, `$ git ${args.join(" ")}\n`);
        return git(args, {
          ...opts,
          env: { ...this.jobEnv(info.id), ...opts.env },
          cwd: job.target.path,
          signal: controller.signal,
          onStderr: (chunk) => {
            this.appendLog(job, chunk);
            const step = progressStep(chunk);
            if (step) ctx.setStep(step);
            opts.onStderr?.(chunk);
          },
        });
      },
      setStep: (step) => {
        if (info.step === step) return;
        info.step = step;
        this.emit("job", { ...info });
      },
      log: (text) => this.appendLog(job, text.endsWith("\n") ? text : text + "\n"),
    };

    try {
      await job.run(ctx);
      this.finish(job, controller.signal.aborted ? "cancelled" : "done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (controller.signal.aborted || msg === "cancelled") {
        this.finish(job, "cancelled");
      } else {
        this.appendLog(job, `\n${msg}\n`);
        this.finish(job, "failed", msg);
      }
    }
  }

  private finish(job: Job, state: JobState, error?: string): void {
    job.info.state = state;
    job.info.finishedAt = Date.now();
    delete job.info.step;
    if (error) job.info.error = firstLine(error);
    this.emit("job", { ...job.info });
  }

  private appendLog(job: Job, chunk: string): void {
    job.log += chunk;
    if (job.log.length > LOG_LIMIT) job.log = job.log.slice(job.log.length - LOG_LIMIT);
    this.emit("log", job.info.id, chunk);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.emit("cancel", id);
    if (job.info.state === "queued") {
      const q = this.queues.get(job.target.id);
      if (q) {
        const i = q.indexOf(job);
        if (i >= 0) q.splice(i, 1);
      }
      job.controller.abort();
      this.finish(job, "cancelled");
      return true;
    }
    if (job.info.state === "running") {
      job.controller.abort();
      return true;
    }
    return false;
  }

  isBusy(repoId: string): boolean {
    return this.running.has(repoId) || (this.queues.get(repoId)?.length ?? 0) > 0;
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((j) => ({ ...j.info }));
  }

  active(): JobInfo[] {
    return this.list().filter((j) => j.state === "queued" || j.state === "running");
  }

  info(id: string): JobInfo | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j.info } : undefined;
  }

  logOf(id: string): string | undefined {
    return this.jobs.get(id)?.log;
  }

  /** Cancel everything on shutdown. */
  cancelAll(): void {
    for (const job of this.jobs.values()) {
      if (job.info.state === "queued" || job.info.state === "running") this.cancel(job.info.id);
    }
  }

  private trim(): void {
    const finished = [...this.jobs.values()].filter((j) => j.info.finishedAt !== undefined);
    if (finished.length <= KEEP_FINISHED) return;
    finished.sort((a, b) => (a.info.finishedAt ?? 0) - (b.info.finishedAt ?? 0));
    for (const j of finished.slice(0, finished.length - KEEP_FINISHED)) this.jobs.delete(j.info.id);
  }
}

/** Turns git progress lines (clone/fetch/push) into a short step label. */
export function progressStep(chunk: string): string | undefined {
  const lines = chunk.split(/[\r\n]/).filter((l) => l.trim());
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  const m = /^(remote: )?((?:Counting|Compressing|Receiving|Resolving|Writing|Enumerating) [a-z]+):\s+(\d+%)/.exec(last);
  if (m) return `${m[2]} ${m[3]}`;
  const u = /^(Updating files):\s+(\d+%)/.exec(last);
  if (u) return `${u[1]} ${u[2]}`;
  return undefined;
}

function firstLine(s: string): string {
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful =
    lines.find((l) => /^(fatal|error)/i.test(l)) ?? lines.find((l) => !/^(warning|hint):/i.test(l)) ?? lines[0] ?? s;
  return meaningful.replace(/^(fatal|error):\s*/i, "");
}
