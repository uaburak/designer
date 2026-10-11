/**
 * A contract fake of round 3a's library routes (docs/data.md §16.10, §17.5–§17.6) and the two the store's session
 * needs (`POST /devices`): one in-memory `Request → Response` handler, as `server/src/api.ts handle` is, so the store's
 * tests can swap in the real handler once 3a merges (as src/store/org/fake/real.ts does for the org routes). Shapes
 * follow §16.12 exactly; the rules are a small subset of §16.4–§16.6 (file access, team members, org scope, drafts
 * can't publish, a stale `baseVersion` is 409, missing payloads / blobs refused, default and approval resolution for
 * the org and team rows). Not a model of `resolveAccess`.
 */
import { diffAgainst, libraryCounts, withDependencies } from "../../../shared/store/libraryRules";
import type { LibraryAsset, LibraryVersion } from "../../../shared/store/types";
import type {
  FileLibraries,
  FileUsageSnapshot,
  LibraryEditorType,
  LibraryMissing,
  LibraryScope,
  LibraryScopeSetting,
  LibrarySettingsInput,
  OrgLibraryInfo,
  OrgLibraryRecord,
  OrgLibrarySummary,
  OrgPublishInput,
  WireUsageEvent,
} from "../../../shared/libraries/orgTypes";
import { writePayloadFrames } from "../org";

interface FakeFile {
  key: string;
  name: string;
  orgId: string;
  teamId: string | null;
  workspaceId: string | null;
  /** null: a draft */
  projectId: string | null;
  editors: Set<string>;
  viewers: Set<string>;
  orgLinkAccess: "none" | "viewer" | "editor";
}

