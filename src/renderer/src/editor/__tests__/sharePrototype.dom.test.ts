// @vitest-environment happy-dom
/**
 * Prototype-only access in the client (docs/editor.md D-6): the Share prototype modal over a fake store — the link's
 * audience as one PATCH (Anyone with the link / Anyone at ‹org› / Only invited people; "Anyone" gone when the org's
 * public links are off), prototype members invited and removed, the link with `m=proto`; `usePrototypeOnly` (owners,
 * editors and local files never ask the server; a prototype-only viewer's file is known from its access).
 */
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, $$, click, mount, type, type Mounted } from "@/ds/__tests__/dom";
import type { FileShareState, LinkSettingsPatch, SharedFileInfo } from "@shared/multiplayer/types";
import { intentFromLink } from "@shared/multiplayer/types";

const calls: string[] = [];
let info: SharedFileInfo;
let state: Partial<FileShareState>;
let members: { email: string; userId: string | null; name: string | null }[] = [];
const store = {
  multiplayer: {
    fileState: async () => state,
    fileInfo: async () => (calls.push("fileInfo"), info),
    updateLink: async (_k: string, patch: LinkSettingsPatch) => {
      calls.push(`patch ${JSON.stringify(patch)}`);
      info = { ...info, ...patch } as SharedFileInfo;
      return info;
    },
  },
  devMode: {
    prototypeMembers: async () => members,
    invitePrototype: async (_k: string, email: string) => void members.push({ email, userId: null, name: null }),
    removePrototype: async (_k: string, email: string) => void (members = members.filter((m) => m.email !== email)),
  },
};
vi.mock("@/store", () => ({ getStoreClient: () => store }));

const { SharePrototypeDialog, audiencePatch, prototypeAudience } = await import("../SharePrototypeDialog");
const { usePrototypeOnly } = await import("../EditorRoute");

let m: Mounted | null = null;
beforeEach(() => {
  calls.length = 0;
  members = [{ email: "dev@x.co", userId: "u9", name: "Dev" }];
  state = { shared: true, role: "owner" };
  info = { key: "k1", name: "Shop", role: "owner", linkAccess: "none", viewersCanCopy: true, link: "https://s/f/k1", protoLinkAccess: "none", protoOrgLinkAccess: "none", org: { id: "o1", name: "Studio", teamId: null, teamName: null }, policy: null, access: { canShare: true, canManage: true, capped: null } };
});
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
async function choose(label: string, option: string) {
  click($$('[role="combobox"]').find((c) => c.getAttribute("aria-label") === label)!);
  await settle();
  click($$('[role="option"]').find((o) => o.textContent?.trim() === option)!);
  await settle();
}
const options = async (label: string) => {
  click($$('[role="combobox"]').find((c) => c.getAttribute("aria-label") === label)!);
  await settle();
  const out = $$('[role="option"]').map((o) => o.textContent?.trim());
  click($$('[role="combobox"]').find((c) => c.getAttribute("aria-label") === label)!);
  await settle();
  return out;
};

describe("Share prototype", () => {
  it("the audience as one PATCH, members invited and removed", async () => {
    m = mount(SharePrototypeDialog, { fileKey: "k1", nodeId: "1:2", onClose: () => {} });
    await settle();
    await settle();
    expect($("[data-prototype-link]")!.getAttribute("data-prototype-link")).toBe("invited");
    expect(await options("Who can view the prototype")).toEqual(["Anyone with the link", "Anyone at Studio", "Only invited people"]);
    await choose("Who can view the prototype", "Anyone at Studio");
    expect(calls).toContain(`patch ${JSON.stringify({ protoLinkAccess: "none", protoOrgLinkAccess: "viewer" })}`);
    expect($("[data-prototype-link]")!.getAttribute("data-prototype-link")).toBe("org");
    type($('[data-share-prototype="emails"]') as HTMLInputElement, "pm@x.co");
    await settle();
    click($('[data-share-prototype="invite"]')!);
    await settle();
    expect($$("[data-prototype-member]").map((r) => r.getAttribute("data-prototype-member"))).toEqual(["dev@x.co", "pm@x.co"]);
    await choose("dev@x.co access", "Remove");
    expect($$("[data-prototype-member]").map((r) => r.getAttribute("data-prototype-member"))).toEqual(["pm@x.co"]);
  });

  it("the org's public links off: no Anyone with the link", async () => {
    info = { ...info, policy: { publicLinks: false, passwordRequired: false, passwordMode: "any", linkExpiryMaxHours: null, cursorChat: true, audio: true, openSessions: true } };
    m = mount(SharePrototypeDialog, { fileKey: "k1", onClose: () => {} });
    await settle();
    await settle();
    expect(await options("Who can view the prototype")).toEqual(["Anyone at Studio", "Only invited people"]);
  });

  it("pure helpers: the audience both ways, the dev=ready link", () => {
    expect(prototypeAudience({ protoLinkAccess: "viewer", protoOrgLinkAccess: "viewer" })).toBe("anyone");
    expect(prototypeAudience({ protoLinkAccess: "none", protoOrgLinkAccess: "viewer" })).toBe("org");
    expect(prototypeAudience(null)).toBe("invited");
    expect(audiencePatch("anyone", false)).toEqual({ protoLinkAccess: "viewer" });
    expect(audiencePatch("invited", true)).toEqual({ protoLinkAccess: "none", protoOrgLinkAccess: "none" });
    expect(intentFromLink("?key=k&m=dev&dev=ready")).toEqual({ mode: "dev", devMode: "ready" });
  });
});

describe("usePrototypeOnly", () => {
  function Probe({ fileKey, out }: { fileKey: string | null; out: (v: boolean | null) => void }) {
    out(usePrototypeOnly(fileKey));
    return createElement("span");
  }
  const run = async (fileKey: string | null) => {
    const seen: (boolean | null)[] = [];
    m = mount(Probe, { fileKey, out: (v: boolean | null) => seen.push(v) });
    await settle();
    await settle();
    m.unmount();
    m = null;
    return seen;
  };
  it("owners don't ask; a prototype-only viewer's file is known from its access", async () => {
    expect((await run("k1")).at(-1)).toBe(false);
    expect(calls).not.toContain("fileInfo");
    state = { shared: true, role: "viewer" };
    info = { ...info, role: "viewer", access: { canShare: false, canManage: false, capped: null, prototypeOnly: true } };
    const seen = await run("k1");
    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toBe(true);
    expect(await run(null)).toEqual([false]);
  });
});
