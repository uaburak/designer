/**
 * The store's org spaces (docs/multiplayer.md §14.6): the `orgs`, `teams`, `projects` and `admin` repositories over the
 * server's routes (§14.12), a cache per org for offline reads, and org files as linked room copies.
 *
 * - **Cache.** One JSON per org (`Workspace/spaces/<orgId>.json` on the desktop, `designer.devStore.v1.space.<orgId>` in
 *   the browser), holding the last lists of teams, folders, files, drafts, people and groups — keyed by the signed-in
 *   person, so another account never sees them. A read answers from it at once and refreshes behind (an event when the
 *   answer changed); with nothing cached it waits for the server. Offline, the cache answers (`cache.stale`,
 *   offline: true) and writes fail with `offline`.
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
import type { Unsubscribe } from "../../shared/store/repositories";
import type { FileKey, FileMeta, FileSpace } from "../../shared/store/types";
import type { MultiplayerService } from "../multiplayer/service";
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
}

const DRAFTS = "@drafts";
/** A read refreshed this recently answers from the cache without asking again */
const FRESH_MS = 2000;

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const seg = (s: unknown, what: string): string => {
  if (typeof s !== "string" || !s || s.length > 256) throw new StoreError("invalid", `bad ${what}`);
  return encodeURIComponent(s);
};
const isOffline = (e: unknown) => e instanceof StoreError && e.code === "offline";
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
  private freshAt = new Map<string, number>();
  private saving = new Map<string, Promise<void>>();
  private offs: Unsubscribe[] = [];

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
      await Promise.all([...this.inflight.values()]).catch(() => {});
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
    const v = await spec.fetch();
    this.store(spec, v);
    return clone(v);
  }

  private store<T>(spec: { key: string; orgId: string | null; set: (c: OrgCache, v: T) => void; place?: (v: T) => string | null | void }, v: T): boolean {
    const placed = spec.place?.(v) ?? null;
    const orgId = spec.orgId ?? placed;
    this.freshAt.set(spec.key, this.host.now());
    if (!orgId) return false;
    const c = this.cacheOf(orgId);
    const before = JSON.stringify(c);
    spec.set(c, clone(v));
    if (JSON.stringify(c) === before) return false;
    void this.save(orgId);
    return true;
  }

  /** Asks the server again; an event when the answer changed, `cache.stale` when the server can't be reached */
  private refresh<T>(spec: { key: string; orgId: string | null; get: (c: OrgCache) => T | undefined; set: (c: OrgCache, v: T) => void; fetch: () => Promise<T>; event: OrgEvent | null; place?: (v: T) => string | null | void }): Promise<void> {
    const running = this.inflight.get(spec.key);
    if (running) return running;
    const p = (async () => {
      try {
        const v = await spec.fetch();
        if (this.store(spec, v) && spec.event) this.emit(spec.event);
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
        } else this.host.log("warn", `org: refreshing ${spec.key} failed`, e);
      } finally {
        this.inflight.delete(spec.key);
      }
    })();
    this.inflight.set(spec.key, p);
    return p;
  }

  /** A change made here or told by the Inbox: the cached entries dropped (the next read asks the server) */
  private drop(orgId: string | null | undefined, change: (c: OrgCache) => void): void {
    if (!orgId) return;
    const c = this.caches.get(orgId);
    if (!c) return;
    change(c);
    for (const k of [...this.freshAt.keys()]) if (k.startsWith(`${orgId}|`)) this.freshAt.delete(k);
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
        this.drop(org, (x) => {
          delete x.team[teamId];
          x.teams = {};
        });
        this.emit({ type: "team.updated", teamId });
        if (org) this.emit({ type: "teams.changed", orgId: org });
        return;
      }
      case "projects": {
        const teamId = typeof n.teamId === "string" ? n.teamId : null;
        if (!teamId) return;
        const parentId = typeof n.parentId === "string" ? n.parentId : null;
        const org = orgId ?? this.teamOrg.get(teamId) ?? null;
        this.drop(org, (x) => {
          for (const k of Object.keys(x.projects)) if (k.startsWith(`${teamId}/`)) delete x.projects[k];
          for (const [id, p] of Object.entries(x.project)) if (p.teamId === teamId) delete x.project[id];
        });
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
        if (v) c.summary = { id: v.id, name: v.name, role: v.role, seat: v.seat, workspaceId: v.workspaceId };
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
        c.summary = { id: org.id, name: org.name, role: org.role, seat: org.seat, workspaceId: org.workspaceId };
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
      watch: (listener) => this.onEvent(listener),
    };
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
    const changed = async (teamId: string, orgId?: string | null) => {
      const org = orgId ?? this.teamOrg.get(teamId) ?? null;
      this.drop(org, (c) => {
        delete c.team[teamId];
        c.teams = {};
      });
      this.emit({ type: "team.updated", teamId });
      if (org) this.emit({ type: "teams.changed", orgId: org });
    };
    const members = (body: unknown) => pick<O.TeamMember[]>(body, "members");
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
        });
      },
      create: async (orgId, input) => {
        const id = String(orgId);
        const team = pick<O.TeamInfo>(await this.call("POST", `/orgs/${seg(id, "org")}/teams`, { name: cleanName(input?.name, null, "team"), ...(input?.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}) }), "team");
        this.teamOrg.set(team.id, id);
        await changed(team.id, id);
        return team;
      },
      update: async (teamId, patch) => {
        const team = pick<O.TeamInfo>(await this.call("PATCH", teamPath(teamId), patch ?? {}), "team");
        await changed(String(teamId));
        return team;
      },
      remove: async (teamId) => {
        await this.call("DELETE", teamPath(teamId));
        await changed(String(teamId));
      },
      restore: async (teamId) => {
        const team = pick<O.TeamInfo>(await this.call("POST", `${teamPath(teamId)}/restore`), "team");
        await changed(String(teamId));
        return team;
      },
      transfer: async (teamId, userId) => {
        const team = pick<O.TeamInfo>(await this.call("POST", `${teamPath(teamId)}/transfer`, { userId: String(userId) }), "team");
        await changed(String(teamId));
        return team;
      },
      members: async (teamId) => members(await this.call("GET", `${teamPath(teamId)}/members`)),
      invite: async (teamId, input) => {
        if (input?.role !== "editor" && input?.role !== "viewer") throw new StoreError("invalid", "bad role");
        const r = await members(await this.call("PUT", `${teamPath(teamId)}/members`, { ...(input.email ? { email: String(input.email) } : { groupId: String(input.groupId ?? "") }), role: input.role, ...(input.admin === true ? { admin: true } : {}) }));
        await changed(String(teamId));
        return r;
      },
      setMember: async (teamId, principal, patch) => {
        const r = await members(await this.call("PATCH", `${teamPath(teamId)}/members/${seg(principal, "member")}`, { ...(patch?.role ? { role: patch.role } : {}), ...(typeof patch?.admin === "boolean" ? { admin: patch.admin } : {}) }));
        await changed(String(teamId));
        return r;
      },
      removeMember: async (teamId, principal) => {
        const r = await members(await this.call("DELETE", `${teamPath(teamId)}/members/${seg(principal, "member")}`));
        await changed(String(teamId));
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
        await changed(String(teamId));
      },
      requests: async (teamId) => pick<O.JoinRequest[]>(await this.call("GET", `${teamPath(teamId)}/requests`), "requests"),
      answerRequest: async (teamId, userId, approve) => {
        const r = pick<O.JoinRequest[]>(await this.call("POST", `${teamPath(teamId)}/requests/${seg(userId, "person")}`, { approve: approve === true }), "requests");
        if (approve === true) await changed(String(teamId));
        return r;
      },
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // projects (folders) and their files
  // -------------------------------------------------------------------------------------------------------------------

  private projectsRepository(): ProjectsRepository {
    const projectPath = (id: unknown) => `/projects/${seg(id, "folder")}`;
    /** A team's folders changed: every level of it dropped */
    const foldersChanged = async (teamId: string, parentId: string | null, projectId?: string) => {
      const org = this.teamOrg.get(teamId) ?? null;
      this.drop(org, (c) => {
        for (const k of Object.keys(c.projects)) if (k.startsWith(`${teamId}/`)) delete c.projects[k];
        if (projectId) delete c.project[projectId];
        delete c.team[teamId];
        c.teams = {};
      });
      this.emit({ type: "projects.changed", teamId, parentId });
    };
    /** Files moved, trashed or restored: the lists holding them (and the destination) dropped */
    const filesChanged = async (keys: string[], to?: string | null) => {
      const touched = new Map<string, Set<string | null>>();
      const add = (orgId: string, projectId: string | null) => {
        let s = touched.get(orgId);
        if (!s) touched.set(orgId, (s = new Set()));
        s.add(projectId);
      };
      for (const c of this.caches.values())
        for (const [k, list] of Object.entries(c.files))
          if (list.some((f) => keys.includes(f.key))) {
            add(c.orgId, k === DRAFTS ? null : k);
            if (to !== undefined) add(c.orgId, to);
          }
      if (to) {
        const team = this.projectTeam.get(to);
        const org = team ? this.teamOrg.get(team) : undefined;
        if (org) add(org, to);
      }
      for (const [orgId, projects] of touched) {
        this.drop(orgId, (c) => {
          for (const p of projects) delete c.files[p ?? DRAFTS];
          // folder counts move too
          c.projects = {};
          c.project = {};
        });
        for (const projectId of projects) this.emit({ type: "files.changed", orgId, projectId });
      }
    };
    const members = (body: unknown) => pick<O.ProjectMember[]>(body, "members");
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
        await foldersChanged(t, p.parentId, p.id);
        return p;
      },
      update: async (projectId, patch) => {
        const p = project(await this.call("PATCH", projectPath(projectId), { ...(patch?.name !== undefined ? { name: cleanName(patch.name, null, "folder") } : {}), ...(patch?.access === "inherited" || patch?.access === "limited" ? { access: patch.access } : {}) }));
        await foldersChanged(p.teamId, p.parentId, p.id);
        return p;
      },
      move: async (projectId, to) => {
        const from = await this.teamOfProject(String(projectId)).catch(() => null);
        const p = project(await this.call("POST", `${projectPath(projectId)}/move`, { teamId: String(to?.teamId ?? ""), parentId: typeof to?.parentId === "string" ? to.parentId : null }));
        if (from && from !== p.teamId) await foldersChanged(from, null, p.id);
        await foldersChanged(p.teamId, p.parentId, p.id);
        return p;
      },
      trash: async (projectId) => {
        const id = String(projectId);
        const team = await this.teamOfProject(id).catch(() => null);
        await this.call("POST", `${projectPath(id)}/trash`);
        if (team) await foldersChanged(team, null, id);
      },
      restore: async (projectId) => {
        const p = project(await this.call("POST", `${projectPath(projectId)}/restore`));
        await foldersChanged(p.teamId, p.parentId, p.id);
        return p;
      },
      deleteForever: async (projectId) => {
        const id = String(projectId);
        const team = this.projectTeam.get(id) ?? null;
        await this.call("DELETE", projectPath(id));
        if (team) await foldersChanged(team, null, id);
      },
      members: async (projectId) => members(await this.call("GET", `${projectPath(projectId)}/members`)),
      invite: async (projectId, input) => {
        if (input?.role !== "editor" && input?.role !== "viewer") throw new StoreError("invalid", "bad role");
        return members(await this.call("PUT", `${projectPath(projectId)}/members`, { ...(input.email ? { email: String(input.email) } : { groupId: String(input.groupId ?? "") }), role: input.role }));
      },
      setMember: async (projectId, principal, role) => {
        if (role !== "editor" && role !== "viewer") throw new StoreError("invalid", "bad role");
        return members(await this.call("PATCH", `${projectPath(projectId)}/members/${seg(principal, "member")}`, { role }));
      },
      removeMember: async (projectId, principal) => members(await this.call("DELETE", `${projectPath(projectId)}/members/${seg(principal, "member")}`)),
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
        await filesChanged([], id);
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
          answer = await this.mp.shareTo(meta.fileKey, input, (k, name) => this.call("POST", "/files", { key: k, name, orgId, projectId: id }), key);
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
        await filesChanged(list);
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
  return { v: 1, uid, orgId, savedAt: now, summary: null, info: null, teams: {}, team: {}, projects: {}, project: {}, files: {}, people: null, groups: null };
}
