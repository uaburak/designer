// @vitest-environment happy-dom
/**
 * Organization and team names and icons (docs/multiplayer.md §14.16): the fallback initial, icons loaded through the
 * store, Change icon (crop preview, Save, Remove icon), the space switcher's avatars, Admin › Settings' organization
 * rows and the local team's Rename in Home.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ContextMenu } from "@/ds";
import { $, $$, click, mount, type, type Mounted } from "@/ds/__tests__/dom";
import { AdminApp, createFakeAdminStore } from "@/admin";
import { FileBrowser } from "../FileBrowser";
import { IconDialog } from "../orgDialogs";
import { spaceMenu } from "../org";
import { setIconLoader, TeamIcon } from "../parts";
import { MemoryWorkspace } from "./memoryWorkspace";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  setIconLoader(null);
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
const button = (label: string, root: ParentNode = document) => $$("button", root).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const dialog = () => $$('[role="dialog"]').at(-1)!;
/** Picks `file` in the dialog's hidden file input */
async function pickFile(file: File) {
  const input = $("[data-icon-input]", dialog()) as HTMLInputElement;
  act(() => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

describe("TeamIcon", () => {
  it("without an icon: the name's initial (CSS draws it, nothing in the text); with one: the store's picture", async () => {
    m = mount(TeamIcon, { name: "design team", size: 40 });
    const el = $("[data-team-icon]");
    expect(el.getAttribute("data-initial")).toBe("D");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("");
    m.unmount();

    const asked: string[] = [];
    setIconLoader(async (url) => (asked.push(url), PNG_URL));
    m = mount(TeamIcon, { name: "Design", iconUrl: "/icons/org0000000000001/" + "a".repeat(40), size: 16 });
    expect($("[data-team-icon]").getAttribute("data-initial")).toBe("D"); // until loaded
    await settle();
    expect($("[data-team-icon] img").getAttribute("src")).toBe(PNG_URL);
    expect($("[data-team-icon]").hasAttribute("data-initial")).toBe(false);
    expect(asked).toEqual(["/icons/org0000000000001/" + "a".repeat(40)]);
  });

  it("an icon that can't be had (offline, no loader) keeps the initial", async () => {
    setIconLoader(async () => null);
    m = mount(TeamIcon, { name: "Web", iconUrl: "/icons/org0000000000001/" + "b".repeat(40) });
    await settle();
    expect($("[data-team-icon]").getAttribute("data-initial")).toBe("W");
  });
});

describe("Change icon", () => {
  it("previews the crop at the page's and the sidebar's sizes, then saves its bytes", async () => {
    const saved: Uint8Array[] = [];
    let closed = false;
    m = mount(IconDialog, { name: "Design", onSave: (b: Uint8Array) => void saved.push(b), onClose: () => (closed = true), crop: async () => PNG });
    expect(dialog().textContent).toContain("Change icon");
    expect($("[data-icon-preview]").getAttribute("data-icon-preview")).toBe("initial");
    expect(button("Save")!.disabled).toBe(true);
    expect(button("Remove icon")).toBeUndefined(); // nothing to remove
    await pickFile(new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }));
    expect($("[data-icon-preview]").getAttribute("data-icon-preview")).toBe("picked");
    expect($$("[data-icon-preview] img").map((i) => i.getAttribute("src"))).toEqual([PNG_URL, PNG_URL]);
    expect($$("[data-icon-preview] [data-team-icon]").map((i) => i.getAttribute("data-size"))).toEqual(["64", "16"]);
    click(button("Save")!);
    await settle();
    expect(saved).toEqual([PNG]);
    expect(closed).toBe(false); // the caller closes once saved
  });

  it("refuses what isn't a PNG, JPEG, WebP or GIF; Remove icon when there is one", async () => {
    let removed = 0;
    m = mount(IconDialog, { name: "Design", iconUrl: PNG_URL, onSave: () => {}, onRemove: () => void removed++, onClose: () => {}, crop: () => Promise.reject(new Error("no decoder")) });
    expect($("[data-icon-preview]").getAttribute("data-icon-preview")).toBe("current");
    await pickFile(new File([new TextEncoder().encode("<svg/>")], "x.svg", { type: "image/svg+xml" }));
    expect($('[role="alert"]', dialog()).textContent).toBe("Couldn’t read that image. Use a PNG, JPEG, WebP or GIF file.");
    expect(button("Save")!.disabled).toBe(true);
    click(button("Remove icon")!);
    await settle();
    expect(removed).toBe(1);
    // A picture the page can't redraw but the server takes goes as it is
    await pickFile(new File([PNG], "icon.png", { type: "image/png" }));
    expect(button("Save")!.disabled).toBe(false);
  });
});

