/**
 * The editor's view of the library registry for one open file (`DocumentSource.libraries`, docs/data.md §9): the
 * store's `libraries.*` with this file's key filled in, payloads converted between the engine's JSON and the store's
 * kiwi, library file names and folders from the workspace, and the file's own enabled list / folder followed.
 *
 * Org copies (docs/data.md §16): "this file's library" is `libraryKeyOfFile` (the room key); the file is in Drafts when
 * its space has no folder; org libraries are named by their record (their files aren't local), located by their team;
 * the Publish dialog reads the org's name and whether the person may change the file's link (`org()`); usage events
 * go to `store.analytics` (§17.3).
 */
import type { EditorPublishAsset, LibraryAccess, LibraryEntry, LibraryNotice, OrgPublishContext } from "@/editor/documentSource";
import { decodeMessage, encodeMessage } from "../../../shared/schema/codec";
import type { StoreApi, Unsubscribe } from "../../../shared/store/repositories";
import type { FileMeta, PublishAsset } from "../../../shared/store/types";
import { isOrgLibrary, libraryKeyOfFile } from "../../../shared/libraries/orgTypes";
import type { Message as EngineMessage } from "@/engine/codec";
import type { AssetPayload } from "../../../shared/store/types";
import { messageToEngine, messageToKiwi } from "./engineMessage";

/** A payload from the store: its kiwi bytes as they are, the engine's Message decoded on first read (a kiwi-reading engine never asks). */
function payloadIn(p: AssetPayload): { key: string; versionHash: string; message: EngineMessage; bytes: Uint8Array } {
  let message: EngineMessage | null = null;
  return {
    key: p.key,
    versionHash: p.versionHash,
    bytes: p.message,
    get message() {
      return (message ??= messageToEngine(decodeMessage(p.message)));
    },
  };
}

/** In Drafts (can't publish): a local file outside a folder, an org copy whose space has no folder. */
const inDraftsOf = (m: FileMeta): boolean => (m.space ? m.space.projectId === null : m.folderId === null);

/** Usage is reported for org copies in a folder, not branches (docs/data.md §17.2; the store applies the same rule). */
export const reportsUsage = (m: FileMeta): boolean => !!m.space && !!m.space.projectId && !m.branch;

export function storeLibraryAccess(store: StoreApi, meta: () => FileMeta, onMeta: (l: (m: FileMeta) => void) => Unsubscribe): LibraryAccess {
  const fileKey = meta().fileKey;
  const libraryKey = () => libraryKeyOfFile(meta());
  // A payload the engine wrote as kiwi is stored as it is; the interim JSON is converted.
  const encode = (assets: EditorPublishAsset[]): PublishAsset[] =>
    assets.map(({ payloadBytes, ...a }) => ({ ...a, payload: payloadBytes ?? (a.payload ? encodeMessage(messageToKiwi({ ...a.payload, sessionID: 0 })) : undefined) }));
  const folderName = async (m: FileMeta): Promise<string> => {
    if (!m.folderId) return "Drafts";
    const folders = await store.workspace.listFolders().catch(() => []);
    return folders.find((f) => f.id === m.folderId)?.name ?? "Drafts";
  };
  return {
    fileKey,
    get libraryKey() {
      return libraryKey();
    },
    inDrafts: () => inDraftsOf(meta()),
    enabled: () => meta().enabledLibraries,
    available: async () => {
      const records = await store.libraries.listAvailable(fileKey);
      const out: LibraryEntry[] = [];
      for (const record of records) {
        if (record.libraryFileKey === libraryKey()) continue;
        if (isOrgLibrary(record)) {
          // An org library's file isn't on this computer: its record names it; its team locates it.
          out.push({ fileKey: record.libraryFileKey, name: record.org.name, location: record.org.teamName ?? "", record, org: record.org });
          continue;
        }
        const m = await store.workspace.getFile(record.libraryFileKey).catch(() => null);
        if (m) out.push({ fileKey: record.libraryFileKey, name: m.name, location: await folderName(m), record });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    fileName: async (lib) => {
      const local = (await store.workspace.getFile(lib).catch(() => null))?.name;
      if (local) return local;
      const record = await store.libraries.getRecord(lib).catch(() => null);
      return record && isOrgLibrary(record) && record.status !== "deleted" ? record.org.name : null;
    },
    record: (lib) => store.libraries.getRecord(lib),
    version: (lib, version) => store.libraries.getVersion(lib, version),
    previewPublish: (assets) => store.libraries.previewPublish(libraryKey(), encode(assets)),
    publish: (input) => store.libraries.publish({ libraryFileKey: libraryKey(), description: input.description, assets: encode(input.assets), moves: input.moves, ...(input.scope ? { scope: input.scope } : {}) }),
    unpublish: () => store.libraries.unpublish(libraryKey()),
    org: async (): Promise<OrgPublishContext | null> => {
      const space = meta().space;
      if (!space) return null;
      const [org, files, record] = await Promise.all([
        store.orgs.get(space.orgId).catch(() => null),
        space.projectId ? store.projects.files(space.projectId).catch(() => []) : Promise.resolve([]),
        store.libraries.getRecord(space.key).catch(() => null),
      ]);
      const file = files.find((f) => f.key === space.key);
      return {
        orgId: space.orgId,
        orgName: org?.name ?? "your organization",
        canShare: file?.access.canShare ?? false,
        scope: record && isOrgLibrary(record) && record.status !== "deleted" ? record.org.scope : null,
      };
    },
    analytics: {
      reports: () => reportsUsage(meta()),
      record: (events) => store.analytics.record(events),
      views: store.analytics,
      orgLibraries: store.orgLibraries,
    },
    setEnabled: async (lib, enabled) => {
      await store.libraries.setEnabled(fileKey, lib, enabled);
    },
    payloads: async (lib, wants, opts) => (await store.libraries.getPayloads(lib, wants, opts)).map(payloadIn),
    diff: (lib, have) => store.libraries.diff(lib, have),
    onChange: (listener: (e: LibraryNotice) => void) => {
      let last = meta();
      const offLib = store.libraries.watch((e) => listener(e));
      const offMeta = onMeta((m) => {
        const was = last;
        last = m;
        if (was.enabledLibraries.join() !== m.enabledLibraries.join()) listener({ type: "enabled", enabled: m.enabledLibraries });
        if (inDraftsOf(was) !== inDraftsOf(m)) listener({ type: "moved", inDrafts: inDraftsOf(m) });
      });
      return () => {
        offLib();
        offMeta();
      };
    },
    blobUrl: (sha1) => store.blobs.url(sha1),
  };
}
