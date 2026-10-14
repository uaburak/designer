import { app, BaseWindow, dialog, powerMonitor } from "electron";
import { autoUpdater, type NsisUpdater } from "electron-updater";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UpdateState, UpdaterStatus } from "../shared/ipc";
import { desktopPolicy, WIN_KEY } from "./policy";
import { t } from "../shared/i18n";

/**
 * The app's updates (docs/desktop.md §12.6), Figma's way: its desktop app updates itself through Squirrel; ours
 * through electron-updater (Squirrel.Mac underneath on a Mac, the NSIS installer on Windows) over a generic feed at
 * get.wecra.app/updates (`latest-mac.yml` / `latest.yml` and the files they name, served from R2 by site/worker;
 * electron-builder.yml `publish`, docs/site.md). Copies up to 1.1.2 read the GitHub releases of `uaburak/designer`.
 *
 * ~10 s after launch, then once a day (an hourly tick catches a day missed while the Mac slept, and so does waking
 * it). An update found downloads by itself; once it's in, the tab bar shows "Restart to update" and the app menu's
 * "Check for Updates…" becomes "Restart to Update". Nothing is forced: quitting installs it too
 * (`autoInstallOnAppQuit`). A background check never shows anything (errors are logged); "Check for Updates…" shows
 * its progress in the tab bar and its answer in a message box.
 *
 * Off in development, under `DisableUpdater` (§12.5), for an MSI install (`HKLM\SOFTWARE\DesignerV2\InstalledByMsi`,
 * the admin updates it) and for the Windows portable zip (no installer to run).
 *
 * "Restart to update" is the app's normal quit — every file flushed, the store shut down, session.json written
 * (window.ts `finishQuit`) — whose last step, instead of `app.exit`, hands over to the updater (`exitForUpdate`).
 */

/** What we use of electron-updater's `autoUpdater` (a fake in updater.test.ts) */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown> | null;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const TICK_MS = 60 * 60 * 1000;

export interface Gate {
  packaged: boolean;
  platform: NodeJS.Platform;
  /** `DisableUpdater` (docs/desktop.md §12.5) */
  disableUpdater: boolean;
  /** Windows: `HKLM\SOFTWARE\DesignerV2\InstalledByMsi` is set */
  msi: boolean;
  /** Windows: installed by the NSIS installer (its uninstaller next to the .exe); the portable zip has none */
  nsis: boolean;
}

/** Why the updater stays off, or null when it runs */
export function updaterBlocked(g: Gate): string | null {
  if (!g.packaged) return "development";
  if (g.disableUpdater) return "DisableUpdater";
  if (g.platform === "win32") {
    if (g.msi) return "MSI install";
    if (!g.nsis) return "portable";
  } else if (g.platform !== "darwin") return `no updates on ${g.platform}`;
  return null;
}

/** What happens outside the state machine: the views and the menu told, the message boxes, the quit */
export interface UpdaterHost {
  changed(status: UpdaterStatus): void;
  /** A manual check's answer (a background check never calls it) */
  announce(status: UpdaterStatus): void;
  /** The app's normal quit (`app.quit()`) */
  quit(): void;
  /** The quit is done (store stopped, session written): install and open again */
  install(updater: AutoUpdaterLike): void;
  log(message: string, error?: unknown): void;
  now(): number;
}

type Version = { version?: string } | undefined;

