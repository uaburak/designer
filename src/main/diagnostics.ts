import { app, contentTracing, dialog, session, type BaseWindow } from "electron";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
import { t } from "../shared/i18n";
import { readSettings } from "./session";
import { graphicsBackend, hardwareAccelerationDisabled } from "./troubleshooting";
import { controllers } from "./window";

/**
 * Help › Troubleshooting's logs (atlas 21 §7, Figma desktop's): Save Debug Info…, Save Network Log… ("You'll get a
 * prompt after 30 seconds to save the network log file.") and Save Performance Log… / Stop Performance Logging….
 * Each file goes only where the person saves it. The debug info names no file: the tabs are counted by kind and state,
 * never titled. What the debug info holds is ours (Figma's isn't read); "Restart and Save Performance Log…" isn't here.
 */

/** Figma's wait before the network log is saved */
export const NETWORK_LOG_MS = 30_000;

/** The debug info: the app, the system, the GPU, the processes' memory, the windows' tabs (counted), the settings. */
export async function debugInfo(): Promise<Record<string, unknown>> {
  const gpu = await app.getGPUInfo("basic").catch(() => null);
  const { shortcuts: _shortcuts, ...settings } = readSettings();
  return {
    app: { name: app.getName(), version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, locale: app.getLocale() },
    system: { platform: process.platform, arch: process.arch, release: release() },
    graphics: { backend: graphicsBackend(), hardwareAccelerationDisabled: hardwareAccelerationDisabled(), featureStatus: app.getGPUFeatureStatus(), info: gpu },
    processes: app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, workingSetKB: m.memory.workingSetSize, peakWorkingSetKB: m.memory.peakWorkingSetSize, cpuPercent: m.cpu.percentCPUUsage })),
    windows: [...controllers.values()].map((c) => {
      const counts: Record<string, number> = {};
      for (const tab of c.tabs.state.tabs) counts[`${tab.kind}:${tab.status}`] = (counts[`${tab.kind}:${tab.status}`] ?? 0) + 1;
      return { tabs: c.tabs.state.tabs.length, closed: c.tabs.state.closed.length, byKindAndState: counts };
    }),
    settings,
    savedAt: new Date().toISOString(),
  };
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

async function saveAs(win: BaseWindow | null, title: string, name: string, write: (path: string) => Promise<void>): Promise<boolean> {
  const options = { title, defaultPath: join(app.getPath("downloads"), name) };
  const { canceled, filePath } = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return false;
  await write(filePath);
  return true;
}

/** Save Debug Info…: the debug info as JSON, where the person saves it. */
export async function saveDebugInfo(win: BaseWindow | null): Promise<boolean> {
  const info = await debugInfo();
  return saveAs(win, t("Save Debug Info"), `${app.getName()} Debug Info ${stamp()}.json`, (path) => writeFile(path, JSON.stringify(info, null, 2)));
}

let networkLogging = false;

/** Save Network Log…: Chromium's net log of every view for 30 s, then the save prompt. */
export async function saveNetworkLog(win: BaseWindow | null): Promise<boolean> {
  if (networkLogging) return false;
  networkLogging = true;
  const dir = await mkdtemp(join(tmpdir(), "net-log-"));
  const file = join(dir, "net-log.json");
  try {
    await session.defaultSession.netLog.startLogging(file, { captureMode: "default" });
    const told = { type: "info" as const, message: t("Recording the network log"), detail: t("You'll get a prompt after 30 seconds to save the network log file."), buttons: [t("OK")] };
    void (win && !win.isDestroyed() ? dialog.showMessageBox(win, told) : dialog.showMessageBox(told));
    await new Promise((r) => setTimeout(r, NETWORK_LOG_MS));
    await session.defaultSession.netLog.stopLogging();
    return await saveAs(win, t("Save Network Log"), `${app.getName()} Network Log ${stamp()}.json`, (path) => copyFile(file, path));
  } finally {
    networkLogging = false;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

let tracing = false;

export const performanceLogging = (): boolean => tracing;

/** Save Performance Log… starts a trace; Stop Performance Logging… ends it and asks where to save it. */
export async function togglePerformanceLog(win: BaseWindow | null, changed: () => void): Promise<boolean> {
  if (!tracing) {
    await contentTracing.startRecording({ included_categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "blink", "cc", "gpu", "toplevel"] });
    tracing = true;
    changed();
    return true;
  }
  const dir = await mkdtemp(join(tmpdir(), "perf-log-"));
  try {
    const file = await contentTracing.stopRecording(join(dir, "trace.json"));
    tracing = false;
    changed();
    return await saveAs(win, t("Save Performance Log"), `${app.getName()} Performance Log ${stamp()}.json`, (path) => copyFile(file, path));
  } finally {
    tracing = false;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
