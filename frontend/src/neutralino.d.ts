// The client library is loaded as a classic script (window.Neutralino). Types come from the npm package, which
// ships the same API surface; only the typings are used, nothing from it is bundled.
declare const Neutralino: typeof import("@neutralinojs/lib");

/** Globals injected by the shell (undefined when the page is opened in a plain browser). */
declare const NL_PATH: string | undefined;
declare const NL_OS: string | undefined;
declare const NL_PID: number | undefined;
