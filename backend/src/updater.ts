/**
 * Self-update from GitHub releases.
 *
 * Every release (tools/release/build.mjs, published by .github/workflows/release.yml) carries latest.json: a manifest
 * signed with the release key (ed25519) that lists every file of the app with its sha256. A few seconds after start and
 * then every few hours the backend fetches it, downloads the files that differ from the installed ones, checks them and
 * renames them into place. Doing that while the app runs is safe: the shell keeps resources.neu in memory (Neutralino's
 * own updater overwrites it live), Node has already loaded main.js, and Windows lets a running exe be renamed even
 * though it cannot be overwritten. The new version starts with the next launch; the UI offers a restart.
 *
 * The signature matters more than HTTPS here: the app runs where all of the user's git credentials are, so a release
 * must come from the build that holds the private key, not from whoever got write access to the release page.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UpdateState } from "@uni-git/shared";
import { APP_NAME, RELEASES_URL } from "@uni-git/shared";
import { UPDATE_PUBLIC_KEY } from "./update-key.js";

export type PlatformKey = "win_x64" | "mac_arm64" | "mac_x64" | "linux_x64";
const PLATFORM_KEYS: readonly PlatformKey[] = ["win_x64", "mac_arm64", "mac_x64", "linux_x64"];

export interface ManifestFile {
  /** path inside the app folder, forward slashes */
  path: string;
  /** release asset to download */
  asset: string;
  sha256: string;
  size: number;
  /** only these platforms need the file; absent = every platform */
  platforms?: PlatformKey[];
  /** chmod 755 on macOS/Linux */
  exec?: boolean;
}

export interface Manifest {
  app: string;
  version: string;
  commit?: string;
  date?: string;
  /** oldest Node.js the backend of this version runs on, e.g. "20.0.0" */
  minNode?: string;
  notes?: string[];
  /** release page */
  url?: string;
  /** where the assets are, ends with "/" */
  baseUrl: string;
  files: ManifestFile[];
}

/** latest.json: the manifest as a string plus its signature, so what is verified is byte for byte what is parsed. */
export interface SignedManifest {
  format: 1;
  manifest: string;
  /** base64 ed25519 signature of the UTF-8 bytes of `manifest` */
  signature: string;
}

export function platformKey(platform: string = process.platform, arch: string = process.arch): PlatformKey | null {
  if (platform === "win32" && arch === "x64") return "win_x64";
  if (platform === "darwin" && arch === "arm64") return "mac_arm64";
  if (platform === "darwin" && arch === "x64") return "mac_x64";
  if (platform === "linux" && arch === "x64") return "linux_x64";
  return null;
}

export function isReleaseVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

/** Compares x.y.z versions; a pre-release suffix ("0.1.0-dev") sorts before the plain version. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre] = v.trim().replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre !== undefined };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre !== y.pre) return x.pre ? -1 : 1;
  return 0;
}

const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SAFE_ASSET = /^[A-Za-z0-9._-]+$/;

/** Checks the shape of a manifest; paths must stay inside the app folder and away from user data. */
export function parseManifest(json: string): Manifest {
  const m = JSON.parse(json) as Partial<Manifest>;
  const fail = (why: string): never => {
    throw new Error(`invalid update manifest: ${why}`);
  };
  if (typeof m !== "object" || m === null) fail("not an object");
  if (m.app !== APP_NAME) fail(`app is ${String(m.app)}, expected ${APP_NAME}`);
  if (typeof m.version !== "string" || !isReleaseVersion(m.version)) fail(`version ${String(m.version)}`);
  if (typeof m.baseUrl !== "string" || !m.baseUrl.endsWith("/")) fail("baseUrl");
  const base = new URL(m.baseUrl as string);
  const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) fail(`baseUrl must be https: ${m.baseUrl}`);
  if (!Array.isArray(m.files) || m.files.length === 0) fail("no files");
  for (const f of m.files as ManifestFile[]) {
    const p = f?.path;
    if (typeof p !== "string" || !SAFE_PATH.test(p) || p.split("/").some((s) => s === "." || s === "..")) fail(`file path ${String(p)}`);
    if (/^(data|\.update)(\/|$)/i.test(p)) fail(`file path ${p} is reserved`);
    if (typeof f.asset !== "string" || !SAFE_ASSET.test(f.asset)) fail(`asset ${String(f.asset)}`);
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) fail(`sha256 of ${p}`);
    if (!Number.isInteger(f.size) || f.size <= 0 || f.size > 200 * 1024 * 1024) fail(`size of ${p}`);
    if (f.platforms !== undefined && (!Array.isArray(f.platforms) || f.platforms.some((k) => !PLATFORM_KEYS.includes(k)))) fail(`platforms of ${p}`);
  }
  if (m.minNode !== undefined && (typeof m.minNode !== "string" || !/^\d+(\.\d+){0,2}$/.test(m.minNode))) fail("minNode");
  if (m.notes !== undefined && (!Array.isArray(m.notes) || m.notes.some((n) => typeof n !== "string"))) fail("notes");
  return m as Manifest;
}

