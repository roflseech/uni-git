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

const root = mkdtempSync(join(tmpdir(), "unigit-smoke-"));
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

  // ── settings, branches, discard, ignore, hunks ──
  const rs = await post("/repo/settings", { repoId });
  check("repo settings", rs.mainBranch === "master" && rs.mainBranchAuto && rs.userName === "Smoke Tester" && rs.userNameScope === "local", JSON.stringify(rs));
  await post("/repo/settings/save", { repoId, groupId: rs.groupId, mainBranch: "feature/x", userName: "Renamed Tester", userEmail: "a@b.c" });
  const rs2 = await post("/repo/settings", { repoId });
  check("repo settings saved", rs2.mainBranch === "feature/x" && !rs2.mainBranchAuto && rs2.userName === "Renamed Tester", JSON.stringify(rs2));
  const gs = await post("/settings/global", {});
  check("global settings", typeof gs.gitVersion === "string" && gs.dataDir.length > 0, JSON.stringify(gs));
  // the window layout is saved apart from the settings dialog and survives its save; 0 = back to the default
  const ui1 = await post("/settings/ui/save", { ui: { commitsSplit: 40.5, commitFilesSplit: 25, sideWidth: 300 } });
  const gs2 = await post("/settings/global/save", { settings: { editorCommand: "code {path}", theme: "dark" } });
  check("global settings saved", gs2.theme === "dark" && gs2.editorCommand === "code {path}");
  const ui2 = await post("/settings/ui/save", { ui: { sideWidth: 0 } });
  const uiNow = (await post("/config", {})).settings.ui;
  check("ui layout saved", ui1.ui.commitsSplit === 40.5 && ui2.ui.sideWidth === undefined && uiNow?.commitsSplit === 40.5 && uiNow.commitFilesSplit === 25 && uiNow.sideWidth === undefined, JSON.stringify(uiNow));

  j = (await post("/repo/branch/create", { repoId, name: "topic/new", from: "master", checkout: false })).job;
  j = await waitJob(j.id);
  check("branch create", j.state === "done" && (await post("/repo/refs", { repoId })).branches.some((b) => b.name === "topic/new"), j.error);
  // commits of another branch without switching, and the task-code filter (message must contain the code)
  sh(`git commit -q --allow-empty -m "OST-1 work on task"`);
  const refLog = await post("/repo/log", { repoId, skip: 0, limit: 10, ref: "topic/new" });
  const headLog = await post("/repo/log", { repoId, skip: 0, limit: 10 });
  check("log of a branch", headLog.commits.length === refLog.commits.length + 1 && refLog.commits[0].sha === headLog.commits[1].sha, JSON.stringify([headLog.commits.length, refLog.commits.length]));
  const taskLog = await post("/repo/log", { repoId, skip: 0, limit: 10, task: "OST-1" });
  const taskText = await post("/repo/log", { repoId, skip: 0, limit: 10, task: "OST-1", text: "nothing-like-this" });
  check("log task filter", taskLog.commits.length === 1 && taskLog.commits[0].subject.startsWith("OST-1") && taskText.commits.length === 0, JSON.stringify([taskLog.commits.length, taskText.commits.length]));
  j = (await post("/repo/branch/rename", { repoId, from: "topic/new", to: "topic/renamed" })).job;
  j = await waitJob(j.id);
  check("branch rename", j.state === "done" && (await post("/repo/refs", { repoId })).branches.some((b) => b.name === "topic/renamed"), j.error);
  const mi = await post("/repo/merged-into", { repoId, branch: "topic/renamed", into: ["master", "feature/x"] });
  check("merged-into", mi.merged.master === true && mi.merged["feature/x"] === true, JSON.stringify(mi));
  j = (await post("/repo/branch/delete", { repoId, name: "topic/renamed", remote: false, force: false })).job;
  j = await waitJob(j.id);
  check("branch delete", j.state === "done" && !(await post("/repo/refs", { repoId })).branches.some((b) => b.name === "topic/renamed"), j.error);

  writeFileSync(join(repo, "a.txt"), "discard me\n");
  writeFileSync(join(repo, "junk.tmp"), "x");
  j = (await post("/repo/discard", { repoId, paths: ["a.txt", "junk.tmp"] })).job;
  j = await waitJob(j.id);
  const stD = await post("/repo/status", { repoId });
  check("discard", j.state === "done" && !stD.unstaged.some((f) => f.path === "a.txt" || f.path === "junk.tmp"), JSON.stringify([j.error, stD.unstaged]));
  writeFileSync(join(repo, "a.txt"), "staged change\n");
  sh("git add a.txt");
  writeFileSync(join(repo, "a.txt"), "then unstaged\n");
  writeFileSync(join(repo, "junk2.tmp"), "x");
  j = (await post("/repo/discard", { repoId, paths: [], all: true })).job;
  j = await waitJob(j.id);
  const stAll = await post("/repo/status", { repoId });
  check("discard all", j.state === "done" && stAll.staged.length === 0 && !stAll.unstaged.some((f) => f.path === "a.txt" || f.path === "junk2.tmp"), JSON.stringify([j.error, stAll.staged, stAll.unstaged]));
  j = (await post("/repo/ignore", { repoId, patterns: ["*.log", "build/"] })).job;
  j = await waitJob(j.id);
  check("ignore", j.state === "done" && readFileSync(join(repo, ".gitignore"), "utf8").includes("*.log"), j.error);

  // hunk staging: two separate changes in one file, stage only the first hunk
  const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(repo, "h.txt"), base.join("\n") + "\n");
  sh("git add h.txt && git commit -q -m hunks");
  const edited = [...base];
  edited[1] = "line 2 CHANGED";
  edited[27] = "line 28 CHANGED";
  writeFileSync(join(repo, "h.txt"), edited.join("\n") + "\n");
  const hd = await post("/repo/diff", { repoId, file: { path: "h.txt", area: "unstaged", kind: "M" } });
  check("two hunks", hd.hunks.length === 2, JSON.stringify(hd.hunks.map((h) => h.header)));
  const h0 = hd.hunks[0];
  const patch = [`--- a/h.txt`, `+++ b/h.txt`, h0.header, ...h0.lines.map((l) => (l.t === "add" ? "+" : l.t === "del" ? "-" : " ") + l.text)].join("\n") + "\n";
  j = (await post("/repo/apply-patch", { repoId, patch, reverse: false })).job;
  j = await waitJob(j.id);
  const stH = await post("/repo/status", { repoId });
  const stagedDiff = await post("/repo/diff", { repoId, file: { path: "h.txt", area: "staged", kind: "M" } });
  check("stage hunk", j.state === "done" && stH.staged.some((f) => f.path === "h.txt") && stH.unstaged.some((f) => f.path === "h.txt") && stagedDiff.hunks.length === 1, JSON.stringify([j.error, stagedDiff.hunks.map((h) => h.header)]));
  j = (await post("/repo/apply-patch", { repoId, patch, reverse: true })).job;
  j = await waitJob(j.id);
  const stH2 = await post("/repo/status", { repoId });
  check("unstage hunk", j.state === "done" && !stH2.staged.some((f) => f.path === "h.txt"), j.error);

  // ── stage 2: merge scenarios against a local bare "origin", conflicts, cherry-pick, stash, tags, remotes ──
  const bare = join(root, "origin.git");
  sh(`git init -q --bare "${bare}"`, root);
  sh(`git remote add origin "${bare}"`);
  sh("git push -q -u origin master");
  sh("git switch -q -c topic");
  writeFileSync(join(repo, "topic.txt"), "topic\n");
  sh("git add topic.txt && git commit -q -m topic-commit");
  // someone else advances master on origin
  const other = join(root, "other");
  sh(`git clone -q "${bare}" other`, root);
  sh("git config user.email o@b.c && git config user.name Other", other);
  writeFileSync(join(other, "remote.txt"), "from origin\n");
  sh("git add remote.txt && git commit -q -m remote-commit && git push -q", other);

  const stM = await post("/repo/status", { repoId });
  check("main branch in status", stM.mainBranch === "feature/x" || stM.mainBranch === "master", JSON.stringify([stM.mainBranch, stM.aheadOfMain, stM.behindMain]));
  await post("/repo/settings/save", { repoId, groupId: rs.groupId, mainBranch: "master", userName: "Renamed Tester", userEmail: "a@b.c" });
  const stM2 = await post("/repo/status", { repoId });
  check("ahead of main counted", stM2.mainBranch === "master" && stM2.aheadOfMain === 1 && stM2.behindMain === 0, JSON.stringify([stM2.aheadOfMain, stM2.behindMain]));

  writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
  j = (await post("/repo/merge-scenario", { repoId, mode: "force-main", stash: true })).job;
  j = await waitJob(j.id);
  const stF = await post("/repo/status", { repoId });
  check("force merge actual main", j.state === "done" && existsSync(join(repo, "remote.txt")) && stF.branch === "topic" && stF.unstaged.some((f) => f.path === "dirty.txt"), JSON.stringify([j.error, stF.branch, stF.unstaged]));
  check("stash restored", (await post("/repo/refs", { repoId })).stashes.length === 0);
  const cfgAfter = await post("/config");
  check("merge stash flag persisted", cfgAfter.settings.mergeStash === true);

  j = (await post("/repo/merge-scenario", { repoId, mode: "into-main", stash: true })).job;
  j = await waitJob(j.id);
  const stI = await post("/repo/status", { repoId });
  const originLog = sh("git log --oneline origin/master", other) || sh("git fetch -q && git log --oneline origin/master", other);
  check("merge into main + push", j.state === "done" && stI.branch === "master", JSON.stringify([j.error, stI.branch]));
  sh("git fetch -q", other);
  check("origin master has topic", sh("git log --oneline origin/master", other).includes("topic-commit"));

  // conflict: same line changed on two branches, then merge, take ours, continue
  sh("git switch -q -c conflict-a");
  writeFileSync(join(repo, "c.txt"), "A\n");
  sh("git add c.txt && git commit -q -m a");
  sh("git switch -q master");
  writeFileSync(join(repo, "c.txt"), "B\n");
  sh("git add c.txt && git commit -q -m b");
  j = (await post("/repo/merge", { repoId, branch: "conflict-a" })).job;
  j = await waitJob(j.id);
  const stC = await post("/repo/status", { repoId });
  check("merge conflict detected", j.state === "failed" && stC.operation === "merge" && stC.conflicts.some((f) => f.path === "c.txt"), JSON.stringify([j.state, stC.operation, stC.conflicts]));
  const mm = await post("/repo/merge-message", { repoId });
  check("merge message available", /Merge branch 'conflict-a'/.test(mm.message), mm.message);
  j = (await post("/repo/conflict/resolve", { repoId, paths: ["c.txt"], take: "theirs" })).job;
  j = await waitJob(j.id);
  const stR = await post("/repo/status", { repoId });
  check("take theirs resolves", j.state === "done" && stR.conflicts.length === 0 && readFileSync(join(repo, "c.txt"), "utf8").replace(/\r/g, "") === "A\n" && stR.operation === "merge", JSON.stringify([j.error, stR.conflicts, stR.operation, readFileSync(join(repo, "c.txt"), "utf8")]));
  j = (await post("/repo/operation/continue", { repoId })).job;
  j = await waitJob(j.id);
  const stDone = await post("/repo/status", { repoId });
  check("continue commits the merge", j.state === "done" && stDone.operation === "none", JSON.stringify([j.error, stDone.operation]));

  // abort path
  sh("git switch -q -c conflict-b conflict-a");
  writeFileSync(join(repo, "c.txt"), "C\n");
  sh("git add c.txt && git commit -q -m c");
  sh("git switch -q master");
  writeFileSync(join(repo, "c.txt"), "D\n");
  sh("git add c.txt && git commit -q -m d");
  j = (await post("/repo/merge", { repoId, branch: "conflict-b" })).job;
  await waitJob(j.id);
  j = (await post("/repo/operation/abort", { repoId })).job;
  j = await waitJob(j.id);
  const stAb = await post("/repo/status", { repoId });
  check("abort merge", j.state === "done" && stAb.operation === "none" && stAb.conflicts.length === 0 && readFileSync(join(repo, "c.txt"), "utf8").replace(/\r/g, "") === "D\n", JSON.stringify([j.error, stAb.operation, readFileSync(join(repo, "c.txt"), "utf8")]));

  // cherry-pick a commit from another branch
  sh("git switch -q -c pick-src");
  writeFileSync(join(repo, "pick.txt"), "picked\n");
  sh("git add pick.txt && git commit -q -m pick-me");
  const pickSha = sh("git rev-parse HEAD").trim();
  sh("git switch -q master");
  j = (await post("/repo/cherry-pick", { repoId, shas: [pickSha] })).job;
  j = await waitJob(j.id);
  check("cherry-pick", j.state === "done" && sh("git log -1 --format=%s").trim() === "pick-me", j.error);

  // stash save / apply / pop / drop
  writeFileSync(join(repo, "s.txt"), "stash me\n");
  j = (await post("/repo/stash/save", { repoId, message: "my stash", includeUntracked: true })).job;
  j = await waitJob(j.id);
  const refsS = await post("/repo/refs", { repoId });
  check("stash saved", j.state === "done" && refsS.stashes.length === 1 && refsS.stashes[0].message.includes("my stash") && !existsSync(join(repo, "s.txt")), JSON.stringify([j.error, refsS.stashes]));
  const stashSha = await post("/repo/stash/sha", { repoId, ref: "stash@{0}" });
  const stashDet = await post("/repo/commit-details", { repoId, sha: stashSha.sha });
  check("stash shown as commit details", stashDet.files.some((f) => f.path === "s.txt") || stashDet.parents.length >= 2, JSON.stringify(stashDet.files));
  j = (await post("/repo/stash/apply", { repoId, ref: "stash@{0}", pop: false })).job;
  j = await waitJob(j.id);
  check("stash apply", j.state === "done" && existsSync(join(repo, "s.txt")) && (await post("/repo/refs", { repoId })).stashes.length === 1, j.error);
  // the stash also holds earlier leftovers (h.txt hunk, .gitignore): discard everything unstaged before popping
  const dirtyNow = (await post("/repo/status", { repoId })).unstaged.map((f) => f.path);
  j = (await post("/repo/discard", { repoId, paths: dirtyNow })).job;
  await waitJob(j.id);
  j = (await post("/repo/stash/apply", { repoId, ref: "stash@{0}", pop: true })).job;
  j = await waitJob(j.id);
  check("stash pop", j.state === "done" && existsSync(join(repo, "s.txt")) && (await post("/repo/refs", { repoId })).stashes.length === 0, j.error + " LOG: " + (await post("/jobs/log", { jobId: j.id })).log);
  j = (await post("/repo/stash/save", { repoId, message: "", includeUntracked: true })).job;
  await waitJob(j.id);
  j = (await post("/repo/stash/drop", { repoId, ref: "stash@{0}" })).job;
  j = await waitJob(j.id);
  check("stash drop", j.state === "done" && (await post("/repo/refs", { repoId })).stashes.length === 0, j.error);

  // tags
  j = (await post("/repo/tag/create", { repoId, name: "v1.0", sha: "HEAD", message: "release one", push: true })).job;
  j = await waitJob(j.id);
  sh("git fetch -q --tags", other);
  check("tag create + push", j.state === "done" && (await post("/repo/refs", { repoId })).tags.some((t) => t.name === "v1.0") && sh("git tag", other).includes("v1.0"), j.error);
  j = (await post("/repo/tag/delete", { repoId, name: "v1.0", remote: true })).job;
  j = await waitJob(j.id);
  j = (await post("/repo/tag/delete", { repoId, name: "v1.0", remote: false })).job;
  j = await waitJob(j.id);
  check("tag delete local + remote", j.state === "done" && !(await post("/repo/refs", { repoId })).tags.some((t) => t.name === "v1.0") && !sh("git ls-remote --tags origin", other).includes("v1.0"), j.error);

  // remotes
  j = (await post("/repo/remote/add", { repoId, name: "mirror", url: bare })).job;
  j = await waitJob(j.id);
  check("remote add", j.state === "done" && (await post("/repo/refs", { repoId })).remotes.includes("mirror"), j.error);
  const ru = await post("/repo/remote/url", { repoId, name: "mirror" });
  check("remote url", ru.url === bare, ru.url);
  j = (await post("/repo/remote/remove", { repoId, name: "mirror" })).job;
  j = await waitJob(j.id);
  check("remote remove", j.state === "done" && !(await post("/repo/refs", { repoId })).remotes.includes("mirror"), j.error);

  // force push after amending a pushed commit
  sh("git push -q origin master");
  sh("git commit -q --amend -m amended-top");
  j = (await post("/repo/push", { repoId })).job;
  j = await waitJob(j.id);
  check("normal push rejected", j.state === "failed", j.state);
  j = (await post("/repo/push", { repoId, force: true })).job;
  j = await waitJob(j.id);
  sh("git fetch -q", other);
  check("force push with lease", j.state === "done" && sh("git log -1 --format=%s origin/master", other).trim() === "amended-top", j.error);
  sh("git remote remove origin");

  // per-repository auth profile: credential.username and core.sshCommand in .git/config
  const auth0 = await post("/repo/auth", { repoId });
  check("repo auth view", Array.isArray(auth0.remotes) && auth0.username === "" && auth0.sshKey === "" && Array.isArray(auth0.keys), JSON.stringify(auth0).slice(0, 200));
  await post("/repo/auth/save", { repoId, username: "smoke-login", sshKey: "C:/keys/id_test" });
  const auth1 = await post("/repo/auth", { repoId });
  check("repo auth saved", auth1.username === "smoke-login" && auth1.sshKey === "C:/keys/id_test" && sh("git config --local core.sshCommand").includes("IdentitiesOnly=yes"), JSON.stringify([auth1.username, auth1.sshKey]));
  await post("/repo/auth/save", { repoId, username: "", sshKey: "" });
  const auth2 = await post("/repo/auth", { repoId });
  check("repo auth cleared", auth2.username === "" && auth2.sshKey === "");

  // accounts screen: non-interactive probe of the credential helper (no prompts may appear), ssh key listing
  const acc = await post("/accounts/list", {});
  check("accounts listed", Array.isArray(acc.accounts) && acc.accounts.some((a) => a.host === "github.com") && Array.isArray(acc.keys) && Array.isArray(acc.sshHosts), JSON.stringify(acc).slice(0, 200));
  check("accounts have sign-in state", acc.accounts.every((a) => typeof a.signedIn === "boolean"));

  // askpass: a tiny http server demands Basic auth, git asks for a username through our helper
  const { createServer } = await import("node:http");
  let seenAuth = null;
  const authServer = createServer((req, res) => {
    if (req.headers.authorization) seenAuth = req.headers.authorization;
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="smoke"' });
    res.end("auth required");
  });
  await new Promise((r) => authServer.listen(0, "127.0.0.1", r));
  const authPort = authServer.address().port;
  sh(`git remote add origin http://127.0.0.1:${authPort}/demo.git`);
  sh("git config credential.helper \"\"");
  const askEvents = [];
  const askListener = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === "askpass") askEvents.push(e.request);
  };
  ws.addEventListener("message", askListener);
  const fj = (await post("/repo/fetch", { repoId })).job;
  for (let i = 0; i < 200 && askEvents.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check("askpass prompt arrived", askEvents.length === 1 && askEvents[0].kind === "username" && askEvents[0].jobId === fj.id, JSON.stringify(askEvents));
  if (askEvents[0]) {
    const pending = await post("/askpass/pending", {});
    check("askpass pending listed", pending.requests.length === 1);
    await post("/askpass/answer", { id: askEvents[0].id, value: "smoke-user" });
    for (let i = 0; i < 200 && askEvents.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    check("askpass asks password next", askEvents.length === 2 && askEvents[1].kind === "password", JSON.stringify(askEvents.map((a) => a.kind)));
    if (askEvents[1]) await post("/askpass/answer", { id: askEvents[1].id, value: "s3cret" });
  }
  const fjd = await waitJob(fj.id);
  check("fetch failed with 401 after answering", fjd.state === "failed", fjd.state);
  check("credentials reached the server", seenAuth === "Basic " + Buffer.from("smoke-user:s3cret").toString("base64"), seenAuth);
  ws.removeEventListener("message", askListener);
  authServer.close();

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
