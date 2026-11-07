/** Tiny DOM builder. No virtual DOM: views rebuild their own container when their slice of state changes. */

export type Child = Node | string | number | null | undefined | false | Child[];

type Handler = (ev: never) => void;
export type Attrs = Record<string, string | number | boolean | Handler | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === "class") {
        el.className = String(value);
      } else if (key === "style") {
        el.setAttribute("style", String(value));
      } else if (key === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
        el.value = String(value);
      } else if (key === "checked" && el instanceof HTMLInputElement) {
        el.checked = value === true;
      } else if (key === "disabled" || key === "selected" || key === "hidden") {
        if (value === true) el.setAttribute(key, "");
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) {
      append(el, c);
    } else if (c instanceof Node) {
      el.appendChild(c);
    } else {
      el.appendChild(document.createTextNode(String(c)));
    }
  }
}

export function replaceChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

const rowDoubleClicks = new WeakMap<Element, { key: string; fn: () => void }>();

/** Registers the double-click action of a list row; `key` identifies the row across rebuilds. See watchDoubleClicks. */
export function onRowDoubleClick<T extends HTMLElement>(row: T, key: string, fn: () => void): T {
  rowDoubleClicks.set(row, { key, fn });
  return row;
}

/**
 * Double clicks for rows that are rebuilt between the two clicks: the native dblclick needs both clicks on the same
 * node, so the second mousedown is used instead (detail = click count, the OS double-click time), on a container that
 * survives re-renders. Even counts, so that quick double clicks on one row after another all register.
 */
export function watchDoubleClicks(container: HTMLElement): void {
  let lastKey: string | null = null;
  container.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    let hit: { key: string; fn: () => void } | undefined;
    for (let el = e.target as Element | null; el && el !== container; el = el.parentElement) {
      if (el.matches("button, a, input, select")) return;
      hit = rowDoubleClicks.get(el);
      if (hit) break;
    }
    const again = hit !== undefined && hit.key === lastKey && e.detail > 1 && e.detail % 2 === 0;
    lastKey = hit?.key ?? null;
    if (again && hit) {
      e.preventDefault();
      hit.fn();
    }
  });
}

/**
 * Draggable column separator. `pane` is the column left of it (above it when `vertical`); its size goes into the CSS
 * variable `name` on `host` (px, or % of the host size when `percent`). `onChange` gets the size when a drag ends, 0 for "back to the default"
 * (double click); the returned function applies a remembered size.
 */
export function setupSplitter(
  handle: HTMLElement,
  pane: HTMLElement,
  host: HTMLElement,
  opts: { name: string; min: number; max: number; percent?: boolean; vertical?: boolean; onChange: (value: number) => void },
): (saved: number | undefined) => void {
  const unit = opts.percent ? "%" : "px";
  const v = opts.vertical === true;
  const bodyClass = v ? "resizing-v" : "resizing";
  let dragging = false;
  const apply = (saved: number | undefined) => {
    if (dragging) return;
    if (saved !== undefined && saved >= opts.min && saved <= opts.max) host.style.setProperty(opts.name, `${saved}${unit}`);
    else host.style.removeProperty(opts.name);
  };
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = v ? e.clientY : e.clientX;
    const rect = pane.getBoundingClientRect();
    const startW = v ? rect.height : rect.width;
    const hostRect = host.getBoundingClientRect();
    const total = (v ? hostRect.height : hostRect.width) || 1;
    let value = 0;
    const move = (ev: MouseEvent) => {
      const px = startW + (v ? ev.clientY : ev.clientX) - start;
      value = Math.min(opts.max, Math.max(opts.min, opts.percent ? (px / total) * 100 : px));
      host.style.setProperty(opts.name, `${opts.percent ? value.toFixed(2) : Math.round(value)}${unit}`);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove(bodyClass);
      dragging = false;
      if (value) opts.onChange(opts.percent ? Number(value.toFixed(2)) : Math.round(value));
    };
    dragging = true;
    document.body.classList.add(bodyClass);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  // double click on the separator: back to the default size
  handle.addEventListener("dblclick", () => {
    host.style.removeProperty(opts.name);
    opts.onChange(0);
  });
  return apply;
}

export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
