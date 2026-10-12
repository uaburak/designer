// @vitest-environment happy-dom
/**
 * Admin, round 5 (docs/plugins.md §10, docs/multiplayer.md §16.3) on the fake org: Settings › Extensions (Plugin /
 * Widget approval with "Allow members to request …") and Settings › Plan access tokens (generated once, plan scopes
 * only, revoked); Resources › Plugins — Approved grouped by plugin, Add plugin, Edit approvals per workspace, Requests
 * with the review (Overview, Request history, Decline with a reason, Approve for workspaces), the org's private
 * plugins; a workspace admin's own requests; the activity log's sentences.
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
const rows = (table: string) => $$(`[data-admin-table="${table}"] [data-row]`);
const row = (table: string, text: string) => rows(table).find((r) => r.textContent?.includes(text))!;
const tab = (label: string) => $$('[role="tab"]').find((b) => b.textContent === label || b.textContent === label + label)!;
const toggle = (label: string, root: ParentNode = document) => $$('[role="switch"]', root).find((s) => s.getAttribute("aria-label") === label) as HTMLButtonElement;
const input = (label: string, root: ParentNode = dialog()) => $$("input,textarea", root).find((i) => i.getAttribute("aria-label") === label) as HTMLInputElement;
const radio = (label: string, root: ParentNode = dialog()) => $$('[role="radiogroup"] label', root).find((l) => l.textContent?.includes(label))!.querySelector('[role="radio"]') as HTMLButtonElement;
const checkbox = (label: string, root: ParentNode = dialog()) => $$("label", root).find((l) => l.textContent?.trim() === label && l.querySelector('input[type="checkbox"]'))!.querySelector("input") as HTMLInputElement;
const actions = (fake: FakeAdminStore) => fake.state.activity.map((r) => r.action.type);

async function open(props: Partial<AdminAppProps> = {}, fake = createFakeAdminStore({ now: NOW })): Promise<FakeAdminStore> {
  m = mount(AdminApp, { orgId: fake.state.orgId, store: fake, now: () => NOW, ...props });
  await settle();
  await settle();
  return fake;
}
async function plugins(view?: "approved" | "requests" | "private") {
  click(tab("Plugins"));
  await settle();
  if (view) {
    click($(`[data-plugins-view="${view}"]`)!);
    await settle();
  }
}

describe("Admin › Settings › Extensions and Plan access tokens", () => {
  it("Plugin approval: only admin-approved plugins, requests off, then on again — each logged with Figma's action", async () => {
    const fake = await open({ initial: { section: "settings" } });
    const rowEl = $('[data-setting="pluginApproval"]')!;
    expect(rowEl.textContent).toContain("All plugins");
    click(button("Change", rowEl));
    await settle();
    expect(checkbox("Allow members to request plugins").disabled).toBe(true);
    click(radio("Only admin-approved plugins."));
    await settle();
    click(checkbox("Allow members to request plugins"));
    await settle();
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings).toMatchObject({ pluginApproval: "approved", pluginRequests: false });
    expect($('[data-setting="pluginApproval"]')!.textContent).toContain("Only admin-approved plugins");
    expect($('[data-setting="pluginApproval"]')!.textContent).toContain("Members can't request plugins");
    expect(fake.state.activity[0].action.type).toBe("plugin_approvelist_enable");
    expect(eventText(fake.state.activity[0])).toBe("Turned on the setting that allows only plugins on the approved plugin list");

    click(button("Change", $('[data-setting="pluginApproval"]')!));
    await settle();
    click(checkbox("Allow members to request plugins"));
    await settle();
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.pluginRequests).toBe(true);
    expect(eventText(fake.state.activity[0])).toBe("Allowed members to request plugins");

    click(button("Change", $('[data-setting="widgetApproval"]')!));
    await settle();
    click(radio("Only admin-approved widgets."));
    await settle();
    click(button("Save", dialog()));
    await settle();
    expect(fake.state.settings.widgetApproval).toBe("approved");
    expect(fake.state.activity[0].action.type).toBe("widgets_enabled");
  });

  it("Plan access tokens: the list, Generate new token (plan scopes only, the secret once), Revoke", async () => {
    const fake = await open({ initial: { section: "settings" } });
    expect(rows("Plan access tokens").map((r) => r.textContent)).toEqual([expect.stringContaining("Activity export")]);
    click(button("Generate new token", $('[data-setting="planTokens"]')!));
    await settle();
    expect($$("[data-plan-scope]", dialog()).map((s) => s.getAttribute("data-plan-scope"))).toEqual(["org:activity_log_read", "org:ai_metering_usage_read", "library_analytics:read", "webhooks:read", "webhooks:write", "org:discovery_read", "org:developer_log_read"]);
    expect(button("Generate token", dialog()).disabled).toBe(true);
    type(input("Token name"), "Usage export");
    click(checkbox("org:ai_metering_usage_read"));
    await settle();
    click(button("Generate token", dialog()));
    await settle();
    expect(dialog().textContent).toContain("This is the only time your token secret is displayed.");
    expect($("[data-new-plan-token]")!.textContent).toMatch(/dsgn_plan_/);
    click(button("Done", dialog()));
    await settle();
    expect(rows("Plan access tokens")).toHaveLength(2);
    expect(fake.pluginsState.planTokens.find((t) => t.description === "Usage export")).toMatchObject({ scopes: ["org:ai_metering_usage_read"], kind: "plan" });
    expect(eventText(fake.state.activity[0])).toBe("Created a new plan access token");

    click($('[data-row] [aria-label="Actions for Activity export"]') ?? row("Plan access tokens", "Activity export").querySelector("button")!);
    await settle();
    click($$('[role="menuitem"]').find((i) => i.textContent?.includes("Revoke token"))!);
    await settle();
    click(button("Revoke token", dialog()));
    await settle();
    expect(rows("Plan access tokens").map((r) => r.textContent?.includes("Activity export"))).toEqual([false]);
    expect(actions(fake)[0]).toBe("plan_access_token_delete");
  });
});

describe("Admin › Resources › Plugins", () => {
  it("Approved: grouped by plugin; Add plugin for workspaces; Edit approvals per workspace", async () => {
    const fake = await open({ initial: { section: "resources" } });
    await plugins();
    expect(rows("Approved plugins").map((r) => r.querySelector("[data-approved-for]")?.textContent)).toEqual(["Design", "Studio", "Design, Engineering", "Studio"]);
    click(button("Add plugin"));
    await settle();
    type(input("Plugin ID"), "1253571037276959291");
    type(input("Name"), "Autoflow");
    click(radio("Specific workspaces"));
    await settle();
    expect(button("Add", dialog()).disabled).toBe(true);
    click(checkbox("Engineering"));
    await settle();
    click(button("Add", dialog()));
    await settle();
    expect(fake.pluginsState.approved.filter((a) => a.pluginId === "1253571037276959291").map((a) => a.scope)).toEqual([{ type: "workspace", id: "ws-eng" }]);
    expect(actions(fake)[0]).toBe("plugin_approvelist_add_workspace");

    click(row("Approved plugins", "Autoflow"));
    await settle();
    click(button("Edit approvals", dialog()));
    await settle();
    click(toggle("Design", dialog()));
    await settle();
    expect(fake.pluginsState.approved.filter((a) => a.pluginId === "1253571037276959291").map((a) => (a.scope.type === "workspace" ? a.scope.id : "org")).sort()).toEqual(["ws-design", "ws-eng"]);
    click(toggle("Engineering", dialog()));
    await settle();
    expect(actions(fake)[0]).toBe("plugin_approvelist_remove_workspace");
    click(toggle("Studio", dialog()));
    await settle();
    expect(fake.pluginsState.approved.filter((a) => a.pluginId === "1253571037276959291").map((a) => a.scope.type).sort()).toEqual(["org", "workspace"]);
    expect(eventText(fake.state.activity[0])).toBe("Added a plugin to the approved plugin list");
  });

  it("Requests: the review's Overview and history, Decline with a reason, Approve for a workspace", async () => {
    const fake = await open({ initial: { section: "resources" } });
    await plugins("requests");
    expect($('[data-plugins-view="requests"]')!.textContent).toBe("Requests (2)");
    click(row("Plugin requests", "We need contrast checks"));
    await settle();
    expect(dialog().textContent).toContain("Overview");
    expect($('[data-review="network"]')!.textContent).toContain("https://api.getstark.co");
    expect(dialog().textContent).toContain("Stark checks contrast");
    expect(dialog().textContent).toContain("Figma Design, Dev Mode");
    expect(button("Try it out", dialog()).disabled).toBe(true);
    click(tab("Request history"));
    await settle();
    expect($('[data-review="history"]')!.textContent).toContain("Waiting for the security review.");
    click(button("Decline", dialog()));
    await settle();
    act(() => {
      const area = input("Reason (optional)") as unknown as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Use the built-in contrast check.");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    click(button("Decline", dialog()));
    await settle();
    expect(fake.pluginsState.requests.find((q) => q.id === "pr1")).toMatchObject({ state: "declined", declineReason: "Use the built-in contrast check." });
    expect(actions(fake)[0]).toBe("plugin_approvelist_request_reject_org");
    expect($('[data-plugins-view="requests"]')!.textContent).toBe("Requests (1)");

    click(row("Plugin requests", "Batch Styler"));
    await settle();
    click(button("Approve", dialog()));
    await settle();
    // Enterprise: the organization, or chosen workspaces (the request's own preselected)
    click(radio("Specific workspaces"));
    await settle();
    click(button("Approve", dialog()));
    await settle();
    expect(fake.pluginsState.requests.find((q) => q.id === "pr2")!.state).toBe("approved");
    expect(fake.pluginsState.approved.filter((a) => a.pluginId === "1146213000417306829").map((a) => a.scope)).toEqual([{ type: "workspace", id: "ws-design" }]);
    expect(actions(fake).slice(0, 2)).toEqual(["plugin_approvelist_request_approve_workspace", "plugin_approvelist_add_workspace"]);
    expect($('[data-plugins-view="requests"]')!.textContent).toBe("Requests");
  });

  it("Try it out hands the request over; the org's private plugins with Remove", async () => {
    const tried: string[] = [];
    const fake = await open({ initial: { section: "resources" }, onTryPlugin: async (q) => void tried.push(q.pluginId) });
    await plugins("requests");
    click(row("Plugin requests", "Stark"));
    await settle();
    click(button("Try it out", dialog()));
    await settle();
    expect(tried).toEqual(["740272380439725040"]);
    click(button("Close", dialog()));
    await settle();
    click($('[data-plugins-view="private"]')!);
    await settle();
    expect($('[data-plugins-view="private"]')!.textContent).toBe("From Studio");
    expect(rows("Private plugins").map((r) => r.querySelector("[class*=whoName]")?.textContent)).toEqual(["Studio Tokens Sync", "Copy Checker"]);
    click(row("Private plugins", "Copy Checker").querySelector('[aria-label="Copy Checker options"]')!);
    await settle();
    click($$('[role="menuitem"]').find((i) => i.textContent?.includes("Remove plugin"))!);
    await settle();
    click(button("Remove", dialog()));
    await settle();
    expect(rows("Private plugins")).toHaveLength(1);
    expect(eventText(fake.state.activity[0])).toBe("Deleted a plugin published privately to the organization");
  });

  it("Widgets: the same lists for widgets; Remove on an approved one", async () => {
    const fake = await open({ initial: { section: "resources" } });
    click(tab("Widgets"));
    await settle();
    expect(rows("Approved widgets").map((r) => r.textContent)).toEqual([expect.stringContaining("Polls")]);
    click(row("Approved widgets", "Polls"));
    await settle();
    click(button("Edit approvals", dialog()));
    await settle();
    click(toggle("Studio", dialog()));
    await settle();
    expect(fake.pluginsState.approved.some((a) => a.kind === "widget")).toBe(false);
    expect(actions(fake)[0]).toBe("widget_approvelist_remove");
  });

  it("a workspace admin: the workspace's requests only, approved for the workspace at once", async () => {
    const fake = await open({ workspace: { id: "ws-design", name: "Design" } });
    click($$('nav [data-ds="SidebarItem"]').find((b) => b.textContent?.includes("Plugins"))!);
    await settle();
    click($('[data-plugins-view="requests"]')!);
    await settle();
    expect(rows("Plugin requests").map((r) => r.textContent?.includes("Batch Styler"))).toEqual([true]);
    expect($('[data-plugins-view="private"]')).toBeNull();
    click(row("Plugin requests", "Batch Styler"));
    await settle();
    click(button("Approve", dialog()));
    await settle();
    expect(fake.pluginsState.approved.filter((a) => a.pluginId === "1146213000417306829").map((a) => a.scope)).toEqual([{ type: "workspace", id: "ws-design" }]);
  });

  it("without the plugins repository the tabs say so", async () => {
    const fake = createFakeAdminStore({ now: NOW });
    await open({ initial: { section: "resources" }, store: { ...fake, plugins: undefined } }, fake);
    await plugins();
    expect($('[data-admin-page="resources/plugins"]')!.textContent).toContain("Plugins aren't available here.");
  });
});
