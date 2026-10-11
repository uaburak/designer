/**
 * SCIM Users (docs/multiplayer.md §15.5; Figma's [F-scim-api]): `id` is our `users.id` (Figma's figmaUserId),
 * `userName` the email. A user is the link `scim_users` plus, while active, the org membership with
 * `provisioned_by 'scim'` and `idp_attributes`. DELETE removes the person from the org and the link — never the account
 * (decision 8). Guests are never managed: a SCIM user who is a guest becomes a member.
 */
import { SCIM_ENTERPRISE_SCHEMA, SCIM_FIGMA_SCHEMA, SCIM_SEAT_VALUE, SCIM_USER_SCHEMA } from "../../../../src/shared/org/identity";
import type { Seat } from "../../../../src/shared/org/types";
import { logActivity, userEntity, type Entity } from "../../activity";
import { normalizeEmail } from "../../db";
import { settingsOf, type MemberRow } from "../../org/db";
import { EMAIL } from "../../org/http";
import { removeFromOrg, setSeat } from "../../org/orgs";
import { orgFileKeys, reauth } from "../../org/reauth";
import { orgNotice } from "../../notifications";
import { accountByEmail, accountForEmail, ensureMember, setNameFromIdp } from "../people";
import { ScimError, bool, iso, listResponse, paging, parseFilter, patchOps, readBody, scimJson, str, type ScimCtx } from "./common";
import { applyGroupsOf } from "./groups";

const ENT_KEYS = ["employeeNumber", "costCenter", "organization", "division", "department"] as const;
type Ent = Partial<Record<(typeof ENT_KEYS)[number] | "managerValue" | "managerDisplayName", string>>;

/** Everything SCIM says about a user; `seat` / `figmaAdmin` undefined: not sent (kept) */
export interface UserState {
  userName: string;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  title: string | null;
  active: boolean;
  seat?: Seat;
  figmaAdmin?: boolean;
  ent: Ent;
}

interface LinkRow {
  org_id: string;
  user_id: string;
  user_name: string;
  external_id: string | null;
  active: number;
  seat: Seat | null;
  created_at: number;
  updated_at: number;
}

const SEAT_OF: Record<string, Seat> = { full: "full", dev: "dev", collab: "collab", view: "view" };
function seatOf(v: unknown): Seat {
  const s = typeof v === "string" ? SEAT_OF[v.trim().toLowerCase()] : undefined;
  if (!s) throw new ScimError(400, `seatType is Full, Dev, Collab or View`, "invalidValue");
  return s;
}
function seatFromRoles(v: unknown): Seat | undefined {
  if (v === null) return undefined;
  const list = Array.isArray(v) ? v : [v];
  const role = list.find((r) => r && typeof r === "object" && (!(r as { type?: unknown }).type || String((r as { type?: unknown }).type).toLowerCase() === "seattype")) as { value?: unknown } | undefined;
  return role ? seatOf(role.value) : undefined;
}

function userName(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new ScimError(400, "userName is required", "invalidValue");
  const e = normalizeEmail(v);
  if (e.length > 100) throw new ScimError(400, "userName is longer than 100 characters", "invalidValue");
  if (!EMAIL.test(e)) throw new ScimError(400, "userName must be an email address", "invalidValue");
  return e;
}

/** A User resource (POST / PUT body) → the state it describes */
function fromResource(b: Record<string, unknown>, keep: UserState | null): UserState {
  const name = (b.name ?? {}) as Record<string, unknown>;
  const ent = (b[SCIM_ENTERPRISE_SCHEMA] ?? {}) as Record<string, unknown>;
  const fig = (b[SCIM_FIGMA_SCHEMA] ?? {}) as Record<string, unknown>;
  const st: UserState = {
    userName: userName(b.userName),
    externalId: str(b.externalId, "externalId", 255),
    givenName: str(name.givenName, "name.givenName", 100),
    familyName: str(name.familyName, "name.familyName", 100),
    displayName: str(b.displayName, "displayName", 100),
    title: str(b.title, "title", 200),
    active: b.active === undefined ? (keep?.active ?? true) : bool(b.active, "active"),
    seat: b.roles === undefined ? keep?.seat : seatFromRoles(b.roles),
    figmaAdmin: fig.figmaAdmin === undefined ? keep?.figmaAdmin : bool(fig.figmaAdmin, "figmaAdmin"),
    ent: {},
  };
  for (const k of ENT_KEYS) {
    const v = str(ent[k], k, 255);
    if (v) st.ent[k] = v;
  }
  setManager(st, ent.manager);
  return st;
}

