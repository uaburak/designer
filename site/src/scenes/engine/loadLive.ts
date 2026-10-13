// Loads the engine's chunk (live.ts) once per page: after the first paint, when the browser is idle — or at once when
// the visitor asks for the canvas.
export type LiveEngine = typeof import("./live");

let loading: Promise<LiveEngine> | null = null;
let release: (() => void) | null = null;

export function loadLive(now = false): Promise<LiveEngine> {
  if (now) release?.();
  loading ??= new Promise<void>((resolve) => {
    release = resolve;
    if (now) return resolve();
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    requestAnimationFrame(() => {
      if (idle) idle(() => resolve(), { timeout: 1200 });
      else setTimeout(resolve, 200);
    });
  }).then(() => import("./live"));
  return loading;
}
