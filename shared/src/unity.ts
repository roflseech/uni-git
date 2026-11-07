/**
 * Unity scenes, prefabs and other serialized assets (text YAML: `--- !u!<classId> &<fileID>` documents).
 * The backend merges them with UnityYAMLMerge (as git's merge driver) and, for what is left, with its own
 * object/property merge that the UI previews (backend/src/parse/unityMerge.ts).
 */

/** Extensions of Unity's text-serialized assets: previewed as objects, merged with UnityYAMLMerge. */
export const UNITY_YAML_EXTENSIONS = [
  ".unity",
  ".prefab",
  ".asset",
  ".mat",
  ".anim",
  ".controller",
  ".overrideController",
  ".physicMaterial",
  ".physicsMaterial2D",
  ".mask",
  ".playable",
  ".signal",
  ".preset",
  ".lighting",
  ".mixer",
  ".spriteatlas",
  ".terrainlayer",
  ".renderTexture",
  ".flare",
  ".guiskin",
  ".fontsettings",
  ".brush",
] as const;

export function isUnityYamlPath(path: string): boolean {
  const lower = path.toLowerCase();
  return UNITY_YAML_EXTENSIONS.some((ext) => lower.endsWith(ext.toLowerCase()));
}

/**
 * How an array conflict (both branches changed the same list differently) is resolved:
 * combine = ours, minus what theirs removed, plus what theirs added; unique = every distinct item of both;
 * positions = item by item, the side that changed a position wins (theirs where both did).
 * keep / delete: an object deleted on one branch and changed on the other.
 */
export type UnityChoice = "ours" | "theirs" | "combine" | "unique" | "positions" | "keep" | "delete";

/** One changed property of an object. Values are display text; an absent value did not exist. */
export interface UnityChange {
  /** path inside the object: m_LocalPosition.x, m_Materials[1], m_Modifications[m_Name @ 1234].value */
  path: string;
  old?: string;
  new?: string;
  /** a list whose items were added / removed (instead of old → new) */
  added?: string[];
  removed?: string[];
}

export interface UnityObjectRef {
  fileId: string;
  /** Unity class name: GameObject, Transform, MonoBehaviour… */
  type: string;
  /** hierarchy path of the GameObject the object belongs to (Root/Child), "" when unknown */
  owner: string;
  /** script class of a MonoBehaviour, found by the guid of its .cs.meta */
  script?: string;
}

export interface UnityObjectDiff extends UnityObjectRef {
  state: "added" | "removed" | "changed";
  changes: UnityChange[];
}

export interface UnityConflictOption {
  choice: UnityChoice;
  label: string;
  /** display lines of the result: one line per list item, or the value */
  result: string[];
}

export interface UnityConflict extends UnityObjectRef {
  /** stable key of the conflict, sent back with the choice */
  id: string;
  /** property path, "" = the whole object */
  path: string;
  kind: "value" | "array" | "object";
  /** display lines per side; absent = the side does not have it */
  base?: string[];
  ours?: string[];
  theirs?: string[];
  options: UnityConflictOption[];
}

export interface UnityPreview {
  path: string;
  /** diff: changes between two versions; merge: a conflicted file (index stages base / ours / theirs) */
  mode: "diff" | "merge";
  /** diff: what changed; merge: what the merge brings into ours without a question (theirs' changes) */
  objects: UnityObjectDiff[];
  conflicts: UnityConflict[];
  /** objects in the newer version (diff) / in ours (merge), for the summary line */
  total: number;
  /** why there is no preview: not Unity YAML, too large, a side missing */
  error?: string;
  /** merge: UnityYAMLMerge used for this repository, null when it was not found */
  yamlMerge?: string | null;
}
