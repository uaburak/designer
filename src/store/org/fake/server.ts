/**
 * A contract fake of the server's org routes (docs/multiplayer.md §14.12) and the few file routes the store's org
 * spaces use (§3, §14.12 "Files"): one in-memory `Request → Response` handler, as `server/src/api.ts handle` is, so a
 * test can swap it for the real handler once round 1a lands. Shapes follow §14.12 / §14.13 exactly; the rules are
 * a small subset of §14.4 (members see the org, team and folder editors write, admins manage, `teamCreation` /
 * `groupCreation` honoured, names unique per org / team → 409 `conflict`). Not a model of `resolveAccess`.
 */
import { DEFAULT_ORG_SETTINGS, type ActivityLog, type AdminPerson, type BillingGroup, type FileAccess, type OrgFile, type OrgInfo, type OrgSettings, type OrgWorkspace, type PersonRef, type ProjectInfo, type ProjectMember, type SeatRequest, type TeamInfo, type TeamMember, type UserGroup } from "../../../shared/org/types";

interface User {
  id: string;
  email: string;
  name: string;
}
interface Member {
  userId: string;
  role: "admin" | "member" | "guest";
  seat: "full" | "dev" | "collab" | "view";
  joinedAt: number;
}
interface Org {
  id: string;
  name: string;
  /** §14.16: the icon's hash in `images` */
  icon?: string | null;
  createdAt: number;
  settings: OrgSettings;
  members: Map<string, Member>;
}
interface Team {
  id: string;
  orgId: string;
  name: string;
  icon?: string | null;
  description: string;
  ownerId: string;
  createdAt: number;
  deletedAt: number | null;
  visibility: "visible" | "hidden";
  orgAccess: "none" | "viewer" | "editor";
  members: Map<string, { role: "editor" | "viewer"; admin: boolean }>;
}
interface Project {
  id: string;
  teamId: string;
  parentId: string | null;
  name: string;
  access: "inherited" | "limited";
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
}
interface File {
  key: string;
  name: string;
  ownerId: string;
  orgId: string | null;
  teamId: string | null;
  projectId: string | null;
  editorType: OrgFile["editorType"];
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  snapshot: { seq: number; bytes: Uint8Array } | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class FakeOrgServer {
  readonly users = new Map<string, User>();
  readonly orgs = new Map<string, Org>();
  readonly teams = new Map<string, Team>();
  readonly projects = new Map<string, Project>();
  readonly files = new Map<string, File>();
  /** A team file's people taken off it (`file_exclusions`), as `<fileKey> <userId>` */
  readonly exclusions = new Set<string>();
  readonly groups = new Map<string, { id: string; orgId: string; name: string; description: string; createdBy: string; members: Set<string> }>();
  readonly seatRequests: SeatRequest[] = [];
  readonly workspaces = new Map<string, { id: string; orgId: string; name: string; hidden: boolean; adminIds: string[]; createdAt: number }>();
  readonly billingGroups = new Map<string, { id: string; orgId: string; name: string; adminIds: string[] }>();
  readonly activity: ActivityLog[] = [];
  /** Icons (§14.16) by `<orgId>/<hash>` */
  readonly images = new Map<string, { bytes: Uint8Array; type: string }>();
  /** Requests answered so far, "METHOD /path" (tests look at what went to the server) */
  readonly log: string[] = [];
  /** Off: every request fails as a network error would */
  online = true;
  private n = 0;
  private clock = Date.UTC(2026, 9, 11);

  /** A person and their session token (the real token's shape: v1.<base64url {uid}>.<sig>) */
  addUser(email: string, name = email.split("@")[0]): { user: User; token: string } {
    const user = { id: `u${++this.n}`, email, name };
    this.users.set(user.id, user);
    return { user, token: this.tokenOf(user.id) };
  }

  tokenOf(userId: string): string {
    return `v1.${b64url(JSON.stringify({ uid: userId, tv: 0 }))}.fake`;
  }

  /** The handler, as `fetch` */
  readonly fetch: typeof fetch = async (input, init) => {
    if (!this.online) throw new TypeError("fetch failed");
    const req = new Request(String(input), init);
    try {
      return await this.handle(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code, ...e.extra }, e.status);
      throw e;
    }
  };

  private id(prefix: string): string {
    return `${prefix}${++this.n}`;
  }

  private now(): number {
    return (this.clock += 1000);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const m = req.method;
    this.log.push(`${m} ${url.pathname}`);
    // Icons: public, before any session (server/src/org/icons.ts)
    if (p[0] === "icons" && p.length === 3 && m === "GET") {
      const img = this.images.get(`${p[1]}/${p[2]}`);
      if (!img) throw new HttpError(404, "not_found", "no such icon");
      return new Response(img.bytes.slice().buffer as ArrayBuffer, { headers: { "content-type": img.type, "cache-control": "public, max-age=31536000, immutable" } });
    }
    const user = this.auth(req);
    const body = async <T>() => {
      const text = await req.text();
      return (text ? JSON.parse(text) : {}) as T;
    };

    if (p[0] === "me" && p.length === 1) return json(user);
    if (p[0] === "devices" && m === "POST") return json({ ordinal: 7 });
    if (p[0] === "orgs") return this.orgRoutes(req, url, p, user, body);
    if (p[0] === "teams") return this.teamRoutes(url, p, m, user, body, req);
    if (p[0] === "projects") return this.projectRoutes(p, m, user, body);
    if (p[0] === "groups") return this.groupRoutes(p, m, user, body);
    if (p[0] === "files") return this.fileRoutes(req, url, p, m, user, body);
    throw new HttpError(404, "not_found", "not found");
  }

