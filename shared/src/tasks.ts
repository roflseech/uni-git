/**
 * Task templates (plan, section 3 "Интеграция с задачами"): how task codes look, how branch names and commit
 * messages are built from them, and where the tracker link points. Pure functions, used by both sides.
 */

export interface TaskTemplate {
  /** Regular expression that recognises a task code in branch names and commit messages, e.g. [A-Z]+-\d+ */
  codePattern: string;
  /** Placeholders: {type}, {name}, {code} */
  branchTemplate: string;
  /** Values for {type}; empty = no type field in the dialog */
  types: string[];
  /** Placeholders: {code}, {message}; empty = commits stay unmarked */
  commitTemplate: string;
  /** Placeholder: {code} */
  linkTemplate: string;
}

export interface TaskPreset {
  name: string;
  template: TaskTemplate;
  builtIn: boolean;
}

export const BUILT_IN_PRESETS: TaskPreset[] = [
  {
    name: "Jira",
    builtIn: true,
    template: {
      codePattern: "[A-Z]+-\\d+",
      branchTemplate: "{type}/{name}#{code}",
      types: ["feature", "fix"],
      commitTemplate: "",
      linkTemplate: "https://chillgamingg.atlassian.net/browse/{code}",
    },
  },
  {
    name: "ClickUp",
    builtIn: true,
    template: {
      codePattern: "[0-9a-z]{9}",
      branchTemplate: "{code}_{name}",
      types: [],
      commitTemplate: "[{code}] {message}",
      linkTemplate: "https://app.clickup.com/t/3862640/{code}",
    },
  },
];

function codeRegex(t: TaskTemplate, flags = ""): RegExp | null {
  if (!t.codePattern.trim()) return null;
  try {
    return new RegExp(t.codePattern, flags);
  } catch {
    return null;
  }
}

/** First task code found in a branch name (works for branches made by hand or by colleagues). */
export function taskCodeFromBranch(t: TaskTemplate | null | undefined, branch: string | null | undefined): string | null {
  if (!t || !branch) return null;
  const re = codeRegex(t);
  const m = re?.exec(branch);
  return m ? m[0] : null;
}

/** All distinct task codes in a text (commit message), in order of appearance. */
export function findTaskCodes(t: TaskTemplate | null | undefined, text: string): string[] {
  if (!t) return [];
  const re = codeRegex(t, "g");
  if (!re) return [];
  const out: string[] = [];
  for (const m of text.matchAll(re)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

/** Branch name from the dialog fields; empty placeholders and their separators are dropped. */
export function buildBranchName(t: TaskTemplate, fields: { type?: string; name: string; code?: string }): string {
  const name = slugify(fields.name);
  const type = (fields.type ?? "").trim();
  const code = (fields.code ?? "").trim();
  let out = t.branchTemplate || "{name}";
  out = out.replace("{type}", type).replace("{name}", name).replace("{code}", code);
  // clean up leftovers of empty parts: "/name", "name#", "_name"
  out = out.replace(/^[\/#_\-]+/, "").replace(/[\/#_\-]+$/, "").replace(/\/{2,}/g, "/");
  return out;
}

/** "feature branch name" → "feature-branch-name" */
export function slugify(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[~^:?*[\]\\@{}]+/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-");
}

/** Prefix the commit subject gets from the template, e.g. "[869eu8fkw] "; empty when the template has none. */
export function commitPrefix(t: TaskTemplate | null | undefined, code: string | null): string {
  if (!t || !code || !t.commitTemplate.trim() || !t.commitTemplate.includes("{message}")) return "";
  const [before] = t.commitTemplate.split("{message}");
  return (before ?? "").replace("{code}", code);
}

export function taskLink(t: TaskTemplate | null | undefined, code: string): string | null {
  if (!t || !t.linkTemplate.trim()) return null;
  return t.linkTemplate.replace("{code}", encodeURIComponent(code));
}

export function sameTemplate(a: TaskTemplate, b: TaskTemplate): boolean {
  return (
    a.codePattern === b.codePattern &&
    a.branchTemplate === b.branchTemplate &&
    a.commitTemplate === b.commitTemplate &&
    a.linkTemplate === b.linkTemplate &&
    a.types.join(",") === b.types.join(",")
  );
}
