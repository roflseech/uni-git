/**
 * The backend's own connection to the Neutralino shell, as its extension.
 *
 * - It ends when the shell exits, though Node does not always report that (on Windows no close event arrives): the
 *   shell pid the page reports is the reliable signal, and main.ts watches it too.
 * - The shell broadcasts its events here too, windowClose included. The page normally handles the close (hide, then
 *   app.exit), but its client library never reconnects: once the page's own socket to the shell drops (seen after long
 *   sessions), the close button does nothing because exitProcessOnClose is off. So the backend gives the page a moment
 *   and then closes the window itself through this link, killing the shell process as the last resort.
 * - The events are logged, so data/logs/backend.log shows when the page loses or regains its link to the shell.
 */
import { randomUUID } from "node:crypto";

export interface ShellHandshake {
  nlPort: string;
  /** Access token for native calls; older shells may not send it. */
  nlToken?: string;
  nlConnectToken: string;
  nlExtensionId: string;
}

export interface ShellLinkOptions {
  handshake: ShellHandshake;
  log: (msg: string) => void;
  /** The socket is gone: the shell exited or crashed. */
  onClosed: (reason: string) => void;
  /** NL_PID reported by the page; null while unknown. */
  shellPid: () => number | null;
  isAlive: (pid: number) => boolean;
  /** How long the page gets to close the window itself after the user asked to. */
  closeGraceMs?: number;
  /** After app.exit, how long to wait for the shell before killing it. */
  exitGraceMs?: number;
}

/** Events that fire all the time and say nothing about the link. */
const QUIET_EVENTS = new Set(["windowFocus", "windowBlur", "extensionReady", "extClientConnect", "clientConnect", "clientDisconnect"]);

const CALL_TIMEOUT_MS = 500;
const SHELL_EXIT_CAP_MS = 6000;

export class ShellLink {
  private ws: WebSocket | null = null;
  private open = false;
  private readonly calls = new Map<string, (data: unknown) => void>();
  private closeTimer: NodeJS.Timeout | null = null;
  private exitPoll: NodeJS.Timeout | null = null;
  private closing: Promise<void> | null = null;
  private finishClosing: (() => void) | null = null;

  constructor(private readonly opts: ShellLinkOptions) {}

  connect(): void {
    const hs = this.opts.handshake;
    const ws = new WebSocket(
      `ws://127.0.0.1:${hs.nlPort}?extensionId=${encodeURIComponent(hs.nlExtensionId)}&connectToken=${encodeURIComponent(hs.nlConnectToken)}`,
    );
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.open = true;
      this.opts.log("connected to the Neutralino shell");
    });
    ws.addEventListener("message", (m) => this.onMessage(String(m.data)));
    ws.addEventListener("close", (ev) => this.onSocketGone(`shell connection closed (code ${ev.code})`));
    ws.addEventListener("error", () => this.onSocketGone("shell connection failed"));
  }

  /**
   * After a close request: resolves once the shell is gone or the fallback has done all it can (a few seconds at
   * most). Without a close request there is nothing to wait for.
   */
  shellExit(): Promise<void> {
    if (!this.closing) return Promise.resolve();
    return Promise.race([this.closing, new Promise<void>((r) => setTimeout(r, SHELL_EXIT_CAP_MS).unref())]);
  }

  private onMessage(text: string): void {
    let msg: { id?: string; event?: string; data?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (msg.id && this.calls.has(msg.id)) {
      const done = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      done?.(msg.data);
      return;
    }
    if (!msg.event) return;
    if (!QUIET_EVENTS.has(msg.event)) this.opts.log(`shell event: ${msg.event}${describe(msg.data)}`);
    if (msg.event === "windowClose") this.onWindowClose();
  }

  private onWindowClose(): void {
    if (this.closing) return;
    this.closing = new Promise((resolve) => (this.finishClosing = resolve));
    const asked = Date.now();
    const grace = this.opts.closeGraceMs ?? 1500;
    // The socket does not report the shell's exit reliably (no close event seen on Windows): watch the pid.
    this.exitPoll = setInterval(() => {
      if (this.shellAlive()) return;
      this.opts.log(`window closed: the shell exited ${Date.now() - asked} ms after the close request`);
      this.done();
    }, 50);
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.shellAlive()) void this.forceClose(`the page did not close the window within ${grace} ms`);
    }, grace);
  }

  private async forceClose(reason: string): Promise<void> {
    this.opts.log(`closing the window from the backend: ${reason}`);
    if (this.open && this.opts.handshake.nlToken) {
      // hide first, as the page does: WebView2 teardown keeps the window on screen for a while otherwise
      const hidden = await this.call("window.hide");
      if (hidden !== undefined && isError(hidden)) this.opts.log(`window.hide failed: ${describe(hidden)}`);
      const exit = await this.call("app.exit");
      if (exit !== undefined && isError(exit)) this.opts.log(`app.exit failed: ${describe(exit)}`);
      await this.waitForShellExit(this.opts.exitGraceMs ?? 1000);
    }
    if (this.finishClosing && this.shellAlive()) {
      const pid = this.opts.shellPid();
      if (pid !== null) {
        this.opts.log(`the shell (pid ${pid}) is still running: killing it`);
        try {
          process.kill(pid);
        } catch (e) {
          this.opts.log(`could not kill the shell: ${(e as Error).message}`);
        }
      } else {
        this.opts.log("the shell is still running and its pid is unknown: giving up");
      }
    }
    this.done();
  }

  /** Answer of a native call, or undefined when there is none within the timeout (app.exit never answers). */
  private call(method: string, data: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || !this.open) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        resolve(undefined);
      }, CALL_TIMEOUT_MS);
      this.calls.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      try {
        ws.send(JSON.stringify({ id, method, accessToken: this.opts.handshake.nlToken, data }));
      } catch {
        clearTimeout(timer);
        this.calls.delete(id);
        resolve(undefined);
      }
    });
  }

  /** By pid when the page has reported it; the socket state is only the fallback (it can stay "open" after the exit). */
  private shellAlive(): boolean {
    const pid = this.opts.shellPid();
    return pid !== null ? this.opts.isAlive(pid) : this.open;
  }

  private async waitForShellExit(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (this.shellAlive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }

  private onSocketGone(reason: string): void {
    const wasOpen = this.open || this.ws !== null;
    this.open = false;
    this.ws = null;
    if (!wasOpen) return;
    this.done();
    this.opts.onClosed(reason);
  }

  /** The close is over: the shell is gone, or the fallback did what it could. */
  private done(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.exitPoll) clearInterval(this.exitPoll);
    this.exitPoll = null;
    this.finishClosing?.();
    this.finishClosing = null;
  }
}

function isError(data: unknown): boolean {
  return typeof data === "object" && data !== null && "error" in data;
}

function describe(data: unknown): string {
  if (data === undefined || data === null || data === "") return "";
  try {
    const s = typeof data === "string" ? data : JSON.stringify(data);
    return ` ${s.length > 300 ? s.slice(0, 300) + "…" : s}`;
  } catch {
    return "";
  }
}
