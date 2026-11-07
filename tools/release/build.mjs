// Builds a release: everything a GitHub release of uni-git carries, in release/ (flat asset names):
//   latest.json          signed manifest (format 1: { manifest, signature }) that installers and the updater read
//   resources.neu, main.js, backend-package.json, run.sh, uni-git-win_x64.exe, uni-git-mac_arm64, uni-git-mac_x64,
//   icon.png             the app files; latest.json maps each asset to its path inside the app folder
//   install.ps1, install.sh   the one-line installers
// plus release-notes.md next to release/ (the release description).
//
//   node tools/release/build.mjs --build-number 57      version 0.1.57 (major.minor from package.json)
//   node tools/release/build.mjs --version 0.1.57 [--out dir] [--base-url url] [--skip-build] [--key file]
//
// The signing key comes from UNI_GIT_SIGNING_KEY (PEM text, the GitHub secret), --key, or .keys/update-signing-key.pem.
// It must match the public key in backend/src/update-key.ts, otherwise installed copies would refuse the release.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const neuConfig = JSON.parse(readFileSync(join(root, "app/neutralino.config.json"), "utf8"));
const sharedSrc = readFileSync(join(root, "shared/src/index.ts"), "utf8");
const repo = process.env.GITHUB_REPOSITORY || /RELEASE_REPO = "([^"]+)"/.exec(sharedSrc)?.[1] || fail("RELEASE_REPO not found in shared/src/index.ts");

// ───── version ─────
const [major, minor] = pkg.version.split(".");
const version = arg("--version") ?? (arg("--build-number") ? `${major}.${minor}.${arg("--build-number")}` : fail("give --version x.y.z or --build-number n"));
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`bad version ${version}`);
const tag = `v${version}`;
const baseUrl = arg("--base-url") ?? `https://github.com/${repo}/releases/download/${tag}/`;
if (!baseUrl.endsWith("/")) fail("--base-url must end with /");
const out = resolve(root, arg("--out") ?? "release");
const notesFile = resolve(root, arg("--notes-file") ?? "release-notes.md");

// ───── signing key (checked before the long build) ─────
const pem = process.env.UNI_GIT_SIGNING_KEY || (() => {
  const file = arg("--key") ?? join(root, ".keys/update-signing-key.pem");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
})();
if (!pem.trim()) fail("no signing key: set UNI_GIT_SIGNING_KEY (GitHub secret) or create one with npm run release:keygen");
const privateKey = createPrivateKey(pem);
const trusted = /UPDATE_PUBLIC_KEY = "([^"]+)"/.exec(readFileSync(join(root, "backend/src/update-key.ts"), "utf8"))?.[1];
const ownPublic = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
if (ownPublic !== trusted) fail("the signing key does not match backend/src/update-key.ts: installed copies would refuse this release");

// ───── build ─────
// fixed npm scripts only: one command string through the shell (npm is npm.cmd on Windows)
const run = (command, env = {}) => {
  console.log(`> ${command}`);
  const r = spawnSync(command, { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, ...env } });
  if (r.status !== 0) fail(`${command} failed`);
};
if (!process.argv.includes("--skip-build")) {
  run("npm run build", { UNI_GIT_VERSION: version });
  run("npm run neu:build");
}

// ───── files ─────
const bin = neuConfig.cli.binaryName;
const dist = join(root, "app", neuConfig.cli.distributionPath ?? "dist", bin);
const mac = ["mac_arm64", "mac_x64"];
const FILES = [
  { path: "resources.neu" },
  { path: "extensions/backend/main.js", asset: "main.js" },
  { path: "extensions/backend/package.json", asset: "backend-package.json" },
  { path: "extensions/backend/run.sh", asset: "run.sh", platforms: mac, exec: true },
  { path: `${bin}-win_x64.exe`, platforms: ["win_x64"], exec: true },
  { path: `${bin}-mac_arm64`, platforms: ["mac_arm64"], exec: true },
  { path: `${bin}-mac_x64`, platforms: ["mac_x64"], exec: true },
  // the macOS installer builds the .app icon from it
  { path: "icon.png", from: join(root, "frontend/public/icons/appIcon.png"), platforms: mac },
];

if (existsSync(out)) {
  if (readdirSync(out).length && !existsSync(join(out, "latest.json"))) fail(`${out} exists and is not a release folder`);
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const files = FILES.map((f) => {
  const from = f.from ?? join(dist, ...f.path.split("/"));
  if (!existsSync(from)) fail(`missing ${from} (did neu build run?)`);
  const asset = f.asset ?? f.path.split("/").pop();
  copyFileSync(from, join(out, asset));
  const data = readFileSync(from);
  if (f.path === "extensions/backend/main.js" && !data.includes(JSON.stringify(version))) fail(`main.js is not stamped with ${version}`);
  return { path: f.path, asset, sha256: sha(data), size: statSync(from).size, ...(f.platforms ? { platforms: f.platforms } : {}), ...(f.exec ? { exec: true } : {}) };
});
for (const script of ["install.ps1", "install.sh"]) copyFileSync(join(root, script), join(out, script));

// ───── notes: commit subjects since the previous release tag ─────
const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const prev = git("describe", "--tags", "--abbrev=0", "--match", "v*");
const subjects = (prev ? git("log", "--no-merges", "--format=%s", `${prev}..HEAD`) : git("log", "--no-merges", "--format=%s", "-10"))
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(0, 20);
const commit = process.env.GITHUB_SHA || git("rev-parse", "HEAD");

// ───── manifest ─────
const minNode = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(pkg.engines?.node ?? "20")?.slice(1).map((n) => n ?? "0").join(".") ?? "20.0.0";
const manifest = JSON.stringify({
  app: "uni-git",
  version,
  commit,
  date: new Date().toISOString(),
  minNode,
  notes: subjects,
  url: `https://github.com/${repo}/releases/tag/${tag}`,
  baseUrl,
  files,
});
const signature = sign(null, Buffer.from(manifest, "utf8"), privateKey).toString("base64");
if (!verify(null, Buffer.from(manifest, "utf8"), createPublicKey({ key: Buffer.from(trusted, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"))) {
  fail("signature check failed");
}
writeFileSync(join(out, "latest.json"), JSON.stringify({ format: 1, manifest, signature }, null, 2) + "\n");

const releases = `https://github.com/${repo}/releases/latest/download`;
writeFileSync(
  notesFile,
  [
    subjects.length ? "## Changes\n\n" + subjects.map((s) => `- ${s}`).join("\n") + "\n" : "",
    "## Install",
    "",
    `Windows (PowerShell): \`irm ${releases}/install.ps1 | iex\``,
    "",
    `macOS (Terminal): \`curl -fsSL ${releases}/install.sh | sh\``,
    "",
    "Installed copies update themselves: the app checks on start and offers a restart.",
    "",
  ]
    .filter((l, i) => i > 0 || l)
    .join("\n"),
);

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
console.log(`release ${version}: ${files.length} app files + installers in ${out}`);
for (const f of files) console.log(`  ${f.asset.padEnd(22)} ${String(f.size).padStart(9)}  ${f.platforms ? f.platforms.join(",") : "all"}`);