export class Updater {
  private state: UpdateState = { kind: "idle" };
  private manual = false;
  private lastCheck = -Infinity;
  private restartAskedAt = -Infinity;
  private restartRequested = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly updater: AutoUpdaterLike | null,
    private readonly host: UpdaterHost,
    private readonly current: string,
    readonly blocked: string | null
  ) {
    if (!updater || blocked) return;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on("update-available", (info: Version) => this.set({ kind: "downloading", percent: 0, version: info?.version ?? null }));
    updater.on("download-progress", (p: { percent?: number } | undefined) => {
      const version = this.state.kind === "downloading" ? this.state.version : null;
      this.set({ kind: "downloading", percent: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))), version });
    });
    updater.on("update-not-available", () => {
      this.set({ kind: "upToDate", version: this.current });
      if (this.manual) this.host.announce(this.status());
    });
    updater.on("update-downloaded", (info: Version) => {
      const version = info?.version ?? (this.state.kind === "downloading" ? this.state.version : null) ?? "";
      this.set({ kind: "ready", version });
      if (this.manual) this.host.announce(this.status());
    });
    updater.on("error", (err: unknown) => this.failed(err));
  }

  get enabled(): boolean {
    return !!this.updater && !this.blocked;
  }

  status(): UpdaterStatus {
    return { enabled: this.enabled, state: this.state, manual: this.manual, current: this.current };
  }

  /** The schedule: the first check soon after launch, then whenever a day has gone by */
  start(): void {
    if (!this.enabled) return;
    this.timers.push(setTimeout(() => void this.check(false), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.checkIfDue(), TICK_MS));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** The hourly tick, and the Mac waking up */
  checkIfDue(): void {
    if (this.host.now() - this.lastCheck >= CHECK_EVERY_MS) void this.check(false);
  }

  /** "Check for Updates…" (manual) or the schedule */
  async check(manual: boolean): Promise<void> {
    if (!this.updater || !this.enabled) return;
    const kind = this.state.kind;
    if (manual) this.manual = true;
    // Already found and downloaded: the answer is the same ("Restart to update").
    if (kind === "ready") {
      if (manual) this.host.announce(this.status());
      return;
    }
    // One at a time: a manual check while one runs only makes it show its progress.
    if (kind === "checking" || kind === "downloading") {
      if (manual) this.host.changed(this.status());
      return;
    }
    this.manual = manual;
    this.lastCheck = this.host.now();
    this.set({ kind: "checking" });
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this.failed(err);
    }
  }

  private failed(err: unknown): void {
    this.host.log("[updater] check or download failed", err);
    // An update already in stays ready; the same failure comes twice (the promise and the event).
    if (this.state.kind === "ready" || this.state.kind === "error" || this.state.kind === "idle") return;
    if (!this.manual) return this.set({ kind: "idle" });
    this.set({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    this.host.announce(this.status());
  }

  /** "Restart to update" (the pill, the menu): the normal quit; its last step installs and relaunches */
  restart(): void {
    if (this.state.kind !== "ready") return;
    this.restartRequested = true;
    this.restartAskedAt = this.host.now();
    this.host.quit();
  }

  /** `before-quit`: a quit that isn't ours (⌘Q later, after a cancelled restart) installs without opening again */
  beforeQuit(): void {
    if (this.host.now() - this.restartAskedAt > 2000) this.restartRequested = false;
  }

  /** The quit's last step (window.ts `finishQuit`): true when the updater takes over the exit */
  exitForUpdate(): boolean {
    if (!this.updater || !this.restartRequested || this.state.kind !== "ready") return false;
    this.restartRequested = false;
    this.stop();
    this.host.install(this.updater);
    return true;
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.host.changed(this.status());
  }
}

// ── The app's one updater ─────────────────────────────────────────────────────

let instance: Updater | null = null;
const listeners = new Set<(s: UpdaterStatus) => void>();

const DISABLED: UpdaterStatus = { enabled: false, state: { kind: "idle" }, manual: false, current: "" };

/** The updater's state now (the tab bar, the menu) */
export const updaterStatus = (): UpdaterStatus => instance?.status() ?? { ...DISABLED, current: app.getVersion() };
/** Told on every change (the menu, the tab bars) */
export function onUpdaterChange(fn: (s: UpdaterStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const checkForUpdates = (): void => void instance?.check(true);
export const restartToUpdate = (): void => instance?.restart();
/** window.ts `finishQuit`'s last step: `if (!exitForUpdate()) app.exit(0)` */
export const exitForUpdate = (): boolean => instance?.exitForUpdate() ?? false;

/** Windows: the MSI's marker (build/msi/installedByMsi.mjs) */
function installedByMsi(): boolean {
  try {
    const out = execFileSync("reg", ["query", `HKLM\\${WIN_KEY}`, "/v", "InstalledByMsi", "/reg:64"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return /InstalledByMsi\s+REG_\w+\s+(0x0*1|1)\b/i.test(out);
  } catch {
    return false;
  }
}

function gate(): Gate {
  const win = process.platform === "win32";
  return {
    packaged: app.isPackaged,
    platform: process.platform,
    disableUpdater: desktopPolicy().disableUpdater,
    msi: win && installedByMsi(),
    nsis: win && existsSync(join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`)),
  };
}

async function announce(s: UpdaterStatus): Promise<void> {
  const win = BaseWindow.getFocusedWindow() ?? BaseWindow.getAllWindows()[0] ?? null;
  const box = (o: Electron.MessageBoxOptions) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o));
  const name = app.getName();
  if (s.state.kind === "upToDate") {
    await box({ type: "info", message: t("You’re up to date"), detail: t("{name} {version} is the latest version.", { name, version: s.current }), buttons: [t("OK")] });
  } else if (s.state.kind === "error") {
    await box({ type: "warning", message: t("Couldn’t check for updates"), detail: `${t("Check your internet connection and try again.")}\n\n${s.state.message}`, buttons: [t("OK")] });
  } else if (s.state.kind === "ready") {
    const { response } = await box({ type: "info", message: t("{name} {version} is ready to install", { name, version: s.state.version }), detail: t("Restart to update now, or it installs the next time you quit."), buttons: [t("Restart to Update"), t("Later")], defaultId: 0, cancelId: 1 });
    if (response === 0) restartToUpdate();
  }
}

/** Started by index.ts once the app is ready (the policy is read by then) */
export function initUpdater(): void {
  if (instance) return;
  const g = gate();
  const blocked = updaterBlocked(g);
  let updater: AutoUpdaterLike | null = null;
  if (!blocked) {
    // `autoUpdater` is a lazy getter: made (and pointed at resources/app-update.yml) only here, when it runs.
    autoUpdater.logger = { info: (m: unknown) => console.log("[updater]", m), warn: (m: unknown) => console.warn("[updater]", m), error: (m: unknown) => console.error("[updater]", m), debug: () => {} };
    // Windows: the NSIS installer isn't signed (docs/desktop.md §12.4; electron-builder.yml `verifyUpdateCodeSignature: false`
    // leaves `publisherName` out of app-update.yml): no publisher to match. The download's sha512 from latest.yml is still checked.
    if (process.platform === "win32") (autoUpdater as NsisUpdater).verifyUpdateCodeSignature = async () => null;
    updater = autoUpdater as unknown as AutoUpdaterLike;
  } else if (process.env.DESIGNER_LOG === "debug") console.log(`[updater] off: ${blocked}`);

  instance = new Updater(
    updater,
    {
      changed: (s) => listeners.forEach((fn) => fn(s)),
      announce: (s) => void announce(s).catch((e) => console.warn("[updater] message box", e)),
      quit: () => app.quit(),
      install: (u) => {
        // The quit's work is done: nothing may hold the app now (the windows' close questions, will-quit's flush).
        for (const ev of ["before-quit", "will-quit", "window-all-closed"] as const) app.removeAllListeners(ev);
        for (const w of BaseWindow.getAllWindows()) w.removeAllListeners("close");
        u.quitAndInstall(true, true);
        // Squirrel.Mac relaunches once it has the update; should it never answer, the app still ends (it installs on the next quit).
        setTimeout(() => app.exit(0), 30_000).unref();
      },
      log: (m, e) => console.warn(m, e instanceof Error ? e.message : (e ?? "")),
      now: () => Date.now(),
    },
    app.getVersion(),
    blocked
  );
  if (!instance.enabled) return;
  app.on("before-quit", () => instance?.beforeQuit());
  powerMonitor.on("resume", () => instance?.checkIfDue());
  instance.start();
}
