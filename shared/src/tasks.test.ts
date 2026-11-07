import { describe, expect, it } from "vitest";
import { BUILT_IN_PRESETS, buildBranchName, commitPrefix, findTaskCodes, taskCodeFromBranch, taskLink } from "./tasks.js";

const jira = BUILT_IN_PRESETS[0]!.template;
const clickup = BUILT_IN_PRESETS[1]!.template;

describe("task templates", () => {
  it("builds the Jira branch name from the plan", () => {
    expect(buildBranchName(jira, { type: "feature", name: "new gang grades", code: "OST-52990" })).toBe("feature/new-gang-grades#OST-52990");
    expect(buildBranchName(jira, { type: "", name: "quick", code: "" })).toBe("quick");
  });

  it("builds the ClickUp branch name and commit prefix", () => {
    expect(buildBranchName(clickup, { name: "fish weight", code: "869eu8fkw" })).toBe("869eu8fkw_fish-weight");
    expect(commitPrefix(clickup, "869eu8fkw")).toBe("[869eu8fkw] ");
    expect(commitPrefix(jira, "OST-1")).toBe("");
  });

  it("recognises codes by pattern, not by template", () => {
    expect(taskCodeFromBranch(jira, "a.kor/bugfix/notif#OST-6827134")).toBe("OST-6827134");
    expect(taskCodeFromBranch(clickup, "869eu8fkw_fish-weight")).toBe("869eu8fkw");
    expect(taskCodeFromBranch(jira, "master")).toBeNull();
    expect(findTaskCodes(jira, "Merge OST-1 and OST-2 (OST-1 again)")).toEqual(["OST-1", "OST-2"]);
  });

  it("builds tracker links", () => {
    expect(taskLink(jira, "OST-52990")).toBe("https://chillgamingg.atlassian.net/browse/OST-52990");
    expect(taskLink({ ...jira, linkTemplate: "" }, "OST-1")).toBeNull();
  });
});
