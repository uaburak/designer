import { app } from "electron";
import { join } from "node:path";

/**
 * The trackpad's haptic tick (docs/desktop.md §10.2 "Haptics"; round 16): a view sends `haptics:tick` on each step of
 * a scrub (ds NumericInput), main plays macOS's NSHapticFeedbackManager "alignment" pattern at once — Figma's desktop
 * app does the same. Electron has no API for it: native/haptics/haptics.node is a tiny Node-API addon (built by
 * native/haptics/build.mjs, committed universal; shipped as an extra resource). Every tick — a panel scrub's step or
 * the canvas's (the engine's haptic events come through the same `haptics:tick`) — passes one throttle: at most one
 * in 80 ms, the ones in between dropped (never queued); nothing off macOS, or when the addon can't load.
 */

/**
 * At most one tick in this many ms (round 17, the owner: a fast scrub's ticks at up to 60 a second ran together into a
 * buzz and lost their feel; 70–90 ms apart each one still reads as a tick — 80, 12.5 a second). A slow scrub (a step
 * every 80 ms or more) still ticks on every step.
 */
export const HAPTIC_MIN_INTERVAL_MS = 80;

/** A clock-driven gate: true when a tick may play at `now` (ms), and then the next one waits its interval. */
export function createHapticThrottle(minIntervalMs = HAPTIC_MIN_INTERVAL_MS) {
  let last = -Infinity;
  return (now: number): boolean => {
    // A clock that went back (a test, a suspended machine): start over.
    if (now < last) last = -Infinity;
    if (now - last < minIntervalMs - 1e-6) return false;
    last = now;
    return true;
  };
}

type Addon = { perform(pattern?: number): boolean };
let addon: Addon | null | undefined;

/** The addon: next to the app's resources when packaged, under native/haptics in development. */
function load(): Addon | null {
  if (addon !== undefined) return addon;
  addon = null;
  if (process.platform !== "darwin") return addon;
  const path = app.isPackaged ? join(process.resourcesPath, "haptics.node") : join(app.getAppPath(), "native", "haptics", "haptics.node");
  try {
    const mod = { exports: {} as Partial<Addon> };
    process.dlopen(mod, path);
    if (typeof mod.exports.perform === "function") addon = mod.exports as Addon;
  } catch (err) {
    console.warn(`[haptics] not loaded (${path}):`, err instanceof Error ? err.message : err);
  }
  return addon;
}

const gate = createHapticThrottle();

/** One tick, if the throttle lets it through: true when it was played. */
export function hapticTick(now = performance.now()): boolean {
  if (process.platform !== "darwin" || !gate(now)) return false;
  const a = load();
  if (!a) return false;
  try {
    return a.perform(1);
  } catch {
    return false;
  }
}
