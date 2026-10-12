import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterStatus } from "../shared/ipc";
import { INVOKE_ROLES, SEND_ROLES } from "../shared/ipc";

vi.mock("electron", () => ({ app: { isPackaged: false, getVersion: () => "0.1.0" }, BaseWindow: {}, dialog: {}, powerMonitor: {} }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));
const { CHECK_EVERY_MS, FIRST_CHECK_MS, TICK_MS, Updater, updaterBlocked } = await import("./updater");
type AutoUpdaterLike = import("./updater").AutoUpdaterLike;

/** electron-updater's autoUpdater, as far as the updater uses it */
class FakeAutoUpdater implements AutoUpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  logger: unknown = null;
  checks = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  next: () => Promise<unknown> = () => Promise.resolve(null);
  private listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  on(event: string, fn: (...a: never[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn as (...a: unknown[]) => void]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
  checkForUpdates() {
    this.checks++;
    return this.next();
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function setup(blocked: string | null = null) {
  const fake = new FakeAutoUpdater();
  let now = 1_000_000;
  const changes: UpdaterStatus[] = [];
  const announced: UpdaterStatus[] = [];
  const quits: number[] = [];
  const installed: AutoUpdaterLike[] = [];
  const updater = new Updater(
    fake,
    {
      changed: (s) => changes.push(s),
      announce: (s) => announced.push(s),
      quit: () => {
        quits.push(now);
        // app.quit() emits before-quit at once
        updater.beforeQuit();
      },
      install: (u) => installed.push(u),
      log: () => {},
      now: () => now,
    },
    "0.1.0",
    blocked
  );
  return { fake, updater, changes, announced, quits, installed, advance: (ms: number) => (now += ms), state: () => updater.status().state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("updaterBlocked", () => {
  const base = { packaged: true, platform: "darwin" as NodeJS.Platform, disableUpdater: false, msi: false, nsis: false };
  it("runs in a packaged Mac app", () => expect(updaterBlocked(base)).toBeNull());
  it("never in development", () => expect(updaterBlocked({ ...base, packaged: false })).toBe("development"));
  it("never under DisableUpdater", () => expect(updaterBlocked({ ...base, disableUpdater: true })).toBe("DisableUpdater"));
  it("Windows: the NSIS install only — not the MSI, not the portable zip", () => {
    expect(updaterBlocked({ ...base, platform: "win32", nsis: true })).toBeNull();
    expect(updaterBlocked({ ...base, platform: "win32", nsis: true, msi: true })).toBe("MSI install");
    expect(updaterBlocked({ ...base, platform: "win32" })).toBe("portable");
  });
  it("nowhere else", () => expect(updaterBlocked({ ...base, platform: "linux" })).not.toBeNull());
});

describe("Updater", () => {
  it("turns on downloading and installing on quit", () => {
    const { fake, updater } = setup();
    expect(updater.enabled).toBe(true);
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
  });

  it("disabled: no checks, no schedule", async () => {
    const { fake, updater } = setup("DisableUpdater");
    expect(updater.status().enabled).toBe(false);
    updater.start();
    await updater.check(true);
    vi.advanceTimersByTime(CHECK_EVERY_MS * 2);
    expect(fake.checks).toBe(0);
  });

  it("checks ~10 s after launch, then once a day (the hourly tick catches a missed day)", () => {
    const { fake, updater, advance } = setup();
    updater.start();
    vi.advanceTimersByTime(FIRST_CHECK_MS - 1);
    expect(fake.checks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fake.checks).toBe(1);
    fake.emit("update-not-available", { version: "0.1.0" });
    // An hour later: not due
    advance(TICK_MS);
    vi.advanceTimersByTime(TICK_MS);
    expect(fake.checks).toBe(1);
    // A day after the check: the next tick checks
    advance(CHECK_EVERY_MS);
    vi.advanceTimersByTime(TICK_MS);
    expect(fake.checks).toBe(2);
    updater.stop();
  });

  it("waking the Mac checks only when overdue", async () => {
    const { fake, updater, advance } = setup();
    await updater.check(false);
    fake.emit("update-not-available", {});
    advance(60_000);
    updater.checkIfDue();
    expect(fake.checks).toBe(1);
    advance(CHECK_EVERY_MS);
    updater.checkIfDue();
    expect(fake.checks).toBe(2);
  });

  it("a background check: checking → downloading(percent) → ready, with nothing announced", async () => {
    const { fake, updater, announced, state } = setup();
    await updater.check(false);
    expect(state()).toEqual({ kind: "checking" });
    fake.emit("update-available", { version: "0.2.0" });
    expect(state()).toEqual({ kind: "downloading", percent: 0, version: "0.2.0" });
    fake.emit("download-progress", { percent: 41.6 });
    expect(state()).toEqual({ kind: "downloading", percent: 42, version: "0.2.0" });
    fake.emit("update-downloaded", { version: "0.2.0" });
    expect(state()).toEqual({ kind: "ready", version: "0.2.0" });
    expect(updater.status().manual).toBe(false);
    expect(announced).toEqual([]);
  });

  it("a background check's error is only logged: back to idle", async () => {
    const { fake, updater, announced, state } = setup();
    fake.next = () => Promise.reject(new Error("offline"));
    await updater.check(false);
    fake.emit("error", new Error("offline"));
    expect(state()).toEqual({ kind: "idle" });
    expect(announced).toEqual([]);
  });

  it("a manual check that finds nothing says so: up to date", async () => {
    const { fake, updater, announced, state } = setup();
    await updater.check(true);
    expect(updater.status().manual).toBe(true);
    fake.emit("update-not-available", { version: "0.1.0" });
    expect(state()).toEqual({ kind: "upToDate", version: "0.1.0" });
    expect(announced.map((s) => s.state.kind)).toEqual(["upToDate"]);
  });

  it("a manual check's error is shown once (the promise and the event both report it)", async () => {
    const { fake, updater, announced, state } = setup();
    fake.next = () => {
      fake.emit("error", new Error("404"));
      return Promise.reject(new Error("404"));
    };
    await updater.check(true);
    expect(state()).toEqual({ kind: "error", message: "404" });
    expect(announced).toHaveLength(1);
  });

  it("a manual check while a background one runs shows its progress without a second check", async () => {
    const { fake, updater, changes } = setup();
    await updater.check(false);
    fake.emit("update-available", { version: "0.2.0" });
    await updater.check(true);
    expect(fake.checks).toBe(1);
    expect(changes.at(-1)?.manual).toBe(true);
  });

  it("an update already in: a manual check answers it again, and the schedule doesn't download it twice", async () => {
    const { fake, updater, announced, advance } = setup();
    await updater.check(false);
    fake.emit("update-downloaded", { version: "0.2.0" });
    advance(CHECK_EVERY_MS);
    updater.checkIfDue();
    await updater.check(true);
    expect(fake.checks).toBe(1);
    expect(announced.map((s) => s.state.kind)).toEqual(["ready"]);
  });

  it("an error after the download keeps the update ready", async () => {
    const { fake, updater, state } = setup();
    await updater.check(true);
    fake.emit("update-downloaded", { version: "0.2.0" });
    fake.emit("error", new Error("late"));
    expect(state()).toEqual({ kind: "ready", version: "0.2.0" });
  });

  it("Restart to update: the app's normal quit, whose last step installs and relaunches", async () => {
    const { fake, updater, quits, installed } = setup();
    // Nothing to install yet: neither quits nor takes over the exit
    updater.restart();
    expect(quits).toEqual([]);
    expect(updater.exitForUpdate()).toBe(false);

    await updater.check(false);
    fake.emit("update-downloaded", { version: "0.2.0" });
    updater.restart();
    expect(quits).toHaveLength(1);
    expect(installed).toEqual([]);
    // window.ts finishQuit, after the store has flushed: the updater takes over
    expect(updater.exitForUpdate()).toBe(true);
    expect(installed).toEqual([fake]);
    expect(updater.exitForUpdate()).toBe(false);
  });

  it("a restart cancelled (an unsaved file's question) and a later ⌘Q: a plain quit, the update installs without relaunching", async () => {
    const { fake, updater, advance } = setup();
    await updater.check(false);
    fake.emit("update-downloaded", { version: "0.2.0" });
    updater.restart();
    advance(60_000);
    updater.beforeQuit();
    expect(updater.exitForUpdate()).toBe(false);
  });
});

describe("the updater's channels", () => {
  it("only the tab bar asks for the state, checks and restarts", () => {
    expect(INVOKE_ROLES["updater:get"]).toEqual(["tabbar"]);
    expect(SEND_ROLES["updater:check"]).toEqual(["tabbar"]);
    expect(SEND_ROLES["updater:restart"]).toEqual(["tabbar"]);
  });
});