/** Verifies latest.json against the public key (base64 SPKI DER) and returns the manifest inside. */
export function verifyManifest(text: string, publicKey: string): Manifest {
  let signed: SignedManifest;
  try {
    signed = JSON.parse(text) as SignedManifest;
  } catch {
    throw new Error("latest.json is not JSON");
  }
  if (signed?.format !== 1 || typeof signed.manifest !== "string" || typeof signed.signature !== "string") {
    throw new Error("latest.json has an unknown format");
  }
  const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  const ok = verify(null, Buffer.from(signed.manifest, "utf8"), key, Buffer.from(signed.signature, "base64"));
  if (!ok) throw new Error("the update is not signed with the uni-git release key");
  return parseManifest(signed.manifest);
}

export function filesFor(m: Manifest, platform: PlatformKey): ManifestFile[] {
  return m.files.filter((f) => !f.platforms || f.platforms.includes(platform));
}

export type UpdatePlan =
  /** nothing newer, installed files are intact */
  | { action: "none" }
  /** a newer version: download these (files already equal to the new ones are skipped) */
  | { action: "update"; files: ManifestFile[] }
  /** same version, but some installed files differ (an interrupted update, a damaged install) */
  | { action: "repair"; files: ManifestFile[] };

/** localSha: sha256 of an installed file by manifest path, null when missing. */
export function planUpdate(m: Manifest, current: string, platform: PlatformKey, localSha: (path: string) => string | null): UpdatePlan {
  const cmp = compareVersions(m.version, current);
  if (cmp < 0) return { action: "none" };
  const changed = filesFor(m, platform).filter((f) => localSha(f.path) !== f.sha256);
  if (cmp > 0) return { action: "update", files: changed };
  return changed.length ? { action: "repair", files: changed } : { action: "none" };
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

export interface UpdaterOptions {
  /** the installed app: shell binary, resources.neu, extensions/ */
  appDir: string;
  version: string;
  log: (msg: string) => void;
  onState: (s: UpdateState) => void;
  /** default: the latest release of RELEASE_REPO; UNI_GIT_UPDATE_URL overrides (tests) */
  manifestUrl?: string;
  /** base64 SPKI DER; default: the release key in update-key.ts */
  publicKey?: string;
  /** first check after start; UNI_GIT_UPDATE_DELAY_MS overrides */
  firstCheckMs?: number;
  intervalMs?: number;
  platform?: PlatformKey | null;
  nodeVersion?: string;
}

const DEFAULT_FIRST_CHECK_MS = 3000;
const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000;

export class Updater {
  private state: UpdateState;
  private running: Promise<UpdateState> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly platform: PlatformKey | null;
  private readonly updDir: string;
  private readonly manifestUrl: string;

  constructor(private readonly opts: UpdaterOptions) {
    this.platform = opts.platform === undefined ? platformKey() : opts.platform;
    this.updDir = join(opts.appDir, ".update");
    this.manifestUrl = opts.manifestUrl ?? process.env["UNI_GIT_UPDATE_URL"] ?? `${RELEASES_URL}/latest/download/latest.json`;
    const off = this.disabledReason();
    this.state = off ? { current: opts.version, status: "disabled", message: off } : { current: opts.version, status: "idle" };
  }

  get(): UpdateState {
    return this.state;
  }

  start(): void {
    if (this.state.status === "disabled") {
      this.opts.log(`updates off: ${this.state.message ?? ""}`);
      return;
    }
    this.cleanup();
    const envDelay = Number(process.env["UNI_GIT_UPDATE_DELAY_MS"]);
    const first = Number.isFinite(envDelay) && envDelay >= 0 && process.env["UNI_GIT_UPDATE_DELAY_MS"] ? envDelay : (this.opts.firstCheckMs ?? DEFAULT_FIRST_CHECK_MS);
    this.timers.push(setTimeout(() => void this.check(), first).unref());
    this.timers.push(setInterval(() => void this.check(), this.opts.intervalMs ?? DEFAULT_INTERVAL_MS).unref());
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** One check at a time; a second caller gets the running one. */
  check(): Promise<UpdateState> {
    if (this.state.status === "disabled") return Promise.resolve(this.state);
    if (!this.running) this.running = this.run().finally(() => (this.running = null));
    return this.running;
  }

  private disabledReason(): string | null {
    if (process.env["UNI_GIT_NO_UPDATE"]) return "turned off by UNI_GIT_NO_UPDATE";
    if (!isReleaseVersion(this.opts.version)) return "development build: updates come with releases";
    if (!this.platform) return `no releases for ${process.platform}/${process.arch}`;
    if (!existsSync(join(this.opts.appDir, "resources.neu"))) return `not an installed copy (no resources.neu in ${this.opts.appDir})`;
    try {
      accessSync(this.opts.appDir, constants.W_OK);
    } catch {
      return `the app folder is read-only: ${this.opts.appDir}`;
    }
    return null;
  }

  private set(next: UpdateState): void {
    this.state = next;
    this.opts.onState(next);
  }

  private async run(): Promise<UpdateState> {
    const platform = this.platform as PlatformKey;
    const current = this.opts.version;
    // once an update is in place it stays "ready" until restart; later checks only look for an even newer one
    const ready = this.state.status === "ready" ? this.state : null;
    if (!ready) this.set({ current, status: "checking" });
    try {
      const m = verifyManifest(await this.fetchText(this.manifestUrl), this.opts.publicKey ?? UPDATE_PUBLIC_KEY);
      const releaseInfo = { available: m.version, ...(m.notes ? { notes: m.notes } : {}), ...(m.url ? { url: m.url } : {}) };
      if (!filesFor(m, platform).length) throw new Error(`release ${m.version} has no files for ${platform}`);
      const nodeVersion = this.opts.nodeVersion ?? process.versions.node;
      if (m.minNode && compareVersions(m.version, current) > 0 && compareVersions(nodeVersion, m.minNode) < 0) {
        this.opts.log(`update ${m.version} needs Node.js ${m.minNode}, installed ${nodeVersion}`);
        return this.finish({ current, status: "blocked", ...releaseInfo, message: `uni-git ${m.version} needs Node.js ${m.minNode} or newer (installed: ${nodeVersion}). Update Node.js, then restart uni-git.` });
      }
      const plan = planUpdate(m, current, platform, (p) => sha256File(join(this.opts.appDir, ...p.split("/"))));
      if (plan.action === "none") return this.finish(ready ?? { current, status: "uptodate" });
      if (!plan.files.length) return this.finish({ current, status: "ready", ...releaseInfo }); // applied earlier in this session
      if (!ready) this.set({ current, status: "downloading", available: m.version });
      this.opts.log(`${plan.action === "repair" ? "repairing" : "updating to"} ${m.version}: ${plan.files.map((f) => f.path).join(", ")}`);
      const stage = join(this.updDir, `stage-${Date.now()}`);
      try {
        for (const f of plan.files) {
          const data = await this.fetchFile(new URL(f.asset, m.baseUrl).toString(), f);
          const out = join(stage, ...f.path.split("/"));
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, data);
          if (f.exec && process.platform !== "win32") chmodSync(out, 0o755);
          // Apple Silicon does not run unsigned native code; an ad-hoc signature made here is enough (no quarantine flag)
          if (f.exec && process.platform === "darwin" && !f.path.endsWith(".sh")) adhocSign(out, this.opts.log);
        }
        this.apply(stage, plan.files);
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
      this.opts.log(`update ${m.version} installed, active after restart`);
      return this.finish({ current, status: "ready", ...releaseInfo });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.opts.log(`update check failed: ${message}`);
      return this.finish(ready ?? { current, status: "error", message });
    }
  }

  private finish(s: UpdateState): UpdateState {
    this.set({ ...s, checkedAt: Date.now() });
    return this.state;
  }

  /** Swaps the staged files in, keeping the replaced ones until the next start; undoes everything if a step fails. */
  private apply(stage: string, files: ManifestFile[]): void {
    const backup = join(this.updDir, `backup-${Date.now()}`);
    const moved: { target: string; saved: string | null }[] = [];
    try {
      for (const f of files) {
        const parts = f.path.split("/");
        const target = join(this.opts.appDir, ...parts);
        mkdirSync(dirname(target), { recursive: true });
        let saved: string | null = null;
        if (existsSync(target)) {
          saved = join(backup, ...parts);
          mkdirSync(dirname(saved), { recursive: true });
          renameSync(target, saved);
        }
        moved.push({ target, saved });
        renameSync(join(stage, ...parts), target);
      }
    } catch (e) {
      for (const m of moved.reverse()) {
        try {
          rmSync(m.target, { force: true });
          if (m.saved) renameSync(m.saved, m.target);
        } catch {
          /* best effort: the next check repairs what is left */
        }
      }
      throw e;
    }
  }

  /** Removes stages of interrupted downloads and the files replaced by the previous update. */
  private cleanup(): void {
    let names: string[] = [];
    try {
      names = readdirSync(this.updDir);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        rmSync(join(this.updDir, name), { recursive: true, force: true });
      } catch {
        /* a file of the previous version is still in use; next time */
      }
    }
  }

  private async fetchText(url: string): Promise<string> {
    const r = await fetch(url, { headers: { "User-Agent": `${APP_NAME}/${this.opts.version}` }, signal: AbortSignal.timeout(20000) });
    if (r.status === 404) throw new Error(`no release published yet (${url})`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.text();
  }

  private async fetchFile(url: string, f: ManifestFile): Promise<Buffer> {
    const r = await fetch(url, { headers: { "User-Agent": `${APP_NAME}/${this.opts.version}` }, signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${f.asset}`);
    const data = Buffer.from(await r.arrayBuffer());
    if (data.length !== f.size || sha256(data) !== f.sha256) throw new Error(`${f.asset} is damaged (size or checksum mismatch)`);
    return data;
  }
}

function adhocSign(file: string, log: (msg: string) => void): void {
  try {
    execFileSync("codesign", ["--force", "--sign", "-", file], { stdio: "ignore", timeout: 30000 });
  } catch (e) {
    log(`codesign ${file} failed: ${(e as Error).message}`);
  }
}
