/**
 * The login gate's rules (docs/desktop.md §18.6), without Electron so the tests drive them: when the gate is off, and
 * what waits for a sign-in.
 */

/**
 * The gate is off — the app opens straight to Home without an account — only for development and tests:
 * `DESIGNER_NO_LOGIN=1`, the demo (`npm run dev:demo`: `DESIGNER_SEED=demo`), and the driven app (`DESIGNER_TEST=1`,
 * scripts/drive.mjs) unless it asks for the gate with `DESIGNER_LOGIN=1`. A packaged app has none of these set.
 */
export function loginBypassed(env: Record<string, string | undefined>): boolean {
  if (env.DESIGNER_LOGIN === "1") return false;
  return env.DESIGNER_NO_LOGIN === "1" || env.DESIGNER_SEED === "demo" || env.DESIGNER_TEST === "1";
}

/**
 * What arrived for the app while nobody was signed in — a shared file's `designer://` link, a .fig opened from the
 * Finder — kept (in order, the same one once, at most `max`) and run after the next sign-in. Run at once while open.
 */
export class OpenQueue {
  private items: { key: string; run: () => void }[] = [];

  constructor(
    private readonly isOpen: () => boolean,
    private readonly max = 20,
  ) {}

  /** Runs `run` now when the app is open, else keeps it under `key` (a newer one with the same key replaces it). */
  add(key: string, run: () => void): "ran" | "queued" {
    if (this.isOpen()) {
      run();
      return "ran";
    }
    this.items = this.items.filter((i) => i.key !== key);
    this.items.push({ key, run });
    if (this.items.length > this.max) this.items.shift();
    return "queued";
  }

  /** After a sign-in: everything kept, in order (nothing when still closed). */
  flush(): number {
    if (!this.isOpen()) return 0;
    const items = this.items.splice(0);
    for (const i of items) {
      try {
        i.run();
      } catch (err) {
        console.warn("[gate] a kept link didn't open:", err instanceof Error ? err.message : err);
      }
    }
    return items.length;
  }

  get size(): number {
    return this.items.length;
  }
}
