// @vitest-environment happy-dom
/**
 * Settings › Security's two-factor authentication (docs/governance.md §2.4, §5 "Clients") on a fake GovernanceRepository:
 * Enable two-factor authentication (QR code, the key as text, the 6-digit code, a wrong code refused, then the recovery
 * codes with Copy / Download), Regenerate recovery codes and Turn off, both taking a code.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountProfile, AccountState } from "@shared/account";
import type { TwoFactorStatus } from "@shared/org/governance";
import { StoreError } from "@shared/store/protocol";
import { $, $$ } from "@/ds/__tests__/dom";
import { mount, type Mounted } from "@/ds/__tests__/dom";
import { closeSettings, openSettings } from "../bridge";
import { SettingsHost } from "../SettingsModal";
import { groupKey } from "../SecurityTab";

const gov = vi.hoisted(() => {
  const calls: string[] = [];
  const state = { status: { enabled: false, enabledAt: null, recoveryCodesLeft: 0 } as TwoFactorStatus };
  return { calls, state };
});

vi.mock("@/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/store")>();
  const codes = ["aaaa-bbbb", "cccc-dddd"];
  const governance = {
    twoFactor: async () => (gov.calls.push("status"), gov.state.status),
    setupTwoFactor: async () => (gov.calls.push("setup"), { secret: "JBSWY3DPEHPK3PXPJBSW", otpauthUrl: "otpauth://totp/DesignerV2:burak%40x.co?secret=JBSWY3DPEHPK3PXPJBSW&issuer=DesignerV2" }),
    enableTwoFactor: async (code: string) => {
      gov.calls.push(`enable:${code}`);
      if (code !== "123456") throw new StoreError("invalid", "two_factor_invalid", { code: "two_factor_invalid" });
      gov.state.status = { enabled: true, enabledAt: 1, recoveryCodesLeft: 10 };
      return { recoveryCodes: codes };
    },
    regenerateRecoveryCodes: async (code: string) => (gov.calls.push(`regenerate:${code}`), { recoveryCodes: ["eeee-ffff"] }),
    disableTwoFactor: async (code: string) => {
      gov.calls.push(`disable:${code}`);
      gov.state.status = { enabled: false, enabledAt: null, recoveryCodesLeft: 0 };
    },
  };
  return { ...real, getStoreClient: () => ({ governance }) };
});

let m: Mounted | null = null;
afterEach(() => {
  act(() => closeSettings());
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
  delete (window as unknown as { designer?: unknown }).designer;
  gov.calls.length = 0;
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
const dialogButton = (label: string) => $$('[role="dialog"] button').find((b) => b.textContent?.trim() === label)!;
const typeInto = (input: HTMLInputElement, text: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

async function open() {
  const user = { id: "u1", email: "burak@x.co", name: "burak.koc", picture: null };
  const profile: AccountProfile = { ...user, role: "Design", community: {}, prefs: {}, provider: "google" };
  const state: AccountState = { server: "https://s", user, signingIn: false };
  (window as unknown as { designer: unknown }).designer = {
    account: {
      get: async () => state,
      signIn: async () => ({ ok: true, state }),
      cancelSignIn: async () => state,
      signOut: async () => state,
      onChanged: () => () => {},
      request: async (r: { path: string }) => (r.path === "/me/profile" ? { status: 200, body: profile } : r.path === "/me/sessions" ? { status: 200, body: { sessions: [] } } : { status: 200, body: { tokens: [] } }),
    },
  };
  m = mount(SettingsHost, {});
  act(() => openSettings("security"));
  await settle();
}

describe("Settings › Security › two-factor authentication", () => {
  it("enables it: QR code and key, a wrong code refused, the recovery codes with Copy and Download", async () => {
    await open();
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
    await click($("[data-two-factor-enable]")!);
    await settle();
    expect(gov.calls).toContain("setup");
    expect($("[data-two-factor-qr] path")?.getAttribute("d")?.length).toBeGreaterThan(100);
    expect($("[data-two-factor-key]")?.textContent).toBe("JBSW Y3DP EHPK 3PXP JBSW");
    const code = $("[data-two-factor-code] input") as HTMLInputElement;
    await typeInto(code, "12a34");
    expect(dialogButton("Verify").hasAttribute("disabled")).toBe(true); // digits only, six of them
    await typeInto(code, "000000");
    await click(dialogButton("Verify"));
    await settle();
    expect($('[role="alert"]')?.textContent).toBe("That code didn't work. Try again.");
    await typeInto(code, "123456");
    await click(dialogButton("Verify"));
    await settle();
    expect($$("[data-recovery-codes] li").map((li) => li.textContent)).toEqual(["aaaa-bbbb", "cccc-dddd"]);
    await click($("[data-recovery-copy]")!);
    await settle();
    expect(writes).toEqual(["aaaa-bbbb\ncccc-dddd"]);
    const clicked: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    try {
      await click($("[data-recovery-download]")!);
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
    expect(clicked).toEqual(["designer-recovery-codes.txt"]);
    await click(dialogButton("Done"));
    await settle();
    expect($("[data-two-factor='on']")?.textContent).toContain("10 recovery codes left");
  });

  it("regenerates recovery codes and turns it off with a code", async () => {
    gov.state.status = { enabled: true, enabledAt: 1, recoveryCodesLeft: 3 };
    await open();
    await click($("[data-two-factor-regenerate]")!);
    await settle();
    expect(dialogButton("Regenerate").hasAttribute("disabled")).toBe(true);
    await typeInto($('[role="dialog"] [data-two-factor-code] input') as HTMLInputElement, "aaaa-bbbb");
    await click(dialogButton("Regenerate"));
    await settle();
    expect(gov.calls).toContain("regenerate:aaaa-bbbb");
    expect($$("[data-recovery-codes] li").map((li) => li.textContent)).toEqual(["eeee-ffff"]);
    await click(dialogButton("Done"));
    await settle();
    await click($("[data-two-factor-disable]")!);
    await settle();
    await typeInto($('[role="dialog"] [data-two-factor-code] input') as HTMLInputElement, "654321");
    await click(dialogButton("Turn off"));
    await settle();
    expect(gov.calls).toContain("disable:654321");
    expect($("[data-two-factor-enable]")).not.toBeNull();
  });

  it("groups the key by four", () => {
    expect(groupKey("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });
});