interface FakeLibrary {
  key: string;
  status: OrgLibraryRecord["status"];
  scope: LibraryScope;
  versions: LibraryVersion[];
  firstPublishedAt: number;
  lastPublishedAt: number;
  publishedBy: string | null;
  payloads: Map<string, Uint8Array>;
  blobs: Map<string, Uint8Array>;
  /** `${type}:${id}` → the row */
  settings: Map<string, { approved: boolean; defaults: Partial<Record<LibraryEditorType, boolean | null>>; defaultModes: { collectionKey: string; modeId: string }[] }>;
  collections: OrgPublishInput["collections"];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Bytes as a Response body */
const asBody = (b: Uint8Array) => b as unknown as ConstructorParameters<typeof Response>[0];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class FakeLibraryServer {
  readonly users = new Map<string, { id: string; email: string }>();
  readonly orgMembers = new Map<string, Set<string>>();
  readonly teamMembers = new Map<string, Set<string>>();
  readonly files = new Map<string, FakeFile>();
  readonly libraries = new Map<string, FakeLibrary>();
  /** fileKey → libraryKey → on/off */
  readonly subscriptions = new Map<string, Map<string, boolean>>();
  readonly events: WireUsageEvent[] = [];
  readonly usage = new Map<string, FileUsageSnapshot>();
  /** "METHOD /path" of every request */
  readonly log: string[] = [];
  /** Off: every request fails as a network error would */
  online = true;
  /** Answer `POST /analytics/library-events` with this status (tests of the queue) */
  eventsStatus = 200;
  /** Called before each request is answered (a test's "meanwhile") */
  onRequest: ((method: string, path: string) => void) | null = null;
  private n = 0;
  clock = Date.UTC(2026, 9, 11, 12);

  addUser(email: string): { user: { id: string; email: string }; token: string } {
    const user = { id: `u${++this.n}`, email };
    this.users.set(user.id, user);
    return { user, token: `v1.${b64url(JSON.stringify({ uid: user.id, tv: 0 }))}.fake` };
  }

  addOrg(orgId: string, members: string[]): void {
    this.orgMembers.set(orgId, new Set(members));
  }

  addTeam(teamId: string, members: string[]): void {
    this.teamMembers.set(teamId, new Set(members));
  }

  addFile(key: string, f: Partial<Omit<FakeFile, "key" | "editors" | "viewers">> & { orgId: string; editors?: string[]; viewers?: string[] }): FakeFile {
    const file: FakeFile = {
      key,
      name: f.name ?? key,
      orgId: f.orgId,
      teamId: f.teamId ?? null,
      workspaceId: f.workspaceId ?? null,
      projectId: f.projectId === undefined ? "p1" : f.projectId,
      editors: new Set(f.editors ?? []),
      viewers: new Set(f.viewers ?? []),
      orgLinkAccess: f.orgLinkAccess ?? "none",
    };
    this.files.set(key, file);
    return file;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (!this.online) throw new TypeError("fetch failed");
    const req = new Request(String(input), init);
    this.log.push(`${req.method} ${new URL(req.url).pathname}`);
    this.onRequest?.(req.method, new URL(req.url).pathname);
    try {
      return await this.handle(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      throw e;
    }
  };

  // ---- access (§16.4, simplified) ----

  private uidOf(req: Request): string {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    try {
      const uid = (JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { uid: string }).uid;
      if (this.users.has(uid)) return uid;
    } catch {
      // fall through
    }
    throw new HttpError(401, "unauthorized", "Log in");
  }

  private canView(uid: string, f: FakeFile): boolean {
    return f.editors.has(uid) || f.viewers.has(uid) || (!!f.teamId && !!this.teamMembers.get(f.teamId)?.has(uid)) || (f.orgLinkAccess !== "none" && !!this.orgMembers.get(f.orgId)?.has(uid));
  }

  private canEdit(uid: string, f: FakeFile): boolean {
    return f.editors.has(uid);
  }

  private via(uid: string, lib: FakeLibrary): ("file" | "team" | "org")[] {
    const f = this.files.get(lib.key)!;
    const out: ("file" | "team" | "org")[] = [];
    if (f.editors.has(uid) || f.viewers.has(uid)) out.push("file");
    if (f.teamId && this.teamMembers.get(f.teamId)?.has(uid)) out.push("team");
    if (lib.scope === "org" && this.orgMembers.get(f.orgId)?.has(uid)) out.push("org");
    return out;
  }

  private file(key: string): FakeFile {
    const f = this.files.get(key);
    if (!f) throw new HttpError(404, "not_found", "No such file");
    return f;
  }

  private usable(uid: string, key: string): FakeLibrary {
    const lib = this.libraries.get(key);
    if (!lib || lib.status !== "published" || !this.via(uid, lib).length) throw new HttpError(404, "not_found", "No such library");
    return lib;
  }

  // ---- §16.5's resolution (org and team rows; workspace rows as the org's) ----

  private defaultOn(lib: FakeLibrary, f: FakeFile | null): boolean {
    const row = (type: string, id: string | null) => (id ? lib.settings.get(`${type}:${id}`)?.defaults.design : undefined);
    for (const v of [row("team", f?.teamId ?? null), row("workspace", f?.workspaceId ?? null), row("org", this.files.get(lib.key)!.orgId)]) if (v === true || v === false) return v;
    return false;
  }

  private approved(lib: FakeLibrary, f: FakeFile | null): "org" | "workspace" | null {
    const orgId = this.files.get(lib.key)!.orgId;
    if (lib.settings.get(`org:${orgId}`)?.approved) return "org";
    if (f?.workspaceId && lib.settings.get(`workspace:${f.workspaceId}`)?.approved) return "workspace";
    return null;
  }

  record(uid: string, lib: FakeLibrary, relativeTo: FakeFile | null): OrgLibraryRecord {
    const f = this.files.get(lib.key)!;
    const latest = lib.versions.at(-1);
    const teamRow = relativeTo?.teamId ? lib.settings.get(`team:${relativeTo.teamId}`) : undefined;
    return {
      libraryFileKey: lib.key,
      status: lib.status,
      latestVersion: latest?.version ?? 0,
      firstPublishedAt: lib.firstPublishedAt,
      lastPublishedAt: lib.lastPublishedAt,
      counts: libraryCounts(latest?.assets ?? []),
      movedIn: [],
      _clk: {},
      org: {
        orgId: f.orgId,
        teamId: f.teamId,
        teamName: f.teamId,
        workspaceId: f.workspaceId,
        scope: lib.scope,
        name: f.name,
        thumbnailUrl: null,
        publishedBy: lib.publishedBy ? { id: lib.publishedBy, name: null, email: this.users.get(lib.publishedBy)?.email ?? "", picture: null, role: "member" } : null,
        approved: this.approved(lib, relativeTo),
        enabledByDefault: this.defaultOn(lib, relativeTo),
        defaultModes: teamRow?.defaultModes ?? [],
        via: this.via(uid, lib),
      },
    };
  }

  private fileLibraries(uid: string, f: FakeFile): FileLibraries {
    const subs = this.subscriptions.get(f.key) ?? new Map<string, boolean>();
    const usable = [...this.libraries.values()].filter((l) => l.status === "published" && l.key !== f.key && this.files.get(l.key)!.orgId === f.orgId && this.via(uid, l).length);
    const defaults = usable.filter((l) => this.defaultOn(l, f)).map((l) => l.key);
    const enabled = usable.filter((l) => subs.get(l.key) ?? this.defaultOn(l, f)).map((l) => l.key);
    return { enabled, defaults, overrides: [...subs].map(([libraryKey, on]) => ({ libraryKey, enabled: on })) };
  }

  private summary(lib: FakeLibrary): OrgLibrarySummary {
    const f = this.files.get(lib.key)!;
    const latest = lib.versions.at(-1);
    const rows = [...lib.settings.entries()];
    return {
      key: lib.key,
      name: f.name,
      orgId: f.orgId,
      teamId: f.teamId,
      teamName: f.teamId,
      workspaceId: f.workspaceId,
      scope: lib.scope,
      status: lib.status,
      latestVersion: latest?.version ?? 0,
      lastPublishedAt: lib.lastPublishedAt,
      counts: libraryCounts(latest?.assets ?? []),
      thumbnailUrl: null,
      approved: { org: !!lib.settings.get(`org:${f.orgId}`)?.approved, workspaceIds: rows.filter(([k, r]) => k.startsWith("workspace:") && r.approved).map(([k]) => k.slice(10)) },
      defaultIn: {
        org: (Object.entries(lib.settings.get(`org:${f.orgId}`)?.defaults ?? {}) as [LibraryEditorType, boolean | null][]).filter(([, v]) => v === true).map(([t]) => t),
        workspaceIds: rows.filter(([k, r]) => k.startsWith("workspace:") && Object.values(r.defaults).includes(true)).map(([k]) => k.slice(10)),
        teamIds: rows.filter(([k, r]) => k.startsWith("team:") && Object.values(r.defaults).includes(true)).map(([k]) => k.slice(5)),
      },
      insertsLastWeek: 0,
    };
  }

  private info(lib: FakeLibrary): OrgLibraryInfo {
    const settings: LibraryScopeSetting[] = [...lib.settings.entries()].map(([k, r]) => {
      const [type, id] = k.split(":") as ["org" | "workspace" | "team", string];
      return { scope: { type, id }, scopeName: id, approved: r.approved, defaults: { design: null, figjam: null, slides: null, buzz: null, ...r.defaults }, defaultModes: r.defaultModes, updatedAt: this.clock, updatedBy: null };
    });
    return { ...this.summary(lib), collections: lib.collections, settings, canManage: { org: true, workspaceIds: [], teamIds: [] } };
  }

  // ---- the routes ----

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname.split("/").filter(Boolean);
    const m = req.method;
    if (m === "POST" && url.pathname === "/devices") return json({ ordinal: 2 });
    const uid = this.uidOf(req);
    const body = async <T>() => (await req.json()) as T;

    if (p[0] === "analytics" && p[1] === "library-events" && m === "POST") {
      if (this.eventsStatus !== 200) return json({ error: "no", code: "fake" }, this.eventsStatus);
      const { events } = await body<{ events: WireUsageEvent[] }>();
      let accepted = 0;
      for (const e of events) {
        const f = this.files.get(e.file);
        if (!f || !this.canEdit(uid, f) || !f.projectId) continue;
        this.events.push(e);
        accepted++;
      }
      return json({ accepted, dropped: events.length - accepted });
    }

    if (p[0] === "files" && p[1]) {
      const f = this.file(decodeURIComponent(p[1]));
      if (p[2] === "libraries" && !p[3] && m === "GET") {
        if (!this.canView(uid, f)) throw new HttpError(404, "not_found", "No such file");
        return json(this.fileLibraries(uid, f));
      }
      if (p[2] === "libraries" && p[3] && m === "PUT") {
        if (!this.canEdit(uid, f)) throw new HttpError(403, "forbidden", "Can't edit");
        const { enabled } = await body<{ enabled: boolean | null }>();
        const subs = this.subscriptions.get(f.key) ?? new Map<string, boolean>();
        if (enabled === null) subs.delete(p[3]);
        else subs.set(p[3], enabled);
        this.subscriptions.set(f.key, subs);
        return json(this.fileLibraries(uid, f));
      }
      if (p[2] === "library-usage" && m === "PUT") {
        if (!this.canEdit(uid, f)) throw new HttpError(403, "forbidden", "Can't edit");
        this.usage.set(f.key, await body<FileUsageSnapshot>());
        return new Response(null, { status: 204 });
      }
    }

    if (p[0] === "libraries" && !p[1] && m === "GET") {
      const f = this.file(url.searchParams.get("file") ?? "");
      if (!this.canView(uid, f)) throw new HttpError(404, "not_found", "No such file");
      const list = [...this.libraries.values()].filter((l) => l.status === "published" && l.key !== f.key && this.files.get(l.key)!.orgId === f.orgId && this.via(uid, l).length);
      return json({ libraries: list.map((l) => this.record(uid, l, f)) });
    }

    if (p[0] === "libraries" && p[1]) {
      const key = p[1];
      const lib = this.libraries.get(key);
      if (p[2] === "analytics") {
        this.usable(uid, key);
        if (p[3] === "overview") return json({ libraryKey: key, teamsUsing: 1, counts: { components: 0, styles: 0, variables: 0 }, thisWeek: { insertions: 0, detachments: 0 }, rows: [], throughDay: "2026-10-10" });
        if (p[3] === "modes") return json({ modes: [] });
        if (p[3] === "csv") return new Response("component_key,component_name\n", { headers: { "content-type": "text/csv" } });
        throw new HttpError(404, "not_found", "No route");
      }
      // Publishing: the file's editors
      if (p[2] === "missing" && m === "POST") {
        const f = this.file(key);
        if (!this.canEdit(uid, f)) throw new HttpError(403, "forbidden", "Can't edit");
        const ask = await body<LibraryMissing>();
        const l = lib ?? this.newLibrary(key);
        return json({ payloads: ask.payloads.filter((x) => !l.payloads.has(`${x.key}/${x.versionHash}`)), blobs: ask.blobs.filter((s) => !l.blobs.has(s)) });
      }
      if (p[2] === "payloads" && p[3] && m === "PUT") {
        if (!this.canEdit(uid, this.file(key))) throw new HttpError(403, "forbidden", "Can't edit");
        (lib ?? this.newLibrary(key)).payloads.set(`${p[3]}/${p[4]}`, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 204 });
      }
      if (p[2] === "blobs" && p[3] && m === "PUT") {
        if (!this.canEdit(uid, this.file(key))) throw new HttpError(403, "forbidden", "Can't edit");
        (lib ?? this.newLibrary(key)).blobs.set(p[3], new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 204 });
      }
      if (p[2] === "versions" && !p[3] && m === "POST") {
        const f = this.file(key);
        if (!this.canEdit(uid, f)) throw new HttpError(403, "forbidden", "Can't edit");
        if (!f.projectId) throw new HttpError(403, "draft_cannot_publish", "Move this file to a project to publish it");
        const input = await body<OrgPublishInput>();
        const l = lib ?? this.newLibrary(key);
        const latest = l.versions.at(-1)?.version ?? 0;
        if (input.baseVersion !== latest) throw new HttpError(409, "conflict", "Someone published meanwhile");
        for (const a of input.assets) {
          if (!l.payloads.has(`${a.key}/${a.versionHash}`)) throw new HttpError(400, "invalid", `missing payload ${a.key}`);
          if (a.thumbnail && !l.blobs.has(a.thumbnail.sha1)) throw new HttpError(400, "invalid", `missing blob ${a.thumbnail.sha1}`);
        }
        const now = (this.clock += 1000);
        const version: LibraryVersion = { libraryFileKey: key, version: latest + 1, publishedAt: now, description: input.description, changes: input.changes, assets: input.assets };
        l.versions.push(version);
        l.status = "published";
        l.lastPublishedAt = now;
        if (!l.firstPublishedAt) l.firstPublishedAt = now;
        l.publishedBy = uid;
        l.collections = input.collections;
        l.scope = input.scope;
        if (input.scope === "org" && f.orgLinkAccess === "none") f.orgLinkAccess = "viewer";
        return json({ version, library: this.record(uid, l, f) });
      }
      if (p[2] === "unpublish" && m === "POST") {
        if (!lib || !this.canEdit(uid, this.file(key))) throw new HttpError(404, "not_found", "No such library");
        lib.status = "unpublished";
        return new Response(null, { status: 204 });
      }
      if (!p[2] && m === "PATCH") {
        if (!lib || !this.canEdit(uid, this.file(key))) throw new HttpError(404, "not_found", "No such library");
        const { scope } = await body<{ scope: LibraryScope }>();
        lib.scope = scope;
        this.file(key).orgLinkAccess = scope === "org" ? "viewer" : "none";
        return json({ library: this.info(lib) });
      }
      // Consuming: anyone who can use it
      const l = this.usable(uid, key);
      if (!p[2] && m === "GET") return json({ library: this.record(uid, l, null) });
      if (p[2] === "versions" && p[3] && m === "GET") {
        const v = p[3] === "latest" ? l.versions.at(-1) : l.versions.find((x) => x.version === Number(p[3]));
        if (!v) throw new HttpError(404, "not_found", "No such version");
        return json(v);
      }
      if (p[2] === "diff" && m === "POST") {
        const { have } = await body<{ have: { key: string; versionHash: string }[] }>();
        const latest = l.versions.at(-1) ?? null;
        return json(diffAgainst(latest, latest?.version ?? 0, have, []));
      }
      if (p[2] === "payloads" && m === "POST") {
        const { wants, withDependencies: deps } = await body<{ wants: { key: string; versionHash: string }[]; withDependencies: boolean }>();
        const entry = (k: string, h: string): { asset: LibraryAsset; manifest: LibraryVersion } | null => {
          for (const v of [...l.versions].reverse()) {
            const a = v.assets.find((x) => x.key === k && x.versionHash === h);
            if (a) return { asset: a, manifest: v };
          }
          return null;
        };
        const all = deps ? withDependencies(entry, wants) : wants;
        return new Response(asBody(writePayloadFrames(all.filter((w) => l.payloads.has(`${w.key}/${w.versionHash}`)).map((w) => ({ ...w, bytes: l.payloads.get(`${w.key}/${w.versionHash}`)! })))), { headers: { "content-type": "application/octet-stream" } });
      }
      if (p[2] === "blobs" && p[3] && m === "GET") {
        const b = l.blobs.get(p[3]);
        if (!b) throw new HttpError(404, "not_found", "No such blob");
        return new Response(asBody(b), { headers: { "content-type": "application/octet-stream" } });
      }
    }

