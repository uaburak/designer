// @vitest-environment happy-dom
/**
 * Admin › Settings, round 4d (docs/roadmap.md Phase 7 round 4; docs/multiplayer.md §15): Figma's sections with every
 * row live on the fake org — Authentication gated by a tested SAML config, Configure SAML → Review → Configure SAML
 * SSO, Test, Remove; the SCIM token shown once; the idle timeout's range; domains verified by their TXT record and
 * domain capture; external content needing capture; public sharing and a workspace's custom settings; the data region
 * moved with its progress; the toggles and their activity sentences; People's SCIM columns.
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
const button = (label: string, root: ParentNode = document) => $$("button", root).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label) as HTMLButtonElement;
const dialogs = () => $$('[role="dialog"]');
const dialog = () => dialogs()[dialogs().length - 1];
const setting = (id: string) => $(`[data-setting="${id}"]`);
const toggle = (label: string, root: ParentNode = document) => $$('[role="switch"]', root).find((s) => s.getAttribute("aria-label") === label) as HTMLButtonElement;
const input = (label: string, root: ParentNode = dialog()) => $$("input,textarea", root).find((i) => i.getAttribute("aria-label") === label) as HTMLInputElement;
const radio = (label: string, root: ParentNode = dialog()) => $$('[role="radiogroup"] label', root).find((l) => l.textContent?.includes(label))!.querySelector('[role="radio"]') as HTMLButtonElement;
const checkbox = (label: string, root: ParentNode = dialog()) => $$('label', root).find((l) => l.textContent?.trim() === label && l.querySelector('input[type="checkbox"]'))!.querySelector('input') as HTMLInputElement;
const nav = (label: string) => $$('nav [data-ds="SidebarItem"]').find((b) => b.textContent?.includes(label))!;
async function choose(label: string, option: string) {
  click($$('[role="combobox"]').find((c) => c.getAttribute("aria-label") === label)!);
  await settle();
  click($$('[role="option"]').find((o) => o.textContent?.trim() === option)!);
  await settle();
}

async function open(props: Partial<AdminAppProps> = {}, store?: (f: FakeAdminStore) => AdminAppProps["store"]): Promise<FakeAdminStore> {
  const fake = createFakeAdminStore({ now: NOW });
  m = mount(AdminApp, { orgId: fake.state.orgId, store: store ? store(fake) : fake, now: () => NOW, onTestSso: fake.testSso, initial: { section: "settings" }, ...props });
  await settle();
  await settle();
  return fake;
}
async function change(id: string, label = "Change") {
  click(button(label, setting(id)));
  await settle();
}
const actions = (fake: FakeAdminStore) => fake.state.activity.map((r) => r.action.type);

describe("Admin › Settings (round 4)", () => {
  it("shows Figma's sections, every row live but the installer's Download", async () => {
    await open();
    expect($$("[data-settings-group]").map((g) => g.getAttribute("data-settings-group"))).toEqual(["Login and provisioning", "Access", "Team management", "Content", "Communication", "Data", "Billing", "Other"]);
    const disabled = $$("[data-setting]").filter((r) => $$("button", r).some((b) => (b as HTMLButtonElement).disabled)).map((r) => r.getAttribute("data-setting"));
    // SCIM waits for SAML (Figma: SCIM requires SAML); Access to external content waits for domain capture
    expect(disabled.sort()).toEqual(["externalContent", "installer", "scim"]);
    expect(button("Download", setting("installer")).disabled).toBe(true);
  });

  it("SAML SSO: configure, copy the SP values, test, then require it; Remove refused while required", async () => {
    const fake = await open();
    await change("authentication");
    expect(radio("Members must log in with SAML SSO").disabled).toBe(true);
    click(button("Cancel", dialog()));
    await settle();

    await change("saml", "Configure SAML");
    expect(dialog().textContent).toContain("Configure SAML");
    expect(button("Review", dialog()).disabled).toBe(true);
    type(input("IdP metadata URL"), "https://acme.okta.com/app/exk1/sso/saml/metadata");
    await settle();
    click(button("Review", dialog()));
    await settle();
    expect(button("Configure SAML SSO", dialog()).disabled).toBe(true);
    click(checkbox("This information is correct"));
    await settle();
    click(button("Configure SAML SSO", dialog()));
    await settle();
    const idp = fake.identityState.idp!;
    expect(idp.provider).toBe("okta");
    expect(idp.tenantId).toMatch(/^\d{18}$/);
    expect($('[data-kv="SP Entity ID"]').textContent).toContain(`/saml/${idp.tenantId}`);
    expect($('[data-kv="SP ACS URL"]').textContent).toContain(`/saml/${idp.tenantId}/consume`);
    expect($('[data-saml-status="untested"]')).not.toBeNull();
    expect(actions(fake)[0]).toBe("idp_config_create");

    click(button("Test", dialog()));
    await settle();
    await settle();
    expect(fake.identityState.idp!.testedAt).not.toBeNull();
    expect($('[data-saml-status="tested"]')).not.toBeNull();
    click(button("Done", dialog()));
    await settle();

    await change("authentication");
    click(radio("Members must log in with SAML SSO"));
    click(button("Done", dialog()));
    await settle();
    expect(fake.state.settings.authMethod).toBe("saml");
    expect(actions(fake)[0]).toBe("saml_sso_auth_change");

    await change("saml", "Manage");
    expect(button("Remove", dialog()).disabled).toBe(true);
  });

  it("SCIM provisioning: the API token shown once, then revoked", async () => {
    const fake = await open();
    await fake.identity.saveIdp(fake.state.orgId, { provider: "entra", metadataUrl: "https://login.microsoftonline.com/x/federationmetadata.xml" });
    m!.unmount();
    m = mount(AdminApp, { orgId: fake.state.orgId, store: fake, now: () => NOW, initial: { section: "settings" } });
    await settle();
    await settle();
    await change("scim");
    expect($('[data-kv="SCIM base URL"]').textContent).toContain(`/scim/v2/${fake.identityState.idp!.tenantId}`);
    click(button("Generate API token", dialog()));
    await settle();
    expect($("[data-scim-token] pre").textContent).toMatch(/^dsgn_scim_/);
    expect(dialog().textContent).toContain("You won't be able to see it again");
    expect(fake.identityState.scimToken).not.toBeNull();
    click(button("Revoke", dialog()));
    await settle();
    click(button("Revoke", dialog()));
    await settle();
    expect(fake.identityState.scimToken).toBeNull();
    expect(actions(fake).slice(0, 2)).toEqual(["scim_token_revoke", "scim_token_generate"]);
  });

  it("Idle session timeout: Custom timeout within 12 hours–14 days", async () => {
    const fake = await open();
    expect(setting("idle").textContent).toContain("21 days (default)");
    await change("idle");
    click(radio("Custom timeout"));
    await settle();
    type(input("Timeout"), "20");
    await settle();
    expect(button("Save", dialog()).disabled).toBe(true);
    expect(dialog().textContent).toContain("Choose between 12 hours and 14 days.");
    type(input("Timeout"), "2");
    await settle();
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.idleSessionTimeoutHours).toBe(48);
    expect(setting("idle").textContent).toContain("2 days");
    expect(actions(fake)[0]).toBe("idle_timeout_setting_change");
  });

  it("Manage domains: + Domain, Verify with the values found, domain capture, then external content", async () => {
    const fake = await open();
    await change("domains", "Manage");
    click(button("Domain", dialog()));
    await settle();
    type(input("Domain"), "https://Acme.com/");
    await settle();
    click(button("Add", dialog()));
    await settle();
    const acme = fake.identityState.domains.find((d) => d.domain === "acme.com")!;
    expect(acme.verified).toBe(false);
    expect($('[data-txt="acme.com"]').textContent).toContain(acme.txtRecord);
    // Capture needs every domain verified
    expect(toggle("Domain capture", dialog()).disabled).toBe(true);
    fake.identityState.dns.set("acme.com", ["google-site-verification=abc"]);
    click(button("Verify", $('[data-admin-table="Domains"] [data-row="acme.com"]')));
    await settle();
    expect($('[data-found="acme.com"]').textContent).toContain("google-site-verification=abc");
    fake.identityState.dns.set("acme.com", [acme.txtRecord]);
    click(button("Verify", $('[data-admin-table="Domains"] [data-row="acme.com"]')));
    await settle();
    expect(acme.verified).toBe(true);
    expect($('[data-txt="acme.com"]')).toBeNull();
    const before = fake.state.people.length;
    click(toggle("Domain capture", dialog()));
    await settle();
    click(button("Turn on", dialog()));
    await settle();
    expect(fake.state.settings.domainCapture).toBe(true);
    expect(fake.state.people.length).toBe(before + 2); // the two outside accounts on studio.co, as View members
    expect(fake.state.people.slice(-1)[0].seat).toBe("view");
    expect(actions(fake)).toContain("org_domain_capture_change");
    click(button("Done", dialog()));
    await settle();

    expect(button("Change", setting("externalContent")).disabled).toBe(false);
    await change("externalContent");
    click(radio("Restrict access to external content"));
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.externalContent).toBe("restricted");
    expect(actions(fake)[0]).toBe("external_collaboration_controls_setting_change");
  });

  it("Public sharing: passwords, expiry, a workspace's custom settings", async () => {
    const fake = await open();
    await change("publicSharing");
    click(checkbox("Require passwords"));
    click(checkbox("Require design file links to expire"));
    await settle();
    type(input("Maximum"), "40");
    await settle();
    expect(button("Save", dialog()).disabled).toBe(true);
    type(input("Maximum"), "3");
    await settle();
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.passwordRequired).toBe(true);
    expect(fake.state.settings.linkExpiryMaxHours).toBe(72);
    expect(fake.state.activity[0].action.type).toBe("public_link_setting_change");
    expect(setting("publicSharing").textContent).toContain("Links expire within 3 days");

    await change("publicSharing");
    click(button("Add workspace", dialog()));
    await settle();
    click(button("Next", dialog()));
    await settle();
    await choose("Public link sharing", "Off");
    click(button("Save", dialog()));
    await settle();
    const ws = fake.state.workspaces.find((w) => w.sharing)!;
    expect(ws.sharing).toEqual({ publicLinks: false });
    expect(actions(fake)[0]).toBe("workspace_public_link_setting_change");
    expect($(`[data-workspace-sharing="${ws.id}"]`).textContent).toContain("Public links off");
  });

  it("Data storage localization: Change → confirm → every file moved, with the progress", async () => {
    const fake = await open();
    expect(setting("dataRegion").textContent).toContain("Default");
    await change("dataRegion");
    await settle();
    await choose("Region", "European Union");
    click(button("Change", dialog()));
    await settle();
    click(button("Change", dialog()));
    for (let i = 0; i < 40; i++) await settle();
    expect(fake.identityState.region).toBe("eu");
    expect(fake.identityState.objects.every((o) => o.region === "eu")).toBe(true);
    expect(actions(fake).filter((a) => a === "fig_file_region_move")).toHaveLength(fake.identityState.objects.length);
    expect(actions(fake)).toContain("data_storage_localization_change");
    click(button("Cancel", dialog()));
    await settle();
    expect(setting("dataRegion").textContent).toContain("European Union");
  });

  it("toggles save at once and the activity log says what changed", async () => {
    const fake = await open();
    click(toggle("Cursor chat"));
    await settle();
    click(toggle("Audio"));
    await settle();
    click(toggle("FigJam open sessions"));
    await settle();
    expect([fake.state.settings.cursorChat, fake.state.settings.audio, fake.state.settings.openSessions]).toEqual([false, false, false]);
    expect(actions(fake).slice(0, 3)).toEqual(["open_sessions_setting_change", "audio_setting_change", "cursor_chat_setting_change"]);
    click(nav("Activity"));
    await settle();
    const text = $('[data-admin-table="Activity"]').textContent!;
    expect(text).toContain("Turned cursor chat off");
    expect(text).toContain("Turned audio off");
    expect(text).toContain("Turned FigJam open sessions off");
  });

  it("People: SCIM data columns; without IdentityRepository the login rows are unavailable", async () => {
    await open({ initial: { section: "people" } });
    const head = () => $('[data-admin-table="People"] [role="row"]').textContent;
    expect(head()).toContain("Provisioned by");
    expect($('[data-admin-table="People"] [data-row="u2"]').textContent).toContain("SCIM");
    m!.unmount();
    await open({}, (f) => ({ admin: f.admin, orgs: f.orgs, teams: f.teams }));
    expect(setting("saml").textContent).toContain("Unavailable");
    expect(button("Configure SAML", setting("saml")).disabled).toBe(true);
    expect(setting("dataRegion").textContent).toContain("Unavailable");
  });
});
