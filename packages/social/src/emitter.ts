type Cb = (x: any) => void;

/** Tiny event emitter. A listener that throws never breaks publishing. */
export class Emitter {
  private map = new Map<string, Set<Cb>>();
  on(ev: string, cb: Cb): void {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev)!.add(cb);
  }
  off(ev: string, cb: Cb): void {
    this.map.get(ev)?.delete(cb);
  }
  emit(ev: string, x: unknown): void {
    for (const cb of this.map.get(ev) ?? []) {
      try {
        cb(x);
      } catch {
        /* listener errors are the host's problem */
      }
    }
  }
  clear(): void {
    this.map.clear();
  }
}