    if (p[0] === "orgs" && p[1] && p[2] === "libraries") {
      const orgId = p[1];
      if (!this.orgMembers.get(orgId)?.has(uid)) throw new HttpError(404, "not_found", "No such org");
      if (p[3] === "analytics") return json({ totals: { teams: 0, teamsWithLibraries: 0, libraries: 0, components: 0, styles: 0, variables: 0 }, libraries: [], throughDay: "2026-10-10" });
      const mine = [...this.libraries.values()].filter((l) => this.files.get(l.key)!.orgId === orgId && l.status === "published");
      if (!p[3] && m === "GET") {
        const approved = url.searchParams.get("approved") === "1";
        const text = url.searchParams.get("text")?.toLowerCase() ?? "";
        return json({ libraries: mine.filter((l) => (!approved || this.approved(l, null)) && this.files.get(l.key)!.name.toLowerCase().includes(text)).map((l) => this.summary(l)) });
      }
      const lib = mine.find((l) => l.key === p[3]);
      if (!lib) throw new HttpError(404, "not_found", "No such library");
      if (!p[4] && m === "GET") return json({ library: this.info(lib) });
      if (p[4] === "settings" && m === "PUT") {
        const input = await body<LibrarySettingsInput>();
        const k = `${input.scope.type}:${input.scope.id}`;
        const row = lib.settings.get(k) ?? { approved: false, defaults: {}, defaultModes: [] };
        if (typeof input.approved === "boolean") row.approved = input.approved;
        if (input.defaults) Object.assign(row.defaults, input.defaults);
        for (const dm of input.defaultModes ?? []) {
          row.defaultModes = row.defaultModes.filter((x) => x.collectionKey !== dm.collectionKey);
          if (dm.modeId) row.defaultModes.push({ collectionKey: dm.collectionKey, modeId: dm.modeId });
        }
        lib.settings.set(k, row);
        if (input.scope.type === "org" && Object.values(input.defaults ?? {}).includes(true) && lib.scope === "team") {
          lib.scope = "org";
          const f = this.files.get(lib.key)!;
          if (f.orgLinkAccess === "none") f.orgLinkAccess = "viewer";
        }
        return json({ library: this.info(lib) });
      }
    }

    if (p[0] === "teams" && p[1] && p[2] === "libraries" && m === "GET") {
      if (!this.teamMembers.get(p[1])?.has(uid)) throw new HttpError(404, "not_found", "No such team");
      const rows = [...this.libraries.values()].filter((l) => l.status === "published" && (this.files.get(l.key)!.teamId === p[1] || l.scope === "org"));
      return json({
        libraries: rows.map((l) => {
          const r = l.settings.get(`team:${p[1]}`);
          return { ...this.summary(l), setting: { scope: { type: "team", id: p[1] }, scopeName: p[1], approved: false, defaults: { design: null, figjam: null, slides: null, buzz: null, ...(r?.defaults ?? {}) }, defaultModes: r?.defaultModes ?? [], updatedAt: 0, updatedBy: null } };
        }),
      });
    }
    throw new HttpError(404, "not_found", `No route ${m} ${url.pathname}`);
  }

  private newLibrary(key: string): FakeLibrary {
    const l: FakeLibrary = { key, status: "unpublished", scope: "team", versions: [], firstPublishedAt: 0, lastPublishedAt: 0, publishedBy: null, payloads: new Map(), blobs: new Map(), settings: new Map(), collections: [] };
    this.libraries.set(key, l);
    return l;
  }
}
