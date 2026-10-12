// @vitest-environment happy-dom
/**
 * Admin's Governance+ (docs/governance.md §5; Phase 7 round 14h) on the fake org: Billing's Add / Remove and the rows
 * it unlocks; the quarter-hour session timeout; several IdPs with their domains and SCIM; the IP allowlist; 2FA for
 * Guests and its "Blocked" badges; the default guest duration; file exporting with a workspace override; network
 * ranges; internal policies; Discovery; key management's encrypt loop; People's guest expiration; Activity › Developer
 * logs.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { $, $$, click, mount, type, type Mounted } from "@/ds/__tests__/dom";
import { AdminApp, createFakeAdminStore, type AdminAppProps, type FakeAdminStore } from "..";
import { eventText } from "../labels";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (label: string, root: ParentNode = document) => $$("button", root).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label) as HTMLButtonElement;
const dialogs = () => $$('[role="dialog"]');
const dialog = () => dialogs()[dialogs().length - 1];
const setting = (id: string) => $(`[data-setting="${id}"]`);
const toggle = (label: string, root: ParentNode = document) => $$('[role="switch"]', root).find((s) => s.getAttribute("aria-label") === label) as HTMLButtonElement;
const input = (label: string, root: ParentNode = dialog()) => $$("input,textarea", root).find((i) => i.getAttribute("aria-label") === label) as HTMLInputElement;
const radio = (label: string, root: ParentNode = dialog()) => $$('[role="radiogroup"] label', root).find((l) => l.textContent?.includes(label))!.querySelector('[role="radio"]') as HTMLButtonElement;
const checkbox = (label: string, root: ParentNode = dialog()) => $$("label", root).find((l) => l.textContent?.trim() === label && l.querySelector('input[type="checkbox"]'))!.querySelector("input") as HTMLInputElement;
const nav = (label: string) => $$('nav [data-ds="SidebarItem"]').find((b) => b.textContent?.includes(label))!;
const tab = (label: string) => $$('[role="tab"]').find((b) => b.textContent === label || b.textContent === label + label)!;
const menuItem = (label: string) => $$('[role="menuitem"]').find((i) => i.textContent?.includes(label))!;
function typeArea(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(label: string, option: string, root: ParentNode = document) {
  click($$('[role="combobox"]', root).find((c) => c.getAttribute("aria-label") === label)!);
  await settle();
  click($$('[role="option"]').find((o) => o.textContent?.trim() === option)!);
  await settle();
}

async function open(props: Partial<AdminAppProps> = {}, options: { governancePlus?: boolean } = { governancePlus: true }): Promise<FakeAdminStore> {
  const fake = createFakeAdminStore({ now: NOW, ...options });
  m = mount(AdminApp, { orgId: fake.state.orgId, store: fake, now: () => NOW, onTestSso: fake.testSso, initial: { section: "settings" }, ...props });
  await settle();
  await settle();
  return fake;
}
async function change(id: string, label = "Change") {
  click(button(label, setting(id)));
  await settle();
}
const actions = (fake: FakeAdminStore) => fake.state.activity.map((r) => r.action.type);
const sentences = (fake: FakeAdminStore) => fake.state.activity.map((r) => eventText(r));

describe("Admin › Governance+ (round 14h)", () => {
  it("Billing › Governance+: Add unlocks the rows; Remove clamps a 15-minute timeout and is refused while key management is on", async () => {
    const fake = await open({}, {});
    expect(setting("ipAllowlist").textContent).toContain("Requires Governance+");
    expect(button("Change", setting("ipAllowlist")).disabled).toBe(true);
    click(button("Add", setting("governancePlus")));
    await settle();
    await settle();
    expect(fake.governanceState.governancePlus).toBe(true);
    expect(actions(fake)[0]).toBe("governance_plus_enable");
    expect(setting("ipAllowlist").textContent).toContain("Off");
    expect(button("Change", setting("ipAllowlist")).disabled).toBe(false);

    // A quarter-hour timeout only with the add-on
    await change("idle");
    click(radio("Custom timeout"));
    await settle();
    await choose("Unit", "Minutes", dialog());
    type(input("Timeout"), "15");
    await settle();
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.idleSessionTimeoutHours).toBe(0.25);
    expect(setting("idle").textContent).toContain("15 minutes");

    click(button("Remove", setting("governancePlus")));
    await settle();
    click(button("Remove", dialog()));
    await settle();
    await settle();
    expect(fake.governanceState.governancePlus).toBe(false);
    expect(fake.state.settings.idleSessionTimeoutHours).toBe(12);
    expect(actions(fake).slice(0, 2)).toEqual(["idle_timeout_setting_change", "governance_plus_disable"]);

    fake.governanceState.governancePlus = true;
    fake.governanceState.ekm.enabled = true;
    m!.unmount();
    m = mount(AdminApp, { orgId: fake.state.orgId, store: fake, now: () => NOW, initial: { section: "settings" } });
    await settle();
    await settle();
    expect(button("Remove", setting("governancePlus")).disabled).toBe(true);
    await expect(fake.governance.setGovernancePlus(fake.state.orgId, false)).rejects.toThrow("Key management");
  });

  it("Manage identity providers (IdP): + Add IDP with its domains, a second IdP, SCIM per IdP, More › Remove", async () => {
    const fake = await open();
    expect(setting("idps").textContent).toContain("0 identity providers");
    await change("idps", "Manage");
    expect($('[data-admin-table="Identity providers"]').textContent).toContain("No identity providers yet");
    click(button("Add IDP", dialog()));
    await settle();
    typeArea(input("Name"), "Okta (Studio)");
    typeArea(input("IdP metadata URL"), "https://studio.okta.com/app/exk1/sso/saml/metadata");
    click(checkbox("studio.co"));
    await settle();
    click(button("Add IDP", dialog()));
    await settle();
    await settle();
    const first = fake.identityState.idp!;
    expect(first.name).toBe("Okta (Studio)");
    expect(fake.governanceState.domainIdp.get("studio.co")).toBe(first.tenantId);
    expect(actions(fake).slice(0, 2)).toEqual(["org_domain_idp_mapping_change", "idp_config_create"]);
    expect($('[data-admin-table="Identity providers"]').textContent).toContain("studio.co");

    click(button("Add IDP", dialog()));
    await settle();
    typeArea(input("Name"), "Entra (Agency)");
    click(radio("IdP metadata XML"));
    await settle();
    typeArea(input("IdP metadata XML"), '<EntityDescriptor entityID="https://sts.windows.net/abc/"><X509Certificate>MII</X509Certificate><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://login.microsoftonline.com/abc/saml2"/></EntityDescriptor>');
    await settle();
    click(button("Add IDP", dialog()));
    await settle();
    await settle();
    expect(fake.governanceState.extraIdps).toHaveLength(1);
    const second = fake.governanceState.extraIdps[0];
    expect($$('[data-admin-table="Identity providers"] [data-row]')).toHaveLength(2);

    // SCIM for the second IdP: its own base URL and token
    click($(`[data-row="${second.tenantId}"] [aria-label^="More for"]`));
    await settle();
    click(menuItem("SCIM provisioning"));
    await settle();
    expect($('[data-kv="SCIM base URL"]').textContent).toContain(`/scim/v2/${second.tenantId}`);
    click(button("Generate API token", dialog()));
    await settle();
    expect($("[data-scim-token] pre").textContent).toMatch(/^dsgn_scim_/);
    expect(fake.governanceState.scimTokens.has(second.tenantId)).toBe(true);
    expect(fake.identityState.scimToken).toBeNull();
    click(button("Done", dialog()));
    await settle();

    click($(`[data-row="${second.tenantId}"] [aria-label^="More for"]`));
    await settle();
    click(menuItem("Remove"));
    await settle();
    click(button("Remove", dialog()));
    await settle();
    await settle();
    expect(fake.governanceState.extraIdps).toHaveLength(0);
    expect(actions(fake).slice(0, 2)).toEqual(["idp_config_delete", "scim_token_revoke"]);
    expect(setting("idps").textContent).toContain("1 identity provider");
  });

  it("IP allowlist: entries validated with normalizeCidr, the caller's IP shown, saved normalized and logged per range", async () => {
    const fake = await open();
    await change("ipAllowlist");
    expect($('[data-kv="Your IP address"]').textContent).toContain("203.0.113.24");
    click(toggle("Turn on IP allowlist", dialog()));
    await settle();
    expect(button("Save", dialog()).disabled).toBe(true);
    expect(dialog().textContent).toContain("Add at least one IP address or range.");
    typeArea(input("IP addresses"), "10.0.0.0/8, 300.1.1.1");
    await settle();
    expect(dialog().textContent).toContain("“300.1.1.1” isn't an IP address or range.");
    expect(button("Save", dialog()).disabled).toBe(true);
    typeArea(input("IP addresses"), "10.1.2.3/8, 203.0.113.0/24 2001:db8::1/32");
    await settle();
    expect($('[data-caller-ip]').getAttribute("data-caller-ip")).toBe("in");
    click(button("Save", dialog()));
    await settle();
    await settle();
    expect(fake.governanceState.allowlist.enabled).toBe(true);
    expect(fake.governanceState.allowlist.ranges.map((r) => r.cidr)).toEqual(["10.0.0.0/8", "203.0.113.0/24", "2001:db8::/32"]);
    expect(actions(fake).slice(0, 4).sort()).toEqual(["ip_allowlist_range_create", "ip_allowlist_range_create", "ip_allowlist_range_create", "ip_allowlist_setting_change"]);
    expect(sentences(fake)).toContain("Added 10.0.0.0/8 to the IP allowlist");
    expect(setting("ipAllowlist").textContent).toContain("On · 3 addresses or ranges");
  });

  it("External access: 2FA for Guests confirms the guests it blocks and People badges them; default duration for guest access", async () => {
    const fake = await open();
    click(toggle("2FA for Guests", setting("guestTwoFactor")));
    await settle();
    expect($("[data-guests-blocked]").textContent).toContain("3 guests will be blocked");
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.twoFactorForGuests).toBe(true);
    expect(sentences(fake)[0]).toBe("Required guests to use two-factor authentication");

    await change("guestExpiry");
    click(radio("Guest access expires after"));
    await settle();
    type(input("Days"), "0");
    await settle();
    expect(button("Save", dialog()).disabled).toBe(true);
    type(input("Days"), "30");
    await settle();
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.guestExpiryDays).toBe(30);
    expect(setting("guestExpiry").textContent).toContain("30 days");
    expect(sentences(fake)[0]).toBe("Set the default duration for guest access to 30 days");

    click(nav("People"));
    await settle();
    await settle();
    const blocked = $$('[data-admin-table="People"] [data-row]').filter((r) => r.querySelector("[data-blocked]")).map((r) => r.getAttribute("data-row"));
    expect(blocked.sort()).toEqual(["g2", "g3", "g4"]);
  });

  it("File exporting: the three options and a workspace's override, each logged", async () => {
    const fake = await open();
    await change("fileExporting");
    click(radio("Prevent exporting by guest viewers"));
    await settle();
    const ws = fake.state.workspaces[0];
    await choose(`File exporting for ${ws.name}`, "Prevent exporting for all viewers", dialog());
    click(button("Save", dialog()));
    await settle();
    await settle();
    expect(fake.state.settings.fileExporting).toBe("guests_blocked");
    expect(fake.state.workspaces[0].sharing).toEqual({ fileExporting: "viewers_blocked" });
    expect(actions(fake).slice(0, 2)).toEqual(["workspace_file_export_controls_setting_change", "file_export_controls_setting_change"]);
    expect(sentences(fake)[1]).toBe("Changed file exporting to “Prevent exporting by guest viewers”");
    expect(setting("fileExporting").textContent).toContain("1 workspace with custom settings");
    // Not a public sharing override
    expect(setting("publicSharing").textContent).not.toContain("workspace with custom settings");
  });

  it("Network access restrictions: too-wide ranges refused, new ranges in Testing with the shadow count, Enforced, Remove", async () => {
    const fake = await open();
    await change("networkRanges", "Manage");
    typeArea(input("IP range"), "10.0.0.0/8");
    await settle();
    expect(button("Add range", dialog()).disabled).toBe(true);
    expect(dialog().textContent).toContain("IPv4 range of /16 or narrower");
    typeArea(input("IP range"), "198.51.100.7/24");
    await settle();
    click(button("Add range", dialog()));
    await settle();
    await settle();
    const r = fake.governanceState.networkRanges[0];
    expect(r).toMatchObject({ cidr: "198.51.100.0/24", state: "testing" });
    expect($(`[data-row="${r.id}"]`).textContent).toContain(`accounts would have been blocked in the last 7 days`);
    await choose("Status of 198.51.100.0/24", "Enforced", dialog());
    await settle();
    expect(fake.governanceState.networkRanges[0].state).toBe("enforced");
    expect(actions(fake).slice(0, 2)).toEqual(["ip_restriction_change", "network_access_restriction_range_update"]);
    expect(sentences(fake)[1]).toBe("Set 198.51.100.0/24 to Enforced");
    click($(`[data-row="${r.id}"] [aria-label^="More for"]`));
    await settle();
    click(menuItem("Remove"));
    await settle();
    click(button("Remove", dialog()));
    await settle();
    await settle();
    expect(fake.governanceState.networkRanges).toHaveLength(0);
  });

  it("Other: Internal policies created (never edited), disabled and re-enabled with the agreed count; Discovery toggled", async () => {
    const fake = await open();
    expect(setting("policies").textContent).toContain("1 policy enabled");
    await change("policies", "Manage");
    expect($('[data-row="pol1"] [data-acknowledged]').textContent).toBe("31");
    click(button("New policy", dialog()));
    await settle();
    expect(button("Create policy", dialog()).disabled).toBe(true);
    typeArea(input("Title"), "Confidentiality");
    typeArea(input("Policy text"), "Client work stays inside the organization.");
    await settle();
    await choose("Audience", "Guests", dialog());
    await choose("Ask to agree", "Once per user", dialog());
    click(button("Create policy", dialog()));
    await settle();
    await settle();
    expect(fake.governanceState.policies[0]).toMatchObject({ title: "Confidentiality", audience: "guests", cadence: "once", acknowledgedCount: 0 });
    expect(fake.state.activity[0]).toMatchObject({ action: { type: "policy_create" }, entity: { type: "policy_acknowledgement_config", name: "Confidentiality" } });
    click(button("Disable", $('[data-row="pol1"]')));
    await settle();
    await settle();
    expect(fake.governanceState.policies.find((p) => p.id === "pol1")!.disabledAt).not.toBeNull();
    expect(sentences(fake)[0]).toBe("Disabled an internal policy");
    click(button("Done", dialog()));
    await settle();
    expect(setting("policies").textContent).toContain("1 policy enabled");

    expect(setting("discovery").textContent).toContain("everyone's text in the organization is recorded");
    click(toggle("Discovery", setting("discovery")));
    await settle();
    expect(fake.state.settings.discovery).toBe(true);
    expect(sentences(fake)[0]).toBe("Turned Discovery on");
  });

  it("Key management: Turn on (irreversible confirm), then every existing file encrypted with the progress", async () => {
    const fake = await open();
    expect(setting("keyManagement").textContent).toContain("Off");
    await change("keyManagement", "Turn on");
    expect($("[data-ekm-note]").textContent).toContain("not against the server's operator");
    click(button("Turn on", dialog()));
    await settle();
    expect(dialog().textContent).toContain("This can't be undone");
    click(button("Turn on", dialog()));
    for (let i = 0; i < 40; i++) await settle();
    expect(fake.governanceState.ekm.enabled).toBe(true);
    expect(fake.governanceState.files.every((f) => f.encrypted)).toBe(true);
    expect(dialog().textContent).toContain("Every file is encrypted.");
    expect(actions(fake).filter((a) => a === "fig_file_encrypt")).toHaveLength(24);
    expect(actions(fake)).toContain("ekm_enable");
    click(button("Done", dialog()));
    await settle();
    expect(setting("keyManagement").textContent).toContain("On");
    expect(button("Remove", setting("governancePlus")).disabled).toBe(true);
  });

  it("People: the guests' expiration date column, Change / Remove expiration date, and the bulk Set guest expiration date", async () => {
    const fake = await open({ initial: { section: "people" } });
    const head = $('[data-admin-table="People"] [role="row"]').textContent;
    expect(head).toContain("Guest access expiration date");
    expect($('[data-row="g2"]').textContent).toContain("No expiration date");
    expect($('[data-row="u2"]').textContent).not.toContain("No expiration date");

    click($('[data-row="g2"] [aria-label^="Guest access expiration date"]'));
    await settle();
    typeArea(input("Expiration date"), "2026-12-31");
    await settle();
    click(button("Save", dialog()));
    await settle();
    await settle();
    const g2 = fake.state.people.find((p) => p.id === "g2")!;
    expect(new Date(g2.guestExpiresAt!).getDate()).toBe(31);
    expect(actions(fake)[0]).toBe("org_user_guest_expiration_change");

    click($('[aria-label^="Actions for"]', $('[data-row="g1"]')));
    await settle();
    click(menuItem("Remove expiration date"));
    await settle();
    await settle();
    expect(fake.state.people.find((p) => p.id === "g1")!.guestExpiresAt).toBeNull();
    expect(sentences(fake)[0]).toBe("Removed a guest's access expiration date");

    // Bulk: only the guests among the checked rows
    for (const id of ["g3", "g4", "u2"]) click($(`[data-row="${id}"] input[type="checkbox"]`));
    await settle();
    click(button("Set guest expiration date", $('[aria-label="Selected people"]')));
    await settle();
    expect($("[data-guest-expiry]").getAttribute("data-guest-expiry")).toBe("g3,g4");
    typeArea(input("Expiration date"), "2027-06-30");
    await settle();
    click(button("Save", dialog()));
    await settle();
    await settle();
    expect(["g3", "g4"].map((id) => new Date(fake.state.people.find((p) => p.id === id)!.guestExpiresAt!).getMonth())).toEqual([5, 5]);
  });

  it("Activity › Developer logs: filters and Load more; without the add-on, Requires Governance+", async () => {
    const fake = await open({ initial: { section: "activity" } });
    expect($('[data-admin-table="Activity"]')).not.toBeNull();
    click(tab("Developer logs"));
    await settle();
    await settle();
    const rows = () => $$('[data-admin-table="Developer logs"] [data-row]');
    expect(rows()).toHaveLength(25);
    click(button("Load more"));
    await settle();
    await settle();
    expect(rows()).toHaveLength(50);
    await choose("Source", "MCP server");
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().every((r) => r.textContent?.includes("MCP server"))).toBe(true);
    await choose("Source", "All sources");
    await choose("Date range", "Last 24 hours");
    expect(rows().length).toBeLessThan(5);
    await choose("Date range", "Last 30 days");
    typeArea($$("input").find((i) => i.getAttribute("aria-label") === "IP address") as HTMLInputElement, "2001:db8");
    await settle();
    await settle();
    expect(rows().every((r) => r.textContent?.includes("2001:db8"))).toBe(true);
    expect(rows().length).toBe(Math.min(25, fake.governanceState.developerLogs.filter((d) => d.context.ip_address.startsWith("2001:db8")).length));

    m!.unmount();
    await open({ initial: { section: "activity", tab: "developer" } }, {});
    expect($("[data-requires-gplus]").textContent).toBe("Requires Governance+");
  });

  it("without GovernanceRepository: the rows say Unavailable, Billing has no Governance+ row, Activity has no tabs", async () => {
    const fake = createFakeAdminStore({ now: NOW });
    m = mount(AdminApp, { orgId: fake.state.orgId, store: { admin: fake.admin, orgs: fake.orgs, identity: fake.identity }, now: () => NOW, initial: { section: "settings" } });
    await settle();
    await settle();
    expect(setting("ipAllowlist").textContent).toContain("Unavailable");
    expect(setting("governancePlus")).toBeNull();
    click(nav("Activity"));
    await settle();
    expect(tab("Developer logs")).toBeUndefined();
  });
});