function setManager(st: UserState, v: unknown) {
  if (v === undefined) return;
  if (v === null || v === "") {
    delete st.ent.managerValue;
    delete st.ent.managerDisplayName;
  } else if (typeof v === "string") st.ent.managerValue = str(v, "manager", 255)!;
  else if (typeof v === "object") {
    const m = v as { value?: unknown; displayName?: unknown };
    const val = str(m.value, "manager.value", 255);
    const dn = str(m.displayName, "manager.displayName", 255);
    if (val) st.ent.managerValue = val;
    else delete st.ent.managerValue;
    if (dn) st.ent.managerDisplayName = dn;
    else delete st.ent.managerDisplayName;
  }
}

/**
 * One PatchOp operation on a user's state — Okta's and Entra's shapes: `op` any case, `path` or none (then `value` is an
 * object of attributes, flattened here), URN-prefixed enterprise / Figma attributes, `roles[type eq "seatType"].value`,
 * `emails[type eq "work"].value`.
 */
export function patchUser(st: UserState, op: "add" | "replace" | "remove", path: string | null, value: unknown): void {
  if (path === null) {
    if (op === "remove") throw new ScimError(400, "remove needs a path", "noTarget");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScimError(400, "an operation without a path needs an object value", "invalidValue");
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (["schemas", "id", "meta"].includes(k)) continue;
      patchUser(st, op, k, v);
    }
    return;
  }
  const remove = op === "remove";
  const lower = path.toLowerCase();
  const ENT = SCIM_ENTERPRISE_SCHEMA.toLowerCase();
  const FIG = SCIM_FIGMA_SCHEMA.toLowerCase();
  const CORE = SCIM_USER_SCHEMA.toLowerCase();
  if (lower === ENT || lower === FIG) {
    if (remove) throw new ScimError(400, `can't remove ${path}`, "invalidPath");
    if (!value || typeof value !== "object") throw new ScimError(400, `${path} needs an object`, "invalidValue");
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) patchUser(st, op, `${path}:${k}`, v);
    return;
  }
  if (lower.startsWith(ENT + ":")) {
    const attr = path.slice(ENT.length + 1);
    const a = attr.toLowerCase();
    if (a === "manager") return setManager(st, remove ? null : value);
    if (a === "manager.value") {
      const v = remove ? null : str(value, "manager.value", 255);
      if (v) st.ent.managerValue = v;
      else delete st.ent.managerValue;
      return;
    }
    if (a === "manager.displayname") {
      const v = remove ? null : str(value, "manager.displayName", 255);
      if (v) st.ent.managerDisplayName = v;
      else delete st.ent.managerDisplayName;
      return;
    }
    const k = ENT_KEYS.find((x) => x.toLowerCase() === a);
    if (!k) throw new ScimError(400, `unknown attribute ${path}`, "invalidPath");
    const v = remove ? null : str(value, k, 255);
    if (v) st.ent[k] = v;
    else delete st.ent[k];
    return;
  }
  if (lower.startsWith(FIG + ":")) {
    if (lower.slice(FIG.length + 1) !== "figmaadmin") throw new ScimError(400, `unknown attribute ${path}`, "invalidPath");
    st.figmaAdmin = remove ? false : bool(value, "figmaAdmin");
    return;
  }
  const p = lower.startsWith(CORE + ":") ? lower.slice(CORE.length + 1) : lower;
  switch (p.replace(/\s+/g, " ")) {
    case "active":
      if (remove) throw new ScimError(400, "active can't be removed", "mutability");
      st.active = bool(value, "active");
      return;
    case "username":
      if (remove) throw new ScimError(400, "userName can't be removed", "mutability");
      st.userName = userName(value);
      return;
    case "emails":
      if (remove) throw new ScimError(400, "emails can't be removed", "mutability");
      {
        const list = (Array.isArray(value) ? value : [value]) as { value?: unknown; primary?: unknown; type?: unknown }[];
        const e = list.find((x) => x && (x.primary === true || x.primary === "True" || x.primary === "true")) ?? list.find((x) => x && String(x.type ?? "").toLowerCase() === "work") ?? list[0];
        if (e?.value !== undefined) st.userName = userName(e.value);
      }
      return;
    case 'emails[type eq "work"].value':
      if (remove) throw new ScimError(400, "the work email can't be removed", "mutability");
      st.userName = userName(value);
      return;
    case "displayname":
      st.displayName = remove ? null : str(value, "displayName", 100);
      return;
    case "title":
      st.title = remove ? null : str(value, "title", 200);
      return;
    case "externalid":
      st.externalId = remove ? null : str(value, "externalId", 255);
      return;
    case "name":
      if (remove) {
        st.givenName = st.familyName = null;
        return;
      }
      if (!value || typeof value !== "object") throw new ScimError(400, "name needs an object", "invalidValue");
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) patchUser(st, op, `name.${k}`, v);
      return;
    case "name.givenname":
      st.givenName = remove ? null : str(value, "name.givenName", 100);
      return;
    case "name.familyname":
      st.familyName = remove ? null : str(value, "name.familyName", 100);
      return;
    case "name.formatted":
      return; // derived; ignored
    case "roles":
      st.seat = remove ? undefined : seatFromRoles(value);
      return;
    case 'roles[type eq "seattype"].value':
      st.seat = remove ? undefined : seatOf(value);
      return;
  }
  throw new ScimError(400, `unknown attribute ${path}`, "invalidPath");
}

