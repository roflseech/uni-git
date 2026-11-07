declare const __UNI_GIT_VERSION__: string | undefined;

/**
 * Version of this build. Release builds get it from UNI_GIT_VERSION through bundle.mjs (tools/release/build.mjs sets it,
 * e.g. "0.1.57"); local builds are "<package version>-dev", tsx runs are "dev". Only release versions self-update.
 */
export const APP_VERSION: string = typeof __UNI_GIT_VERSION__ === "string" ? __UNI_GIT_VERSION__ : "dev";
