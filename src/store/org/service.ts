/**
 * The store's org spaces (docs/multiplayer.md §14.6): the `orgs`, `teams`, `projects` and `admin` repositories over the
 * server's routes (§14.12), a cache per org for offline reads, and org files as linked room copies.
 *
 * - **Cache.** One JSON per org (`Workspace/spaces/<orgId>.json` on the desktop, `designer.devStore.v1.space.<orgId>` in
 *   the browser), holding the last lists of teams, folders, files, drafts, members, join requests, people and groups —
 *   keyed by the signed-in person, so another account never sees them. Stale-while-revalidate: a read answers from it
 *   at once and refreshes behind (an event when the answer changed); with nothing cached it waits for the server (one
 *   request per Home page: `teams.page`, `projects.page` over `GET /teams/:id/page`, `/projects/:id/page`). A write
 *   patches what it knows into the cache (the server's answer, or the moved / removed entries), marks the org's
 *   entries stale (the next read answers at once and refreshes) and announces itself; an answer to a read started
 *   before a write isn't stored over it. Offline, the cache answers (`cache.stale`, offline: true) and writes fail with
 *   `offline`.
 * - **Events** (topic `org`) come from the person's Inbox socket (`{t: "org", …}` notices, §14.11): the entries named
 *   are refreshed first, then the event goes out. Writes made here announce themselves the same way. No polling.
 * - **Files.** An org file's local copy is a shared file's (§5), its `FileMeta.space` set: `multiplayer.openShared(key)`
 *   makes it (the server's `GET /files/:key` says where it lives). Creating one in a folder or drafts makes the local
 *   copy and registers it in one call; moving a local file into a folder is §5's share with a destination.
 *
 * No Node or DOM imports: the desktop store (LocalStore) and the browser's dev store (MemoryStore) both run it.
 */
import type * as O from "../../shared/org/types";
import type { AccessTokenInfo } from "../../shared/account";
import type { AdminRepository, OrgEvent, OrgsRepository, ProjectsRepository, TeamsRepository } from "../../shared/org/repositories";
import { StoreError } from "../../shared/store/protocol";
import { ICON_MAX_BYTES, ICON_URL, bytesToDataUrl, iconMime } from "../../shared/org/icons";
import type { Unsubscribe } from "../../shared/store/repositories";
import type { FileKey, FileMeta, FileSpace } from "../../shared/store/types";
import { isGovernanceCode, type MultiplayerService } from "../multiplayer/service";
import type { OrgGate } from "../../shared/org/governance";
import type { OrgNotice } from "../notifications/service";

/** What the store gives the service. */
export interface OrgHost {
  /** An org's cache as saved (null: none) */
  loadCache(orgId: string): Promise<unknown>;
  /** null removes it */
  saveCache(orgId: string, cache: OrgCache | null): Promise<void>;
  /** The orgs with a cache */
  cachedOrgIds(): Promise<string[]>;
  /** A new empty design file, already the copy of an org file (it never lists among local Drafts) */
  createOrgFile(input: { name: string; space: FileSpace }): Promise<FileMeta>;
  /** A local file gone for good (a creation the server refused) */
  deleteLocalFile(fileKey: FileKey): Promise<void>;
  setFileSpace(fileKey: FileKey, space: FileSpace | null): Promise<void>;
  getMeta(fileKey: FileKey): FileMeta | null;
  /** The file's document at its journal head, as a kiwi Message */
  headSnapshot(fileKey: FileKey): Promise<Uint8Array>;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
  now(): number;
}

/** Where the Inbox's `{t: "org"}` notices come from (NotificationsService) */
export interface OrgNotices {
  onOrg(listener: (n: OrgNotice) => void): Unsubscribe;
  onReconnect?(listener: () => void): Unsubscribe;
}

/** One org's cache (docs/multiplayer.md §14.6) */
export interface OrgCache {
  v: 1;
  /** The person it belongs to */
  uid: string | null;
  orgId: string;
  savedAt: number;
  summary: O.OrgSummary | null;
  info: O.OrgInfo | null;
  teams: { mine?: O.TeamSummary[]; browse?: O.TeamSummary[] };
  team: Record<string, O.TeamInfo>;
  /** Folders by `<teamId>/<parentId or "">` */
  projects: Record<string, O.ProjectSummary[]>;
  project: Record<string, O.ProjectInfo>;
  /** Files by folder id, the drafts under DRAFTS */
  files: Record<string, O.OrgFile[]>;
  people: { people: O.PersonRef[]; groups: O.GroupRef[] } | null;
  groups: O.UserGroup[] | null;
  /** Team people and join requests by team id, folder people by folder id (Home's pages; caches saved before
   *  2026-10-12 have none: read as empty) */
  teamMembers: Record<string, O.TeamMember[]>;
  requests: Record<string, O.JoinRequest[]>;
  projectMembers: Record<string, O.ProjectMember[]>;
}

const DRAFTS = "@drafts";
/** A read refreshed this recently answers from the cache without asking again */
const FRESH_MS = 2000;

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** An org's list entry from its info: the same fields `GET /orgs` sends, Governance+'s gate and a guest's expiry included
 *  (docs/governance.md §2.5, §2.13) — reading the org must not drop them from the list Home reads */
/** A team's list entry from its info (the fields `GET /orgs/:id/teams` sends) */
const summaryOfTeam = (t: O.TeamInfo): O.TeamSummary => {
  const { description: _d, ownerId: _o, createdAt: _c, deletedAt: _x, ...summary } = clone(t);
  return summary;
};
/** A folder's list entry from its info */
const summaryOfProject = (p: O.ProjectInfo): O.ProjectSummary => {
  const { ownerId: _o, depth: _d, path: _p, createdAt: _c, ...summary } = clone(p);
  return summary;
};
const summaryOf = (v: O.OrgInfo): O.OrgSummary => ({
  id: v.id,
  name: v.name,
  ...(v.iconUrl !== undefined ? { iconUrl: v.iconUrl } : {}),
  role: v.role,
  seat: v.seat,
  workspaceId: v.workspaceId,
  ...(v.gate ? { gate: clone(v.gate) } : {}),
  ...(v.guestExpiresAt !== undefined ? { guestExpiresAt: v.guestExpiresAt } : {}),
});
/** A share registered on the server whose content didn't finish uploading (MultiplayerService.shareTo's `upload_incomplete`) */
const pendingUpload = (e: unknown): boolean => e instanceof StoreError && (e.detail as { pendingUpload?: unknown } | undefined)?.pendingUpload === true;