async function link(ctx: ScimCtx, userId: string): Promise<LinkRow | null> {
  return ctx.deps.db.d1.prepare(`SELECT * FROM scim_users WHERE org_id = ?1 AND user_id = ?2`).bind(ctx.orgId, userId).first<LinkRow>();
}

async function member(ctx: ScimCtx, userId: string): Promise<MemberRow & { idp_attributes: string }> {
  return (await ctx.deps.db.d1.prepare(`SELECT * FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(ctx.orgId, userId).first<MemberRow & { idp_attributes: string }>())!;
}

/** The state of a linked user, read back */
async function stateOf(ctx: ScimCtx, l: LinkRow): Promise<UserState> {
  const u = await ctx.deps.db.d1.prepare(`SELECT name FROM users WHERE id = ?1`).bind(l.user_id).first<{ name: string | null }>();
  const m = await member(ctx, l.user_id);
  let a: Record<string, string> = {};
  try {
    a = m ? (JSON.parse(m.idp_attributes) as Record<string, string>) : {};
  } catch {
    // none
  }
  const [first, ...rest] = (u?.name ?? "").split(" ");
  const ent: Ent = {};
  for (const k of [...ENT_KEYS, "managerValue", "managerDisplayName"] as const) if (a[k]) ent[k] = a[k];
  return {
    userName: l.user_name,
    externalId: l.external_id,
    givenName: a.givenName ?? (first || null),
    familyName: a.familyName ?? (rest.join(" ") || null),
    displayName: u?.name ?? null,
    title: a.title ?? null,
    active: l.active === 1,
    seat: (m?.seat as Seat | undefined) ?? l.seat ?? undefined,
    figmaAdmin: m ? m.role === "admin" : false,
    ent,
  };
}

function resource(ctx: ScimCtx, l: LinkRow, st: UserState) {
  const ent: Record<string, unknown> = {};
  for (const k of ENT_KEYS) if (st.ent[k]) ent[k] = st.ent[k];
  if (st.ent.managerValue || st.ent.managerDisplayName) ent.manager = { ...(st.ent.managerValue ? { value: st.ent.managerValue } : {}), ...(st.ent.managerDisplayName ? { displayName: st.ent.managerDisplayName } : {}) };
  return {
    schemas: [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_SCHEMA, SCIM_FIGMA_SCHEMA],
    id: l.user_id,
    ...(st.externalId ? { externalId: st.externalId } : {}),
    userName: st.userName,
    name: { ...(st.givenName ? { givenName: st.givenName } : {}), ...(st.familyName ? { familyName: st.familyName } : {}) },
    ...(st.displayName ? { displayName: st.displayName } : {}),
    ...(st.title ? { title: st.title } : {}),
    emails: [{ value: st.userName, primary: true, type: "work" }],
    active: st.active,
    ...(st.seat ? { roles: [{ type: "seatType", value: SCIM_SEAT_VALUE[st.seat], primary: true }] } : {}),
    [SCIM_ENTERPRISE_SCHEMA]: ent,
    [SCIM_FIGMA_SCHEMA]: { figmaAdmin: st.figmaAdmin === true },
    meta: { resourceType: "User", created: iso(l.created_at), lastModified: iso(l.updated_at), location: `${ctx.base}/Users/${l.user_id}` },
  };
}

/** Figma's `idp_user` entity (§15.11) */
export const idpUserEntity = (ctx: ScimCtx, userId: string, userName: string, externalId: string | null): Entity => ({ type: "idp_user", id: userId, name: userName, user_name: userName, org_saml_id: ctx.tenantId, external_id: externalId ?? "" });

/** org_members.idp_attributes from the state */
function attrsOf(st: UserState): Record<string, string | null> {
  const a: Record<string, string | null> = { externalId: st.externalId, title: st.title, givenName: st.givenName, familyName: st.familyName };
  for (const k of [...ENT_KEYS, "managerValue", "managerDisplayName"] as const) a[k] = st.ent[k] ?? null;
  return a;
}
const displayNameOf = (st: UserState) => st.displayName ?? (`${st.givenName ?? ""} ${st.familyName ?? ""}`.trim() || null);

/** Last admin standing: an org needs one (§14.7) */
async function keepsAnAdmin(ctx: ScimCtx, userId: string): Promise<void> {
  const r = await ctx.deps.db.d1.prepare(`SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1 AND role = 'admin' AND user_id <> ?2`).bind(ctx.orgId, userId).first<{ n: number }>();
  if (!r?.n) throw new ScimError(400, "an organization needs at least one admin", "mutability");
}

/** Writes the difference between two states (PUT, PATCH) and logs it */
async function apply(ctx: ScimCtx, l: LinkRow, cur: UserState, next: UserState): Promise<void> {
  const { deps, orgId, req } = ctx;
  const d1 = deps.db.d1;
  const now = deps.now();
  const userId = l.user_id;
  const entity = () => idpUserEntity(ctx, userId, next.userName, next.externalId);
  // Refusals first, before anything is written
  if (cur.figmaAdmin && cur.active && (!next.active || next.figmaAdmin === false)) await keepsAnAdmin(ctx, userId);
  if (next.userName !== cur.userName) {
    const other = await accountByEmail(deps, next.userName);
    if (other && other.id !== userId) throw new ScimError(409, `another account uses ${next.userName}`, "uniqueness");
    const taken = await d1.prepare(`SELECT 1 AS x FROM scim_users WHERE org_id = ?1 AND user_name = ?2 AND user_id <> ?3`).bind(orgId, next.userName, userId).first();
    if (taken) throw new ScimError(409, `${next.userName} is already provisioned`, "uniqueness");
    // Figma: changing userName changes the account's email
    await d1.prepare(`UPDATE users SET email = ?2 WHERE id = ?1`).bind(userId, next.userName).run();
    await d1.prepare(`DELETE FROM org_members WHERE org_id = ?1 AND email = ?2 AND user_id IS NULL`).bind(orgId, next.userName).run();
    await d1.prepare(`UPDATE org_members SET email = ?3 WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId, next.userName).run();
  }
  if (next.externalId !== cur.externalId && next.externalId) {
    const taken = await d1.prepare(`SELECT 1 AS x FROM scim_users WHERE org_id = ?1 AND external_id = ?2 AND user_id <> ?3`).bind(orgId, next.externalId, userId).first();
    if (taken) throw new ScimError(409, `externalId ${next.externalId} is already provisioned`, "uniqueness");
  }
  const name = displayNameOf(next);
  if (name !== displayNameOf(cur)) await setNameFromIdp(deps, userId, name);
  const settings = settingsOf(await d1.prepare(`SELECT settings FROM orgs WHERE id = ?1`).bind(orgId).first<{ settings: string }>());
  const seat = next.seat ?? cur.seat ?? l.seat ?? settings.defaultSeat;
  await d1.prepare(`UPDATE scim_users SET user_name = ?3, external_id = ?4, active = ?5, seat = ?6, updated_at = ?7 WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId, next.userName, next.externalId, next.active ? 1 : 0, next.seat ?? l.seat, now).run();
  const user = (await deps.db.user(userId))!;

  if (cur.active && !next.active) {
    await removeFromOrg(deps, orgId, userId, null, req);
    await logActivity(deps, { orgId, action: "idp_user_deactivate", actor: null, entity: entity(), req });
    return;
  }
  if (!next.active) {
    await logActivity(deps, { orgId, action: "idp_user_update", actor: null, entity: entity(), details: { active: false }, req });
    return;
  }
  if (!cur.active) {
    await ensureMember(deps, orgId, user, { role: next.figmaAdmin ? "admin" : "member", seat, provisionedBy: "scim", attrs: attrsOf(next), actor: null, req, details: { scim: true } });
    await d1.prepare(`UPDATE org_members SET idp_attributes = ?3, provisioned_by = 'scim' WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId, JSON.stringify(attrsOf(next))).run();
    await applyGroupsOf(ctx, userId);
    await logActivity(deps, { orgId, action: "idp_user_activate", actor: null, entity: entity(), req });
    return;
  }
  // Active before and after: attributes, seat, admin
  await d1.prepare(`UPDATE org_members SET idp_attributes = ?3, provisioned_by = 'scim' WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId, JSON.stringify(attrsOf(next))).run();
  const m = await member(ctx, userId);
  const changed: string[] = [];
  if (m && next.seat && next.seat !== m.seat) {
    await setSeat(deps, orgId, userId, next.seat, null, req);
    changed.push("seat");
  }
  if (m && next.figmaAdmin !== undefined && (m.role === "admin") !== next.figmaAdmin) {
    const role = next.figmaAdmin ? "admin" : "member";
    await d1.prepare(`UPDATE org_members SET role = ?3 WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId, role).run();
    await logActivity(deps, { orgId, action: "org_user_permission_change", actor: null, entity: userEntity(user), details: { from: m.role, to: role, scim: true }, req });
    await reauth(deps, await orgFileKeys(d1, orgId), [userId]);
    await orgNotice(deps, [userId], { what: "orgs" });
    changed.push("figmaAdmin");
  }
  for (const k of ["userName", "externalId", "givenName", "familyName", "displayName", "title"] as const) if (next[k] !== cur[k]) changed.push(k);
  if (JSON.stringify(next.ent) !== JSON.stringify(cur.ent)) changed.push("enterprise");
  if (changed.length) await logActivity(deps, { orgId, action: "idp_user_update", actor: null, entity: entity(), details: { changed, ...(changed.includes("seat") ? { seat: next.seat } : {}) }, req });
}