describe("the space switcher", () => {
  it("shows each space's icon: the org's picture once loaded, else its initial", async () => {
    setIconLoader(async () => PNG_URL);
    const iconUrl = "/icons/org0000000000001/" + "c".repeat(40);
    m = mount(TeamIcon, { name: "Acme", iconUrl });
    await settle(); // loaded (Home loads the switcher's icons ahead)
    const entries = spaceMenu({ local: "My team", orgs: [{ id: "org0000000000001", name: "Acme", iconUrl, role: "admin", seat: "full", workspaceId: null }, { id: "org0000000000002", name: "Beta", role: "member", seat: "view", workspaceId: null }], current: "local", signedIn: true });
    m.unmount();
    m = mount(ContextMenu, { at: { x: 0, y: 0 }, entries, onSelect: () => {}, onClose: () => {} });
    const avatars = $$("[data-menu-avatar]");
    expect(avatars.map((a) => a.getAttribute("data-initial"))).toEqual(["M", null, "B"]);
    expect(avatars[1].querySelector("img")?.getAttribute("src")).toBe(PNG_URL);
  });
});

describe("Admin › Settings › Organization", () => {
  it("renames the organization and changes its icon; the header follows; logged", async () => {
    const fake = createFakeAdminStore({ now: Date.UTC(2026, 9, 11) });
    m = mount(AdminApp, { orgId: fake.state.orgId, store: fake, now: () => Date.UTC(2026, 9, 11), initial: { section: "settings" } });
    await settle();
    const row = (id: string) => $(`[data-setting="${id}"]`);
    expect(row("orgName").textContent).toContain("Studio");
    expect($('nav[aria-label="Admin"] [data-team-icon]').getAttribute("data-initial")).toBe("S");

    click(button("Change", row("orgName"))!);
    await settle();
    type($$("input", dialog()).find((i) => i.getAttribute("aria-label") === "Organization name") as HTMLInputElement, "Studio North");
    click(button("Save", dialog())!);
    await settle();
    expect(row("orgName").textContent).toContain("Studio North");
    expect($('nav[aria-label="Admin"]').textContent).toContain("Studio North");

    click(button("Change", row("orgIcon"))!);
    await settle();
    expect(dialog().textContent).toContain("Organization icon");
    await pickFile(new File([PNG], "logo.png", { type: "image/png" }));
    click(button("Save", dialog())!);
    await settle();
    expect($$('[role="dialog"]')).toHaveLength(0);
    expect($('nav[aria-label="Admin"] [data-team-icon] img').getAttribute("src")).toBe(PNG_URL);
    expect(row("orgIcon").querySelector("img")?.getAttribute("src")).toBe(PNG_URL);

    click(button("Change", row("orgIcon"))!);
    await settle();
    click(button("Remove icon", dialog())!);
    await settle();
    expect(row("orgIcon").querySelector("[data-team-icon]")?.getAttribute("data-initial")).toBe("S");
    expect(fake.state.activity.map((r) => r.action.type).filter((t) => t.startsWith("org_"))).toEqual(expect.arrayContaining(["org_rename", "org_icon_change"]));
  });
});

describe("Home: the local team's Rename", () => {
  it("right-click the team's name → Rename → the workspace's team name, shown at once", async () => {
    const ws = new MemoryWorkspace({ teamName: "My team" });
    m = mount(FileBrowser, { backend: { workspace: ws, source: "memory", thumbnailUrl: () => null }, initialLocation: { kind: "drafts" }, toast: () => {} });
    await settle();
    const row = $$("nav span").filter((s) => s.textContent === "My team").at(-1)!.parentElement!; // the space row (the account row names the owner too)
    act(() => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle();
    click($$('#ds-overlays [role="menuitem"]').find((el) => el.textContent?.includes("Rename"))!);
    await settle();
    expect(dialog().textContent).toContain("Rename team");
    type($$("input", dialog()).find((i) => i.getAttribute("aria-label") === "Team name") as HTMLInputElement, "Burak’s team");
    click(button("Rename", dialog())!);
    await settle();
    expect((await ws.getWorkspace()).teamName).toBe("Burak’s team");
    expect($("nav").textContent).toContain("Burak’s team");
  });
});

