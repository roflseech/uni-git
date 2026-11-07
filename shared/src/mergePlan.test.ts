import { describe, expect, it } from "vitest";
import { mergePlan, planCommands } from "./mergePlan.js";

const ctx = { main: "master", current: "feature/x", remote: "origin", stash: false };

describe("mergePlan", () => {
  it("merge main", () => {
    expect(planCommands(mergePlan("main", ctx))).toEqual(["git merge --no-edit master"]);
  });

  it("update main and merge, with stash", () => {
    expect(planCommands(mergePlan("force-main", { ...ctx, stash: true }))).toEqual([
      'git stash push --include-untracked -m "uni-git: before update main and merge"',
      "git fetch --progress origin master:master",
      "git merge --no-edit master",
      "git stash pop",
    ]);
  });

  it("update main while on main pulls instead of fetch+merge", () => {
    expect(planCommands(mergePlan("force-main", { ...ctx, current: "master" }))).toEqual(["git pull --no-rebase --progress origin master"]);
  });

  it("merge into main pushes at the end", () => {
    expect(planCommands(mergePlan("into-main", ctx))).toEqual([
      "git switch master",
      "git pull --no-rebase --progress",
      "git merge --no-edit feature/x",
      "git push --progress",
    ]);
  });
});
