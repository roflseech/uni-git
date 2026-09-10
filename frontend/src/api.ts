import type { Api, ApiRoute, ServerEvent } from "@epic-git/shared";
import type { Session } from "./session.js";

export class ApiClient {
  private ws: WebSocket | null = null;
  private closed = false;

  /** shellPid: NL_PID of the Neutralino shell, so the backend can exit the moment the shell is gone. */
  constructor(
    private readonly session: Session,
    private readonly shellPid: number | null = null,
  ) {}

  async call<R extends ApiRoute>(route: R, body: Api[R]["req"]): Promise<Api[R]["res"]> {
    const r = await fetch(`http://127.0.0.1:${this.session.port}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${route}: invalid response`);
    }
    if (!r.ok) {
      const err = data as { error?: string };
      throw new Error(err.error ?? `${route} failed (${r.status})`);
    }
    return data as Api[R]["res"];
  }

  /** Fire-and-forget shutdown used while the window is closing. */
  shutdown(): void {
    try {
      fetch(`http://127.0.0.1:${this.session.port}/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.session.token}` },
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* closing anyway */
    }
  }

  connectEvents(onEvent: (e: ServerEvent) => void, onState: (connected: boolean) => void): void {
    const open = () => {
      if (this.closed) return;
      const pid = this.shellPid ? `&shellPid=${this.shellPid}` : "";
      const ws = new WebSocket(`ws://127.0.0.1:${this.session.port}/events?token=${this.session.token}${pid}`);
      this.ws = ws;
      ws.onopen = () => onState(true);
      ws.onmessage = (m) => {
        try {
          onEvent(JSON.parse(String(m.data)) as ServerEvent);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        onState(false);
        if (!this.closed) setTimeout(open, 1000);
      };
      ws.onerror = () => ws.close();
    };
    open();
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
