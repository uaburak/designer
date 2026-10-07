/**
 * The editor's view of the library registry for one open file (`DocumentSource.libraries`, docs/data.md §9): the
 * store's `libraries.*` with this file's key filled in, payloads converted between the engine's JSON and the store's
 * kiwi, library file names and folders from the workspace, and the file's own enabled list / folder followed.
 */
import type { EditorPublishAsset, LibraryAccess, LibraryEntry, LibraryNotice } from "@/editor/documentSource";
import { decodeMessage, encodeMessage } from "../../../shared/schema/codec";
import type { StoreApi, Unsubscribe } from "../../../shared/store/repositories";
import type { FileMeta, PublishAsset } from "../../../shared/store/types";
import { messageToEngine, messageToKiwi } from "./engineMessage";

export function storeLibraryAccess(store: StoreApi, meta: () => FileMeta, onMeta: (l: (m: FileMeta) => void) => Unsubscribe): LibraryAccess {
  const fileKey = meta().fileKey;
  const encode = (assets: EditorPublishAsset[]): PublishAsset[] => assets.map((a) => ({ ...a, payload: a.payload ? encodeMessage(messageToKiwi({ ...a.payload, sessionID: 0 })) : undefined }));
  const folderName = async (m: FileMeta): Promise<string> => {
    if (!m.folderId) return "Drafts";
    const folders = await store.workspace.listFolders().catch(() => []);
    return folders.find((f) => f.id === m.folderId)?.name ?? "Drafts";
  };
  return {
    fileKey,
    inDrafts: () => meta().folderId === null,
    enabled: () => meta().enabledLibraries,
    available: async () => {
      const records = await store.libraries.listAvailable(fileKey);
      const out: LibraryEntry[] = [];
      for (const record of records) {
        const m = await store.workspace.getFile(record.libraryFileKey).catch(() => null);
        if (m) out.push({ fileKey: record.libraryFileKey, name: m.name, location: await folderName(m), record });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    fileName: async (lib) => (await store.workspace.getFile(lib).catch(() => null))?.name ?? null,
    record: (lib) => store.libraries.getRecord(lib),
    version: (lib, version) => store.libraries.getVersion(lib, version),
    previewPublish: (assets) => store.libraries.previewPublish(fileKey, encode(assets)),
    publish: (input) => store.libraries.publish({ libraryFileKey: fileKey, description: input.description, assets: encode(input.assets), moves: input.moves }),
    setEnabled: async (lib, enabled) => {
      await store.libraries.setEnabled(fileKey, lib, enabled);
    },
    payloads: async (lib, wants, opts) => (await store.libraries.getPayloads(lib, wants, opts)).map((p) => ({ key: p.key, versionHash: p.versionHash, message: messageToEngine(decodeMessage(p.message)) })),
    diff: (lib, have) => store.libraries.diff(lib, have),
    onChange: (listener: (e: LibraryNotice) => void) => {
      let last = meta();
      const offLib = store.libraries.watch((e) => listener(e));
      const offMeta = onMeta((m) => {
        const was = last;
        last = m;
        if (was.enabledLibraries.join() !== m.enabledLibraries.join()) listener({ type: "enabled", enabled: m.enabledLibraries });
        if ((was.folderId === null) !== (m.folderId === null)) listener({ type: "moved", inDrafts: m.folderId === null });
      });
      return () => {
        offLib();
        offMeta();
      };
    },
    blobUrl: (sha1) => store.blobs.url(sha1),
  };
}