/** `POST /Users` */
async function create(ctx: ScimCtx, b: Record<string, unknown>): Promise<Response> {
  const { deps, orgId, req } = ctx;
  const d1 = deps.db.d1;
  const st = fromResource(b, null);
  if (await d1.prepare(`SELECT 1 AS x FROM scim_users WHERE org_id = ?1 AND user_name = ?2`).bind(orgId, st.userName).first()) throw new ScimError(409, `${st.userName} is already provisioned`, "uniqueness");
  if (st.externalId && (await d1.prepare(`SELECT 1 AS x FROM scim_users WHERE org_id = ?1 AND external_id = ?2`).bind(orgId, st.externalId).first())) throw new ScimError(409, `externalId ${st.externalId} is already provisioned`, "uniqueness");
  const { user } = await accountForEmail(deps, st.userName, displayNameOf(st));
  if (await link(ctx, user.id)) throw new ScimError(409, `${st.userName} is already provisioned`, "uniqueness");
  const now = deps.now();
  const settings = settingsOf(await d1.prepare(`SELECT settings FROM orgs WHERE id = ?1`).bind(orgId).first<{ settings: string }>());
  await d1.prepare(`INSERT INTO scim_users (org_id, user_id, user_name, external_id, active, seat, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`).bind(orgId, user.id, st.userName, st.externalId, st.active ? 1 : 0, st.seat ?? null, now).run();
  await setNameFromIdp(deps, user.id, displayNameOf(st));
  if (st.active) {
    const was = await d1.prepare(`SELECT role, seat FROM org_members WHERE org_id = ?1 AND (user_id = ?2 OR (user_id IS NULL AND email = ?3))`).bind(orgId, user.id, user.email).first<{ role: string; seat: Seat }>();
    await ensureMember(deps, orgId, user, { role: st.figmaAdmin ? "admin" : "member", seat: st.seat ?? settings.defaultSeat, provisionedBy: "scim", attrs: attrsOf(st), actor: null, req, details: { scim: true } });
    await d1.prepare(`UPDATE org_members SET idp_attributes = ?3, provisioned_by = 'scim' WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, user.id, JSON.stringify(attrsOf(st))).run();
    if (was && was.role !== "guest") {
      // Already a member: SCIM's seat and admin flag win (a seat set here bypasses seat approval [F-scim])
      if (st.seat && st.seat !== was.seat) await setSeat(deps, orgId, user.id, st.seat, null, req);
      const role = st.figmaAdmin === true ? "admin" : st.figmaAdmin === false ? "member" : was.role;
      if (role !== was.role) {
        if (role !== "admin") await keepsAnAdmin(ctx, user.id);
        await d1.prepare(`UPDATE org_members SET role = ?3 WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, user.id, role).run();
        await logActivity(deps, { orgId, action: "org_user_permission_change", actor: null, entity: userEntity(user), details: { from: was.role, to: role, scim: true }, req });
      }
    }
  }
  await logActivity(deps, { orgId, action: "idp_user_create", actor: null, entity: idpUserEntity(ctx, user.id, st.userName, st.externalId), details: { active: st.active, seat: st.seat ?? null }, req });
  const l = (await link(ctx, user.id))!;
  return scimJson(resource(ctx, l, await stateOf(ctx, l)), 201);
}