const seg = (s: unknown, what: string): string => {
  if (typeof s !== "string" || !s || s.length > 256) throw new StoreError("invalid", `bad ${what}`);
  return encodeURIComponent(s);
};
const isOffline = (e: unknown) => e instanceof StoreError && e.code === "offline";
/** A server from before a route (its "not found" for an unknown path — a missing team or folder says which) */
const routeMissing = (e: unknown) => e instanceof StoreError && e.code === "not-found" && e.message === "not found";
/** The org a team or folder names (the server adds `orgId` beyond §14.13's shapes) */
const orgOf = (v: object): string | null => {
  const id = (v as { orgId?: unknown }).orgId;
  return typeof id === "string" && id ? id : null;
};
const pick = <T>(body: unknown, ...keys: string[]): T => {
  if (body && typeof body === "object") for (const k of keys) if (k in body) return (body as Record<string, unknown>)[k] as T;
  return body as T;
};
const query = (q: Record<string, unknown>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    p.set(k, v === true ? "1" : Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};
/** An icon upload as the server takes it (§14.16), checked here first */
const iconBytes = (image: unknown): Uint8Array => {
  if (!(image instanceof Uint8Array) || !image.length) throw new StoreError("invalid", "an icon is an image's bytes");
  if (image.length > ICON_MAX_BYTES) throw new StoreError("invalid", "The image is larger than 1 MB");
  if (!iconMime(image)) throw new StoreError("invalid", "Only PNG, JPEG, WebP and GIF images can be used as an icon");
  return image;
};
const cleanName = (name: unknown, fallback: string | null, what: string): string => {
  const n = typeof name === "string" ? name.trim() : "";
  if (n) return n.slice(0, 512);
  if (fallback !== null) return fallback;
  throw new StoreError("invalid", `a ${what} name can't be empty`);
};

export class OrgService {
  readonly orgs: OrgsRepository;
  readonly teams: TeamsRepository;
  readonly projects: ProjectsRepository;
  readonly admin: AdminRepository;

  private listeners = new Set<(e: OrgEvent) => void>();
  private caches = new Map<string, OrgCache>();
  private loaded: Promise<void> | null = null;
  private loadedFor: string | null | undefined = undefined;
  /** Where things are, learnt from every answer: team → org, folder → team, group / workspace / billing group → org */
  private teamOrg = new Map<string, string>();
  private projectTeam = new Map<string, string>();
  private groupOrg = new Map<string, string>();
  private workspaceOrg = new Map<string, string>();
  private billingOrg = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();
  /** Reads with nothing cached, by key: concurrent ones (a hover's prefetch, then the click) share one request */
  private loading = new Map<string, Promise<unknown>>();
  /** Writes per org: an answer to a read started before the latest write isn't stored over the write's patch */
  private writes = new Map<string, number>();
  private freshAt = new Map<string, number>();
  private saving = new Map<string, Promise<void>>();
  private offs: Unsubscribe[] = [];
  /** Icons fetched this session, by URL (the URL names its bytes: never stale) */
  private icons = new Map<string, Promise<string | null>>();

  constructor(
    private mp: MultiplayerService,
    private host: OrgHost,
    notices?: OrgNotices,
  ) {
    if (notices) {
      this.offs.push(notices.onOrg((n) => void this.notice(n)));
      if (notices.onReconnect) this.offs.push(notices.onReconnect(() => void this.notice({ t: "org", what: "orgs" })));
    }
    this.offs.push(mp.onSession(() => this.forget()));
    this.orgs = this.orgsRepository();
    this.teams = this.teamsRepository();
    this.projects = this.projectsRepository();
    this.admin = this.adminRepository();
  }

  close(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.listeners.clear();
  }

  onEvent(listener: (e: OrgEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: OrgEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        this.host.log("warn", "org: a listener failed", err);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The cache
  // -------------------------------------------------------------------------------------------------------------------

  /** Signed in as someone else (or out): the caches in memory are dropped, the next read loads that person's */
  private forget(): void {
    this.caches.clear();
    this.loaded = null;
    this.loadedFor = undefined;
    this.inflight.clear();
    this.loading.clear();
    this.writes.clear();
    this.freshAt.clear();
    this.teamOrg.clear();
    this.projectTeam.clear();
    this.groupOrg.clear();
  }

  private requireSession(): void {
    if (!this.mp.signedIn) throw new StoreError("offline", "Log in to see your organizations");
  }

  private async ensureLoaded(): Promise<void> {
    const uid = this.mp.userId;
    if (this.loaded && this.loadedFor === uid) return this.loaded;
    this.caches.clear();
    this.loadedFor = uid;
    this.loaded = (async () => {
      for (const orgId of await this.host.cachedOrgIds().catch(() => [] as string[])) {
        const raw = (await this.host.loadCache(orgId).catch(() => null)) as OrgCache | null;
        if (!raw || raw.v !== 1 || raw.orgId !== orgId || raw.uid !== uid) continue;
        const c: OrgCache = { ...emptyCache(orgId, uid, 0), ...raw };
        this.caches.set(orgId, c);
        this.learn(c);
      }
    })();
    return this.loaded;
  }

  private learn(c: OrgCache): void {
    for (const list of [c.teams.mine, c.teams.browse]) for (const t of list ?? []) this.teamOrg.set(t.id, c.orgId);
    for (const t of Object.values(c.team)) this.teamOrg.set(t.id, c.orgId);
    for (const list of Object.values(c.projects)) for (const p of list) this.learnProject(p, c.orgId);
    for (const p of Object.values(c.project)) this.learnProject(p, c.orgId);
    for (const g of c.groups ?? []) this.groupOrg.set(g.id, c.orgId);
    for (const g of c.people?.groups ?? []) this.groupOrg.set(g.id, c.orgId);
  }

  private learnProject(p: O.ProjectSummary, orgId?: string | null): void {
    this.projectTeam.set(p.id, p.teamId);
    if (orgId) this.teamOrg.set(p.teamId, orgId);
  }

  private cacheOf(orgId: string): OrgCache {
    let c = this.caches.get(orgId);
    if (!c) this.caches.set(orgId, (c = emptyCache(orgId, this.mp.userId, this.host.now())));
    return c;
  }

  /** Writes an org's cache, one write per org at a time (the latest state wins) */
  private save(orgId: string): Promise<void> {
    const prev = this.saving.get(orgId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const c = this.caches.get(orgId);
        if (c) c.savedAt = this.host.now();
        await this.host.saveCache(orgId, c ? clone(c) : null);
      })
      .catch((e) => this.host.log("warn", `org ${orgId}: saving the cache failed`, e));
    this.saving.set(orgId, next);
    return next;
  }

  /** Resolves when every cache write so far is done (tests) */
  async idle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await Promise.all([...this.inflight.values(), ...this.loading.values()].map((p) => p.catch(() => {})));
      await Promise.all([...this.saving.values()]);
    }
  }

  /**
   * A cached read: the cache's answer at once (refreshed behind, `event` when it changed), else the server's. `orgId`
   * null: not known yet (the answer may tell — `place`), so it isn't cached.
   */
  private async read<T>(spec: {
    key: string;
    orgId: string | null;
    get: (c: OrgCache) => T | undefined;
    set: (c: OrgCache, v: T) => void;
    fetch: () => Promise<T>;
    event: OrgEvent | null;
    /** Learns where things are from the answer; returns its org when the answer says */
    place?: (v: T) => string | null | void;
    /** The other reads this answer holds (a page's parts: `team:<id>`, `members:<id>`…) — fresh with it */
    parts?: (v: T) => string[];
  }): Promise<T> {
    this.requireSession();
    await this.ensureLoaded();
    const orgId = spec.orgId;
    const c = orgId ? this.caches.get(orgId) : undefined;
    const hit = c ? spec.get(c) : undefined;
    if (hit !== undefined) {
      if ((this.freshAt.get(spec.key) ?? -Infinity) + FRESH_MS < this.host.now()) void this.refresh(spec).catch(() => {});
      return clone(hit);
    }
    let p = this.loading.get(spec.key) as Promise<T> | undefined;
    if (!p) {
      const gen = this.writeGen(orgId);
      p = spec.fetch().then((v) => {
        this.store(spec, v, gen);
        return v;
      });
      this.loading.set(spec.key, p);
      const done = () => {
        if (this.loading.get(spec.key) === p) this.loading.delete(spec.key);
      };
      p.then(done, done);
    }
    return clone(await p);
  }

  private writeGen(orgId: string | null): number {
    return orgId ? (this.writes.get(orgId) ?? 0) : 0;
  }

  /** `gen`: the org's write count when the read began — a write since then wins over this (older) answer */
  private store<T>(spec: { key: string; orgId: string | null; set: (c: OrgCache, v: T) => void; place?: (v: T) => string | null | void; parts?: (v: T) => string[] }, v: T, gen?: number): boolean {
    const placed = spec.place?.(v) ?? null;
    const orgId = spec.orgId ?? placed;
    if (gen !== undefined && spec.orgId && this.writeGen(spec.orgId) !== gen) return false;
    this.freshAt.set(spec.key, this.host.now());
    if (!orgId) return false;
    // Read before its org was known (the key's org part empty): fresh under the org's key too, which the next read uses
    if (!spec.orgId && spec.key.startsWith("|")) this.freshAt.set(`${orgId}${spec.key}`, this.host.now());
    for (const part of (v && spec.parts?.(v)) || []) this.freshAt.set(`${orgId}|${part}`, this.host.now());
    const c = this.cacheOf(orgId);
    const before = JSON.stringify(c);
    spec.set(c, clone(v));
    if (JSON.stringify(c) === before) return false;
    void this.save(orgId);
    return true;
  }

  /** Asks the server again; an event when the answer changed, `cache.stale` when the server can't be reached */
  private refresh<T>(spec: { key: string; orgId: string | null; get: (c: OrgCache) => T | undefined; set: (c: OrgCache, v: T) => void; fetch: () => Promise<T>; event: OrgEvent | null; place?: (v: T) => string | null | void; parts?: (v: T) => string[] }): Promise<void> {
    const running = this.inflight.get(spec.key);
    if (running) return running;
    const gen = this.writeGen(spec.orgId);
    let p: Promise<void> | undefined = undefined;
    p = (async () => {
      try {
        const v = await spec.fetch();
        if (this.store(spec, v, gen) && spec.event) this.emit(spec.event);
      } catch (e) {
        if (isOffline(e) && spec.orgId) this.emit({ type: "cache.stale", orgId: spec.orgId, offline: true });
        else if (e instanceof StoreError && (e.code === "not-found" || e.code === "forbidden") && spec.orgId) {
          // Gone, or no longer the person's to see: dropped from the cache.
          const c = this.caches.get(spec.orgId);
          if (c) {
            spec.set(c, undefined as T);
            void this.save(spec.orgId);
            if (spec.event) this.emit(spec.event);
          }
          // A Governance+ gate met by a refresh behind a cached page (a team's or folder's route: the refusal itself
          // can't say whose org it is): said for this org, so Home shows the gate rather than the stale page
          const detail = e.detail as { code?: unknown; gate?: unknown } | undefined;
          if (e.code === "forbidden" && isGovernanceCode(detail?.code) && detail.gate && typeof detail.gate === "object") {
            this.emit({ type: "access.blocked", orgId: spec.orgId, code: detail.code, gate: detail.gate as OrgGate });
          }
        } else this.host.log("warn", `org: refreshing ${spec.key} failed`, e);
      } finally {
        if (this.inflight.get(spec.key) === p) this.inflight.delete(spec.key);
      }
    })();
    this.inflight.set(spec.key, p);
    return p;
  }

  /**
   * A change made here or told by the Inbox: `change` patches the cache with what is known (entries it deletes are
   * read from the server next time), and every entry of the org is stale — the next read answers from the cache at
   * once and refreshes behind. Reads on their way since before are not stored over it.
   */
  private drop(orgId: string | null | undefined, change: (c: OrgCache) => void = () => {}): void {
    if (!orgId) return;
    this.writes.set(orgId, this.writeGen(orgId) + 1);
    for (const k of [...this.freshAt.keys()]) if (k.startsWith(`${orgId}|`)) this.freshAt.delete(k);
    for (const k of [...this.inflight.keys()]) if (k.startsWith(`${orgId}|`)) this.inflight.delete(k);
    for (const k of [...this.loading.keys()]) if (k.startsWith(`${orgId}|`)) this.loading.delete(k);
    const c = this.caches.get(orgId);
    if (!c) return;
    change(c);
    void this.save(orgId);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The server
  // -------------------------------------------------------------------------------------------------------------------

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.requireSession();
    return this.mp.call<T>(method, path, body);
  }

  /** The org a team belongs to: learnt from listings, else looked for in the person's orgs */
  private async orgOfTeam(teamId: string): Promise<string> {
    await this.ensureLoaded();
    const known = this.teamOrg.get(teamId);
    if (known) return known;
    for (const org of await this.orgs.list()) {
      for (const filter of ["mine", "browse"] as const) {
        const teams = await this.teams.list(org.id, filter).catch(() => [] as O.TeamSummary[]);
        if (teams.some((t) => t.id === teamId)) return org.id;
      }
    }
    throw new StoreError("not-found", "No such team");
  }

  private async teamOfProject(projectId: string): Promise<string> {
    await this.ensureLoaded();
    return this.projectTeam.get(projectId) ?? (await this.projects.get(projectId)).teamId;
  }

  /** The admin route's org for a workspace or billing group: learnt from listings, else looked for */
  private async orgOfAdminThing(id: string, index: Map<string, string>, list: (orgId: string) => Promise<{ id: string }[]>): Promise<string> {
    const known = index.get(id);
    if (known) return known;
    for (const org of await this.orgs.list()) if ((await list(org.id).catch(() => [])).some((x) => x.id === id)) return org.id;
    throw new StoreError("not-found", "Not found");
  }

  /** Fills each file's local copy (`fileKey`) and keeps the copies' `space` where the server says they are */
  private async withCopies(files: O.OrgFile[]): Promise<O.OrgFile[]> {
    const copies = await this.mp.linkedCopies();
    const out = files.map((f) => ({ ...f, fileKey: copies.get(f.key) ?? null }));
    for (const f of out) {
      if (!f.fileKey) continue;
      const space: FileSpace = { orgId: f.orgId, key: f.key, teamId: f.teamId, projectId: f.projectId };
      const cur = this.host.getMeta(f.fileKey)?.space ?? null;
      if (!cur || !same(cur, space)) await this.host.setFileSpace(f.fileKey, space).catch((e) => this.host.log("warn", `org: updating ${f.fileKey}'s place failed`, e));
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Inbox notices
  // -------------------------------------------------------------------------------------------------------------------

  /** @internal An Inbox notice: the entries it names are refreshed, then its event goes out. */
  async notice(n: OrgNotice): Promise<void> {
    if (!this.mp.signedIn) return;
    await this.ensureLoaded();
    const what = (n.what ?? "").replace(/\.(changed|updated)$/, "");
    const orgId = typeof n.orgId === "string" ? n.orgId : null;
    const c = orgId ? this.caches.get(orgId) : undefined;
    const refreshed = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        // offline or gone: the event still goes, the next read asks again
      }
    };
    switch (what) {
      case "orgs":
        await refreshed(() => this.refresh({ ...this.orgListSpec(), event: null }));
        this.emit({ type: "orgs.changed" });
        return;
      case "org":
        if (!orgId) return;
        // The org itself is read again now (offline, the cached one stays); people and groups at their next read
        if (c) {
          c.people = null;
          c.groups = null;
        }
        await refreshed(() => this.refresh({ ...this.orgInfoSpec(orgId), event: null }));
        this.emit({ type: "org.updated", orgId });
        return;
      case "teams":
        if (!orgId) return;
        if (c) delete c.teams.browse;
        await refreshed(() => this.refresh({ ...this.teamListSpec(orgId, "mine"), event: null }));
        this.emit({ type: "teams.changed", orgId });
        return;
      case "team": {
        const teamId = typeof n.teamId === "string" ? n.teamId : null;
        if (!teamId) return;
        const org = orgId ?? this.teamOrg.get(teamId) ?? null;
        // Kept, stale: Home shows the team at once and reads it again behind (gone: dropped then)
        this.drop(org);
        this.emit({ type: "team.updated", teamId });
        if (org) this.emit({ type: "teams.changed", orgId: org });
        return;
      }
      case "projects": {
        const teamId = typeof n.teamId === "string" ? n.teamId : null;
        if (!teamId) return;
        const parentId = typeof n.parentId === "string" ? n.parentId : null;
        const org = orgId ?? this.teamOrg.get(teamId) ?? null;
        this.drop(org);
        if (org) await refreshed(() => this.refresh({ ...this.projectListSpec(org, teamId, parentId), event: null }));
        this.emit({ type: "projects.changed", teamId, parentId });
        return;
      }
      case "files": {
        if (!orgId) return;
        const projectId = typeof n.projectId === "string" ? n.projectId : null;
        await refreshed(() => this.refresh({ ...(projectId ? this.fileListSpec(orgId, projectId) : this.draftsSpec(orgId)), event: null }));
        this.emit({ type: "files.changed", orgId, projectId });
        return;
      }
      default:
        // Something the store doesn't know by name: the org's cache is read again from the server.
        if (!orgId) return this.emit({ type: "orgs.changed" });
        this.drop(orgId, (x) => Object.assign(x, emptyCache(orgId, x.uid, x.savedAt), { summary: x.summary }));
        this.emit({ type: "org.updated", orgId });
        this.emit({ type: "teams.changed", orgId });
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Read specs (shared by reads, refreshes and notices)
  // -------------------------------------------------------------------------------------------------------------------

  private orgListSpec() {
    return {
      key: "|orgs",
      orgId: null,
      get: () => undefined,
      set: () => {},
      fetch: async () => {
        const orgs = pick<O.OrgSummary[]>(await this.call("GET", "/orgs"), "orgs");
        this.storeOrgList(orgs);
        return orgs;
      },
      event: { type: "orgs.changed" } as OrgEvent,
    };
  }

  /** The orgs the person is in: each one's summary into its cache; caches of orgs they left are dropped */
  private storeOrgList(orgs: O.OrgSummary[]): boolean {
    let changed = false;
    const ids = new Set(orgs.map((o) => o.id));
    for (const o of orgs) {
      const c = this.cacheOf(o.id);
      if (!same(c.summary, o)) {
        c.summary = clone(o);
        changed = true;
        void this.save(o.id);
      }
    }
    for (const id of [...this.caches.keys()]) {
      if (ids.has(id)) continue;
      this.caches.delete(id);
      changed = true;
      void this.save(id);
    }
    return changed;
  }

  private orgInfoSpec(orgId: string) {
    return {
      key: `${orgId}|info`,
      orgId,
      get: (c: OrgCache) => c.info ?? undefined,
      set: (c: OrgCache, v: O.OrgInfo) => {
        c.info = v ?? null;
        if (v) c.summary = summaryOf(v);
      },
      fetch: async () => pick<O.OrgInfo>(await this.call("GET", `/orgs/${seg(orgId, "org")}`), "org"),
      event: { type: "org.updated", orgId } as OrgEvent,
    };
  }

  private teamListSpec(orgId: string, filter: "mine" | "browse") {
    return {
      key: `${orgId}|teams:${filter}`,
      orgId,
      get: (c: OrgCache) => c.teams[filter],
      set: (c: OrgCache, v: O.TeamSummary[]) => {
        if (v) c.teams[filter] = v;
        else delete c.teams[filter];
      },
      fetch: async () => {
        const teams = pick<O.TeamSummary[]>(await this.call("GET", `/orgs/${seg(orgId, "org")}/teams${query({ filter })}`), "teams");
        for (const t of teams) this.teamOrg.set(t.id, orgId);
        return teams;
      },
      event: { type: "teams.changed", orgId } as OrgEvent,
    };
  }

  private projectListSpec(orgId: string | null, teamId: string, parentId: string | null) {
    const k = `${teamId}/${parentId ?? ""}`;
    return {
      key: `${orgId ?? ""}|projects:${k}`,
      orgId,
      get: (c: OrgCache) => c.projects[k],
      set: (c: OrgCache, v: O.ProjectSummary[]) => {
        if (v) c.projects[k] = v;
        else delete c.projects[k];
      },
      fetch: async () => {
        const projects = pick<O.ProjectSummary[]>(await this.call("GET", `/teams/${seg(teamId, "team")}/projects${query({ parent: parentId })}`), "projects");
        for (const p of projects) this.learnProject(p, orgId);
        return projects;
      },
      event: { type: "projects.changed", teamId, parentId } as OrgEvent,
    };
  }

  private fileListSpec(orgId: string | null, projectId: string) {
    return {
      key: `${orgId ?? ""}|files:${projectId}`,
      orgId,
      get: (c: OrgCache) => c.files[projectId],
      set: (c: OrgCache, v: O.OrgFile[]) => {
        if (v) c.files[projectId] = v.map((f) => ({ ...f, fileKey: null }));
        else delete c.files[projectId];
      },
      fetch: async () => pick<O.OrgFile[]>(await this.call("GET", `/projects/${seg(projectId, "folder")}/files`), "files"),
      event: orgId ? ({ type: "files.changed", orgId, projectId } as OrgEvent) : null,
      place: (v: O.OrgFile[]) => v?.[0]?.orgId ?? null,
    };
  }

  private draftsSpec(orgId: string) {
    return {
      key: `${orgId}|drafts`,
      orgId,
      get: (c: OrgCache) => c.files[DRAFTS],
      set: (c: OrgCache, v: O.OrgFile[]) => {
        if (v) c.files[DRAFTS] = v.map((f) => ({ ...f, fileKey: null }));
        else delete c.files[DRAFTS];
      },
      fetch: async () => pick<O.OrgFile[]>(await this.call("GET", `/orgs/${seg(orgId, "org")}/drafts`), "files"),
      event: { type: "files.changed", orgId, projectId: null } as OrgEvent,
    };
  }

  private teamMembersSpec(orgId: string | null, teamId: string) {
    return {
      key: `${orgId ?? ""}|members:${teamId}`,
      orgId,
      get: (c: OrgCache) => c.teamMembers[teamId],
      set: (c: OrgCache, v: O.TeamMember[]) => {
        if (v) c.teamMembers[teamId] = v;
        else delete c.teamMembers[teamId];
      },
      fetch: async () => pick<O.TeamMember[]>(await this.call("GET", `/teams/${seg(teamId, "team")}/members`), "members"),
      event: { type: "team.updated", teamId } as OrgEvent,
    };
  }

  private requestsSpec(orgId: string | null, teamId: string) {
    return {
      key: `${orgId ?? ""}|requests:${teamId}`,
      orgId,
      get: (c: OrgCache) => c.requests[teamId],
      set: (c: OrgCache, v: O.JoinRequest[]) => {
        if (v) c.requests[teamId] = v;
        else delete c.requests[teamId];
      },
      fetch: async () => pick<O.JoinRequest[]>(await this.call("GET", `/teams/${seg(teamId, "team")}/requests`), "requests"),
      event: { type: "team.updated", teamId } as OrgEvent,
    };
  }

  private projectMembersSpec(orgId: string | null, projectId: string) {
    const team = this.projectTeam.get(projectId);
    return {
      key: `${orgId ?? ""}|pmembers:${projectId}`,
      orgId,
      get: (c: OrgCache) => c.projectMembers[projectId],
      set: (c: OrgCache, v: O.ProjectMember[]) => {
        if (v) c.projectMembers[projectId] = v;
        else delete c.projectMembers[projectId];
      },
      fetch: async () => pick<O.ProjectMember[]>(await this.call("GET", `/projects/${seg(projectId, "folder")}/members`), "members"),
      event: team ? ({ type: "projects.changed", teamId: team, parentId: projectId } as OrgEvent) : null,
    };
  }

  /** Home's team page: the team, its top-level folders, members and join requests — cached as those four entries */
  private teamPageSpec(orgId: string | null, teamId: string) {
    const top = `${teamId}/`;
    const path = `/teams/${seg(teamId, "team")}`;
    return {
      key: `${orgId ?? ""}|teampage:${teamId}`,
      orgId,
      get: (c: OrgCache): O.TeamPage | undefined => {
        const [team, folders, members, requests] = [c.team[teamId], c.projects[top], c.teamMembers[teamId], c.requests[teamId]];
        return team && folders && members && requests ? { team, folders, members, requests } : undefined;
      },
      set: (c: OrgCache, v: O.TeamPage) => {
        if (!v) {
          delete c.team[teamId];
          delete c.projects[top];
          delete c.teamMembers[teamId];
          delete c.requests[teamId];
          return;
        }
        c.team[teamId] = v.team;
        c.projects[top] = v.folders;
        c.teamMembers[teamId] = v.members;
        c.requests[teamId] = v.requests;
      },
      fetch: async (): Promise<O.TeamPage> => {
        let page: O.TeamPage | null = null;
        try {
          const r = await this.call<Partial<O.TeamPage>>("GET", `${path}/page`);
          if (r?.team) page = { team: r.team, folders: r.folders ?? [], members: r.members ?? [], requests: r.requests ?? [] };
        } catch (e) {
          if (!routeMissing(e)) throw e;
        }
        if (!page) {
          // A server from before the page routes: the parts one by one, as Home read them (a refused part empty)
          const team = pick<O.TeamInfo>(await this.call("GET", path), "team");
          const quiet = <T>(p: Promise<T>, none: T) => p.catch(() => none);
          const [folders, members, requests] = await Promise.all([
            quiet(this.call("GET", `${path}/projects`).then((b) => pick<O.ProjectSummary[]>(b, "projects")), []),
            quiet(this.call("GET", `${path}/members`).then((b) => pick<O.TeamMember[]>(b, "members")), []),
            team.me?.admin || team.me?.owner ? quiet(this.call("GET", `${path}/requests`).then((b) => pick<O.JoinRequest[]>(b, "requests")), []) : Promise.resolve([]),
          ]);
          page = { team, folders, members, requests };
        }
        const org = orgOf(page.team) ?? orgId;
        if (org) this.teamOrg.set(page.team.id, org);
        for (const p of page.folders) this.learnProject(p, org);
        return page;
      },
      event: { type: "team.updated", teamId } as OrgEvent,
      place: (v: O.TeamPage) => (v ? (orgOf(v.team) ?? this.teamOrg.get(v.team.id) ?? null) : null),
      parts: () => [`team:${teamId}`, `projects:${top}`, `members:${teamId}`, `requests:${teamId}`],
    };
  }

  /** Home's folder page: the folder, its team, subfolders, files and members — cached as those entries */
  private projectPageSpec(orgId: string | null, projectId: string) {
    const path = `/projects/${seg(projectId, "folder")}`;
    const team = this.projectTeam.get(projectId);
    return {
      key: `${orgId ?? ""}|projectpage:${projectId}`,
      orgId,
      get: (c: OrgCache): O.ProjectPage | undefined => {
        const project = c.project[projectId];
        if (!project) return undefined;
        const [folders, files, members] = [c.projects[`${project.teamId}/${projectId}`], c.files[projectId], c.projectMembers[projectId]];
        return folders && files && members ? { project, team: c.team[project.teamId] ?? null, folders, files, members } : undefined;
      },
      set: (c: OrgCache, v: O.ProjectPage) => {
        const teamId = v?.project.teamId ?? c.project[projectId]?.teamId;
        if (!v) {
          delete c.project[projectId];
          if (teamId) delete c.projects[`${teamId}/${projectId}`];
          delete c.files[projectId];
          delete c.projectMembers[projectId];
          return;
        }
        c.project[projectId] = v.project;
        if (v.team) c.team[v.team.id] = v.team;
        c.projects[`${v.project.teamId}/${projectId}`] = v.folders;
        c.files[projectId] = v.files.map((f) => ({ ...f, fileKey: null }));
        c.projectMembers[projectId] = v.members;
      },
      fetch: async (): Promise<O.ProjectPage> => {
        let page: O.ProjectPage | null = null;
        try {
          const r = await this.call<Partial<O.ProjectPage>>("GET", `${path}/page`);
          if (r?.project) page = { project: r.project, team: r.team ?? null, folders: r.folders ?? [], files: r.files ?? [], members: r.members ?? [] };
        } catch (e) {
          if (!routeMissing(e)) throw e;
        }
        if (!page) {
          // A server from before the page routes: the parts one by one, as Home read them
          const project = pick<O.ProjectInfo>(await this.call("GET", path), "project");
          const quiet = <T>(p: Promise<T>, none: T) => p.catch(() => none);
          const teamPath = `/teams/${seg(project.teamId, "team")}`;
          const [team, folders, files, members] = await Promise.all([
            quiet(this.call("GET", teamPath).then((b) => pick<O.TeamInfo>(b, "team")), null),
            quiet(this.call("GET", `${teamPath}/projects${query({ parent: project.id })}`).then((b) => pick<O.ProjectSummary[]>(b, "projects")), []),
            this.call("GET", `${path}/files`).then((b) => pick<O.OrgFile[]>(b, "files")),
            quiet(this.call("GET", `${path}/members`).then((b) => pick<O.ProjectMember[]>(b, "members")), []),
          ]);
          page = { project, team, folders, files, members };
        }
        const org = orgOf(page.project) ?? (page.team ? orgOf(page.team) : null) ?? this.teamOrg.get(page.project.teamId) ?? orgId;
        this.learnProject(page.project, org);
        for (const p of page.folders) this.learnProject(p, org);
        return page;
      },
      event: (team ? { type: "projects.changed", teamId: team, parentId: projectId } : orgId ? { type: "files.changed", orgId, projectId } : null) as OrgEvent | null,
      place: (v: O.ProjectPage) => (v ? (orgOf(v.project) ?? this.teamOrg.get(v.project.teamId) ?? null) : null),
      parts: (v: O.ProjectPage) => [`project:${projectId}`, `projects:${v.project.teamId}/${projectId}`, `files:${projectId}`, `pmembers:${projectId}`, ...(v.team ? [`team:${v.team.id}`] : [])],
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // orgs
  // -------------------------------------------------------------------------------------------------------------------

  private orgsRepository(): OrgsRepository {
    return {
      list: async () => {
        if (!this.mp.signedIn) return [];
        await this.ensureLoaded();
        const cached = [...this.caches.values()].map((c) => c.summary).filter((s): s is O.OrgSummary => !!s);
        const spec = this.orgListSpec();
        if (cached.length) {
          if ((this.freshAt.get(spec.key) ?? -Infinity) + FRESH_MS < this.host.now()) {
            const running = this.inflight.get(spec.key);
            if (!running) {
              const p = (async () => {
                try {
                  const orgs = pick<O.OrgSummary[]>(await this.call("GET", "/orgs"), "orgs");
                  this.freshAt.set(spec.key, this.host.now());
                  if (this.storeOrgList(orgs)) this.emit({ type: "orgs.changed" });
                } catch (e) {
                  if (isOffline(e)) for (const s of cached) this.emit({ type: "cache.stale", orgId: s.id, offline: true });
                } finally {
                  this.inflight.delete(spec.key);
                }
              })();
              this.inflight.set(spec.key, p);
            }
          }
          return clone(cached);
        }
        try {
          const orgs = pick<O.OrgSummary[]>(await this.call("GET", "/orgs"), "orgs");
          this.freshAt.set(spec.key, this.host.now());
          this.storeOrgList(orgs);
          return clone(orgs);
        } catch (e) {
          // Offline with nothing cached: no org is known yet.
          if (isOffline(e)) return [];
          throw e;
        }
      },
      get: (orgId) => this.read(this.orgInfoSpec(String(orgId))),
      create: async (input) => {
        const org = pick<O.OrgInfo>(await this.call("POST", "/orgs", { name: cleanName(input?.name, null, "organization"), ...(input?.importSharedFiles === true ? { importSharedFiles: true } : {}) }), "org");
        await this.ensureLoaded();
        const c = this.cacheOf(org.id);
        c.info = clone(org);
        c.summary = summaryOf(org);
        await this.save(org.id);
        this.emit({ type: "orgs.changed" });
        return org;
      },
      people: async (orgId, q) => {
        const id = String(orgId);
        const text = typeof q?.text === "string" ? q.text.trim() : "";
        const limit = Number.isInteger(q?.limit) && q!.limit! > 0 ? q!.limit! : undefined;
        const fetch = async () => {
          const r = await this.call<{ people: O.PersonRef[]; groups: O.GroupRef[] }>("GET", `/orgs/${seg(id, "org")}/people${query({ text, limit })}`);
          for (const g of r.groups ?? []) this.groupOrg.set(g.id, id);
          return { people: r.people ?? [], groups: r.groups ?? [] };
        };
        // Only the whole list is cached (a search asks the server)
        if (text || limit) return fetch();
        return this.read({ key: `${id}|people`, orgId: id, get: (c) => c.people ?? undefined, set: (c, v) => void (c.people = v ?? null), fetch, event: { type: "org.updated", orgId: id } });
      },
      drafts: async (orgId) => this.withCopies(await this.read(this.draftsSpec(String(orgId)))),
      createDraft: async (orgId, input) => {
        const id = String(orgId);
        const r = await this.createOrgFile(input?.name, { orgId: id, teamId: null, projectId: null }, (key, name) => this.call("POST", `/orgs/${seg(id, "org")}/drafts`, { key, name, ...(input?.editorType ? { editorType: input.editorType } : {}) }));
        this.drop(id, (c) => delete c.files[DRAFTS]);
        this.emit({ type: "files.changed", orgId: id, projectId: null });
        return r;
      },
      search: async (orgId, text) => {
        const r = await this.call<O.OrgSearchResult>("GET", `/orgs/${seg(String(orgId), "org")}/search${query({ text: String(text ?? "") })}`);
        return { ...r, files: await this.withCopies(r.files ?? []) };
      },
      requestSeat: async (orgId, seat, note) => {
        if (seat !== "full" && seat !== "dev" && seat !== "collab") throw new StoreError("invalid", `bad seat ${String(seat)}`);
        const id = String(orgId);
        const request = pick<O.SeatRequest>(await this.call("POST", `/orgs/${seg(id, "org")}/seat-requests`, { seat, ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}) }), "request");
        // Approved at once under `auto`: the seat changed
        if (request.state === "approved") {
          this.drop(id, (c) => (c.info = null));
          this.emit({ type: "orgs.changed" });
          this.emit({ type: "org.updated", orgId: id });
        }
        return request;
      },
      groups: (orgId) => {
        const id = String(orgId);
        return this.read({
          key: `${id}|groups`,
          orgId: id,
          get: (c) => c.groups ?? undefined,
          set: (c, v) => void (c.groups = v ?? null),
          fetch: async () => {
            const groups = pick<O.UserGroup[]>(await this.call("GET", `/orgs/${seg(id, "org")}/groups`), "groups");
            for (const g of groups) this.groupOrg.set(g.id, id);
            return groups;
          },
          event: { type: "org.updated", orgId: id },
        });
      },
      createGroup: async (orgId, input) => {
        const id = String(orgId);
        const group = pick<O.UserGroup>(
          await this.call("POST", `/orgs/${seg(id, "org")}/groups`, {
            name: cleanName(input?.name, null, "group"),
            ...(typeof input?.description === "string" ? { description: input.description } : {}),
            ...(Array.isArray(input?.userIds) ? { userIds: input.userIds.map(String) } : {}),
          }),
          "group",
        );
        this.groupOrg.set(group.id, id);
        this.groupsChanged(id);
        return group;
      },
      updateGroup: async (groupId, patch) => {
        const group = pick<O.UserGroup>(await this.call("PATCH", `/groups/${seg(groupId, "group")}`, { ...(patch?.name !== undefined ? { name: cleanName(patch.name, null, "group") } : {}), ...(typeof patch?.description === "string" ? { description: patch.description } : {}) }), "group");
        this.groupsChanged(this.groupOrg.get(String(groupId)));
        return group;
      },
      setGroupMembers: async (groupId, change) => {
        const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
        const group = pick<O.UserGroup>(await this.call("POST", `/groups/${seg(groupId, "group")}/members`, { add: ids(change?.add), remove: ids(change?.remove) }), "group");
        this.groupsChanged(this.groupOrg.get(String(groupId)));
        return group;
      },
      deleteGroup: async (groupId) => {
        await this.call("DELETE", `/groups/${seg(groupId, "group")}`);
        this.groupsChanged(this.groupOrg.get(String(groupId)));
      },
      leave: async (orgId) => {
        const id = String(orgId);
        await this.call("DELETE", `/orgs/${seg(id, "org")}/me`);
        this.caches.delete(id);
        await this.save(id);
        this.emit({ type: "orgs.changed" });
      },
      update: async (orgId, patch) => {
        const id = String(orgId);
        return this.orgChanged(pick<O.OrgInfo>(await this.call("PATCH", `/orgs/${seg(id, "org")}`, { name: cleanName(patch?.name, null, "organization") }), "org"));
      },
      setIcon: async (orgId, image) => {
        const id = String(orgId);
        return this.orgChanged(pick<O.OrgInfo>(await this.call("PUT", `/orgs/${seg(id, "org")}/icon`, iconBytes(image)), "org"));
      },
      removeIcon: async (orgId) => {
        const id = String(orgId);
        return this.orgChanged(pick<O.OrgInfo>(await this.call("DELETE", `/orgs/${seg(id, "org")}/icon`), "org"));
      },
      iconData: (iconUrl) => this.iconData(iconUrl),
      watch: (listener) => this.onEvent(listener),
    };
  }

  /** The org's new name or icon: its cached entry and list summary, then `orgs.changed` and `org.updated` */
  private async orgChanged(org: O.OrgInfo): Promise<O.OrgInfo> {
    await this.ensureLoaded();
    const c = this.cacheOf(org.id);
    c.info = clone(org);
    c.summary = summaryOf(org);
    this.freshAt.set(`${org.id}|info`, this.host.now());
    await this.save(org.id);
    this.emit({ type: "orgs.changed" });
    this.emit({ type: "org.updated", orgId: org.id });
    return org;
  }

  private iconData(iconUrl: unknown): Promise<string | null> {
    if (typeof iconUrl !== "string") return Promise.resolve(null);
    if (iconUrl.startsWith("data:image/")) return Promise.resolve(iconUrl);
    if (!ICON_URL.test(iconUrl) || !this.mp.signedIn) return Promise.resolve(null);
    let p = this.icons.get(iconUrl);
    if (!p) {
      p = this.mp.callBytes("GET", iconUrl).then(
        ({ bytes, headers }) => {
          const mime = iconMime(bytes) ?? headers.get("content-type");
          return mime && mime.startsWith("image/") ? bytesToDataUrl(bytes, mime) : null;
        },
        () => {
          // Offline or gone: asked again next time
          this.icons.delete(iconUrl);
          return null;
        },
      );
      this.icons.set(iconUrl, p);
      // A long session with many teams: the oldest go first
      if (this.icons.size > 200) this.icons.delete(this.icons.keys().next().value!);
    }
    return p;
  }

  private groupsChanged(orgId: string | undefined): void {
    if (!orgId) return;
    this.drop(orgId, (c) => {
      c.groups = null;
      c.people = null;
    });
    this.emit({ type: "org.updated", orgId });
  }

  /**
   * A new org file (docs/multiplayer.md §14.6): its local copy, then — in one call — registered through `register` with
   * the copy's snapshot. Offline (or refused) nothing is left behind: the copy goes again.
   */
  private async createOrgFile(name: unknown, place: Omit<FileSpace, "key">, register: (key: string, name: string) => Promise<unknown>): Promise<{ fileKey: FileKey; file: O.OrgFile }> {
    this.requireSession();
    const key = this.mp.newRoomKey("file");
    const meta = await this.host.createOrgFile({ name: cleanName(name, "Untitled", "file"), space: { ...place, key } });
    let answer: unknown;
    try {
      const snapshot = await this.host.headSnapshot(meta.fileKey);
      answer = await this.mp.shareTo(meta.fileKey, { snapshot, headSeq: 0 }, register, key);
    } catch (e) {
      // Registered, but its content didn't finish uploading: the file is on the server, so its copy stays (and its link
      // uploads the rest when it next starts) — removing the copy would leave the server's file empty for good.
      if (pendingUpload(e)) throw e;
      await this.host.deleteLocalFile(meta.fileKey).catch((err) => this.host.log("warn", `org: removing the unregistered copy ${meta.fileKey} failed`, err));
      throw e;
    }
    const file = pick<O.OrgFile>(answer, "file");
    return { fileKey: meta.fileKey, file: { ...file, fileKey: meta.fileKey } };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // teams
  // -------------------------------------------------------------------------------------------------------------------

  private teamsRepository(): TeamsRepository {
    const teamPath = (teamId: unknown) => `/teams/${seg(teamId, "team")}`;
    /** A team changed: what the server answered goes into the cache (the team, its list entries; `null`: it's gone
     *  for the person), the rest is stale — read at once next time, refreshed behind */
    const changed = async (teamId: string, orgId?: string | null, patch?: { team?: O.TeamInfo | null; members?: O.TeamMember[]; requests?: O.JoinRequest[]; left?: boolean }) => {
      const org = orgId ?? (patch?.team ? orgOf(patch.team) : null) ?? this.teamOrg.get(teamId) ?? null;
      this.drop(org, (c) => {
        if (patch?.team === null) {
          delete c.team[teamId];
          for (const f of ["mine", "browse"] as const) if (c.teams[f]) c.teams[f] = c.teams[f]!.filter((t) => t.id !== teamId);
        } else if (patch?.team) {
          const t = patch.team;
          c.team[teamId] = clone(t);
          for (const f of ["mine", "browse"] as const) {
            const list = c.teams[f];
            if (!list) continue;
            const i = list.findIndex((x) => x.id === teamId);
            const summary = summaryOfTeam(t);
            if (i >= 0) list[i] = summary;
            else if (f === "mine" && t.me) c.teams[f] = [...list, summary].sort((a, b) => a.name.localeCompare(b.name));
          }
        }
        // Left: out of the person's teams (still in Browse when visible)
        if (patch?.left && c.teams.mine) c.teams.mine = c.teams.mine.filter((t) => t.id !== teamId);
        if (patch?.members) c.teamMembers[teamId] = clone(patch.members);
        if (patch?.requests) c.requests[teamId] = clone(patch.requests);
      });
      this.emit({ type: "team.updated", teamId });
      if (org) this.emit({ type: "teams.changed", orgId: org });
    };
    const members = (body: unknown) => pick<O.TeamMember[]>(body, "members");
    const orgOfTeamId = async (teamId: string) => {
      await this.ensureLoaded();
      return this.teamOrg.get(teamId) ?? null;
    };
    return {
      list: (orgId, filter) => this.read(this.teamListSpec(String(orgId), filter === "browse" ? "browse" : "mine")),
      get: async (teamId) => {
        const id = String(teamId);
        await this.ensureLoaded();
        return this.read({
          key: `${this.teamOrg.get(id) ?? ""}|team:${id}`,
          orgId: this.teamOrg.get(id) ?? null,
          get: (c) => c.team[id],
          set: (c, v) => {
            if (v) c.team[id] = v;
            else delete c.team[id];
          },
          fetch: async () => pick<O.TeamInfo>(await this.call("GET", teamPath(id)), "team"),
          event: { type: "team.updated", teamId: id },
          place: (v) => (v ? orgOf(v) : null),
        });
      },
      page: async (teamId) => this.read(this.teamPageSpec(await orgOfTeamId(String(teamId)), String(teamId))),
      create: async (orgId, input) => {
        const id = String(orgId);
        const team = pick<O.TeamInfo>(await this.call("POST", `/orgs/${seg(id, "org")}/teams`, { name: cleanName(input?.name, null, "team"), ...(input?.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}) }), "team");
        this.teamOrg.set(team.id, id);
        await changed(team.id, id, { team });
        return team;
      },
      update: async (teamId, patch) => {
        const team = pick<O.TeamInfo>(await this.call("PATCH", teamPath(teamId), patch ?? {}), "team");
        await changed(String(teamId), null, { team });
        return team;
      },
      setIcon: async (teamId, image) => {
        const team = pick<O.TeamInfo>(await this.call("PUT", `${teamPath(teamId)}/icon`, iconBytes(image)), "team");
        await changed(String(teamId), null, { team });
        return team;
      },
      removeIcon: async (teamId) => {
        const team = pick<O.TeamInfo>(await this.call("DELETE", `${teamPath(teamId)}/icon`), "team");
        await changed(String(teamId), null, { team });
        return team;
      },
      remove: async (teamId) => {
        await this.call("DELETE", teamPath(teamId));
        await changed(String(teamId), null, { team: null });
      },
      restore: async (teamId) => {
        const team = pick<O.TeamInfo>(await this.call("POST", `${teamPath(teamId)}/restore`), "team");
        await changed(String(teamId), null, { team });
        return team;
      },
      transfer: async (teamId, userId) => {
        const team = pick<O.TeamInfo>(await this.call("POST", `${teamPath(teamId)}/transfer`, { userId: String(userId) }), "team");
        await changed(String(teamId), null, { team });
        return team;
      },
      members: async (teamId) => this.read(this.teamMembersSpec(await orgOfTeamId(String(teamId)), String(teamId))),
      invite: async (teamId, input) => {
        if (input?.role !== "editor" && input?.role !== "viewer") throw new StoreError("invalid", "bad role");
        const r = await members(await this.call("PUT", `${teamPath(teamId)}/members`, { ...(input.email ? { email: String(input.email) } : { groupId: String(input.groupId ?? "") }), role: input.role, ...(input.admin === true ? { admin: true } : {}) }));
        await changed(String(teamId), null, { members: r });
        return r;
      },
      setMember: async (teamId, principal, patch) => {
        const r = await members(await this.call("PATCH", `${teamPath(teamId)}/members/${seg(principal, "member")}`, { ...(patch?.role ? { role: patch.role } : {}), ...(typeof patch?.admin === "boolean" ? { admin: patch.admin } : {}) }));
        await changed(String(teamId), null, { members: r });
        return r;
      },
      removeMember: async (teamId, principal) => {
        const r = await members(await this.call("DELETE", `${teamPath(teamId)}/members/${seg(principal, "member")}`));
        await changed(String(teamId), null, { members: r });
        return r;
      },
      join: async (teamId) => {
        const r = await this.call<{ status: "joined" | "requested" }>("POST", `${teamPath(teamId)}/join`);
        await changed(String(teamId));
        return { status: r?.status === "requested" ? "requested" : "joined" };
      },
      leave: async (teamId) => {
        const uid = this.mp.userId;
        if (!uid) throw new StoreError("offline", "Log in to leave a team");
        await this.call("DELETE", `${teamPath(teamId)}/members/${seg(`u:${uid}`, "member")}`);
        await changed(String(teamId), null, { left: true });
      },
      requests: async (teamId) => this.read(this.requestsSpec(await orgOfTeamId(String(teamId)), String(teamId))),
      answerRequest: async (teamId, userId, approve) => {
        const r = pick<O.JoinRequest[]>(await this.call("POST", `${teamPath(teamId)}/requests/${seg(userId, "person")}`, { approve: approve === true }), "requests");
        await changed(String(teamId), null, { requests: r });
        return r;
      },
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // projects (folders) and their files
  // -------------------------------------------------------------------------------------------------------------------

  private projectsRepository(): ProjectsRepository {
    const projectPath = (id: unknown) => `/projects/${seg(id, "folder")}`;
    /**
     * A folder changed: the server's answer (`info`) replaces it in the cache and in the list it now sits in; `gone`
     * (trashed, deleted) takes it out. Everything else of the org (counts, paths below a moved folder) is stale.
     */
    const foldersChanged = async (teamId: string, parentId: string | null, projectId?: string, change?: { info?: O.ProjectInfo; gone?: boolean }) => {
      const org = this.teamOrg.get(teamId) ?? null;
      this.drop(org, (c) => {
        if (!projectId || (!change?.info && !change?.gone)) return;
        for (const [k, list] of Object.entries(c.projects)) c.projects[k] = list.filter((x) => x.id !== projectId);
        if (change.gone) {
          delete c.project[projectId];
          return;
        }
        const info = change.info!;
        c.project[projectId] = clone(info);
        const k = `${info.teamId}/${info.parentId ?? ""}`;
        if (c.projects[k]) c.projects[k] = [...c.projects[k], summaryOfProject(info)].sort((a, b) => a.name.localeCompare(b.name));
      });
      this.emit({ type: "projects.changed", teamId, parentId });
    };
    /**
     * Files moved or trashed: out of the lists holding them, into the destination's list when it is cached (`to`:
     * a folder, null the mover's drafts); `added`: a new file into its folder's list. Restored files: their lists are
     * read again (`refetch`: where they go back isn't known here).
     */
    const filesChanged = async (keys: string[], to?: string | null, opts: { added?: O.OrgFile; refetch?: boolean } = {}) => {
      const touched = new Map<string, Set<string | null>>();
      const add = (orgId: string, projectId: string | null) => {
        let s = touched.get(orgId);
        if (!s) touched.set(orgId, (s = new Set()));
        s.add(projectId);
      };
      const moved = new Map<string, O.OrgFile[]>();
      for (const c of this.caches.values())
        for (const [k, list] of Object.entries(c.files))
          if (list.some((f) => keys.includes(f.key))) {
            add(c.orgId, k === DRAFTS ? null : k);
            if (to !== undefined) add(c.orgId, to);
            if (!opts.refetch) {
              moved.set(c.orgId, [...(moved.get(c.orgId) ?? []), ...list.filter((f) => keys.includes(f.key))]);
              c.files[k] = list.filter((f) => !keys.includes(f.key));
            }
          }
      const destTeam = to ? (this.projectTeam.get(to) ?? null) : null;
      if (to) {
        const org = destTeam ? this.teamOrg.get(destTeam) : undefined;
        if (org) add(org, to);
      }
      if (opts.added) add(opts.added.orgId, opts.added.projectId);
      for (const [orgId, projects] of touched) {
        this.drop(orgId, (c) => {
          if (opts.refetch) for (const p of projects) delete c.files[p ?? DRAFTS];
          const dest = to !== undefined ? c.files[to ?? DRAFTS] : undefined;
          if (dest) for (const f of moved.get(orgId) ?? []) if (!dest.some((x) => x.key === f.key)) dest.unshift({ ...f, projectId: to ?? null, teamId: to ? destTeam : null });
          const a = opts.added;
          if (a && a.orgId === orgId) {
            const list = c.files[a.projectId ?? DRAFTS];
            if (list && !list.some((x) => x.key === a.key)) list.unshift({ ...a, fileKey: null });
          }
        });
        for (const projectId of projects) this.emit({ type: "files.changed", orgId, projectId });
      }
    };
    const members = (body: unknown) => pick<O.ProjectMember[]>(body, "members");
    /** A folder's people as the server answered a change to them (its subfolders' inherited ones are stale) */
    const membersChanged = (projectId: string, list: O.ProjectMember[]): O.ProjectMember[] => {
      const team = this.projectTeam.get(projectId);
      const org = team ? (this.teamOrg.get(team) ?? null) : null;
      this.drop(org, (c) => (c.projectMembers[projectId] = clone(list)));
      if (team) this.emit({ type: "projects.changed", teamId: team, parentId: projectId });
      return list;
    };
    const project = (body: unknown) => {
      const p = pick<O.ProjectInfo>(body, "project");
      this.learnProject(p);
      return p;
    };
    return {
      list: async (teamId, parentId) => {
        const t = String(teamId);
        await this.ensureLoaded();
        return this.read(this.projectListSpec(this.teamOrg.get(t) ?? null, t, typeof parentId === "string" ? parentId : null));
      },
      get: async (projectId) => {
        const id = String(projectId);
        await this.ensureLoaded();
        const team = this.projectTeam.get(id);
        const org = team ? (this.teamOrg.get(team) ?? null) : null;
        return this.read({
          key: `${org ?? ""}|project:${id}`,
          orgId: org,
          get: (c) => c.project[id],
          set: (c, v) => {
            if (v) c.project[id] = v;
            else delete c.project[id];
          },
          fetch: async () => project(await this.call("GET", projectPath(id))),
          event: team ? { type: "projects.changed", teamId: team, parentId: null } : null,
          place: (v) => (v ? (this.teamOrg.get(v.teamId) ?? null) : null),
        });
      },
      create: async (teamId, input) => {
        const t = String(teamId);
        const p = project(
          await this.call("POST", `/teams/${seg(t, "team")}/projects`, {
            name: cleanName(input?.name, null, "folder"),
            ...(typeof input?.parentId === "string" ? { parentId: input.parentId } : {}),
            ...(input?.access === "inherited" || input?.access === "limited" ? { access: input.access } : {}),
          }),
        );
        await foldersChanged(t, p.parentId, p.id, { info: p });
        return p;
      },
      update: async (projectId, patch) => {
        const p = project(await this.call("PATCH", projectPath(projectId), { ...(patch?.name !== undefined ? { name: cleanName(patch.name, null, "folder") } : {}), ...(patch?.access === "inherited" || patch?.access === "limited" ? { access: patch.access } : {}) }));
        await foldersChanged(p.teamId, p.parentId, p.id, { info: p });
        return p;
      },
      move: async (projectId, to) => {
        const from = await this.teamOfProject(String(projectId)).catch(() => null);
        const p = project(await this.call("POST", `${projectPath(projectId)}/move`, { teamId: String(to?.teamId ?? ""), parentId: typeof to?.parentId === "string" ? to.parentId : null }));
        if (from && from !== p.teamId) await foldersChanged(from, null, p.id, { info: p });
        await foldersChanged(p.teamId, p.parentId, p.id, { info: p });
        return p;
      },
      trash: async (projectId) => {
        const id = String(projectId);
        const team = await this.teamOfProject(id).catch(() => null);
        await this.call("POST", `${projectPath(id)}/trash`);
        if (team) await foldersChanged(team, null, id, { gone: true });
      },
      restore: async (projectId) => {
        const p = project(await this.call("POST", `${projectPath(projectId)}/restore`));
        await foldersChanged(p.teamId, p.parentId, p.id, { info: p });
        return p;
      },
      deleteForever: async (projectId) => {
        const id = String(projectId);
        const team = this.projectTeam.get(id) ?? null;
        await this.call("DELETE", projectPath(id));
        if (team) await foldersChanged(team, null, id, { gone: true });
      },
      page: async (projectId) => {
        const id = String(projectId);
        await this.ensureLoaded();
        const team = this.projectTeam.get(id);
        const page = await this.read(this.projectPageSpec(team ? (this.teamOrg.get(team) ?? null) : null, id));
        return { ...page, files: await this.withCopies(page.files) };
      },
      members: async (projectId) => {
        const id = String(projectId);
        await this.ensureLoaded();
        const team = this.projectTeam.get(id);
        return this.read(this.projectMembersSpec(team ? (this.teamOrg.get(team) ?? null) : null, id));
      },
      invite: async (projectId, input) => {
        if (input?.role !== "editor" && input?.role !== "viewer") throw new StoreError("invalid", "bad role");
        return membersChanged(String(projectId), members(await this.call("PUT", `${projectPath(projectId)}/members`, { ...(input.email ? { email: String(input.email) } : { groupId: String(input.groupId ?? "") }), role: input.role })));
      },
      setMember: async (projectId, principal, role) => {
        if (role !== "editor" && role !== "viewer") throw new StoreError("invalid", "bad role");
        return membersChanged(String(projectId), members(await this.call("PATCH", `${projectPath(projectId)}/members/${seg(principal, "member")}`, { role })));
      },
      removeMember: async (projectId, principal) => membersChanged(String(projectId), members(await this.call("DELETE", `${projectPath(projectId)}/members/${seg(principal, "member")}`))),
      files: async (projectId) => {
        const id = String(projectId);
        await this.ensureLoaded();
        const team = this.projectTeam.get(id);
        return this.withCopies(await this.read(this.fileListSpec(team ? (this.teamOrg.get(team) ?? null) : null, id)));
      },
      createFile: async (projectId, input) => {
        const id = String(projectId);
        const teamId = await this.teamOfProject(id);
        const orgId = await this.orgOfTeam(teamId);
        const r = await this.createOrgFile(input?.name, { orgId, teamId, projectId: id }, (key, name) => this.call("POST", `${projectPath(id)}/files`, { key, name, ...(input?.editorType ? { editorType: input.editorType } : {}) }));
        await filesChanged([], undefined, { added: { ...r.file, orgId, teamId, projectId: id } });
        return r;
      },
      moveFiles: async (keys, to) => {
        const list = Array.isArray(keys) ? keys.map(String) : [];
        const dest = typeof to?.projectId === "string" ? to.projectId : null;
        const teamId = dest ? await this.teamOfProject(dest) : null;
        for (const key of list) {
          await this.call("POST", `/files/${seg(key, "file")}/move`, { projectId: dest });
          const copy = await this.mp.linkedCopy(key);
          const cur = copy ? this.host.getMeta(copy)?.space : null;
          if (copy && cur) await this.host.setFileSpace(copy, { orgId: cur.orgId, key, teamId, projectId: dest });
        }
        await filesChanged(list, dest);
      },
      moveLocalFile: async (fileKey, projectId, input) => {
        if (!(input?.snapshot instanceof Uint8Array) || !Number.isInteger(input.headSeq)) throw new StoreError("invalid", "moving a file needs its snapshot and head seq");
        const meta = this.host.getMeta(String(fileKey));
        if (!meta) throw new StoreError("not-found", "No such file");
        if (meta.space) throw new StoreError("invalid", "This file is in an organization already");
        const id = String(projectId);
        const teamId = await this.teamOfProject(id);
        const orgId = await this.orgOfTeam(teamId);
        const linked = await this.mp.roomKey(meta.fileKey);
        let key: string;
        let answer: unknown;
        if (linked) {
          // Shared outside any org already (§3): the room moves, the server decides whether it may.
          key = linked;
          answer = await this.call("POST", `/files/${seg(key, "file")}/move`, { projectId: id });
        } else {
          key = this.mp.newRoomKey(meta.fileKey);
          try {
            answer = await this.mp.shareTo(meta.fileKey, input, (k, name) => this.call("POST", "/files", { key: k, name, orgId, projectId: id }), key);
          } catch (e) {
            // In the folder on the server already, its content still uploading: the copy says where it lives now
            if (pendingUpload(e)) {
              await this.host.setFileSpace(meta.fileKey, { orgId, key, teamId, projectId: id });
              this.drop(orgId, (c) => delete c.files[id]);
              this.emit({ type: "files.changed", orgId, projectId: id });
            }
            throw e;
          }
        }
        await this.host.setFileSpace(meta.fileKey, { orgId, key, teamId, projectId: id });
        this.drop(orgId, (c) => delete c.files[id]);
        this.emit({ type: "files.changed", orgId, projectId: id });
        // `POST /files` may answer the file itself ({file}) or only its key (as outside orgs): then the folder says.
        let file = answer && typeof answer === "object" && "file" in answer ? (answer as { file: O.OrgFile }).file : undefined;
        if (!file || file.key !== key) {
          const files = pick<O.OrgFile[]>(await this.call("GET", `${projectPath(id)}/files`), "files");
          file = files.find((f) => f.key === key);
        }
        if (!file) throw new StoreError("not-found", "The moved file isn't in the folder");
        return { ...file, fileKey: meta.fileKey };
      },
      trashFiles: async (keys) => {
        const list = Array.isArray(keys) ? keys.map(String) : [];
        for (const key of list) await this.call("POST", `/files/${seg(key, "file")}/trash`);
        await filesChanged(list);
      },
      restoreFiles: async (keys) => {
        const list = Array.isArray(keys) ? keys.map(String) : [];
        for (const key of list) await this.call("POST", `/files/${seg(key, "file")}/restore`);
        await filesChanged(list, undefined, { refetch: true });
        // A restored file's list wasn't cached while it was trashed: its team's lists go too.
        for (const c of this.caches.values()) this.drop(c.orgId, (x) => (x.files = {}));
      },
      trashed: async (teamId) => {
        const r = await this.call<{ projects: O.ProjectSummary[]; files: O.OrgFile[] }>("GET", `/teams/${seg(teamId, "team")}/trash`);
        return { projects: r.projects ?? [], files: await this.withCopies(r.files ?? []) };
      },
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // admin (no cache: the Admin location wants the server's state)
  // -------------------------------------------------------------------------------------------------------------------

  private adminRepository(): AdminRepository {
    const base = (orgId: unknown) => `/orgs/${seg(orgId, "org")}/admin`;
    const peopleQuery = (q: O.PeopleQuery | undefined) => ({
      text: q?.text,
      role: q?.role,
      seat: q?.seat,
      workspace: q?.workspaceId,
      billingGroup: q?.billingGroupId,
      activeBefore: q?.activeBefore,
      cursor: q?.cursor,
      limit: q?.limit,
    });
    const teamsQuery = (q: O.TeamsQuery | undefined) => ({ text: q?.text, workspace: q?.workspaceId, includeHidden: q?.includeHidden === true, includeDeleted: q?.includeDeleted === true, cursor: q?.cursor, limit: q?.limit });
    const activityQuery = (q: O.ActivityQuery | undefined) => ({
      events: Array.isArray(q?.events) ? q!.events : undefined,
      email: q?.email,
      team: q?.teamId,
      start_time: q?.startTime,
      end_time: q?.endTime,
      order: q?.order,
      cursor: q?.cursor,
      limit: q?.limit,
    });
    /** People, seats or roles changed: the person's own org list and the org's people may differ now */
    const peopleChanged = (orgId: string) => {
      this.drop(orgId, (c) => {
        c.people = null;
        c.info = null;
      });
      this.emit({ type: "org.updated", orgId });
    };
    const workspaces = async (orgId: string) => {
      const list = pick<O.OrgWorkspace[]>(await this.call("GET", `${base(orgId)}/workspaces`), "workspaces");
      for (const w of list) this.workspaceOrg.set(w.id, orgId);
      return list;
    };
    const billingGroups = async (orgId: string) => {
      const list = pick<O.BillingGroup[]>(await this.call("GET", `${base(orgId)}/billing-groups`), "billingGroups", "groups");
      for (const g of list) this.billingOrg.set(g.id, orgId);
      return list;
    };
    return {
      dashboard: (orgId) => this.call<O.AdminDashboard>("GET", `${base(orgId)}/dashboard`),
      people: (orgId, q) => this.call<O.Page<O.AdminPerson>>("GET", `${base(orgId)}/people${query(peopleQuery(q))}`),
      addPeople: async (orgId, input) => {
        const r = pick<O.AdminPerson[]>(await this.call("POST", `${base(orgId)}/people`, input), "people");
        peopleChanged(String(orgId));
        return r;
      },
      updatePeople: async (orgId, input) => {
        const r = pick<O.AdminPerson[]>(await this.call("PATCH", `${base(orgId)}/people`, input), "people");
        peopleChanged(String(orgId));
        if (this.mp.userId && input?.userIds?.includes(this.mp.userId)) this.emit({ type: "orgs.changed" });
        return r;
      },
      removePeople: async (orgId, userIds) => {
        await this.call("POST", `${base(orgId)}/people/remove`, { userIds: Array.isArray(userIds) ? userIds.map(String) : [] });
        peopleChanged(String(orgId));
      },
      seatRequests: async (orgId, state) => pick<O.SeatRequest[]>(await this.call("GET", `${base(orgId)}/seat-requests${query({ state: state === "all" ? "all" : "pending" })}`), "requests"),
      answerSeatRequest: async (orgId, id, approve) => {
        const r = pick<O.SeatRequest>(await this.call("POST", `${base(orgId)}/seat-requests/${seg(id, "request")}`, { approve: approve === true }), "request");
        peopleChanged(String(orgId));
        return r;
      },
      guestRequests: async (orgId) => pick<O.GuestRequest[]>(await this.call("GET", `${base(orgId)}/guest-requests`), "requests"),
      answerGuestRequest: async (orgId, id, approve) => pick<O.GuestRequest>(await this.call("POST", `${base(orgId)}/guest-requests/${seg(id, "request")}`, { approve: approve === true }), "request"),
      teams: (orgId, q) => this.call<O.Page<O.AdminTeam>>("GET", `${base(orgId)}/teams${query(teamsQuery(q))}`),
      workspaces: (orgId) => workspaces(String(orgId)),
      createWorkspace: async (orgId, input) => {
        const w = pick<O.OrgWorkspace>(await this.call("POST", `${base(orgId)}/workspaces`, input), "workspace");
        this.workspaceOrg.set(w.id, String(orgId));
        return w;
      },
      updateWorkspace: async (workspaceId, patch) => {
        const orgId = await this.orgOfAdminThing(String(workspaceId), this.workspaceOrg, workspaces);
        const w = pick<O.OrgWorkspace>(await this.call("PATCH", `${base(orgId)}/workspaces/${seg(workspaceId, "workspace")}`, patch ?? {}), "workspace");
        this.drop(orgId, (c) => (c.teams = {}));
        this.emit({ type: "teams.changed", orgId });
        return w;
      },
      deleteWorkspace: async (workspaceId) => {
        const orgId = await this.orgOfAdminThing(String(workspaceId), this.workspaceOrg, workspaces);
        await this.call("DELETE", `${base(orgId)}/workspaces/${seg(workspaceId, "workspace")}`);
        this.workspaceOrg.delete(String(workspaceId));
        this.drop(orgId, (c) => (c.teams = {}));
        this.emit({ type: "teams.changed", orgId });
      },
      billingGroups: (orgId) => billingGroups(String(orgId)),
      createBillingGroup: async (orgId, input) => {
        const g = pick<O.BillingGroup>(await this.call("POST", `${base(orgId)}/billing-groups`, input), "billingGroup", "group");
        this.billingOrg.set(g.id, String(orgId));
        return g;
      },
      updateBillingGroup: async (id, patch) => {
        const orgId = await this.orgOfAdminThing(String(id), this.billingOrg, billingGroups);
        return pick<O.BillingGroup>(await this.call("PATCH", `${base(orgId)}/billing-groups/${seg(id, "billing group")}`, patch ?? {}), "billingGroup", "group");
      },
      deleteBillingGroup: async (id) => {
        const orgId = await this.orgOfAdminThing(String(id), this.billingOrg, billingGroups);
        await this.call("DELETE", `${base(orgId)}/billing-groups/${seg(id, "billing group")}`);
        this.billingOrg.delete(String(id));
      },
      activity: (orgId, q) => this.call<O.ActivityPage>("GET", `${base(orgId)}/activity${query(activityQuery(q))}`),
      settings: (orgId) => this.call<O.OrgSettings>("GET", `${base(orgId)}/settings`).then((s) => pick<O.OrgSettings>(s, "settings")),
      updateSettings: async (orgId, patch) => {
        const s = pick<O.OrgSettings>(await this.call("PATCH", `${base(orgId)}/settings`, patch ?? {}), "settings");
        this.drop(String(orgId), (c) => (c.info = null));
        this.emit({ type: "org.updated", orgId: String(orgId) });
        return s;
      },
      unassignedDrafts: async (orgId) => pick<O.UnassignedDrafts[]>(await this.call("GET", `${base(orgId)}/drafts`), "owners"),
      moveUnassigned: async (orgId, input) => {
        await this.call("POST", `${base(orgId)}/drafts/move`, input);
        this.drop(String(orgId), (c) => {
          c.files = {};
          c.projects = {};
        });
        this.emit({ type: "teams.changed", orgId: String(orgId) });
      },
      deleteUnassigned: async (orgId, fileKeys) => {
        await this.call("POST", `${base(orgId)}/drafts/delete`, { fileKeys: Array.isArray(fileKeys) ? fileKeys.map(String) : [] });
      },
      exportCsv: async (orgId, what, q) => {
        this.requireSession();
        const path =
          what === "people"
            ? `${base(orgId)}/people${query({ ...peopleQuery(q as O.PeopleQuery), format: "csv" })}`
            : what === "teams"
              ? `${base(orgId)}/teams${query({ ...teamsQuery(q as O.TeamsQuery), format: "csv" })}`
              : what === "activity"
                ? `${base(orgId)}/activity${query({ ...activityQuery(q as O.ActivityQuery), format: "csv" })}`
                : null;
        if (!path) throw new StoreError("invalid", `can't export ${String(what)}`);
        return this.mp.callText("GET", path);
      },
      // Plan access tokens (docs/multiplayer.md §16.3; server/src/rest/planTokens.ts)
      planTokens: async (orgId) => pick<AccessTokenInfo[]>(await this.call("GET", `${base(orgId)}/plan-tokens`), "tokens"),
      createPlanToken: async (orgId, input) => {
        const i = (input ?? {}) as { description?: unknown; expiresInDays?: unknown; scopes?: unknown };
        const body = { description: typeof i.description === "string" ? i.description : "", expiresInDays: Number(i.expiresInDays), scopes: Array.isArray(i.scopes) ? i.scopes.map(String) : [] };
        return this.call<{ token: string; info: AccessTokenInfo }>("POST", `${base(orgId)}/plan-tokens`, body);
      },
      revokePlanToken: async (orgId, tokenId) => {
        await this.call("DELETE", `${base(orgId)}/plan-tokens/${seg(tokenId, "token")}`);
      },
    };
  }
}

function emptyCache(orgId: string, uid: string | null, now: number): OrgCache {
  return { v: 1, uid, orgId, savedAt: now, summary: null, info: null, teams: {}, team: {}, projects: {}, project: {}, files: {}, people: null, groups: null, teamMembers: {}, requests: {}, projectMembers: {} };
}
