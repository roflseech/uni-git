import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UpdateState } from "@uni-git/shared";
import { compareVersions, filesFor, parseManifest, planUpdate, platformKey, sha256, Updater, verifyManifest, type Manifest, type ManifestFile } from "./updater.js";

const keys = generateKeyPairSync("ed25519");
const PUB = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");

function signed(m: object, key: KeyObject = keys.privateKey): string {
  const text = JSON.stringify(m);
  return JSON.stringify({ format: 1, manifest: text, signature: sign(null, Buffer.from(text), key).toString("base64") });
}

function entry(path: string, content: string, extra: Partial<ManifestFile> = {}): ManifestFile {
  return { path, asset: path.split("/").pop() ?? path, sha256: sha256(Buffer.from(content)), size: Buffer.byteLength(content), ...extra };
}

function manifest(version: string, files: ManifestFile[], baseUrl = "https://github.com/x/y/releases/download/v1/"): Manifest {
  return { app: "uni-git", version, baseUrl, files };
}

describe("versions and platforms", () => {
  it("compares numerically, pre-release first", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
    expect(compareVersions("0.1.5", "0.1.5")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.0-dev")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("22.11.0", "20")).toBe(1);
  });
  it("maps OS/arch to the release binaries", () => {
    expect(platformKey("win32", "x64")).toBe("win_x64");
    expect(platformKey("darwin", "arm64")).toBe("mac_arm64");
    expect(platformKey("darwin", "x64")).toBe("mac_x64");
    expect(platformKey("win32", "arm64")).toBeNull();
  });
});

describe("manifest", () => {
  const ok = manifest("0.1.2", [entry("resources.neu", "r"), entry("extensions/backend/main.js", "m")]);

  it("accepts a valid manifest", () => {
    expect(parseManifest(JSON.stringify(ok)).version).toBe("0.1.2");
  });
  it.each(["../evil.exe", "/etc/passwd", "C:/x.exe", "a\\b.js", "data/config.json", ".update/x", "x/./y", ""])("refuses path %s", (path) => {
    expect(() => parseManifest(JSON.stringify(manifest("0.1.2", [{ ...entry("a", "a"), path }])))).toThrow(/path/);
  });
  it("refuses plain http except loopback", () => {
    expect(() => parseManifest(JSON.stringify({ ...ok, baseUrl: "http://example.com/r/" }))).toThrow(/https/);
    expect(parseManifest(JSON.stringify({ ...ok, baseUrl: "http://127.0.0.1:8080/" })).baseUrl).toContain("127.0.0.1");
  });
  it("refuses another app and odd versions", () => {
    expect(() => parseManifest(JSON.stringify({ ...ok, app: "other" }))).toThrow(/app/);
    expect(() => parseManifest(JSON.stringify({ ...ok, version: "0.1.2-dev" }))).toThrow(/version/);
  });
  it("checks the signature", () => {
    expect(verifyManifest(signed(ok), PUB).version).toBe("0.1.2");
    const tampered = JSON.parse(signed(ok)) as { manifest: string };
    tampered.manifest = tampered.manifest.replace("0.1.2", "0.1.3");
    expect(() => verifyManifest(JSON.stringify(tampered), PUB)).toThrow(/not signed/);
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(() => verifyManifest(signed(ok, other), PUB)).toThrow(/not signed/);
  });
});

describe("planUpdate", () => {
  const m = manifest("0.1.5", [
    entry("resources.neu", "new-res"),
    entry("extensions/backend/main.js", "new-main"),
    entry("uni-git-win_x64.exe", "exe", { platforms: ["win_x64"] }),
    entry("uni-git-mac_arm64", "mac", { platforms: ["mac_arm64"], exec: true }),
  ]);
  const disk = (files: Record<string, string>) => (p: string) => (p in files ? sha256(Buffer.from(files[p] ?? "")) : null);

  it("picks this platform's files", () => {
    expect(filesFor(m, "win_x64").map((f) => f.path)).toEqual(["resources.neu", "extensions/backend/main.js", "uni-git-win_x64.exe"]);
  });
  it("downloads only what changed", () => {
    const plan = planUpdate(m, "0.1.4", "win_x64", disk({ "resources.neu": "old", "extensions/backend/main.js": "old", "uni-git-win_x64.exe": "exe" }));
    expect(plan.action).toBe("update");
    expect(plan.action === "update" && plan.files.map((f) => f.path)).toEqual(["resources.neu", "extensions/backend/main.js"]);
  });
  it("leaves an intact install of the same version alone and repairs a damaged one", () => {
    const intact = { "resources.neu": "new-res", "extensions/backend/main.js": "new-main", "uni-git-win_x64.exe": "exe" };
    expect(planUpdate(m, "0.1.5", "win_x64", disk(intact)).action).toBe("none");
    const plan = planUpdate(m, "0.1.5", "win_x64", disk({ ...intact, "resources.neu": "half-written" }));
    expect(plan.action === "repair" && plan.files.map((f) => f.path)).toEqual(["resources.neu"]);
  });
  it("never goes back to an older release", () => {
    expect(planUpdate(m, "0.1.6", "win_x64", disk({})).action).toBe("none");
  });
});

