/**
 * Admin › Resources › Plugins / Widgets and Settings › Plan access tokens on the fake org: the admin side of
 * `PluginsRepository` (docs/plugins.md §10.2–§10.3) and the plan token calls of `AdminRepository` (docs/multiplayer.md
 * §16.3) over in-memory rows. They keep the server's rules the views show (server/src/plugins/approvals.ts,
 * private.ts; server/src/rest/planTokens.ts): approving also answers the pending requests it covers, an answered
 * request can't be answered again, a decline keeps its reason, removal of a row that isn't there is not-found, every
 * change logs Figma's action; a plan token is shown once and holds only the plan scopes.
 */
import type { AccessTokenInfo, TokenScope } from "@shared/account";
import type * as O from "@shared/org/types";
import type { PluginApproval, PluginKind, PluginManifest, PluginRequest, PrivatePlugin } from "@shared/plugins/types";
import { PLAN_TOKEN_SCOPES, type RestScope } from "@shared/rest/types";
import type { AdminPluginsApi } from "../context";
import type { Seed } from "./seed";

export type { AdminPluginsApi };

const DAY = 86_400_000;

export interface PluginsState {
  approved: (PluginApproval & { orgId: string })[];
  requests: PluginRequest[];
  private: PrivatePlugin[];
  planTokens: AccessTokenInfo[];
}

type Log = (type: O.ActivityAction, entity: O.ActivityLog["entity"], details?: Record<string, unknown>) => void;

class Fail extends Error {
  constructor(public code: "not-found" | "invalid" | "conflict", message: string) {
    super(message);
  }
}

