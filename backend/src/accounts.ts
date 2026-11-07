/**
 * Accounts (plan, section 4 "Аутентификация"): which hosts have stored credentials in Git Credential Manager,
 * sign in through the browser (GCM's OAuth flow), store a personal access token, sign out, and SSH keys.
 * Everything goes through `git credential` so it works with whatever helper the user has configured.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { AccountInfo, SshKeyInfo } from "@epic-git/shared";
import { git } from "./git.js";

const DEFAULT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "dev.azure.com"];

/** Hosts from the remotes of the given repositories: https hosts for credentials, ssh hosts for key tests. */
export async function remoteHosts(repoPaths: string[]): Promise<{ https: string[]; ssh: string[] }> {
  const https = new Set<string>();
  const ssh = new Set<string>();
  await Promise.all(
    repoPaths.map(async (cwd) => {
      const r = await git(["remote", "-v"], { cwd, allowFailure: true }).catch(() => null);
      if (!r || r.code !== 0) return;
      for (const line of r.stdout.split(/\r?\n/)) {
        const url = line.split(/\s+/)[1] ?? "";
        if (/^([A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|file:)/.test(url)) continue; // local path, no account involved
        const m = /^https?:\/\/(?:[^@\/]+@)?([^\/:]+)/.exec(url);
        if (m) https.add(m[1]!.toLowerCase());
        const s = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)(?::|\/)/.exec(url);
        if (!m && s && !/^https?/.test(url)) ssh.add(s[1]!.toLowerCase());
      }
    }),
  );
  return { https: [...https], ssh: [...ssh] };
}

function credentialInput(host: string, username?: string, password?: string): string {
  const lines = ["protocol=https", `host=${host}`];
  if (username) lines.push(`username=${username}`);
  if (password) lines.push(`password=${password}`);
  return lines.join("\n") + "\n\n";
}

/** Non-interactive probe: does a helper already hold credentials for the host? */
async function probe(host: string): Promise<{ signedIn: boolean; username?: string }> {
  const r = await git(["credential", "fill"], {
    cwd: homedir(),
    input: credentialInput(host),
    allowFailure: true,
    env: { GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_TERMINAL_PROMPT: "0" },
  }).catch(() => null);
  if (!r || r.code !== 0) return { signedIn: false };
  const m = /^username=(.*)$/m.exec(r.stdout);
  const hasPassword = /^password=/m.test(r.stdout);
  return m && hasPassword ? { signedIn: true, username: m[1]!.trim() } : { signedIn: false };
}

/** Sign-in state of the given https hosts (non-interactive). */
export async function probeHosts(hosts: string[]): Promise<AccountInfo[]> {
  return Promise.all(
    hosts.map(async (host) => {
      const p = await probe(host);
      const info: AccountInfo = { host, signedIn: p.signedIn, source: DEFAULT_HOSTS.includes(host) ? "default" : "remote" };
      if (p.username) info.username = p.username;
      return info;
    }),
  );
}

export async function listAccounts(repoPaths: string[]): Promise<{ accounts: AccountInfo[]; sshHosts: string[] }> {
  const remotes = await remoteHosts(repoPaths);
  const hosts = [...new Set([...DEFAULT_HOSTS, ...remotes.https])];
  const accounts = await Promise.all(
    hosts.map(async (host) => {
      const p = await probe(host);
      const info: AccountInfo = { host, signedIn: p.signedIn, source: DEFAULT_HOSTS.includes(host) ? "default" : "remote" };
      if (p.username) info.username = p.username;
      return info;
    }),
  );
  return { accounts, sshHosts: [...new Set([...remotes.ssh, "github.com", "gitlab.com", "bitbucket.org"])] };
}

/** Stores a token as the credential for the host (GCM keeps it in the OS store). */
export async function storeToken(host: string, username: string, token: string): Promise<void> {
  const r = await git(["credential", "approve"], { cwd: homedir(), input: credentialInput(host, username, token), allowFailure: true });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git credential approve failed");
}

export async function signOut(host: string, username?: string): Promise<void> {
  // reject needs the username to hit the right entry; ask the helper first when unknown
  const u = username ?? (await probe(host)).username;
  const r = await git(["credential", "reject"], { cwd: homedir(), input: credentialInput(host, u, u ? "x" : undefined), allowFailure: true });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git credential reject failed");
}

// ───────────── SSH keys ─────────────

function sshDir(): string {
  return join(homedir(), ".ssh");
}

function runCapture(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e) => resolve({ code: -1, out, err: e.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

export async function listSshKeys(): Promise<SshKeyInfo[]> {
  const dir = sshDir();
  if (!existsSync(dir)) return [];
  const pubs = readdirSync(dir).filter((f) => f.endsWith(".pub"));
  const keys: SshKeyInfo[] = [];
  for (const pub of pubs) {
    const file = join(dir, pub);
    const publicKey = readFileSync(file, "utf8").trim();
    const parts = publicKey.split(/\s+/);
    const r = await runCapture("ssh-keygen", ["-lf", file]);
    const fp = /(SHA256:\S+)/.exec(r.out)?.[1] ?? "";
    keys.push({ file, name: pub.replace(/\.pub$/, ""), type: parts[0] ?? "", fingerprint: fp, comment: parts.slice(2).join(" "), publicKey });
  }
  return keys;
}

/** ed25519 key without passphrase in ~/.ssh; picks a free file name. */
export async function generateSshKey(comment: string): Promise<SshKeyInfo> {
  const dir = sshDir();
  mkdirSync(dir, { recursive: true });
  let name = "id_ed25519";
  for (let i = 2; existsSync(join(dir, name)) || existsSync(join(dir, `${name}.pub`)); i++) name = `id_ed25519_${i}`;
  const file = join(dir, name);
  const r = await runCapture("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment || "epic-git", "-f", file]);
  if (r.code !== 0) throw new Error((r.err || r.out).trim() || "ssh-keygen failed");
  const key = (await listSshKeys()).find((k) => k.file === `${file}.pub`);
  if (!key) throw new Error("key was generated but could not be read back");
  return key;
}
