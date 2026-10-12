// The renames to "Designer" (1.0.0) and "Wecra" (1.0.4) keep the owner's data: userData stays <appData>/DesignerV2, and the name Electron
// gives the keychain item before `ready` stays "DesignerV2" so "DesignerV2 Safe Storage" keeps opening every "enc:" value.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyIdentity, keychainItem, LEGACY_NAME, PRODUCT_NAME, userDataPath, type IdentityApp } from "./identity";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** An appData folder holding a pre-1.0 profile, like ~/Library/Application Support with DesignerV2 in it */
function appDataWithProfile(): string {
  const appData = mkdtempSync(join(tmpdir(), "designer-identity-"));
  dirs.push(appData);
  const old = join(appData, "DesignerV2");
  mkdirSync(join(old, "Workspace"), { recursive: true });
  mkdirSync(join(old, "account"), { recursive: true });
  writeFileSync(join(old, "Workspace", ".lock"), JSON.stringify({ pid: 1, startedAt: 0 }));
  writeFileSync(join(old, "account", "session.json"), JSON.stringify({ token: "enc:AAAA" }));
  return appData;
}

/** Electron's app as far as identity.ts uses it, with the order of what it was told */
function fakeApp(appData: string) {
  const log: string[] = [];
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  let name = "Wecra"; // package.json's productName, as Electron starts with it
  const paths: Record<string, string> = {};
  const app: IdentityApp & { name: () => string } = {
    getPath: () => appData,
    setPath: (k, p) => void ((paths[k] = p), log.push(`setPath ${k}`)),
    setName: (n) => void ((name = n), log.push(`setName ${n}`)),
    whenReady: () => readyP,
    name: () => name,
  };
  return { app, log, paths, ready: async () => (ready(), await readyP, await Promise.resolve()) };
}

describe("userData", () => {
  it("stays the pre-1.0 folder, found where it is and left untouched", () => {
    const appData = appDataWithProfile();
    const before = readdirSync(join(appData, "DesignerV2")).sort();
    const { app, paths } = fakeApp(appData);
    applyIdentity(app, {});
    expect(paths.userData).toBe(join(appData, "DesignerV2"));
    expect(readdirSync(appData)).toEqual(["DesignerV2"]); // no "Wecra" (or "Designer") folder made, nothing moved
    expect(readdirSync(join(appData, "DesignerV2")).sort()).toEqual(before);
    expect(existsSync(join(paths.userData, "account", "session.json"))).toBe(true);
  });

  it("is the same folder on a fresh install (Windows' %APPDATA% too)", () => {
    expect(userDataPath("C:\\Users\\b\\AppData\\Roaming")).toBe(join("C:\\Users\\b\\AppData\\Roaming", "DesignerV2"));
    expect(userDataPath("/Users/b/Library/Application Support")).toBe("/Users/b/Library/Application Support/DesignerV2");
  });

  it("is DESIGNER_USER_DATA when set (scripts/drive.mjs)", () => {
    const { app, paths } = fakeApp("/nowhere");
    applyIdentity(app, { DESIGNER_USER_DATA: "/tmp/run-1" });
    expect(paths.userData).toBe("/tmp/run-1");
  });
});

describe("the keychain's name", () => {
  it("is the pre-1.0 one until ready, then the app is Wecra", async () => {
    const { app, log, ready } = fakeApp(appDataWithProfile());
    applyIdentity(app, {});
    // Electron names the item from app.name between the main script's first run and `ready`
    expect(app.name()).toBe(LEGACY_NAME);
    expect(keychainItem(app.name())).toEqual({ service: "DesignerV2 Safe Storage", account: "DesignerV2 Key" });
    await ready();
    expect(app.name()).toBe(PRODUCT_NAME);
    // userData is set before the name changes anything, and the name goes back only once ready
    expect(log).toEqual(["setPath userData", "setName DesignerV2", "setName Wecra"]);
  });

  it("would be a new, empty item under the new name", () => {
    expect(keychainItem(PRODUCT_NAME).service).toBe("Wecra Safe Storage");
    expect(keychainItem(PRODUCT_NAME).service).not.toBe(keychainItem(LEGACY_NAME).service);
  });
});