describe("Updater against a local release server", () => {
  let server: Server;
  let base = "";
  const served = new Map<string, string>();
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const name = (req.url ?? "/").slice(1);
      requests.push(name);
      const body = served.get(name);
      if (body === undefined) res.writeHead(404).end();
      else res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => server.close());

  const installed = { "resources.neu": "old-res", "extensions/backend/main.js": "old-main", "uni-git-win_x64.exe": "exe" };
  const release = { "resources.neu": "new-res", "extensions/backend/main.js": "new-main", "uni-git-win_x64.exe": "exe" };

  function install(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "unigit-upd-"));
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), content);
    }
    return dir;
  }

  function publish(version: string, files: Record<string, string>, opts: { corrupt?: string; key?: KeyObject; minNode?: string } = {}): void {
    served.clear();
    const list = Object.entries(files).map(([p, c]) => entry(p, c, p.endsWith(".exe") ? { platforms: ["win_x64"] } : {}));
    for (const [p, c] of Object.entries(files)) served.set(p.split("/").pop() ?? p, opts.corrupt === p ? c + "!" : c);
    served.set("latest.json", signed({ ...manifest(version, list, base), notes: ["Fix things"], ...(opts.minNode ? { minNode: opts.minNode } : {}) }, opts.key));
  }

  function updater(appDir: string, version: string, states: UpdateState[] = [], nodeVersion?: string): Updater {
    return new Updater({
      appDir,
      version,
      log: () => {},
      onState: (s) => states.push(s),
      manifestUrl: `${base}latest.json`,
      publicKey: PUB,
      platform: "win_x64",
      ...(nodeVersion ? { nodeVersion } : {}),
    });
  }

  const read = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");

  it("installs a newer release in place and keeps the replaced files until the next start", async () => {
    const dir = install(installed);
    publish("0.1.2", release);
    requests.length = 0;
    const states: UpdateState[] = [];
    const s = await updater(dir, "0.1.1", states).check();
    expect(s.status).toBe("ready");
    expect(s.available).toBe("0.1.2");
    expect(s.notes).toEqual(["Fix things"]);
    expect(states.map((x) => x.status)).toEqual(["checking", "downloading", "ready"]);
    expect(read(dir, "resources.neu")).toBe("new-res");
    expect(read(dir, "extensions/backend/main.js")).toBe("new-main");
    // the unchanged shell binary is not downloaded again
    expect(requests).not.toContain("uni-git-win_x64.exe");
    const backups = readdirSync(join(dir, ".update"));
    expect(backups).toHaveLength(1);
    expect(read(join(dir, ".update", backups[0] ?? ""), "resources.neu")).toBe("old-res");

    // after the restart: same version as the release, nothing to do, leftovers are cleaned up
    const next = updater(dir, "0.1.2");
    next.start();
    next.stop();
    expect(existsSync(join(dir, ".update")) ? readdirSync(join(dir, ".update")) : []).toEqual([]);
    expect((await next.check()).status).toBe("uptodate");
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes nothing when a file arrives damaged", async () => {
    const dir = install(installed);
    publish("0.1.2", release, { corrupt: "extensions/backend/main.js" });
    const s = await updater(dir, "0.1.1").check();
    expect(s.status).toBe("error");
    expect(s.message).toMatch(/damaged/);
    expect(read(dir, "resources.neu")).toBe("old-res");
    expect(read(dir, "extensions/backend/main.js")).toBe("old-main");
    expect(existsSync(join(dir, ".update")) ? readdirSync(join(dir, ".update")) : []).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a release signed with another key", async () => {
    const dir = install(installed);
    publish("0.1.2", release, { key: generateKeyPairSync("ed25519").privateKey });
    const s = await updater(dir, "0.1.1").check();
    expect(s.status).toBe("error");
    expect(read(dir, "resources.neu")).toBe("old-res");
    rmSync(dir, { recursive: true, force: true });
  });

  it("waits for a newer Node.js when the release needs one", async () => {
    const dir = install(installed);
    publish("0.1.2", release, { minNode: "22.0.0" });
    const s = await updater(dir, "0.1.1", [], "20.11.1").check();
    expect(s.status).toBe("blocked");
    expect(s.message).toMatch(/Node\.js 22\.0\.0/);
    expect(read(dir, "resources.neu")).toBe("old-res");
    rmSync(dir, { recursive: true, force: true });
  });

  it("is off for development builds and for folders that are not an installed copy", () => {
    const dir = install(installed);
    expect(updater(dir, "0.1.0-dev").get().status).toBe("disabled");
    const bare = install({ "extensions/backend/main.js": "x" });
    expect(updater(bare, "0.1.1").get().message).toMatch(/not an installed copy/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });
});
