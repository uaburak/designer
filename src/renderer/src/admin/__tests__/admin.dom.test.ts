// @vitest-environment happy-dom
/**
 * The Admin location on the fake org (src/renderer/src/admin): every section renders, and the writes a person makes
 * there reach the repository — seat changes in bulk, requests, restore, workspaces, activity filters and CSV,
 * settings, unassigned drafts.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { $, $$, click, mount, type, type Mounted } from "@/ds/__tests__/dom";
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
const dialog = () => $('[role="dialog"]');
const rows = (table: string) => $$(`[data-admin-table="${table}"] [data-row]`);
const nav = (label: string) => $$('nav [data-ds="SidebarItem"]').find((b) => b.textContent?.includes(label))!;
const tab = (label: string) => $$('[role="tab"]').find((b) => b.textContent === label || b.textContent === label + label)!; // the tab's hidden bold copy

async function open(props: Partial<AdminAppProps> = {}): Promise<FakeAdminStore> {
  const fake = createFakeAdminStore({ now: NOW });
  m = mount(AdminApp, { orgId: fake.state.orgId, store: fake, now: () => NOW, ...props });
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

describe("Admin", () => {
  it("Dashboard: counts, seat requests answered, guest requests added", async () => {
    const fake = await open();
    expect($('[data-stat="Members"]').textContent).toContain(String(fake.state.people.filter((p) => p.role !== "guest" && !p.pending).length));
    expect($('[data-stat="Guests"]').textContent).toContain("4");
    expect(rows("Seat requests")).toHaveLength(5);
    const first = rows("Seat requests")[0];
    const id = fake.state.seatRequests.find((r) => r.state === "pending" && first.textContent?.includes(r.person.name!))!;
    click(button("Approve", first));
    await settle();
    expect(fake.state.seatRequests.find((r) => r.id === id.id)!.state).toBe("approved");
    expect(fake.state.people.find((p) => p.id === id.userId)!.seat).toBe(id.seat);
    expect(rows("Seat requests")).toHaveLength(4);
    click(button("Dismiss", rows("Guest requests")[0]));
    await settle();
    expect(rows("Guest requests")).toHaveLength(2);
    // View all: every request and Approval settings
    click($$("button").filter((b) => b.textContent === "View all")[0]);
    await settle();
    click(button("All requests"));
    await settle();
    expect(rows("Seat requests").length).toBe(7);
    expect($("h1").textContent).toBe("Seat requests");
  });

  it("People: search, seat filter, bulk seat change, remove sends drafts to Unassigned", async () => {
    const fake = await open();
    await go("People");
    expect(rows("People")).toHaveLength(fake.state.people.length);
    type($('[data-ds="SearchField"] input') as HTMLInputElement, "studio.co");
    await settle();
    const members = fake.state.people.filter((p) => p.email.includes("studio.co")).length;
    expect(rows("People")).toHaveLength(members);
    click($('[data-seat="view"]'));
    await settle();
    const views = fake.state.people.filter((p) => p.email.includes("studio.co") && p.seat === "view");
    expect(rows("People")).toHaveLength(views.length);
    // check two, then Change seat → Full
    const [a, b] = rows("People");
    click($("input[type=checkbox]", a));
    click($("input[type=checkbox]", b));
    await settle();
    expect($('[role="toolbar"]').textContent).toContain("2 selected");
    click(button("Change seat"));
    await settle();
    click($$('[role="radio"]', dialog())[0]);
    click(button("Change seat", dialog()));
    await settle();
    const changed = fake.state.people.filter((p) => p.seat === "full" && [a, b].some((r) => r.dataset.row === p.id));
    expect(changed).toHaveLength(2);
    expect(fake.state.activity[0].action.type).toBe("org_user_account_type_change_to_full");
    // remove one person: their drafts land in Unassigned drafts
    const victim = rows("People")[0].dataset.row!;
    click($("input[type=checkbox]", rows("People")[0]));
    await settle();
    click(button("Remove users"));
    await settle();
    click(button("Remove", dialog()));
    await settle();
    expect(fake.state.people.some((p) => p.id === victim)).toBe(false);
    expect(fake.state.unassigned[0].owner.id).toBe(victim);
  });

  it("People: Add people invites pending members; Get CSV hands the roster to the callback", async () => {
    const saved: [string, string][] = [];
    const fake = await open({ onExportCsv: (name, csv) => saved.push([name, csv]) });
    await go("People");
    click(button("Add people"));
    await settle();
    const area = $("textarea", dialog()) as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "a@studio.co, b@studio.co");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(button("Add people", dialog()));
    await settle();
    expect(fake.state.people.filter((p) => p.pending && p.email.endsWith("@studio.co")).map((p) => p.email)).toEqual(expect.arrayContaining(["a@studio.co", "b@studio.co"]));
    click(button("Get CSV"));
    await settle();
    expect(saved[0][0]).toBe("people-2026-10-11.csv");
    expect(saved[0][1].split("\n")[0]).toBe("Name,Email,User type,Seat type,Workspace,Billing group,Last active,Joined");
    expect(fake.state.activity[0].action.type).toBe("roster_exported");
  });

  it("User groups: listed, created", async () => {
    const fake = await open();
    await go("People", "User groups");
    expect(rows("User groups")).toHaveLength(4);
    click(button("Create user group"));
    await settle();
    type($("input", dialog()) as HTMLInputElement, "QA");
    click(button("Create group"));
    await settle();
    expect(rows("User groups")).toHaveLength(5);
    expect(fake.state.groups.at(-1)!.name).toBe("QA");
  });

  it("Content › Teams: hidden shown, deleted on demand and restored", async () => {
    const fake = await open();
    await go("Content");
    const live = fake.state.teams.filter((t) => t.deletedAt === null).length;
    expect(rows("Teams")).toHaveLength(live);
    click($$('[data-ds="Checkbox"]').find((c) => c.textContent === "Show deleted teams")!.querySelector("input")!);
    await settle();
    expect(rows("Teams")).toHaveLength(fake.state.teams.length);
    const deleted = rows("Teams").find((r) => r.textContent?.includes("Deleted"))!;
    click($('[aria-label^="Actions for"]', deleted));
    await settle();
    click($$('[role="menuitem"]').find((i) => i.textContent?.includes("Restore team"))!);
    await settle();
    expect(fake.state.teams.find((t) => t.id === deleted.dataset.row)!.deletedAt).toBeNull();
  });

  it("Content › Workspaces: New workspace with an admin, hidden; members added", async () => {
    const fake = await open();
    await go("Content", "Workspaces");
    expect(rows("Workspaces")).toHaveLength(3);
    click(button("New workspace"));
    await settle();
    type($("input", dialog()) as HTMLInputElement, "Marketing");
    click(button("Add workspace admin"));
    await settle();
    click($('[data-pick="u2"] input'));
    click(button("Done"));
    await settle();
    click($$('[data-ds="Checkbox"]', dialog()).find((c) => c.textContent === "Make it hidden")!.querySelector("input")!);
    click(button("Create workspace"));
    await settle();
    const w = fake.state.workspaces.find((x) => x.name === "Marketing")!;
    expect(w.hidden).toBe(true);
    expect(w.admins.map((a) => a.id)).toEqual(["u2"]);
    // it opens on its Members
    expect($("h2").textContent).toContain("Marketing");
    click(button("Add members"));
    await settle();
    const unassigned = fake.state.people.find((p) => p.workspaceId === null && !p.pending)!;
    click($(`[data-pick="${unassigned.id}"] input`));
    click(button("Add"));
    await settle();
    expect(fake.state.people.find((p) => p.id === unassigned.id)!.workspaceId).toBe(w.id);
    expect(rows("Workspace members")).toHaveLength(1);
  });

  it("Content › Unassigned drafts: a folder per removed person; files deleted for good", async () => {
    const fake = await open();
    await go("Content", "Unassigned drafts");
    expect(rows("Unassigned drafts")).toHaveLength(2);
    click($('[data-row="x1"] [role=cell]'));
    await settle();
    expect(rows("Unassigned files")).toHaveLength(3); // the trashed one is hidden
    click($$('[data-ds="Checkbox"]').find((c) => c.textContent === "Show trashed files")!.querySelector("input")!);
    await settle();
    expect(rows("Unassigned files")).toHaveLength(4);
    click($('[aria-label^="Actions for"]', rows("Unassigned files")[0]));
    await settle();
    click($$('[role="menuitem"]').find((i) => i.textContent?.includes("Permanently delete"))!);
    await settle();
    click(button("Permanently delete", dialog()));
    await settle();
    expect(fake.state.unassigned.find((u) => u.owner.id === "x1")!.files).toHaveLength(3);
  });

  it("Activity: Figma's columns, filter by member and event, Get CSV", async () => {
    const saved: string[] = [];
    const fake = await open({ onExportCsv: (_n, csv) => saved.push(csv) });
    await go("Activity");
    const headers = $$('[data-admin-table="Activity"] [role="columnheader"]').map((h) => h.textContent);
    expect(headers).toEqual(["Date (UTC)", "Team member", "Event", "Product", "Team", "IP address"]);
    expect(rows("Activity")).toHaveLength(100);
    expect(button("Load more")).toBeTruthy();
    const email = fake.state.people[3].email;
    type($('input[aria-label="Member"]') as HTMLInputElement, email);
    await settle();
    const mine = fake.state.activity.filter((r) => r.actor?.email === email && r.timestamp >= NOW / 1000 - 30 * 86_400);
    expect(rows("Activity")).toHaveLength(Math.min(100, mine.length));
    click(button("Get CSV"));
    await settle();
    expect(saved[0].split("\n")[0]).toBe("Date (UTC),Team member,Email,Event type,Event,Entity type,Entity,Product,Team,IP address");
  });

  it("Settings: guest membership and team creation saved; round-4 settings disabled", async () => {
    const fake = await open();
    await go("Settings");
    click(button("Change", $('[data-setting="guestMembership"]')));
    await settle();
    click($$('[role="radio"]', dialog())[1]);
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.guestMembership).toBe("approval");
    click(button("Change", $('[data-setting="teamCreation"]')));
    await settle();
    click($$('[role="radio"]', dialog())[1]);
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.teamCreation).toBe("admins");
    expect(fake.state.activity[0].action.type).toBe("org_team_creation_controls");
    expect((button("Change", $('[data-setting="publicLinks"]')) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Billing groups: created, deleted (people back to Unassigned)", async () => {
    const fake = await open();
    await go("Billing", "Billing groups");
    expect(rows("Billing groups")).toHaveLength(2);
    click(button("Billing group"));
    await settle();
    type($("input", dialog()) as HTMLInputElement, "Engineering");
    click(button("Create billing group"));
    await settle();
    expect(rows("Billing groups")).toHaveLength(3);
    const product = rows("Billing groups").find((r) => r.textContent?.includes("Product"))!;
    click($('[aria-label^="Actions for"]', product));
    await settle();
    click($$('[role="menuitem"]').find((i) => i.textContent?.includes("Delete billing group"))!);
    await settle();
    click(button("Delete billing group", dialog()));
    await settle();
    expect(fake.state.people.some((p) => p.billingGroupId === "bg-product")).toBe(false);
  });
});
