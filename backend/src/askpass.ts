/**
 * Askpass through the UI (plan, section 2, principle 4): git and ssh never prompt in a terminal. Jobs run git with
 * GIT_ASKPASS / SSH_ASKPASS pointing at a small node script (written to data/ at startup) that POSTs the prompt to
 * this backend and waits for the answer. The backend forwards the prompt to the UI as an event and resolves the
 * pending request when the user answers or cancels.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskpassKind, AskpassRequest } from "@epic-git/shared";
import { newId } from "./config.js";

/** The helper script. Runs under git's shell (MSYS sh on Windows, /bin/sh on macOS) thanks to the shebang. */
const HELPER_SOURCE = `#!/usr/bin/env node
// epic-git askpass helper: asks the running backend, which asks the user. Generated file, do not edit.
const prompt = process.argv.slice(2).join(" ");
const port = process.env.EPIC_GIT_ASKPASS_PORT;
const token = process.env.EPIC_GIT_ASKPASS_TOKEN;
const jobId = process.env.EPIC_GIT_ASKPASS_JOB || "";
if (!port || !token) { process.exit(1); }
fetch("http://127.0.0.1:" + port + "/askpass", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token, jobId, prompt }),
})
  .then((r) => r.json())
  .then((j) => {
    if (j && typeof j.value === "string") { process.stdout.write(j.value + "\\n"); process.exit(0); }
    process.exit(1);
  })
  .catch(() => process.exit(1));
`;

interface Pending {
  request: AskpassRequest;
  resolve: (value: string | null) => void;
}

export interface AskpassEnvSource {
  jobId: string;
}

export class AskpassBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly helperPath: string;
  private readonly helperToken: string;

  constructor(
    private readonly dataDir: string,
    private readonly port: number,
    private readonly onRequest: (r: AskpassRequest) => void,
    private readonly onDone: (id: string) => void,
    private readonly jobInfo: (jobId: string) => { repoName: string; title: string } | undefined,
  ) {
    this.helperPath = join(dataDir, "askpass.js");
    this.helperToken = newId() + newId();
    this.writeHelper();
  }

  private writeHelper(): void {
    mkdirSync(this.dataDir, { recursive: true });
    if (!existsSync(this.helperPath) || readFileSync(this.helperPath, "utf8") !== HELPER_SOURCE) {
      writeFileSync(this.helperPath, HELPER_SOURCE, "utf8");
    }
    try {
      chmodSync(this.helperPath, 0o755);
    } catch {
      /* Windows has no exec bit */
    }
  }

  /** Environment for git processes of a job. */
  env(jobId: string): Record<string, string> {
    // git runs GIT_ASKPASS through its shell, so a path with spaces needs quotes; ssh execs SSH_ASKPASS directly.
    const forward = this.helperPath.replace(/\\/g, "/");
    return {
      GIT_ASKPASS: forward.includes(" ") ? `'${forward}'` : forward,
      SSH_ASKPASS: forward,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env["DISPLAY"] ?? ":0",
      GIT_TERMINAL_PROMPT: "0",
      EPIC_GIT_ASKPASS_PORT: String(this.port),
      EPIC_GIT_ASKPASS_TOKEN: this.helperToken,
      EPIC_GIT_ASKPASS_JOB: jobId,
    };
  }

  /** Called by the helper script (HTTP). Resolves when the UI answers; null = cancelled. */
  ask(token: string, jobId: string, prompt: string): Promise<string | null> {
    if (token !== this.helperToken) return Promise.resolve(null);
    const info = this.jobInfo(jobId);
    const request: AskpassRequest = {
      id: newId(),
      jobId,
      repoName: info?.repoName ?? "",
      jobTitle: info?.title ?? "",
      kind: classify(prompt),
      prompt: prompt.trim(),
    };
    return new Promise((resolve) => {
      this.pending.set(request.id, { request, resolve });
      this.onRequest(request);
    });
  }

  answer(id: string, value: string | null): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(value);
    this.onDone(id);
    return true;
  }

  /** Cancelling a job cancels its prompts. */
  cancelJob(jobId: string): void {
    for (const [id, p] of this.pending) if (p.request.jobId === jobId) this.answer(id, null);
  }

  list(): AskpassRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }
}

export function classify(prompt: string): AskpassKind {
  const p = prompt.toLowerCase();
  if (/continue connecting|\(yes\/no|fingerprint/.test(p)) return "hostkey";
  if (p.includes("passphrase")) return "passphrase";
  if (p.includes("password")) return "password";
  if (p.includes("username")) return "username";
  return "other";
}
