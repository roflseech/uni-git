/**
 * The Branch menu scenarios (plan, section 3 "Меню Merge") as explicit git command plans. The backend executes
 * exactly these steps and the UI shows them as a preview on hover, so what you see is what runs.
 */

export type MergeMode = "main" | "force-main" | "into-main";

export type MergeStepKind = "stash" | "unstash" | "fetch" | "pull" | "switch" | "merge" | "push";

export interface MergeStep {
  kind: MergeStepKind;
  /** arguments after `git` */
  args: string[];
  label: string;
}

export interface MergeContext {
  /** base branch from Repo Settings (or detected) */
  main: string;
  /** branch checked out now */
  current: string;
  remote: string;
  /** stash uncommitted changes before, restore after */
  stash: boolean;
}

export const MERGE_TITLES: Record<MergeMode, string> = {
  main: "merge main",
  "force-main": "update main and merge",
  "into-main": "merge into main",
};

export function mergePlan(mode: MergeMode, c: MergeContext): MergeStep[] {
  const steps: MergeStep[] = [];
  if (c.stash) steps.push({ kind: "stash", args: ["stash", "push", "--include-untracked", "-m", `uni-git: before ${MERGE_TITLES[mode]}`], label: "stash changes" });

  if (mode === "main") {
    steps.push({ kind: "merge", args: ["merge", "--no-edit", c.main], label: `merge ${c.main} into ${c.current}` });
  } else if (mode === "force-main") {
    if (c.current === c.main) {
      steps.push({ kind: "pull", args: ["pull", "--no-rebase", "--progress", c.remote, c.main], label: `pull ${c.main} from ${c.remote}` });
    } else {
      steps.push({ kind: "fetch", args: ["fetch", "--progress", c.remote, `${c.main}:${c.main}`], label: `fetch ${c.remote}/${c.main} into local ${c.main}` });
      steps.push({ kind: "merge", args: ["merge", "--no-edit", c.main], label: `merge ${c.main} into ${c.current}` });
    }
  } else {
    steps.push({ kind: "switch", args: ["switch", c.main], label: `switch to ${c.main}` });
    steps.push({ kind: "pull", args: ["pull", "--no-rebase", "--progress"], label: `pull ${c.main}` });
    steps.push({ kind: "merge", args: ["merge", "--no-edit", c.current], label: `merge ${c.current} into ${c.main}` });
    steps.push({ kind: "push", args: ["push", "--progress"], label: `push ${c.main}` });
  }

  if (c.stash) steps.push({ kind: "unstash", args: ["stash", "pop"], label: "restore stashed changes" });
  return steps;
}

/** `git …` lines for the preview popup. */
export function planCommands(steps: MergeStep[]): string[] {
  return steps.map((s) => "git " + s.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
}

/** "Is `branch` merged into `into`?" and "Is commit `sha` in `branch`?" are the same question to git. */
export function isAncestorCommand(what: string, into: string): string[] {
  return ["merge-base", "--is-ancestor", what, into];
}
