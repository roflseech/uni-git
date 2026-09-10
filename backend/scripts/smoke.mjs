// End-to-end smoke test of the built backend bundle (app/extensions/backend/main.js): starts it with a temp
// data dir, creates a temp git repository and drives the HTTP/WS API through the stage-1 scenario
// (scan → add group → status → diff → stage/unstage → commit → log → details → clone → watcher → shutdown).
//   npm run build -w backend && npm run smoke -w backend
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "../../app/extensions/backend/main.js");
if (!existsSync(bundle)) {
  console.error(`bundle not found: ${bundle} (run npm run build -w backend)`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "epicgit-smoke-"));
const dataDir = join(root, "data");
const work = join(root, "Work");
mkdirSync(work);
const repo = join(work, "demo");
const sh = (cmd, cwd = repo) => execSync(cmd, { cwd, stdio: "pipe" }).toString();
sh(`git init -q -b master demo`, work);
sh(`git config user.email a@b.c`);
sh(`git config user.name "Smoke Tester"`);
writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
sh(`git add . && git commit -q -m "first commit"`);
writeFileSync(join(repo, "a.txt"), "one\n2\nthree\nfour\n");
writeFileSync(join(repo, "new.txt"), "hello\n");
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src", "x.cs"), "class X {}\n");

const backend = spawn(process.execPath, [bundle, "--data-dir", dataDir], { stdio: ["pipe", "pipe", "pipe"] });
backend.stdout.on("data", (d) => process.stdout.write("[be] " + d));
backend.stderr.on("data", (d) => process.stdout.write("[be!] " + d));

const sessionFile = join(dataDir, "session.json");
for (let i = 0; i < 100 && !existsSync(sessionFile); i++) await new Promise((r) => setTimeout(r, 50));
const session = JSON.parse(readFileSync(sessionFile, "utf8"));

const events = [];
const ws = new WebSocket(`ws://127.0.0.1:${session.port}/events?token=${session.token}`);
ws.addEventListener("message", (m) => events.push(JSON.parse(m.data)));
await new Promise((r) => ws.addEventListener("open", r));

