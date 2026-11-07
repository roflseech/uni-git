/**
 * UnityYAMLMerge: finding it (the editor of the project's ProjectVersion.txt in Unity Hub, else the newest installed),
 * making git use it as the merge driver of scenes/prefabs for the merges this app runs (GIT_CONFIG_* environment and
 * an attributes file in data/, nothing written to the repository), and running it on a conflicted file directly.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UNITY_YAML_EXTENSIONS } from "@uni-git/shared";

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

/** m_EditorVersion of the Unity project at the repository root or one folder below it. */
export function projectEditorVersion(repo: string): string | null {
  const read = (dir: string): string | null => {
    try {
      return /m_EditorVersion:\s*(\S+)/.exec(readFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), "utf8"))?.[1] ?? null;
    } catch {
      return null;
    }
  };
  const own = read(repo);
  if (own) return own;
  try {
    for (const e of readdirSync(repo, { withFileTypes: true }).slice(0, 200)) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const v = read(join(repo, e.name));
      if (v) return v;
    }
  } catch {
    /* unreadable folder */
  }
  return null;
}

/** Folders holding one folder per installed editor version (Unity Hub's default and its custom install location). */
function hubEditorFolders(): string[] {
  const out: string[] = [];
  const secondary = (file: string) => {
    try {
      const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    } catch {
      /* no custom location */
    }
  };
  if (WIN) {
    for (const pf of [process.env.ProgramFiles, process.env.ProgramW6432, "C:\\Program Files"]) if (pf) out.push(join(pf, "Unity", "Hub", "Editor"));
    if (process.env.APPDATA) secondary(join(process.env.APPDATA, "UnityHub", "secondaryInstallPath.json"));
  } else if (MAC) {
    out.push("/Applications/Unity/Hub/Editor");
    secondary(join(homedir(), "Library", "Application Support", "UnityHub", "secondaryInstallPath.json"));
  } else {
    out.push(join(homedir(), "Unity", "Hub", "Editor"));
    secondary(join(homedir(), ".config", "UnityHub", "secondaryInstallPath.json"));
  }
  return [...new Set(out)];
}

function toolOf(editorDir: string): string {
  if (WIN) return join(editorDir, "Editor", "Data", "Tools", "UnityYAMLMerge.exe");
  if (MAC) return join(editorDir, "Unity.app", "Contents", "Tools", "UnityYAMLMerge");
  return join(editorDir, "Editor", "Data", "Tools", "UnityYAMLMerge");
}

/** 2022.3.62f3 < 6000.0.1f1: numbers compared one by one, letters ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/\D+/).filter(Boolean).map(Number);
  const pb = b.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const found = new Map<string, { at: number; tool: string | null }>();

/** The configured path, else the editor of the project, else the newest editor installed. Cached for 30 s. */
export function findUnityYamlMerge(repo: string | null, configured?: string): string | null {
  if (configured?.trim()) return existsSync(configured.trim()) ? configured.trim() : null;
  const key = repo ?? "";
  const hit = found.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.tool;
  let tool: string | null = null;
  const folders = hubEditorFolders();
  const version = repo ? projectEditorVersion(repo) : null;
  if (version) tool = folders.map((f) => toolOf(join(f, version))).find((p) => existsSync(p)) ?? null;
  if (!tool) {
    const all: { version: string; tool: string }[] = [];
    for (const f of folders) {
      try {
        for (const v of readdirSync(f)) {
          const p = toolOf(join(f, v));
          if (existsSync(p)) all.push({ version: v, tool: p });
        }
      } catch {
        /* folder absent */
      }
    }
    all.sort((x, y) => compareVersions(y.version, x.version));
    tool = all[0]?.tool ?? null;
  }
  if (!tool) {
    const standalone = WIN ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Unity", "Editor", "Data", "Tools", "UnityYAMLMerge.exe") : "/Applications/Unity/Unity.app/Contents/Tools/UnityYAMLMerge";
    if (existsSync(standalone)) tool = standalone;
  }
  found.set(key, { at: Date.now(), tool });
  return tool;
}

/** Name of the merge driver; the usual one, so a repository's own `merge=unityyamlmerge` attributes use it as well. */
const DRIVER = "unityyamlmerge";

/** Arguments of a merge: base, theirs ("left"), ours ("right"), result. -h: no dialogs; --force: any file name. */
export const YAML_MERGE_ARGS = ["merge", "-h", "-p", "--force", "--fallback", "none"];

/**
 * Environment for a git command that may merge: UnityYAMLMerge as the merge driver of Unity YAML files.
 * `userAttributes` is the attributes file the user has configured (core.attributesFile): it is replaced for the
 * command, so its content goes first into ours. GIT_CONFIG_COUNT needs git 2.31 or newer.
 */
export function unityMergeEnv(dataDir: string, tool: string, userAttributes: string | null): Record<string, string> {
  let own = "";
  if (userAttributes) {
    try {
      own = readFileSync(userAttributes, "utf8");
    } catch {
      /* configured but absent */
    }
  }
  const content = `${own}${own && !own.endsWith("\n") ? "\n" : ""}# uni-git: Unity scenes and prefabs merge with UnityYAMLMerge\n${UNITY_YAML_EXTENSIONS.map((e) => `*${e} merge=${DRIVER}`).join("\n")}\n`;
  // one file per content: jobs of two repositories may write at the same time
  const dir = join(dataDir, "unity");
  const file = join(dir, `gitattributes-${createHash("sha1").update(content).digest("hex").slice(0, 10)}`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
  }
  // git runs the driver through sh: single quotes keep the path as it is, forward slashes work on Windows too
  const quoted = `'${tool.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
  const config: [string, string][] = [
    [`merge.${DRIVER}.name`, "UnityYAMLMerge (uni-git)"],
    [`merge.${DRIVER}.driver`, `${quoted} ${YAML_MERGE_ARGS.join(" ")} %O %B %A %A`],
    // criss-cross merges: the virtual base is not merged with it
    [`merge.${DRIVER}.recursive`, "binary"],
    ["core.attributesFile", file.replace(/\\/g, "/")],
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(config.length) };
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** Default user attributes file when core.attributesFile is not set. */
export function defaultAttributesFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "git", "attributes");
}

export interface ToolResult {
  code: number;
  output: string;
}

/** Runs UnityYAMLMerge (or any tool) with a cancel signal; output is stdout + stderr. */
export function runTool(tool: string, args: string[], signal?: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const child = spawn(tool, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`${tool}: ${e.message}`));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("cancelled"));
      else resolve({ code: code ?? -1, output });
    });
  });
}
