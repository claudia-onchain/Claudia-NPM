type Cb = (x: any) => void;

/** Tiny event emitter; listener errors never break the queue. */
export class Emitter {
  private map = new Map<string, Set<Cb>>();
  on(ev: string, cb: Cb): void {
    let s = this.map.get(ev);
    if (!s) this.map.set(ev, (s = new Set()));
    s.add(cb);
  }
  off(ev: string, cb: Cb): void {
    this.map.get(ev)?.delete(cb);
  }
  emit(ev: string, x: unknown): void {
    for (const cb of this.map.get(ev) ?? []) {
      try {
        cb(x);
      } catch {
        // ignore listener errors
      }
    }
  }
  clear(): void {
    this.map.clear();
  }
}
