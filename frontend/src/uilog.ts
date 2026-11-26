/**
 * Diagnostic lines from the page into data/logs/backend.log: the shell swallows the page's console, and the inspector
 * is off. Lines logged before the backend is found are kept (a few) and sent once it is.
 */
let sink: ((line: string) => void) | null = null;
const pending: string[] = [];

export function uiLog(line: string): void {
  if (sink) sink(line);
  else if (pending.length < 50) pending.push(line);
}

export function setUiLogSink(fn: (line: string) => void): void {
  sink = fn;
  for (const line of pending.splice(0)) fn(line);
}

/** Uncaught errors and rejections, the first few of each kind per page load (a loop would repeat the same one). */
export function logUncaughtErrors(): void {
  let errors = 0;
  window.addEventListener("error", (e) => {
    if (++errors > 20) return;
    const where = e.filename ? ` at ${e.filename.replace(/^.*\//, "")}:${e.lineno}:${e.colno}` : "";
    uiLog(`error: ${e.message}${where}`);
  });
  let rejections = 0;
  window.addEventListener("unhandledrejection", (e) => {
    if (++rejections > 20) return;
    const r: unknown = e.reason;
    uiLog(`unhandled rejection: ${r instanceof Error ? r.message : describe(r)}`);
  });
}

function describe(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
