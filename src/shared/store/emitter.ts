export type Unsubscribe = () => void;

/** A minimal typed event emitter; a throwing listener never stops the others. */
export class Emitter<T> {
  private readonly listeners = new Set<(e: T) => void>();

  on(listener: (e: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error("store: event listener failed", err);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
