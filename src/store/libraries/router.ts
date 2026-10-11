/**
 * The store's `LibraryRegistry` (docs/data.md §16.3): one interface over two registries — the local one (§9, files on
 * disk or the browser's storage) for local keys, the org one (org.ts) for room keys. A call naming a file goes by that
 * file: an org copy (`FileMeta.space` set) → the org registry, else the local one. A call naming a library goes by the
 * key's form (`isLocalLibraryKey`). The interface doesn't change.
 *
 * Figma's rule, the owner's default: org libraries are offered only in files of that org; a local file never lists
 * them. §16.9's exception: a local library whose file moved into an org (`moved.json`) forwards its consumers to the
 * org library — `diff` answers "moved" for every asset the org library has, and accepting swaps the key in the
 * consumer's `enabledLibraries`; from then on that local file receives the org library's updates.
 */
import { isLocalLibraryKey } from "../../shared/libraries/orgTypes";
import { StoreError } from "../../shared/store/protocol";
import type { LibraryEvent, LibraryRegistry, Unsubscribe } from "../../shared/store/repositories";
import type { FileKey, FileMeta, LibraryDiff, LibraryVersion, PublishRequest, Redirect } from "../../shared/store/types";
import type { OrgLibraries } from "./org";

/** What the router needs besides the two registries */
export interface LibraryRouterHost {
  getMeta(fileKey: FileKey): FileMeta | null;
  /** The local copy of an org file, by its room key */
  copyOf(roomKey: string): FileMeta | null;
  patchFile(fileKey: FileKey, patch: Partial<Pick<FileMeta, "enabledLibraries">>): Promise<FileMeta>;
  /** §16.9's alias: libraries/<lib>/moved.json */
  moved: {
    movedTo(lib: FileKey): { to: string; at: number } | null;
    movedFrom(to: string): FileKey[];
    markMoved(lib: FileKey, to: string): Promise<void>;
  };
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

const isOffline = (e: unknown) => e instanceof StoreError && (e.code === "offline" || e.code === "forbidden" || e.code === "not-found");

export class LibraryRouter implements LibraryRegistry {
  constructor(
    private readonly local: LibraryRegistry,
    private readonly org: OrgLibraries,
    private readonly host: LibraryRouterHost,
  ) {}

  /** An org copy's file (by its local key) */
  private isOrgFile(fileKey: FileKey | undefined): boolean {
    return !!fileKey && !!this.host.getMeta(fileKey)?.space;
  }

  async listAvailable(forFileKey?: FileKey) {
    if (forFileKey && this.isOrgFile(forFileKey)) return this.org.listAvailable(forFileKey);
    return this.local.listAvailable(forFileKey);
  }

  getRecord(key: FileKey) {
    return isLocalLibraryKey(key) ? this.local.getRecord(key) : this.org.getRecord(key);
  }

  getVersion(key: FileKey, version?: number): Promise<LibraryVersion> {
    return isLocalLibraryKey(key) ? this.local.getVersion(key, version) : this.org.getVersion(key, version);
  }

  previewPublish(key: FileKey, assets: Parameters<LibraryRegistry["previewPublish"]>[1]) {
    return isLocalLibraryKey(key) ? this.local.previewPublish(key, assets) : this.org.previewPublish(key, assets ?? []);
  }

  async publish(req: PublishRequest): Promise<LibraryVersion> {
    const key = req?.libraryFileKey;
    if (typeof key !== "string") throw new StoreError("invalid", "bad library key");
    // An org copy publishes under its room key (libraryKeyOfFile); its local key would publish a local library.
    const meta = isLocalLibraryKey(key) ? this.host.getMeta(key) : null;
    if (meta?.space) return this.publish({ ...req, libraryFileKey: meta.space.key });
    if (isLocalLibraryKey(key)) return this.local.publish(req);
    const version = await this.org.publish(req);
    // §16.9: a local library file moved into the org — its local consumers are forwarded from now on.
    const copy = this.host.copyOf(key);
    if (copy) await this.host.moved.markMoved(copy.fileKey, key).catch((e) => this.host.log("warn", "libraries: moved.json", e));
    return version;
  }

  unpublish(key: FileKey) {
    return isLocalLibraryKey(key) ? this.local.unpublish(key) : this.org.unpublish(key);
  }

  async setEnabled(fileKey: FileKey, key: FileKey, enabled: boolean): Promise<FileMeta> {
    if (this.isOrgFile(fileKey) && !isLocalLibraryKey(key)) return this.org.setEnabled(fileKey, key, !!enabled);
    if (isLocalLibraryKey(key)) return this.local.setEnabled(fileKey, key, !!enabled);
    // An org library in a local file: only the one a library it uses moved to (§16.9), swapping the key.
    const meta = this.host.getMeta(fileKey);
    if (!meta) throw new StoreError("not-found", "No such file");
    const has = meta.enabledLibraries.includes(key);
    if (!enabled) return has ? this.host.patchFile(fileKey, { enabledLibraries: meta.enabledLibraries.filter((k) => k !== key) }) : { ...meta };
    const from = this.host.moved.movedFrom(key);
    if (!from.length) throw new StoreError("forbidden", "Organization libraries can be used only in files of that organization", { code: "org_library_local_file" });
    if (has && !from.some((k) => meta.enabledLibraries.includes(k))) return { ...meta };
    const next = [...meta.enabledLibraries.filter((k) => !from.includes(k)), ...(has ? [] : [key])];
    return this.host.patchFile(fileKey, { enabledLibraries: next });
  }

  getPayloads(key: FileKey, wants: { key: string; versionHash: string }[], opts: { withDependencies: boolean }) {
    return isLocalLibraryKey(key) ? this.local.getPayloads(key, wants, opts) : this.org.getPayloads(key, wants ?? [], { withDependencies: !!opts?.withDependencies });
  }

  async diff(key: FileKey, have: { key: string; versionHash: string }[]): Promise<LibraryDiff> {
    if (!isLocalLibraryKey(key)) return this.org.diff(key, have ?? []);
    const local = await this.local.diff(key, have ?? []);
    const moved = this.host.moved.movedTo(key);
    if (!moved || !this.org.signedIn) return local;
    // §16.9: forward to the org library; signed out or not allowed → the old manifest's answer (no updates).
    let latest: LibraryVersion;
    try {
      latest = await this.org.getVersion(moved.to);
    } catch (e) {
      if (isOffline(e)) return local;
      throw e;
    }
    const inOrg = new Map(latest.assets.map((a) => [a.key, a]));
    const redirects: Redirect[] = [];
    const seen = new Set<string>();
    for (const h of have ?? []) {
      if (seen.has(h.key) || !inOrg.has(h.key)) continue;
      seen.add(h.key);
      redirects.push({ fromLibraryFileKey: key, fromKey: h.key, toLibraryFileKey: moved.to, toKey: h.key, version: latest.version, at: moved.at });
    }
    return {
      latestVersion: local.latestVersion,
      updated: local.updated.filter((a) => !seen.has(a.key)),
      removed: [...new Set([...local.removed, ...(have ?? []).map((h) => h.key).filter((k) => !inOrg.has(k))])].filter((k) => !seen.has(k)),
      moved: [...redirects, ...local.moved.filter((m) => !seen.has(m.fromKey))],
    };
  }

  watch(listener: (e: LibraryEvent) => void): Unsubscribe {
    const a = this.local.watch(listener);
    const b = this.org.watch(listener);
    return () => {
      a();
      b();
    };
  }
}
