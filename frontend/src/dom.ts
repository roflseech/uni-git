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

export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
