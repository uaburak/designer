import { app, type BaseWindow } from "electron";
import { askRestartRequired } from "./dialogs";
import { readSettings, writeSettings } from "./session";
import { controllers } from "./window";

/**
 * Help › Troubleshooting (atlas 21 §7, Figma desktop's menu), the parts this app has:
 * - Disable Hardware Acceleration: a check kept in settings.json, after Figma's "Restart required" box; the app
 *   relaunches (its files flushed by the usual quit) and starts without the GPU (`initTroubleshooting`, before ready).
 * - Graphics Backend ▸ Default / WebGL2 / WebGPU: for this session only (Figma's isn't kept either); the file tabs load
 *   again with the engine's `?force-webgl2=1` / `?force-webgpu=1` (engine/gfx.ts), and new ones open with it. Figma's
 *   WebGL1 isn't offered: this renderer has no WebGL1 path.
 * - Reload All Tabs.
 * The logs (Save Debug Info…, Save Network Log…, Save Performance Log…) are diagnostics.ts's. Not here: Reset and
 * Restart (it would wipe local data that, unlike Figma's, includes the workspace's own files), Prefer High-Performance
 * GPU (Windows only).
 */

export type GraphicsBackend = "default" | "webgl2" | "webgpu";

let backend: GraphicsBackend = "default";

export const graphicsBackend = (): GraphicsBackend => backend;
export const hardwareAccelerationDisabled = (): boolean => readSettings().disableHardwareAcceleration === true;

/** At launch, before ready: the GPU left off when the user turned it off. */
export function initTroubleshooting(): void {
  if (hardwareAccelerationDisabled()) app.disableHardwareAcceleration();
}

/** The engine's switch for a backend (engine/gfx.ts reads it from the page's address). */
export function backendQuery(b: GraphicsBackend = backend): Record<string, string> {
  return b === "webgl2" ? { "force-webgl2": "1" } : b === "webgpu" ? { "force-webgpu": "1" } : {};
}

/** A page's address with the backend's switch (and no other's). */
export function withBackend(url: string, b: GraphicsBackend = backend): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("force-webgl2");
    u.searchParams.delete("force-webgpu");
    for (const [k, v] of Object.entries(backendQuery(b))) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return url;
  }
}

/** Graphics Backend ▸ …: kept for the session, every window's tabs loaded again with it. */
export function setGraphicsBackend(next: GraphicsBackend): void {
  if (next === backend) return;
  backend = next;
  for (const ctl of controllers.values()) ctl.tabs.reloadAll((url) => withBackend(url));
}

/** Disable Hardware Acceleration clicked: asked first, kept, then the app starts again. */
export async function toggleHardwareAcceleration(win: BaseWindow | null): Promise<void> {
  const next = !hardwareAccelerationDisabled();
  if (!(await askRestartRequired(win))) return;
  const { disableHardwareAcceleration: _old, ...rest } = readSettings();
  writeSettings(next ? { ...rest, disableHardwareAcceleration: true } : rest);
  app.relaunch();
  app.quit();
}

/** Reload All Tabs. */
export function reloadAllTabs(): void {
  for (const ctl of controllers.values()) ctl.tabs.reloadAll();
}