  private auth(req: Request): User {
    const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const part = token?.split(".")[1];
    let uid: string | undefined;
    try {
      uid = part ? (JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { uid?: string }).uid : undefined;
    } catch {
      uid = undefined;
    }
    const user = uid ? this.users.get(uid) : undefined;
    if (!user) throw new HttpError(401, "unauthorized", "no session");
    return user;
  }

  // --- helpers ---

  private org(orgId: string, user: User): { org: Org; me: Member } {
    const org = this.orgs.get(orgId);
    const me = org?.members.get(user.id);
    if (!org || !me) throw new HttpError(404, "not_found", "no such organization");
    return { org, me };
  }

  private adminOf(orgId: string, user: User): Org {
    const { org, me } = this.org(orgId, user);
    if (me.role !== "admin") throw new HttpError(403, "not_admin", "only admins can");
    return org;
  }

  private person(userId: string, org: Org): PersonRef {
    const u = this.users.get(userId)!;
    return { id: u.id, email: u.email, name: u.name, picture: null, role: org.members.get(userId)?.role ?? "member" };
  }

  /** An icon upload (§14.16): PNG / JPEG / WebP / GIF by its first bytes, ≤ 1 MB → its hash (not SHA-1: 40 hex all the same) */
  private async putIcon(req: Request, orgId: string): Promise<string> {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > 1024 * 1024) throw new HttpError(413, "too_large", "the image is larger than 1 MB");
    const type = bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes[0] === 0x47 && bytes[1] === 0x49 ? "image/gif" : bytes[0] === 0x52 && bytes[8] === 0x57 ? "image/webp" : null;
    if (!type) throw new HttpError(400, "invalid", "only PNG, JPEG, WebP and GIF images can be used as an icon");
    let h = 0x811c9dc5;
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    const hash = h.toString(16).padStart(8, "0").repeat(5);
    this.images.set(`${orgId}/${hash}`, { bytes, type });
    return hash;
  }

  private iconUrl(orgId: string, hash: string | null | undefined): string | null {
    return hash ? `/icons/${orgId}/${hash}` : null;
  }

  private orgInfo(org: Org, me: Member): OrgInfo {
    const members = [...org.members.values()];
    return {
      id: org.id,
      name: org.name,
      iconUrl: this.iconUrl(org.id, org.icon),
      role: me.role,
      seat: me.seat,
      workspaceId: null,
      createdAt: org.createdAt,
      workspaceAdminOf: [],
      billingGroupAdminOf: [],
      counts: { members: members.filter((x) => x.role !== "guest").length, guests: members.filter((x) => x.role === "guest").length, teams: [...this.teams.values()].filter((t) => t.orgId === org.id && !t.deletedAt).length },
      settings: { ...org.settings },
    };
  }

  private team(teamId: string, user: User): { team: Team; org: Org; me: Member } {
    const team = this.teams.get(teamId);
    if (!team) throw new HttpError(404, "not_found", "no such team");
    const { org, me } = this.org(team.orgId, user);
    if (team.visibility === "hidden" && !team.members.has(user.id) && me.role !== "admin") throw new HttpError(404, "not_found", "no such team");
    return { team, org, me };
  }

  private teamWriter(team: Team, user: User, me: Member): void {
    const t = team.members.get(user.id);
    if (me.role !== "admin" && t?.role !== "editor" && !t?.admin) throw new HttpError(403, "forbidden", "you can only view this team");
  }

  private teamAdmin(team: Team, user: User, me: Member): void {
    if (me.role !== "admin" && team.ownerId !== user.id && !team.members.get(user.id)?.admin) throw new HttpError(403, "forbidden", "only the team's admins can");
  }

  private teamInfo(team: Team, user: User): TeamInfo {
    const mine = team.members.get(user.id);
    return {
      id: team.id,
      name: team.name,
      icon: null,
      iconUrl: this.iconUrl(team.orgId, team.icon),
      workspaceId: null,
      visibility: team.visibility,
      orgAccess: team.orgAccess,
      workspaceAccess: "none",
      me: mine ? { role: mine.role, admin: mine.admin, owner: team.ownerId === user.id, requested: false } : null,
      memberCount: team.members.size,
      projectCount: [...this.projects.values()].filter((p) => p.teamId === team.id && !p.trashedAt).length,
      description: team.description,
      ownerId: team.ownerId,
      createdAt: team.createdAt,
      deletedAt: team.deletedAt,
    };
  }

  private teamMembers(team: Team, org: Org): TeamMember[] {
    return [...team.members].map(([userId, t]) => ({ principal: `u:${userId}`, person: this.person(userId, org), group: null, email: this.users.get(userId)!.email, role: t.role, admin: t.admin, owner: team.ownerId === userId, pending: false, guest: false }));
  }

  private project(id: string, user: User): { project: Project; team: Team; org: Org; me: Member } {
    const project = this.projects.get(id);
    if (!project) throw new HttpError(404, "not_found", "no such folder");
    return { project, ...this.team(project.teamId, user) };
  }

  private projectInfo(p: Project, user: User): ProjectInfo {
    const path: { id: string; name: string }[] = [];
    for (let cur: Project | undefined = p; cur; cur = cur.parentId ? this.projects.get(cur.parentId) : undefined) path.unshift({ id: cur.id, name: cur.name });
    const team = this.teams.get(p.teamId)!;
    const t = team.members.get(user.id);
    return {
      id: p.id,
      teamId: p.teamId,
      parentId: p.parentId,
      name: p.name,
      access: p.access,
      fileCount: [...this.files.values()].filter((f) => f.projectId === p.id && !f.trashedAt).length,
      folderCount: [...this.projects.values()].filter((x) => x.parentId === p.id && !x.trashedAt).length,
      updatedAt: p.updatedAt,
      trashedAt: p.trashedAt,
      me: p.ownerId === user.id ? "owner" : t?.role === "editor" ? "editor" : "viewer",
      ownerId: p.ownerId,
      depth: path.length,
      path,
      createdAt: p.createdAt,
    };
  }

  /** The caller's access through the team taken away from this one file (the owner keeps theirs) */
  private excluded(f: File, user: User): boolean {
    return f.ownerId !== user.id && this.exclusions.has(`${f.key} ${user.id}`);
  }

  private orgFile(f: File, user: User): OrgFile {
    const owner = this.users.get(f.ownerId);
    const team = f.teamId ? this.teams.get(f.teamId) : undefined;
    const t = team?.members.get(user.id);
    const role = f.ownerId === user.id ? "owner" : t?.role === "editor" ? "editor" : "viewer";
    const access: FileAccess = { role, canEdit: role !== "viewer", canComment: true, canExport: true, canDevMode: false, canShare: role !== "viewer", canManage: role === "owner", capped: null, prototypeOnly: false, via: f.projectId ? ["team"] : ["file"] };
    return {
      key: f.key,
      name: f.name,
      editorType: f.editorType,
      ownerId: f.ownerId,
      ownerName: owner?.name ?? null,
      orgId: f.orgId!,
      teamId: f.teamId,
      projectId: f.projectId,
      updatedAt: f.updatedAt,
      createdAt: f.createdAt,
      trashedAt: f.trashedAt,
      thumbnailUrl: null,
      access,
      fileKey: null,
    };
  }

  private log_(org: Org, user: User, type: ActivityLog["action"]["type"], entity: { type: ActivityLog["entity"]["type"]; id: string; name: string }, teamId: string | null = null): void {
    this.activity.push({
      id: String(this.activity.length + 1),
      timestamp: Math.floor(this.now() / 1000),
      actor: { type: "user", id: user.id, email: user.email, name: user.name },
      action: { type, details: {} },
      entity,
      context: { client_name: null, ip_address: "127.0.0.1", is_figma_support_team_action: false, org_id: org.id, team_id: teamId },
    });
  }

  private newFile(input: { key?: unknown; name?: unknown; editorType?: unknown }, user: User, place: { orgId: string | null; teamId: string | null; projectId: string | null }): File {
    const key = String(input.key ?? "");
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(key)) throw new HttpError(400, "invalid", "bad file key");
    if (this.files.has(key)) throw new HttpError(409, "conflict", "file key taken");
    const now = this.now();
    const f: File = { key, name: String(input.name ?? "Untitled") || "Untitled", ownerId: user.id, ...place, editorType: (input.editorType as File["editorType"]) ?? "design", createdAt: now, updatedAt: now, trashedAt: null, snapshot: null };
    this.files.set(key, f);
    return f;
  }

  // --- /orgs ---

  private async orgRoutes(req: Request, url: URL, p: string[], user: User, body: <T>() => Promise<T>): Promise<Response> {
    const m = req.method;
    if (p.length === 1 && m === "GET")
      return json({
        orgs: [...this.orgs.values()]
          .filter((o) => o.members.has(user.id))
          .map((o) => ({ id: o.id, name: o.name, iconUrl: this.iconUrl(o.id, o.icon), role: o.members.get(user.id)!.role, seat: o.members.get(user.id)!.seat, workspaceId: null })),
      });
    if (p.length === 1 && m === "POST") {
      const b = await body<{ name?: string }>();
      if (!b.name?.trim()) throw new HttpError(400, "invalid", "name");
      const org: Org = { id: this.id("o"), name: b.name.trim(), createdAt: this.now(), settings: { ...DEFAULT_ORG_SETTINGS, seatApproval: { ...DEFAULT_ORG_SETTINGS.seatApproval } }, members: new Map() };
      org.members.set(user.id, { userId: user.id, role: "admin", seat: "full", joinedAt: this.now() });
      this.orgs.set(org.id, org);
      return json({ org: this.orgInfo(org, org.members.get(user.id)!) }, 201);
    }
    const orgId = p[1];
    if (p[2] === "admin") return this.adminRoutes(req, url, p.slice(3), orgId, user, body);
    // Delete organization (§14.17): admins, the name typed; deleted for good at once
    if ((p.length === 2 && m === "DELETE") || (p.length === 2 && m === "GET")) {
      const { org, me } = this.org(orgId, user);
      if (m === "GET") return json({ org: this.orgInfo(org, me) });
      if (me.role !== "admin") throw new HttpError(403, "forbidden", "only organization admins can do that", { code: "not_admin" });
      const b = await body<{ confirmName?: string }>();
      if ((b.confirmName ?? "").trim() !== org.name) throw new HttpError(400, "invalid", "type the organization’s name to delete it");
      this.orgs.delete(org.id);
      for (const t of [...this.teams.values()]) if (t.orgId === org.id) this.teams.delete(t.id);
      return new Response(null, { status: 204 });
    }
    const { org, me } = this.org(orgId, user);
    const sub = p[2];
    // Name and icon (§14.16): org admins
    if ((!sub && m === "PATCH") || sub === "icon") {
      if (me.role !== "admin") throw new HttpError(403, "forbidden", "only organization admins can do that", { code: "not_admin" });
      if (!sub) {
        const b = await body<{ name?: string }>();
        if (!b.name?.trim()) throw new HttpError(400, "invalid", "name");
        org.name = b.name.trim();
        this.log_(org, user, "org_rename", { type: "org", id: org.id, name: org.name });
      } else if (m === "PUT") {
        org.icon = await this.putIcon(req, org.id);
        this.log_(org, user, "org_icon_change", { type: "org", id: org.id, name: org.name });
      } else if (m === "DELETE") org.icon = null;
      else throw new HttpError(405, "invalid", "method not allowed");
      return json({ org: this.orgInfo(org, me) });
    }
    if (sub === "people" && m === "GET") {
      const text = (url.searchParams.get("text") ?? "").toLowerCase();
      const people = [...org.members.keys()].map((id) => this.person(id, org)).filter((x) => !text || x.email.includes(text) || (x.name ?? "").toLowerCase().includes(text));
      const limit = Number(url.searchParams.get("limit")) || 200;
      const groups = [...this.groups.values()].filter((g) => g.orgId === org.id).map((g) => ({ id: g.id, name: g.name, memberCount: g.members.size }));
      return json({ people: people.slice(0, limit), groups });
    }
    if (sub === "drafts" && m === "GET") {
      const trashed = url.searchParams.get("trashed") === "1";
      return json({ files: [...this.files.values()].filter((f) => f.orgId === org.id && !f.projectId && f.ownerId === user.id && !!f.trashedAt === trashed).map((f) => this.orgFile(f, user)) });
    }
    if (sub === "drafts" && m === "POST") {
      const f = this.newFile(await body(), user, { orgId: org.id, teamId: null, projectId: null });
      this.log_(org, user, "fig_file_create", { type: "file", id: f.key, name: f.name });
      return json({ file: this.orgFile(f, user) }, 201);
    }
    if (sub === "files" && m === "GET") {
      // All projects: the caller's drafts and every team file (the fake's team files are all open to members)
      return json({ files: [...this.files.values()].filter((f) => f.orgId === org.id && !f.trashedAt && (f.projectId || f.ownerId === user.id) && !this.excluded(f, user)).map((f) => this.orgFile(f, user)) });
    }
    if (sub === "search" && m === "GET") {
      const text = (url.searchParams.get("text") ?? "").toLowerCase();
      const files = [...this.files.values()].filter((f) => f.orgId === org.id && !f.trashedAt && f.name.toLowerCase().includes(text) && !this.excluded(f, user)).map((f) => this.orgFile(f, user));
      return json({ files, projects: [], teams: [], people: [] });
    }
    if (sub === "seat-requests" && m === "POST") {
      const b = await body<{ seat: SeatRequest["seat"]; note?: string }>();
      const r: SeatRequest = { id: this.id("sr"), orgId: org.id, userId: user.id, person: this.person(user.id, org), seat: b.seat, note: b.note ?? "", state: "pending", createdAt: this.now(), answeredAt: null, answeredBy: null };
      if (org.settings.seatApproval[b.seat] === "auto") {
        r.state = "approved";
        me.seat = b.seat;
      }
      this.seatRequests.push(r);
      return json({ request: r }, 201);
    }
    if (sub === "me" && m === "DELETE") {
      if (me.role === "admin" && [...org.members.values()].filter((x) => x.role === "admin").length === 1) throw new HttpError(409, "conflict", "the last admin can't leave");
      org.members.delete(user.id);
      return new Response(null, { status: 204 });
    }
    if (sub === "groups" && m === "GET") return json({ groups: [...this.groups.values()].filter((g) => g.orgId === org.id).map((g) => this.groupOut(g, org, user)) });
    if (sub === "groups" && m === "POST") {
      if (org.settings.groupCreation === "admins" && me.role !== "admin") throw new HttpError(403, "admins_only", "only admins can create groups");
      const b = await body<{ name?: string; description?: string; userIds?: string[] }>();
      const g = { id: this.id("g"), orgId: org.id, name: String(b.name ?? ""), description: b.description ?? "", createdBy: user.id, members: new Set(b.userIds ?? []) };
      this.groups.set(g.id, g);
      return json({ group: this.groupOut(g, org, user) }, 201);
    }
    if (sub === "teams" && m === "GET") {
      const filter = url.searchParams.get("filter") === "browse" ? "browse" : "mine";
      const teams = [...this.teams.values()].filter((t) => t.orgId === org.id && !t.deletedAt && (t.members.has(user.id) || (filter === "browse" && t.visibility === "visible")));
      return json({ teams: teams.map((t) => this.teamInfo(t, user)) });
    }
    if (sub === "teams" && m === "POST") {
      if (org.settings.teamCreation === "admins" && me.role !== "admin") throw new HttpError(403, "admins_only", "only admins can create teams");
      const b = await body<{ name?: string; orgAccess?: Team["orgAccess"]; visibility?: Team["visibility"] }>();
      const name = String(b.name ?? "").trim();
      if (!name) throw new HttpError(400, "invalid", "name");
      if ([...this.teams.values()].some((t) => t.orgId === org.id && !t.deletedAt && t.name === name)) throw new HttpError(409, "conflict", "a team with that name exists");
      const team: Team = { id: this.id("t"), orgId: org.id, name, description: "", ownerId: user.id, createdAt: this.now(), deletedAt: null, visibility: b.visibility === "hidden" ? "hidden" : "visible", orgAccess: b.orgAccess ?? "editor", members: new Map([[user.id, { role: "editor" as const, admin: true }]]) };
      this.teams.set(team.id, team);
      this.log_(org, user, "team_create", { type: "team", id: team.id, name }, team.id);
      return json({ team: this.teamInfo(team, user) }, 201);
    }
    throw new HttpError(404, "not_found", "not found");
  }

  private groupOut(g: { id: string; name: string; description: string; createdBy: string; members: Set<string> }, org: Org, user: User): UserGroup {
    return { id: g.id, name: g.name, memberCount: g.members.size, description: g.description, createdBy: g.createdBy, external: false, members: [...g.members].filter((id) => this.users.has(id)).map((id) => this.person(id, org)), canManage: g.createdBy === user.id || org.members.get(user.id)?.role === "admin" };
  }

  private async groupRoutes(p: string[], m: string, user: User, body: <T>() => Promise<T>): Promise<Response> {
    const g = this.groups.get(p[1]);
    if (!g) throw new HttpError(404, "not_found", "no such group");
    const { org, me } = this.org(g.orgId, user);
    if (g.createdBy !== user.id && me.role !== "admin") throw new HttpError(403, "forbidden", "not yours");
    if (p.length === 2 && m === "PATCH") {
      const b = await body<{ name?: string; description?: string }>();
      if (b.name !== undefined) g.name = b.name;
      if (b.description !== undefined) g.description = b.description;
      return json({ group: this.groupOut(g, org, user) });
    }
    if (p[2] === "members" && m === "POST") {
      const b = await body<{ add?: string[]; remove?: string[] }>();
      for (const id of b.add ?? []) g.members.add(id);
      for (const id of b.remove ?? []) g.members.delete(id);
      return json({ group: this.groupOut(g, org, user) });
    }
    if (p.length === 2 && m === "DELETE") {
      this.groups.delete(g.id);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(404, "not_found", "not found");
  }

  // --- /teams ---

  private async teamRoutes(url: URL, p: string[], m: string, user: User, body: <T>() => Promise<T>, req: Request): Promise<Response> {
    const { team, org, me } = this.team(p[1], user);
    const sub = p[2];
    if (sub === "icon" && (m === "PUT" || m === "DELETE")) {
      this.teamAdmin(team, user, me);
      team.icon = m === "PUT" ? await this.putIcon(req, team.orgId) : null;
      this.log_(org, user, "team_icon_change", { type: "team", id: team.id, name: team.name }, team.id);
      return json({ team: this.teamInfo(team, user) });
    }
    if (!sub && m === "GET") return json({ team: this.teamInfo(team, user) });
    if (!sub && m === "PATCH") {
      this.teamAdmin(team, user, me);
      const b = await body<Partial<TeamInfo>>();
      if (typeof b.name === "string") team.name = b.name;
      if (typeof b.description === "string") team.description = b.description;
      if (b.visibility) team.visibility = b.visibility;
      if (b.orgAccess) team.orgAccess = b.orgAccess;
      return json({ team: this.teamInfo(team, user) });
    }
    if (!sub && m === "DELETE") {
      this.teamAdmin(team, user, me);
      team.deletedAt = this.now();
      return new Response(null, { status: 204 });
    }
    if (sub === "restore" && m === "POST") {
      team.deletedAt = null;
      return json({ team: this.teamInfo(team, user) });
    }
    if (sub === "transfer" && m === "POST") {
      const b = await body<{ userId: string }>();
      if (team.ownerId !== user.id) throw new HttpError(403, "forbidden", "only the owner can");
      if (!team.members.has(b.userId)) throw new HttpError(409, "conflict", "not a member of the team");
      team.ownerId = b.userId;
      return json({ team: this.teamInfo(team, user) });
    }
    if (sub === "members") {
      if (m === "PUT") {
        this.teamWriter(team, user, me);
        const b = await body<{ email?: string; role: "editor" | "viewer"; admin?: boolean }>();
        const who = [...this.users.values()].find((u) => u.email === b.email);
        if (!who) throw new HttpError(403, "guest_blocked", "no such person");
        if (!org.members.has(who.id)) org.members.set(who.id, { userId: who.id, role: "member", seat: org.settings.defaultSeat, joinedAt: this.now() });
        team.members.set(who.id, { role: b.role, admin: b.admin === true });
      } else if (m === "PATCH") {
        this.teamAdmin(team, user, me);
        const b = await body<{ role?: "editor" | "viewer"; admin?: boolean }>();
        const id = p[3].replace(/^u:/, "");
        const cur = team.members.get(id);
        if (!cur) throw new HttpError(404, "not_found", "no such member");
        team.members.set(id, { role: b.role ?? cur.role, admin: b.admin ?? cur.admin });
      } else if (m === "DELETE") {
        const id = p[3].replace(/^u:/, "");
        if (id !== user.id) this.teamAdmin(team, user, me);
        team.members.delete(id);
      }
      return json({ members: this.teamMembers(team, org) });
    }
    if (sub === "join" && m === "POST") {
      team.members.set(user.id, { role: team.orgAccess === "editor" ? "editor" : "viewer", admin: false });
      return json({ status: "joined" });
    }
    if (sub === "requests") return json({ requests: [] });
    if (sub === "projects" && m === "GET") {
      const parent = url.searchParams.get("parent") || null;
      return json({ projects: [...this.projects.values()].filter((x) => x.teamId === team.id && x.parentId === parent && !x.trashedAt).map((x) => this.projectInfo(x, user)) });
    }
    if (sub === "projects" && m === "POST") {
      this.teamWriter(team, user, me);
      const b = await body<{ name?: string; parentId?: string | null; access?: Project["access"] }>();
      const name = String(b.name ?? "").trim();
      const parentId = b.parentId ?? null;
      if (!name) throw new HttpError(400, "invalid", "name");
      if ([...this.projects.values()].some((x) => x.teamId === team.id && x.parentId === parentId && x.name === name && !x.trashedAt)) throw new HttpError(409, "conflict", "a folder with that name exists");
      const now = this.now();
      const proj: Project = { id: this.id("p"), teamId: team.id, parentId, name, access: b.access ?? "inherited", ownerId: user.id, createdAt: now, updatedAt: now, trashedAt: null };
      this.projects.set(proj.id, proj);
      this.log_(org, user, "project_create", { type: "project", id: proj.id, name }, team.id);
      return json({ project: this.projectInfo(proj, user) }, 201);
    }
    if (sub === "trash" && m === "GET") {
      return json({
        projects: [...this.projects.values()].filter((x) => x.teamId === team.id && x.trashedAt).map((x) => this.projectInfo(x, user)),
        files: [...this.files.values()].filter((f) => f.teamId === team.id && f.trashedAt).map((f) => this.orgFile(f, user)),
      });
    }
    throw new HttpError(404, "not_found", "not found");
  }

  // --- /projects ---

  private async projectRoutes(p: string[], m: string, user: User, body: <T>() => Promise<T>): Promise<Response> {
    const { project, team, org, me } = this.project(p[1], user);
    const sub = p[2];
    if (!sub && m === "GET") return json({ project: this.projectInfo(project, user) });
    if (!sub && m === "PATCH") {
      this.teamWriter(team, user, me);
      const b = await body<{ name?: string; access?: Project["access"] }>();
      if (b.name) project.name = b.name;
      if (b.access) project.access = b.access;
      project.updatedAt = this.now();
      return json({ project: this.projectInfo(project, user) });
    }
    if (!sub && m === "DELETE") {
      if (!project.trashedAt) throw new HttpError(400, "invalid", "only from the trash");
      this.projects.delete(project.id);
      return new Response(null, { status: 204 });
    }
    if (sub === "move" && m === "POST") {
      const b = await body<{ teamId: string; parentId: string | null }>();
      this.team(b.teamId, user);
      project.teamId = b.teamId;
      project.parentId = b.parentId;
      return json({ project: this.projectInfo(project, user) });
    }
    if (sub === "trash" && m === "POST") {
      this.teamWriter(team, user, me);
      project.trashedAt = this.now();
      return new Response(null, { status: 204 });
    }
    if (sub === "restore" && m === "POST") {
      project.trashedAt = null;
      return json({ project: this.projectInfo(project, user) });
    }
    if (sub === "members") {
      const members: ProjectMember[] = this.teamMembers(team, org).map(({ admin: _a, ...x }) => ({ ...x, inherited: true }));
      return json({ members });
    }
    if (sub === "files" && m === "GET") return json({ files: [...this.files.values()].filter((f) => f.projectId === project.id && !f.trashedAt && !this.excluded(f, user)).map((f) => this.orgFile(f, user)) });
    if (sub === "files" && m === "POST") {
      this.teamWriter(team, user, me);
      if (me.seat === "view") throw new HttpError(403, "seat_required", "your seat can't create design files", { seat: "full" });
      const f = this.newFile(await body(), user, { orgId: org.id, teamId: team.id, projectId: project.id });
      this.log_(org, user, "fig_file_create", { type: "file", id: f.key, name: f.name }, team.id);
      return json({ file: this.orgFile(f, user) }, 201);
    }
    throw new HttpError(404, "not_found", "not found");
  }

  // --- /files (the org parts of §14.12 "Files", and the snapshot / blob routes the store's share uses) ---

  private async fileRoutes(req: Request, url: URL, p: string[], m: string, user: User, body: <T>() => Promise<T>): Promise<Response> {
    if (p.length === 1 && m === "POST") {
      const b = await body<{ key?: string; name?: string; orgId?: string; projectId?: string }>();
      let place = { orgId: null as string | null, teamId: null as string | null, projectId: null as string | null };
      if (b.projectId) {
        const { project, team, org, me } = this.project(b.projectId, user);
        this.teamWriter(team, user, me);
        if (b.orgId && b.orgId !== org.id) throw new HttpError(400, "invalid", "orgId");
        place = { orgId: org.id, teamId: team.id, projectId: project.id };
      } else if (b.orgId) place = { orgId: this.org(b.orgId, user).org.id, teamId: null, projectId: null };
      const f = this.newFile(b, user, place);
      return json(f.orgId ? { file: this.orgFile(f, user) } : { key: f.key, name: f.name, role: "owner" }, 201);
    }
    const f = this.files.get(p[1]);
    if (!f) throw new HttpError(404, "not_found", "no such file");
    const orgMember = f.orgId ? this.orgs.get(f.orgId)?.members.get(user.id) : undefined;
    if ((f.ownerId !== user.id && !orgMember) || this.excluded(f, user)) throw new HttpError(404, "not_found", "no such file");
    const sub = p[2];
    if (sub === "exclusions") {
      const team = f.teamId ? this.teams.get(f.teamId) : undefined;
      if (!team) throw new HttpError(404, "not_found", "not a team file");
      if (f.ownerId !== user.id && team.members.get(user.id)?.role !== "editor") throw new HttpError(403, "forbidden", "only people who can edit the file can share it");
      if (m === "PUT") {
        const { userId } = await body<{ userId: string }>();
        if (userId === f.ownerId) throw new HttpError(400, "invalid", "the file's owner keeps their access");
        this.exclusions.add(`${f.key} ${userId}`);
      } else if (m === "DELETE" && p[3]) this.exclusions.delete(`${f.key} ${decodeURIComponent(p[3])}`);
      else if (m !== "GET") throw new HttpError(405, "invalid", "method not allowed");
      const people = [...team.members].map(([id, t]) => {
        const u = this.users.get(id)!;
        return { userId: id, email: u.email, name: u.name, picture: null, role: t.role, owner: id === f.ownerId, excluded: this.exclusions.has(`${f.key} ${id}`) };
      });
      return json(m === "GET" ? { people } : { ok: true });
    }
    if (!sub && m === "GET") {
      const of = f.orgId ? this.orgFile(f, user) : null;
      const team = f.teamId ? this.teams.get(f.teamId) : undefined;
      return json({
        key: f.key,
        name: f.name,
        role: of?.access.role ?? "owner",
        linkAccess: "none",
        viewersCanCopy: true,
        link: `${url.origin}/f/${f.key}`,
        ...(of ? { access: of.access } : {}),
        org: f.orgId ? { id: f.orgId, name: this.orgs.get(f.orgId)!.name, teamId: f.teamId, teamName: team?.name ?? null, projectId: f.projectId, path: [] } : null,
      });
    }
    if (sub === "snapshot" && m === "PUT") {
      f.snapshot = { seq: Number(url.searchParams.get("seq")) || 0, bytes: new Uint8Array(await req.arrayBuffer()) };
      return json({ ok: true });
    }
    if (sub === "snapshot" && m === "GET") {
      if (!f.snapshot) throw new HttpError(404, "no_snapshot", "no snapshot yet");
      return new Response(f.snapshot.bytes.slice(), { headers: { "x-seq": String(f.snapshot.seq) } });
    }
    if (sub === "blobs" && p[3] === "missing") return json({ missing: [] });
    if (sub === "move" && m === "POST") {
      const b = await body<{ projectId: string | null }>();
      if (b.projectId) {
        const { project, team, org } = this.project(b.projectId, user);
        if (f.orgId && f.orgId !== org.id) throw new HttpError(400, "invalid", "another organization");
        Object.assign(f, { orgId: org.id, teamId: team.id, projectId: project.id });
      } else Object.assign(f, { teamId: null, projectId: null, ownerId: user.id });
      return json({ file: this.orgFile(f, user) });
    }
    if (sub === "trash" && m === "POST") {
      f.trashedAt = this.now();
      return new Response(null, { status: 204 });
    }
    if (sub === "restore" && m === "POST") {
      f.trashedAt = null;
      return json({ file: this.orgFile(f, user) });
    }
    if (!sub && m === "DELETE") {
      if (f.orgId && !f.trashedAt) throw new HttpError(409, "conflict", "move the file to the trash first");
      this.files.delete(f.key);
      return json({ ok: true });
    }
    throw new HttpError(404, "not_found", "not found");
  }

  // --- /orgs/:org/admin ---

  private async adminRoutes(req: Request, url: URL, p: string[], orgId: string, user: User, body: <T>() => Promise<T>): Promise<Response> {
    const org = this.adminOf(orgId, user);
    const m = req.method;
    const csv = url.searchParams.get("format") === "csv";
    const people = (): AdminPerson[] =>
      [...org.members.values()].map((x) => ({ ...this.person(x.userId, org), seat: x.seat, workspaceId: null, billingGroupId: null, lastActiveAt: null, joinedAt: x.joinedAt, pending: false, teams: [...this.teams.values()].filter((t) => t.orgId === org.id && t.members.has(x.userId)).length }));
    const workspace = (w: { id: string; name: string; hidden: boolean; adminIds: string[]; createdAt: number }): OrgWorkspace => ({ id: w.id, name: w.name, hidden: w.hidden, admins: w.adminIds.filter((id) => this.users.has(id)).map((id) => this.person(id, org)), defaultTeamIds: [], memberCount: 0, teamCount: 0, createdAt: w.createdAt });
    const billing = (g: { id: string; name: string; adminIds: string[] }): BillingGroup => ({ id: g.id, name: g.name, admins: g.adminIds.filter((id) => this.users.has(id)).map((id) => this.person(id, org)), memberCount: 0 });
    switch (`${m} ${p.join("/")}`) {
      case "GET dashboard": {
        const ps = people();
        const seats = { full: 0, dev: 0, collab: 0, view: 0 };
        for (const x of ps) seats[x.seat]++;
        return json({ members: ps.filter((x) => x.role !== "guest").length, guests: ps.filter((x) => x.role === "guest").length, seats, pendingSeatRequests: this.seatRequests.filter((r) => r.orgId === org.id && r.state === "pending").length, pendingGuestRequests: 0, teams: [...this.teams.values()].filter((t) => t.orgId === org.id).length, workspaces: [...this.workspaces.values()].filter((w) => w.orgId === org.id).length, activeLast30Days: ps.length });
      }
      case "GET people": {
        const text = (url.searchParams.get("text") ?? "").toLowerCase();
        const items = people().filter((x) => !text || x.email.includes(text));
        if (csv) return new Response(["email,name,role,seat", ...items.map((x) => `${x.email},${x.name ?? ""},${x.role},${x.seat}`)].join("\n"), { headers: { "content-type": "text/csv" } });
        return json({ items, cursor: null, total: items.length });
      }
      case "POST people": {
        const b = await body<{ emails: string[]; role: Member["role"]; seat?: Member["seat"] }>();
        for (const email of b.emails) {
          const u = [...this.users.values()].find((x) => x.email === email) ?? this.addUser(email).user;
          org.members.set(u.id, { userId: u.id, role: b.role, seat: b.seat ?? org.settings.defaultSeat, joinedAt: this.now() });
        }
        return json({ people: people().filter((x) => b.emails.includes(x.email)) }, 201);
      }
      case "PATCH people": {
        const b = await body<{ userIds: string[]; role?: Member["role"]; seat?: Member["seat"] }>();
        for (const id of b.userIds) {
          const x = org.members.get(id);
          if (!x) continue;
          if (b.role) x.role = b.role;
          if (b.seat) x.seat = b.seat;
        }
        return json({ people: people().filter((x) => b.userIds.includes(x.id)) });
      }
      case "POST people/remove": {
        const b = await body<{ userIds: string[] }>();
        for (const id of b.userIds) org.members.delete(id);
        return new Response(null, { status: 204 });
      }
      case "GET seat-requests":
        return json({ requests: this.seatRequests.filter((r) => r.orgId === org.id && (url.searchParams.get("state") === "all" || r.state === "pending")) });
      case "GET guest-requests":
        return json({ requests: [] });
      case "GET teams": {
        const items = [...this.teams.values()].filter((t) => t.orgId === org.id).map((t) => ({ ...this.teamInfo(t, user), ownerName: this.users.get(t.ownerId)?.name ?? null, adminCount: [...t.members.values()].filter((x) => x.admin).length, fileCount: 0, lastEditedAt: null }));
        if (csv) return new Response(["name,owner", ...items.map((t) => `${t.name},${t.ownerName ?? ""}`)].join("\n"), { headers: { "content-type": "text/csv" } });
        return json({ items, cursor: null, total: items.length });
      }
      case "GET workspaces":
        return json({ workspaces: [...this.workspaces.values()].filter((w) => w.orgId === org.id).map(workspace) });
      case "POST workspaces": {
        const b = await body<{ name: string; adminIds: string[]; hidden?: boolean }>();
        const w = { id: this.id("w"), orgId: org.id, name: b.name, hidden: b.hidden === true, adminIds: b.adminIds ?? [], createdAt: this.now() };
        this.workspaces.set(w.id, w);
        return json({ workspace: workspace(w) }, 201);
      }
      case "GET billing-groups":
        return json({ billingGroups: [...this.billingGroups.values()].filter((g) => g.orgId === org.id).map(billing) });
      case "POST billing-groups": {
        const b = await body<{ name: string; adminIds?: string[] }>();
        const g = { id: this.id("b"), orgId: org.id, name: b.name, adminIds: b.adminIds ?? [] };
        this.billingGroups.set(g.id, g);
        return json({ billingGroup: billing(g) }, 201);
      }
      case "GET activity": {
        const events = url.searchParams.get("events")?.split(",");
        const logs = this.activity.filter((a) => a.context.org_id === org.id && (!events || events.includes(a.action.type)));
        if (csv) return new Response(["timestamp,action,entity", ...logs.map((a) => `${a.timestamp},${a.action.type},${a.entity.name}`)].join("\n"), { headers: { "content-type": "text/csv" } });
        return json({ activity_logs: logs, cursor: null, next_page: false });
      }
      case "GET settings":
        return json(org.settings);
      case "PATCH settings":
        org.settings = { ...org.settings, ...(await body<Partial<OrgSettings>>()) };
        return json(org.settings);
      case "GET drafts":
        return json({ owners: [] });
      case "POST drafts/move":
      case "POST drafts/delete":
        return new Response(null, { status: 204 });
    }
    const w = p[0] === "workspaces" ? this.workspaces.get(p[1]) : undefined;
    if (w && w.orgId === org.id && m === "PATCH") {
      const b = await body<{ name?: string; hidden?: boolean; adminIds?: string[] }>();
      Object.assign(w, { ...(b.name ? { name: b.name } : {}), ...(typeof b.hidden === "boolean" ? { hidden: b.hidden } : {}), ...(b.adminIds ? { adminIds: b.adminIds } : {}) });
      return json({ workspace: workspace(w) });
    }
    if (w && w.orgId === org.id && m === "DELETE") {
      this.workspaces.delete(w.id);
      return new Response(null, { status: 204 });
    }
    const g = p[0] === "billing-groups" ? this.billingGroups.get(p[1]) : undefined;
    if (g && g.orgId === org.id && m === "PATCH") {
      const b = await body<{ name?: string; adminIds?: string[] }>();
      Object.assign(g, { ...(b.name ? { name: b.name } : {}), ...(b.adminIds ? { adminIds: b.adminIds } : {}) });
      return json({ billingGroup: billing(g) });
    }
    if (g && g.orgId === org.id && m === "DELETE") {
      this.billingGroups.delete(g.id);
      return new Response(null, { status: 204 });
    }
    const sr = p[0] === "seat-requests" ? this.seatRequests.find((r) => r.id === p[1] && r.orgId === org.id) : undefined;
    if (sr && m === "POST") {
      const b = await body<{ approve: boolean }>();
      sr.state = b.approve ? "approved" : "denied";
      sr.answeredAt = this.now();
      sr.answeredBy = user.id;
      if (b.approve) org.members.get(sr.userId)!.seat = sr.seat;
      return json({ request: sr });
    }
    throw new HttpError(404, "not_found", "not found");
  }
}