const manifest = (name: string, id: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({ name, id, api: "1.0.0", main: "code.js", editorType: ["figma"], ...extra });

export function seedPlugins(s: Seed, now: number): PluginsState {
  const person = (id: string) => {
    const p = s.people.find((x) => x.id === id)!;
    return { id: p.id, email: p.email, name: p.name };
  };
  const approval = (pluginId: string, name: string, scope: PluginApproval["scope"], days: number, kind: PluginKind = "plugin") => ({ orgId: s.orgId, pluginId, kind, name, scope, addedBy: "u1", addedAt: now - days * DAY });
  const request = (id: string, pluginId: string, name: string, by: string, days: number, m: PluginManifest | null, reason: string, extra: Partial<PluginRequest> = {}): PluginRequest => ({
    id, orgId: s.orgId, pluginId, kind: "plugin", name, manifest: m, requestedBy: person(by), workspaceId: null, reason, state: "pending", declineReason: "", createdAt: now - days * DAY, answeredAt: null, ...extra,
  });
  return {
    approved: [
      approval("738454987945972471", "Unsplash", { type: "org" }, 120),
      approval("735098390272716381", "Iconify", { type: "org" }, 90),
      approval("731310036968334777", "Content Reel", { type: "workspace", id: "ws-design" }, 40),
      approval("1189950418479539999", "Tokens Studio for Figma", { type: "workspace", id: "ws-eng" }, 30),
      approval("1189950418479539999", "Tokens Studio for Figma", { type: "workspace", id: "ws-design" }, 30),
      approval("1061386476432436498", "Polls", { type: "org" }, 15, "widget"),
    ],
    requests: [
      request("pr1", "740272380439725040", "Stark", "u7", 1, manifest("Stark", "740272380439725040", { editorType: ["figma", "dev"], networkAccess: { allowedDomains: ["https://api.getstark.co"], reasoning: "Stark checks contrast and stores your audit history on its servers." }, permissions: ["currentuser"] }), "We need contrast checks before handoff."),
      request("pr2", "1146213000417306829", "Batch Styler", "u12", 3, manifest("Batch Styler", "1146213000417306829", { networkAccess: { allowedDomains: ["none"] } }), "Renaming 200 text styles by hand takes a day.", { workspaceId: "ws-design" }),
      request("pr3", "740272380439725040", "Stark", "u18", 20, null, "Accessibility review.", { state: "declined", declineReason: "Waiting for the security review.", answeredAt: now - 18 * DAY }),
      request("pr4", "735098390272716381", "Iconify", "u9", 95, null, "", { state: "approved", answeredAt: now - 90 * DAY }),
    ],
    private: [
      {
        id: "1427781234567890123", orgId: s.orgId, kind: "plugin", name: "Studio Tokens Sync", description: "Pushes the design tokens to the Studio repo.",
        manifest: manifest("Studio Tokens Sync", "studio-tokens-sync", { networkAccess: { allowedDomains: ["https://api.github.com"], reasoning: "Opens pull requests on the tokens repository." } }),
        version: 4, publishedBy: { id: "u13", name: person("u13").name }, createdAt: now - 60 * DAY, updatedAt: now - 2 * DAY, canManage: true,
      },
      {
        id: "1427781234567890456", orgId: s.orgId, kind: "plugin", name: "Copy Checker", description: "Flags text that isn't in the copy deck.",
        manifest: manifest("Copy Checker", "copy-checker", { capabilities: ["textreview"] }), version: 1, publishedBy: { id: "u4", name: person("u4").name }, createdAt: now - 10 * DAY, updatedAt: now - 10 * DAY, canManage: true,
      },
    ],
    planTokens: [
      { id: "t_seed1", description: "Activity export", scopes: ["org:activity_log_read"], kind: "plan", orgId: s.orgId, createdAt: now - 40 * DAY, expiresAt: now + 325 * DAY, lastUsedAt: now - DAY },
    ],
  };
}

export function fakePlugins(s: Seed, st: PluginsState, log: Log, wait: <T>(v: T) => Promise<T>, me: string, now: () => number): AdminPluginsApi {
  const entity = (kind: PluginKind, id: string, name: string): O.ActivityLog["entity"] => ({ type: kind, id, name });
  const action = (kind: PluginKind, what: string) => `${kind === "widget" ? "widget" : "plugin"}_approvelist_${what}` as O.ActivityAction;
  const workspaces = (ids: string[]) => {
    if (!ids.length) throw new Fail("invalid", "Choose at least one workspace");
    for (const id of ids) if (!s.workspaces.some((w) => w.id === id)) throw new Fail("invalid", "no such workspace");
    return [...new Set(ids)];
  };
  const add = (p: { pluginId: string; kind: PluginKind; name: string }, scope: { type: "org" } | { type: "workspace"; ids: string[] }) => {
    const rows: PluginApproval["scope"][] = scope.type === "org" ? [{ type: "org" }] : scope.ids.map((id) => ({ type: "workspace", id }));
    for (const sc of rows) {
      const same = st.approved.find((a) => a.pluginId === p.pluginId && a.kind === p.kind && a.scope.type === sc.type && (sc.type === "org" || (a.scope.type === "workspace" && a.scope.id === sc.id)));
      if (same) same.name = p.name;
      else st.approved.push({ orgId: s.orgId, pluginId: p.pluginId, kind: p.kind, name: p.name, scope: sc, addedBy: me, addedAt: now() });
    }
    log(action(p.kind, scope.type === "org" ? "add" : "add_workspace"), entity(p.kind, p.pluginId, p.name), scope.type === "org" ? {} : { workspace_ids: scope.ids });
  };
  const settle = (q: PluginRequest, approve: boolean, reason: string) => {
    q.state = approve ? "approved" : "declined";
    q.declineReason = approve ? "" : reason;
    q.answeredAt = now();
  };
  const settleCovered = (pluginId: string, kind: PluginKind, scope: { type: "org" } | { type: "workspace"; ids: string[] }) => {
    for (const q of st.requests) if (q.pluginId === pluginId && q.kind === kind && q.state === "pending" && (scope.type === "org" || (q.workspaceId !== null && scope.ids.includes(q.workspaceId)))) settle(q, true, "");
  };
  return {
    async admin(_org, kind) {
      const requests = st.requests.filter((q) => q.kind === kind).sort((a, b) => Number(b.state === "pending") - Number(a.state === "pending") || b.createdAt - a.createdAt);
      return wait({
        approved: st.approved.filter((a) => a.kind === kind).map(({ orgId: _o, ...a }) => a).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
        requests,
        private: st.private.filter((p) => p.kind === kind),
      });
    },
    async approve(_org, input) {
      const name = input.name.trim();
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(input.pluginId)) throw new Fail("invalid", "pluginId is the plugin's manifest id");
      if (!name) throw new Fail("invalid", "name is required");
      const scope = input.scope.type === "org" ? input.scope : { type: "workspace" as const, ids: workspaces(input.scope.ids) };
      add({ pluginId: input.pluginId, kind: input.kind, name }, scope);
      settleCovered(input.pluginId, input.kind, scope);
      return wait(undefined);
    },
    async unapprove(_org, pluginId, workspaceId) {
      const i = st.approved.findIndex((a) => a.pluginId === pluginId && (workspaceId ? a.scope.type === "workspace" && a.scope.id === workspaceId : a.scope.type === "org"));
      if (i < 0) throw new Fail("not-found", "no such approval");
      const [gone] = st.approved.splice(i, 1);
      log(action(gone.kind, workspaceId ? "remove_workspace" : "remove"), entity(gone.kind, pluginId, gone.name), workspaceId ? { workspace_ids: [workspaceId] } : {});
      return wait(undefined);
    },
    async answer(_org, requestId, input) {
      const q = st.requests.find((r) => r.id === requestId);
      if (!q) throw new Fail("not-found", "no such request");
      if (q.state !== "pending") throw new Fail("conflict", "this request was already answered");
      const ref = { pluginId: q.pluginId, kind: q.kind, name: q.name };
      if (input.approve) {
        const ws = input.workspaceIds ? workspaces(input.workspaceIds) : null;
        const scope = ws ? { type: "workspace" as const, ids: ws } : { type: "org" as const };
        add(ref, scope);
        settle(q, true, "");
        log(action(q.kind, ws ? "request_approve_workspace" : "request_approve_org"), entity(q.kind, q.pluginId, q.name), { request_id: q.id, requested_by: q.requestedBy.id, ...(ws ? { workspace_ids: ws } : {}) });
        settleCovered(q.pluginId, q.kind, scope);
      } else {
        const reason = (input.reason ?? "").trim().slice(0, 1000);
        settle(q, false, reason);
        log(action(q.kind, "request_reject_org"), entity(q.kind, q.pluginId, q.name), { request_id: q.id, requested_by: q.requestedBy.id, reason });
      }
      return wait(q);
    },
    async removePrivate(id) {
      const p = st.private.find((x) => x.id === id);
      if (!p) throw new Fail("not-found", "no such plugin");
      st.private = st.private.filter((x) => x.id !== id);
      log(p.kind === "widget" ? "private_widget_delete" : "private_plugin_delete", entity(p.kind, p.id, p.name));
      return wait(undefined);
    },
  };
}

