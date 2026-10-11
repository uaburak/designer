// @vitest-environment happy-dom
/**
 * Admin › Resources on the fake org (src/renderer/src/admin/Resources.tsx): Libraries — the list, approved first, the
 * "Approved" / "Added by default" filters, Manage this library (approve, defaults per organization and workspace and
 * file type, the org-publish warning, default modes), a workspace admin's Admin › ‹workspace› › Libraries; Fonts —
 * the list, Font with the licence and Skip / Replace, cancel, remove.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { $, $$, click, mount, type Mounted } from "@/ds/__tests__/dom";
import { AdminApp, createFakeAdminStore, type AdminAppProps, type FakeAdminStore } from "..";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (label: string, root: ParentNode = document) => $$("button", root).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)!;
const dialogs = () => $$('[role="dialog"]');
const dialog = () => dialogs()[dialogs().length - 1];
const rows = (table: string) => $$(`[data-admin-table="${table}"] [data-row]`);
const row = (table: string, text: string) => rows(table).find((r) => r.textContent?.includes(text))!;
const nav = (label: string) => $$('nav [data-ds="SidebarItem"]').find((b) => b.textContent?.includes(label))!;
const tab = (label: string) => $$('[role="tab"]').find((b) => b.textContent === label || b.textContent === label + label)!;
const toggle = (label: string) => $$('[role="switch"]').find((s) => s.getAttribute("aria-label") === label) as HTMLButtonElement;
async function choose(label: string, option: string) {
  click($$('[role="combobox"]').find((c) => c.getAttribute("aria-label") === label)!);
  await settle();
  click($$('[role="option"]').find((o) => o.textContent?.trim() === option)!);
  await settle();
}

async function open(fake = createFakeAdminStore({ now: NOW }), props: Partial<AdminAppProps> = {}): Promise<FakeAdminStore> {
  m = mount(AdminApp, { orgId: fake.state.orgId, store: fake, fonts: fake.fonts, now: () => NOW, ...props });
  await settle();
  return fake;
}
async function go(section: string, tabLabel?: string) {
  click(nav(section));
  await settle();
  if (tabLabel) {
    click(tab(tabLabel));
    await settle();
  }
}
const setting = (fake: FakeAdminStore, key: string, type: string, id: string) => fake.resources.settings.get(`${key}|${type}|${id}`);

describe("Admin › Resources › Libraries", () => {
  it("lists every library, approved first with the check mark; Approved and Added by default filter", async () => {
    await open();
    await go("Resources");
    expect($("h1").textContent).toBe("Resources");
    expect(rows("Libraries")).toHaveLength(7);
    const marked = rows("Libraries").map((r) => r.querySelector("[data-approved]")?.getAttribute("data-approved") ?? null);
    expect(marked).toEqual(["", "", "workspace", "workspace", null, null, null]);
    expect(rows("Libraries")[2].querySelector("[data-approved]")!.getAttribute("aria-label")).toMatch(/^Approved for (Design|Engineering)$/);
    expect(row("Libraries", "Core Design System").textContent).toContain("Design files, FigJam boards");
    expect(row("Libraries", "Icons").textContent).toContain("Off");
    click($('[data-filter="approved"]'));
    await settle();
    expect(rows("Libraries").map((r) => r.getAttribute("data-row")).sort()).toEqual(["lib_core01", "lib_dataviz", "lib_icons1", "lib_mobile"]);
    click($('[data-filter="approved"]'));
    click($('[data-filter="default"]'));
    await settle();
    expect(rows("Libraries").map((r) => r.getAttribute("data-row")).sort()).toEqual(["lib_core01", "lib_mobile", "lib_webui1"]);
  });

  it("Manage this library: Set as approved library (org_library_approve), defaults per file type", async () => {
    const fake = await open();
    await go("Resources");
    click(row("Libraries", "Marketing Brand"));
    await settle();
    expect($('[role="dialog"] h2, [role="dialog"] [id]')).toBeTruthy();
    expect(dialog().textContent).toContain("Manage this library");
    expect(dialog().textContent).toContain("Enable this library by default");
    expect($$("[data-file-type]", dialog()).map((r) => r.textContent)).toEqual(["Design files", "FigJam boards", "Slide decks", "Figma Buzz files"]);
    click(toggle("Set as approved library"));
    await settle();
    expect(setting(fake, "lib_brand1", "org", "org1")!.approved).toBe(true);
    expect(fake.state.activity[0].action.type).toBe("org_library_approve");
    expect(toggle("Set as approved library").getAttribute("aria-checked")).toBe("true");
    // an org-shared library: no warning
    click(toggle("Slide decks"));
    await settle();
    expect(dialogs()).toHaveLength(1);
    expect(setting(fake, "lib_brand1", "org", "org1")!.defaults.slides).toBe(true);
    expect(fake.state.activity[0].action.type).toBe("org_library_setting_change");
    click(toggle("Slide decks"));
    await settle();
    expect(setting(fake, "lib_brand1", "org", "org1")!.defaults.slides).toBeNull();
    click(button("Done"));
    await settle();
    expect(row("Libraries", "Marketing Brand").querySelector("[data-approved]")!.getAttribute("data-approved")).toBe("");
  });

  it("an org default on a team library warns, then publishes it to the organization", async () => {
    const fake = await open();
    await go("Resources");
    click(row("Libraries", "Web Platform UI"));
    await settle();
    click(toggle("Design files"));
    await settle();
    expect(dialog().textContent).toContain("Publish to the organization?");
    expect(dialog().textContent).toContain("will publish the library to the organization and change the file's permissions");
    click(button("Cancel", dialog()));
    await settle();
    expect(fake.resources.libraries.find((l) => l.key === "lib_webui1")!.scope).toBe("team");
    click(toggle("Design files"));
    await settle();
    click(button("Enable by default", dialog()));
    await settle();
    expect(fake.resources.libraries.find((l) => l.key === "lib_webui1")!.scope).toBe("org");
    expect(setting(fake, "lib_webui1", "org", "org1")!.defaults.design).toBe(true);
    expect(fake.state.activity.slice(0, 2).map((a) => a.action.type)).toEqual(["org_library_setting_change", "fig_file_link_access_change"]);
    expect(dialog().textContent).toContain("Anyone at");
  });

  it("a workspace's defaults override the organization's; Manage default modes", async () => {
    const fake = await open();
    await go("Resources");
    click(row("Libraries", "Core Design System"));
    await settle();
    await choose("Where", "Engineering");
    // inherit → Off overrides the organization's On
    await choose("Design files", "Off");
    expect(setting(fake, "lib_core01", "workspace", "ws-eng")!.defaults.design).toBe(false);
    expect(fake.state.activity[0].action.type).toBe("workspace_library_setting_change");
    expect($("[data-default-modes]", dialog()).textContent).toContain("Turn on Design files");
    await choose("Design files", "Organization setting (On)");
    expect(setting(fake, "lib_core01", "workspace", "ws-eng")!.defaults.design).toBeNull();
    // Colors has two modes; Spacing one (not offered)
    expect($$("[data-collection]", dialog()).map((r) => r.getAttribute("data-collection"))).toEqual(["c-colors"]);
    await choose("Default mode for Colors", "Dark");
    expect(setting(fake, "lib_core01", "workspace", "ws-eng")!.defaultModes).toEqual([{ collectionKey: "c-colors", modeId: "1:11" }]);
    await choose("Default mode for Colors", "Light (collection default)");
    expect(setting(fake, "lib_core01", "workspace", "ws-eng")!.defaultModes).toEqual([]);
  });

  it("a workspace admin: Admin › ‹workspace› › Libraries — can't unapprove an org approval, approves for the workspace", async () => {
    const fake = createFakeAdminStore({ now: NOW, me: "u13" });
    await open(fake, { workspace: { id: "ws-eng", name: "Engineering" } });
    expect($$('nav [data-ds="SidebarItem"]').map((b) => b.textContent)).toEqual(["Libraries"]);
    expect($("nav").textContent).toContain("Engineering");
    expect(rows("Libraries").map((r) => r.getAttribute("data-row")).sort()).toEqual(["lib_brand1", "lib_core01", "lib_dataviz", "lib_icons1", "lib_webui1"]);
    click(row("Libraries", "Core Design System"));
    await settle();
    expect(toggle("Set as approved library").disabled).toBe(true);
    expect(toggle("Set as approved library").getAttribute("aria-checked")).toBe("true");
    expect($$('[role="combobox"]', dialog()).some((c) => c.getAttribute("aria-label") === "Where")).toBe(false);
    click(button("Done"));
    await settle();
    click(row("Libraries", "Web Platform UI"));
    await settle();
    click(toggle("Set as approved library"));
    await settle();
    expect(setting(fake, "lib_webui1", "workspace", "ws-eng")!.approved).toBe(true);
    expect(fake.state.activity[0].action.type).toBe("workspace_library_approve");
    expect(fake.state.activity[0].action.details).toMatchObject({ workspace_id: "ws-eng" });
  });

  it("an org admin reaches a workspace's Libraries from Content › Workspaces", async () => {
    await open();
    await go("Content", "Workspaces");
    click(row("Workspaces", "Research"));
    await settle();
    click(tab("Libraries"));
    await settle();
    expect(rows("Libraries")).toHaveLength(7);
    // approved for the org, or for this workspace only
    expect(row("Libraries", "Mobile Components").querySelector("[data-approved]")).toBeNull();
    expect(row("Libraries", "Icons").querySelector("[data-approved]")).not.toBeNull();
  });
});

describe("Admin › Resources › Fonts", () => {
  it("lists the organization's fonts by family; Font: licence, Replace, Skip; Cancel; remove", async () => {
    const fake = await open();
    await go("Resources", "Fonts");
    expect(rows("Fonts").map((r) => r.getAttribute("data-row"))).toEqual(["Studio Sans", "Studio Serif"]);
    expect(row("Fonts", "Studio Sans").textContent).toContain("Regular, Medium, Bold");

    click(button("Font"));
    await settle();
    expect(dialog().textContent).toContain("Upload fonts");
    expect($$("[data-font-file]", dialog())).toHaveLength(3);
    expect($('[data-font-failed="brand-grotesk.woff2"]', dialog()).textContent).toContain("Only .TTF and .OTF files can be uploaded");
    const upload = button("Upload", dialog()) as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    click($('[role="dialog"] input[type="checkbox"]'));
    await settle();
    expect((button("Upload", dialog()) as HTMLButtonElement).disabled).toBe(false);
    click(button("Upload", dialog()));
    await settle();
    expect($("[data-font-conflict]", dialog()).getAttribute("data-font-conflict")).toBe("Studio Sans");
    expect(dialog().textContent).toContain("Click Skip to leave the font out of the upload, or Replace to update the existing font.");
    click(button("Replace", dialog()));
    await settle();
    expect(dialogs()).toHaveLength(0);
    const sans = fake.resources.fonts.filter((f) => f.family === "Studio Sans" && f.teamId === null);
    expect(sans.map((f) => f.style)).toEqual(["Black"]);
    expect(rows("Fonts").map((r) => r.getAttribute("data-row"))).toEqual(["Brand Grotesk", "Studio Sans", "Studio Serif"]);

    // Skip leaves the family out
    fake.fonts.nextPick = [{ fileName: "StudioSerif-Bold.otf", faces: [{ family: "Studio Serif", style: "Bold", weight: 700 }] }];
    click(button("Font"));
    await settle();
    click($('[role="dialog"] input[type="checkbox"]'));
    await settle();
    click(button("Upload", dialog()));
    await settle();
    click(button("Skip", dialog()));
    await settle();
    expect(fake.resources.fonts.filter((f) => f.family === "Studio Serif").map((f) => f.style)).toEqual(["Regular", "Italic"]);

    // Cancel in main's Open dialog: nothing
    fake.fonts.nextPick = null;
    const calls = fake.fonts.calls.length;
    click(button("Font"));
    await settle();
    expect(dialogs()).toHaveLength(0);
    expect(fake.fonts.calls.slice(calls)).toEqual(["pick"]);

    // Remove a family
    click($('[aria-label="Actions for Studio Serif"]'));
    await settle();
    click($$('[role="menuitem"]').find((i) => i.textContent?.includes("Remove font"))!);
    await settle();
    click(button("Remove", dialog()));
    await settle();
    expect(fake.resources.fonts.some((f) => f.family === "Studio Serif")).toBe(false);
    expect(rows("Fonts").map((r) => r.getAttribute("data-row"))).toEqual(["Brand Grotesk", "Studio Sans"]);
    // the team's font is untouched
    expect(fake.resources.fonts.some((f) => f.family === "Campaign Display")).toBe(true);
  });

  it("without the preload's fonts the tab says so", async () => {
    await open(undefined, { fonts: undefined });
    await go("Resources", "Fonts");
    expect($('[data-admin-page="resources/fonts"]').textContent).toContain("desktop app");
  });
});
