// @vitest-environment happy-dom
// A shared file the server refuses (docs/governance.md §9 14e: `FileShareState.blocked`): the editor says why instead
// of reconnecting forever — the key, a policy to agree to (Agree → acknowledgePolicy), 2FA, the IP allowlist, the network.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { FileBlocked, KEY_UNAVAILABLE_TEXT, type FileBlockedDeps } from "../multiplayer/FileBlocked";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)));
const press = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const buttonNamed = (label: string) => $$("button").find((el) => el.textContent?.trim() === label);

function deps() {
  const log: string[] = [];
  const d: FileBlockedDeps = {
    orgOf: async () => ({ id: "o1", name: "Acme" }),
    acknowledgePolicy: async (org, id) => void log.push(`agree:${org}:${id}`),
    signOut: () => void log.push("signOut"),
    openSecurity: () => void log.push("security"),
  };
  return { d, log };
}

describe("FileBlocked", () => {
  it("an unavailable encryption key", async () => {
    m = mount(FileBlocked, { fileKey: "f1", blocked: { code: "key_unavailable" }, deps: deps().d });
    await settle();
    expect($("[data-file-blocked='key_unavailable']")?.textContent).toContain(KEY_UNAVAILABLE_TEXT);
  });

  it("a policy: the modal, Agree acknowledges each in turn; Cancel leaves Review policies", async () => {
    const { d, log } = deps();
    const policies = [
      { id: "p1", title: "Code of conduct", text: "Be kind" },
      { id: "p2", title: "NDA", text: "Keep it" },
    ];
    m = mount(FileBlocked, { fileKey: "f1", blocked: { code: "policy_acknowledgement_required", gate: { kind: "policy", policies } }, deps: d });
    await settle();
    expect($("[data-file-blocked]")?.textContent).toContain("Agree to Acme’s policies to open this file.");
    expect($('[role="dialog"]')?.textContent).toContain("Code of conduct");
    await press($("[data-policy-agree]")!);
    await settle();
    expect($('[role="dialog"]')?.textContent).toContain("NDA");
    await press($("[data-policy-cancel]")!);
    await settle();
    expect($('[role="dialog"]')).toBeNull();
    await press(buttonNamed("Review policies")!);
    await settle();
    await press($("[data-policy-agree]")!);
    await settle();
    expect(log).toEqual(["agree:o1:p1", "agree:o1:p2"]);
    expect($('[role="dialog"]')).toBeNull();
  });

  it("2FA for guests opens Settings › Security; the IP allowlist; the network restriction logs out", async () => {
    const { d, log } = deps();
    m = mount(FileBlocked, { fileKey: "f1", blocked: { code: "two_factor_required", gate: { kind: "two_factor" } }, deps: d });
    await settle();
    expect($("[data-gate='two_factor']")?.textContent).toContain("Acme requires two-factor authentication for guests.");
    await press(buttonNamed("Set up two-factor authentication")!);
    m.unmount();
    m = mount(FileBlocked, { fileKey: "f1", blocked: { code: "ip_not_allowed", gate: { kind: "ip", ip: "192.0.2.1" } }, deps: d });
    await settle();
    expect($("[data-gate='ip']")?.textContent).toContain("192.0.2.1");
    m.unmount();
    m = mount(FileBlocked, { fileKey: "f1", blocked: { code: "network_restricted" }, deps: d });
    await settle();
    await press($("[data-network-log-out]")!);
    expect(log).toEqual(["security", "signOut"]);
  });
});