/** `AdminRepository`'s plan token calls on the fake (server/src/rest/planTokens.ts's rules) */
export function fakePlanTokens(s: Seed, st: PluginsState, log: Log, wait: <T>(v: T) => Promise<T>, now: () => number) {
  const org = (): O.ActivityLog["entity"] => ({ type: "org", id: s.orgId, name: s.orgName });
  let seq = 0;
  return {
    planTokens: async () => wait([...st.planTokens].sort((a, b) => b.createdAt - a.createdAt)),
    createPlanToken: async (_org: string, input: { description: string; expiresInDays: number; scopes: TokenScope[] }) => {
      const description = input.description.trim().slice(0, 100);
      if (!description) throw new Fail("invalid", "give the token a name");
      if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 365) throw new Fail("invalid", "expiresInDays is 1 to 365");
      const scopes = [...new Set(input.scopes)];
      if (!scopes.length || !scopes.every((x) => PLAN_TOKEN_SCOPES.includes(x as RestScope))) throw new Fail("invalid", `a plan access token holds only ${PLAN_TOKEN_SCOPES.join(", ")}`);
      const at = now();
      const info: AccessTokenInfo = { id: `t_fake${++seq}`, description, scopes, kind: "plan", orgId: s.orgId, createdAt: at, expiresAt: at + input.expiresInDays * DAY, lastUsedAt: null };
      st.planTokens.push(info);
      log("plan_access_token_create", org(), { token_id: info.id, description, scopes });
      return wait({ token: `dsgn_plan_${Math.random().toString(36).slice(2).padEnd(12, "0")}${seq}`, info });
    },
    revokePlanToken: async (_org: string, id: string) => {
      const had = st.planTokens.some((t) => t.id === id);
      st.planTokens = st.planTokens.filter((t) => t.id !== id);
      if (had) log("plan_access_token_delete", org(), { token_id: id });
      return wait(undefined);
    },
  };
}
