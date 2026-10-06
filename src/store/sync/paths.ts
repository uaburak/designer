/**
 * Firestore and Storage paths (docs/data.md §12.4), exactly as the contract lists them. Nothing else builds paths.
 */
import type { FileKey, FolderId, VersionId } from "../../shared/store/types";

export const firestorePaths = {
  /** Workspace — workspace.json */
  workspace: (wid: string) => `workspaces/${wid}`,
  /** Folder — folders/<id>.json */
  folders: (wid: string) => `workspaces/${wid}/folders`,
  folder: (wid: string, id: FolderId) => `workspaces/${wid}/folders/${id}`,
  /** FileMeta — files/<key>/meta.json */
  fileMetas: (wid: string) => `workspaces/${wid}/files`,
  fileMeta: (wid: string, fileKey: FileKey) => `workspaces/${wid}/files/${fileKey}`,
  /** Prefs — prefs.json (per signed-in user) */
  prefs: (wid: string, uid: string) => `workspaces/${wid}/prefs/${uid}`,
  /** LibraryRecord — libraries/<key>/library.json */
  libraries: (wid: string) => `workspaces/${wid}/libraries`,
  library: (wid: string, lib: FileKey) => `workspaces/${wid}/libraries/${lib}`,
  /** {version, publishedAt, description, changes, assetCount}; the full manifest is in Storage */
  libraryVersion: (wid: string, lib: FileKey, n: number) => `workspaces/${wid}/libraries/${lib}/versions/${n}`,
  /** {name, createdAt, lastSeenAt} — userData/device.json */
  device: (wid: string, ordinal: number) => `workspaces/${wid}/devices/${ordinal}`,
  deviceCounter: (wid: string) => `workspaces/${wid}/devices/_counter`,
  /** {wid, ownerUid, documentFormatVersion, schemaSha1, createdAt} — store.json (subset) */
  file: (fileKey: FileKey) => `files/${fileKey}`,
  /** One document per node, one field per top-level NodeChange property, plus _clk, _t, _del, _dev */
  nodes: (fileKey: FileKey) => `files/${fileKey}/nodes`,
  node: (fileKey: FileKey, guid: string) => `files/${fileKey}/nodes/${guid}`,
  /** VersionRecord minus blobRefs — versions/index.json */
  versions: (fileKey: FileKey) => `files/${fileKey}/versions`,
  version: (fileKey: FileKey, id: VersionId) => `files/${fileKey}/versions/${id}`,
};

export const storagePaths = {
  /** Image bytes and spilled large values (immutable; Cache-Control: immutable) */
  blob: (sha1: string) => `blobs/${sha1}`,
  /** Custom metadata `version` */
  thumbnail: (fileKey: FileKey) => `thumbnails/${fileKey}.png`,
  versionSnapshot: (fileKey: FileKey, id: VersionId) => `versions/${fileKey}/${id}.kiwi`,
  libraryManifest: (lib: FileKey, n: number) => `libraries/${lib}/versions/${n}.json`,
  libraryAsset: (lib: FileKey, key: string, versionHash: string) => `libraries/${lib}/assets/${key}/${versionHash}.kiwi`,
  schema: (sha1: string) => `schemas/${sha1}.kiwi`,
  preview: (previewId: string, name: string) => `previews/${previewId}/${name}`,
};
