/** Minimal store: set() merges a patch and notifies subscribers with the set of changed keys (batched per tick). */
export class Store<S extends object> {
  private listeners = new Set<(changed: Set<keyof S>) => void>();
  private pending = new Set<keyof S>();
  private scheduled = false;

  constructor(public state: S) {}

  set(patch: Partial<S>): void {
    for (const key of Object.keys(patch) as (keyof S)[]) {
      const next = patch[key] as S[keyof S];
      if (this.state[key] === next) continue;
      this.state[key] = next;
      this.pending.add(key);
    }
    if (this.pending.size && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** Force listeners for keys whose value was mutated in place. */
  touch(...keys: (keyof S)[]): void {
    for (const k of keys) this.pending.add(k);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    const changed = this.pending;
    this.pending = new Set();
    for (const l of this.listeners) l(changed);
  }

  subscribe(fn: (changed: Set<keyof S>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