export async function usersRoute(ctx: ScimCtx, url: URL, rest: string[]): Promise<Response> {
  const { deps, orgId, req } = ctx;
  const d1 = deps.db.d1;
  const m = req.method;
  if (!rest.length) {
    if (m === "POST") return create(ctx, await readBody(req));
    if (m !== "GET") throw new ScimError(405, "method not allowed");
    const f = parseFilter(url.searchParams.get("filter"), ["userName", "externalId"]);
    const { offset, count, startIndex } = paging(url);
    const where = f ? (f.attr === "userName" ? `AND user_name = ?2` : `AND external_id = ?2`) : "";
    const args = f ? [orgId, f.attr === "userName" ? normalizeEmail(f.value) : f.value] : [orgId];
    const total = (await d1.prepare(`SELECT COUNT(*) AS n FROM scim_users WHERE org_id = ?1 ${where}`).bind(...args).first<{ n: number }>())?.n ?? 0;
    const { results } = await d1.prepare(`SELECT * FROM scim_users WHERE org_id = ?1 ${where} ORDER BY created_at, rowid LIMIT ${count} OFFSET ${offset}`).bind(...args).all<LinkRow>();
    const resources = [];
    for (const l of results) resources.push(resource(ctx, l, await stateOf(ctx, l)));
    return scimJson(listResponse(resources, total, startIndex));
  }
  if (rest.length !== 1) throw new ScimError(404, "not found");
  const l = await link(ctx, rest[0]);
  if (!l) throw new ScimError(404, `no user ${rest[0]}`);
  const cur = await stateOf(ctx, l);
  if (m === "GET") return scimJson(resource(ctx, l, cur));
  if (m === "PUT" || m === "PATCH") {
    const b = await readBody(req);
    let next: UserState;
    if (m === "PUT") next = fromResource(b, cur);
    else {
      next = { ...cur, ent: { ...cur.ent } };
      for (const op of patchOps(b)) patchUser(next, op.op, op.path, op.value);
    }
    await apply(ctx, l, cur, next);
    const after = (await link(ctx, l.user_id))!;
    return scimJson(resource(ctx, after, await stateOf(ctx, after)));
  }
  if (m === "DELETE") {
    if (cur.active && cur.figmaAdmin) await keepsAnAdmin(ctx, l.user_id);
    await removeFromOrg(deps, orgId, l.user_id, null, req);
    await d1.prepare(`DELETE FROM scim_group_members WHERE user_id = ?1 AND group_id IN (SELECT id FROM scim_groups WHERE org_id = ?2)`).bind(l.user_id, orgId).run();
    await d1.prepare(`DELETE FROM scim_users WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, l.user_id).run();
    await logActivity(deps, { orgId, action: "idp_user_delete", actor: null, entity: idpUserEntity(ctx, l.user_id, l.user_name, l.external_id), req });
    return new Response(null, { status: 204 });
  }
  throw new ScimError(405, "method not allowed");
}

