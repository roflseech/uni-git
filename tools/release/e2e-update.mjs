// End-to-end check of the self-update with the real backend bundle, no window and no GitHub:
//   1. bundles the backend as 0.1.1 and 0.1.2, "installs" 0.1.1 into a temp app folder;
//   2. publishes 0.1.2 on a local HTTP server, signed with the release key (.keys/, matches update-key.ts);
//   3. starts the installed backend: it must download, verify and swap the files and report "ready";
//   4. starts it again: it must run as 0.1.2 and find nothing newer;
//   5. publishes a 0.1.3 signed with another key: it must be refused, files untouched.
//   npm run release:test
import { generateKeyPairSync, createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const keyFile = join(root, ".keys/update-signing-key.pem");
if (!existsSync(keyFile)) {
  console.error("no .keys/update-signing-key.pem (npm run release:keygen)");
  process.exit(2);
}
const releaseKey = createPrivateKey(readFileSync(keyFile, "utf8"));
const platform = { win32: "win_x64", darwin: process.arch === "arm64" ? "mac_arm64" : "mac_x64", linux: "linux_x64" }[process.platform];
const binName = `uni-git-${platform}${process.platform === "win32" ? ".exe" : ""}`;

const tmp = mkdtempSync(join(tmpdir(), "unigit-e2e-"));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
let ok = true;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) ok = false;
};

// ───── two builds of the backend ─────
const bundle = (version) => {
  const out = join(tmp, `bundle-${version}`, "main.js");
  execFileSync(process.execPath, [join(root, "backend/bundle.mjs"), "--out", out], { env: { ...process.env, UNI_GIT_VERSION: version }, stdio: "pipe" });
  return dirname(out);
};
const b1 = bundle("0.1.1");
const b2 = bundle("0.1.2");

// ───── installed 0.1.1 ─────
const app = join(tmp, "app");
mkdirSync(join(app, "extensions/backend"), { recursive: true });
writeFileSync(join(app, "resources.neu"), "frontend 0.1.1");
writeFileSync(join(app, binName), "shell binary");
cpSync(join(b1, "main.js"), join(app, "extensions/backend/main.js"));
cpSync(join(b1, "package.json"), join(app, "extensions/backend/package.json"));

// ───── release server ─────
const served = new Map();
const server = createServer((req, res) => {
  const body = served.get(decodeURIComponent((req.url ?? "/").split("?")[0]));
  if (body === undefined) res.writeHead(404).end();
  else res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

function publish(version, files, key = releaseKey) {
  const baseUrl = `${origin}/v${version}/`;
  const list = files.map(({ path, asset, data, platforms }) => {
    served.set(`/v${version}/${asset}`, data);
    return { path, asset, sha256: sha(data), size: data.length, ...(platforms ? { platforms } : {}) };
  });
  const manifest = JSON.stringify({ app: "uni-git", version, minNode: "20.0.0", notes: [`release ${version}`], url: `${origin}/v${version}`, baseUrl, files: list });
  served.set("/latest.json", JSON.stringify({ format: 1, manifest, signature: sign(null, Buffer.from(manifest), key).toString("base64") }));
  return list;
}

const release2 = publish("0.1.2", [
  { path: "resources.neu", asset: "resources.neu", data: Buffer.from("frontend 0.1.2") },
  { path: "extensions/backend/main.js", asset: "main.js", data: readFileSync(join(b2, "main.js")) },
  { path: "extensions/backend/package.json", asset: "backend-package.json", data: readFileSync(join(b2, "package.json")) },
  { path: binName, asset: binName, data: Buffer.from("shell binary"), platforms: [platform] },
]);

// ───── backend runs ─────
async function runBackend(label) {
  const env = { ...process.env, UNI_GIT_UPDATE_URL: `${origin}/latest.json`, UNI_GIT_UPDATE_DELAY_MS: "100" };
  delete env.UNI_GIT_NO_UPDATE;
  const child = spawn(process.execPath, [join(app, "extensions/backend/main.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stdout.write(`[${label}!] ${d}`));
  const sessionFile = join(app, "data/session.json");
  for (let i = 0; i < 200 && !existsSync(sessionFile); i++) await new Promise((r) => setTimeout(r, 25));
  const s = JSON.parse(readFileSync(sessionFile, "utf8"));
  const post = async (route) => {
    const r = await fetch(`http://127.0.0.1:${s.port}${route}`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` }, body: "{}" });
    return r.json();
  };
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/events?token=${s.token}`);
  ws.addEventListener("message", (m) => events.push(JSON.parse(String(m.data))));
  await new Promise((r) => ws.addEventListener("open", r));
  const waitUpdate = async (statuses) => {
    for (let i = 0; i < 300; i++) {
      const u = await post("/update/status");
      if (statuses.includes(u.status)) return u;
      await new Promise((r) => setTimeout(r, 50));
    }
    return post("/update/status");
  };
  const stop = async () => {
    ws.close();
    await post("/shutdown").catch(() => {});
    await new Promise((r) => child.once("exit", r));
  };
  return { post, events, waitUpdate, stop };
}

try {
  // run 1: installed 0.1.1 finds 0.1.2
  const r1 = await runBackend("0.1.1");
  check("runs as 0.1.1", (await r1.post("/ping")).version === "0.1.1");
  const u1 = await r1.waitUpdate(["ready", "error", "blocked"]);
  check("update 0.1.2 installed", u1.status === "ready" && u1.available === "0.1.2", JSON.stringify(u1));
  check("ready announced over the event socket", r1.events.some((e) => e.type === "update" && e.update.status === "ready"));
  for (const f of release2) {
    const data = readFileSync(join(app, ...f.path.split("/")));
    check(`installed ${f.path} matches the release`, sha(data) === f.sha256);
  }
  await r1.stop();

  // run 2: the restarted app is 0.1.2 and finds nothing newer; leftovers of the swap are gone
  const r2 = await runBackend("0.1.2");
  check("runs as 0.1.2 after restart", (await r2.post("/ping")).version === "0.1.2");
  const u2 = await r2.waitUpdate(["uptodate", "error", "ready"]);
  check("up to date", u2.status === "uptodate", JSON.stringify(u2));
  const upd = join(app, ".update");
  check("previous files cleaned up", !existsSync(upd) || readdirSync(upd).length === 0, existsSync(upd) ? readdirSync(upd).join(",") : "");

  // run 2 continued: a forged 0.1.3 is refused
  const forged = generateKeyPairSync("ed25519").privateKey;
  publish("0.1.3", [{ path: "resources.neu", asset: "resources.neu", data: Buffer.from("evil") }], forged);
  const u3 = await r2.post("/update/check");
  check("forged release refused", u3.status === "error" && /not signed/.test(u3.message ?? ""), JSON.stringify(u3));
  check("files untouched by the forged release", readFileSync(join(app, "resources.neu"), "utf8") === "frontend 0.1.2");
  await r2.stop();
} catch (e) {
  console.error(e);
  ok = false;
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(ok ? "e2e update: all checks passed" : "e2e update: FAILED");
process.exit(ok ? 0 : 1);