async function post(route, body = {}) {
  const r = await fetch(`http://127.0.0.1:${session.port}${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${route} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const waitJob = async (id) => {
  for (let i = 0; i < 400; i++) {
    const { jobs } = await post("/jobs");
    const j = jobs.find((x) => x.id === id);
    if (j && (j.state === "done" || j.state === "failed" || j.state === "cancelled")) return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job timeout");
};

let ok = true;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name, cond ? "" : (extra ?? ""));
  if (!cond) ok = false;
};

try {
  const ping = await post("/ping");
  check("ping pid", ping.pid === session.pid);
  const scan = await post("/groups/scan", { root: work });
  check("scan finds demo", scan.repos.length === 1 && scan.repos[0].name === "demo", JSON.stringify(scan));
  let cfg = await post("/groups/add-folder", { root: work, name: "Work", hidden: [] });
  check("group added with repo", cfg.groups.length === 1 && cfg.repos.length === 1);
  const repoId = cfg.repos[0].id;
  cfg = await post("/config/select", { repoId });
  check("lastRepoId", cfg.lastRepoId === repoId);

  const snap = await post("/repo/snapshot", { repoId });
  check("snapshot empty first", snap.status === null);
  const st = await post("/repo/status", { repoId });
  check("status branch", st.branch === "master", JSON.stringify(st));
  check("status unstaged 3", st.unstaged.length === 3, st.unstaged.map((f) => f.kind + f.path).join(","));
  const diff = await post("/repo/diff", { repoId, file: { path: "a.txt", area: "unstaged", kind: "M" } });
  check("diff hunks", diff.hunks.length === 1 && diff.hunks[0].lines.some((l) => l.t === "add" && l.text === "four"), JSON.stringify(diff).slice(0, 200));
  const nd = await post("/repo/diff", { repoId, file: { path: "new.txt", area: "unstaged", kind: "?" } });
  check("new file diff", nd.hunks[0]?.lines[0]?.text === "hello");

  let j = (await post("/repo/stage", { repoId, paths: ["a.txt", "src"] })).job;
  j = await waitJob(j.id);
  check("stage done", j.state === "done", j.error);
  const st2 = await post("/repo/status", { repoId });
  check("staged 2 / unstaged 1", st2.staged.length === 2 && st2.unstaged.length === 1, JSON.stringify(st2.staged));
  const sd = await post("/repo/diff", { repoId, file: { path: "src/x.cs", area: "staged", kind: "A" } });
  check("staged new diff", sd.hunks[0]?.lines[0]?.text === "class X {}");

  j = (await post("/repo/unstage", { repoId, paths: ["src/x.cs"] })).job;
  j = await waitJob(j.id);
  const st3 = await post("/repo/status", { repoId });
  check("after unstage staged 1", st3.staged.length === 1 && st3.unstaged.length === 2);

  j = (await post("/repo/commit", { repoId, message: "second commit\n\nbody here", amend: false, push: false })).job;
  j = await waitJob(j.id);
  check("commit done", j.state === "done", j.error);
  const log = await post("/repo/log", { repoId, skip: 0, limit: 10 });
  check("log 2 commits", log.commits.length === 2 && log.commits[0].subject === "second commit" && log.commits[0].body === "body here", JSON.stringify(log.commits[0]));
  check("log refs", log.commits[0].refs.some((r) => r.includes("master")), JSON.stringify(log.commits[0].refs));
  const det = await post("/repo/commit-details", { repoId, sha: log.commits[0].sha });
  check("details files", det.files.length === 1 && det.files[0].path === "a.txt" && det.files[0].kind === "M", JSON.stringify(det.files));
  const cd = await post("/repo/commit-diff", { repoId, sha: log.commits[0].sha, path: "a.txt" });
  check("commit diff", cd.hunks.length === 1);
  const rootDet = await post("/repo/commit-details", { repoId, sha: log.commits[1].sha });
  check("root commit files", rootDet.files.length === 1 && rootDet.files[0].kind === "A");
  const rcd = await post("/repo/commit-diff", { repoId, sha: log.commits[1].sha, path: "a.txt" });
  check("root commit diff", rcd.hunks.length === 1 && rcd.hunks[0].lines.length === 3, JSON.stringify(rcd));
  const br = await post("/repo/commit-branches", { repoId, sha: log.commits[1].sha });
  check("branches contain", br.branches.includes("master"), JSON.stringify(br));
  const refs = await post("/repo/refs", { repoId });
  check("refs master current", refs.branches.length === 1 && refs.branches[0].current);
  const lm = await post("/repo/last-message", { repoId });
  check("last message", lm.message.startsWith("second commit"));
  const user = await post("/repo/user", { repoId });
  check("user", user.email === "a@b.c");
  const filtered = await post("/repo/log", { repoId, skip: 0, limit: 10, text: "first" });
  check("grep filter", filtered.commits.length === 1);
  const page = await post("/repo/log", { repoId, skip: 0, limit: 1 });
  check("hasMore paging", page.commits.length === 1 && page.hasMore === true);

  j = (await post("/repo/commit", { repoId, message: "second commit amended", amend: true, push: false })).job;
  j = await waitJob(j.id);
  const log2 = await post("/repo/log", { repoId, skip: 0, limit: 10 });
  check("amend", log2.commits[0].subject === "second commit amended" && log2.commits.length === 2);

  j = (await post("/repo/push", { repoId })).job;
  j = await waitJob(j.id);
  check("push fails w/o remote", j.state === "failed" && /remote/i.test(j.error ?? ""), j.error);
  const jl = await post("/jobs/log", { jobId: j.id });
  check("job log", jl.log.includes("$ git"));

  const cj = (await post("/repos/clone", { url: repo, dest: join(work, "demo-clone"), groupId: cfg.groups[0].id, recurse: false })).job;
  const cjd = await waitJob(cj.id);
  check("clone done", cjd.state === "done", cjd.error);
  const cfg2 = await post("/config");
  check("clone registered", cfg2.repos.length === 2 && cfg2.repos.some((r) => r.name === "demo-clone"), JSON.stringify(cfg2.repos.map((r) => r.name)));

  const ext = join(root, "elsewhere");
  sh(`git init -q ${ext}`, root);
  const cfg3 = await post("/repos/open", { path: ext, groupId: cfg.groups[0].id });
  check("external flag", cfg3.repos.find((r) => r.path === ext)?.external === true);

  events.length = 0;
  writeFileSync(join(repo, "watched.txt"), "x");
  await new Promise((r) => setTimeout(r, 900));
  check("watcher event", events.some((e) => e.type === "repoChanged" && e.repoId === repoId), JSON.stringify(events.map((e) => e.type)));

  const snap2 = await post("/repo/snapshot", { repoId });
  check("snapshot cached", snap2.status !== null && snap2.commits !== null);

  // branch switching: create a branch, dirty the tree, switch with stash, switch back
  sh(`git branch feature/x`);
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  j = (await post("/repo/checkout", { repoId, branch: "feature/x", remote: false, stash: true })).job;
  j = await waitJob(j.id);
  check("checkout with stash done", j.state === "done", j.error);
  const stSw = await post("/repo/status", { repoId });
  check("on feature/x with changes restored", stSw.branch === "feature/x" && stSw.unstaged.some((f) => f.path === "a.txt"), JSON.stringify(stSw));
  j = (await post("/repo/checkout", { repoId, branch: "master", remote: false, stash: false })).job;
  j = await waitJob(j.id);
  check("checkout back", j.state === "done" && (await post("/repo/status", { repoId })).branch === "master", j.error);
  sh("git fetch -q", join(work, "demo-clone"));
  const remoteSt = await post("/repo/refs", { repoId: cfg2.repos.find((r) => r.name === "demo-clone").id });
  check("clone has remote branch", remoteSt.remoteBranches.some((b) => b.name === "origin/feature/x"), JSON.stringify(remoteSt.remoteBranches));
  const cloneId = cfg2.repos.find((r) => r.name === "demo-clone").id;
  j = (await post("/repo/checkout", { repoId: cloneId, branch: "origin/feature/x", remote: true, stash: false })).job;
  j = await waitJob(j.id);
  const cst = await post("/repo/status", { repoId: cloneId });
  check("remote checkout creates tracking branch", j.state === "done" && cst.branch === "feature/x" && cst.upstream === "origin/feature/x", JSON.stringify([j.error, cst.branch, cst.upstream]));

  const un = await fetch(`http://127.0.0.1:${session.port}/ping`, { method: "POST" });
  check("401 without token", un.status === 401);
} catch (e) {
  ok = false;
  console.log("ERROR", e);
}

await post("/shutdown").catch(() => {});
await new Promise((r) => setTimeout(r, 400));
check("session file removed", !existsSync(sessionFile));
check("backend exited", backend.exitCode !== null, backend.exitCode);
ws.close();
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  /* temp dir may be busy on Windows */
}
console.log(ok ? "ALL OK" : "SOME FAILED");
process.exit(ok ? 0 : 1);
