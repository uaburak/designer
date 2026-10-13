/**
 * Version history of shared (room) files (docs/data.md §15.7, as built §15.7.1 and §15.9): a shared file's history is
 * its room's — `GET /files/:key/versions` (kinds as §6 plus "branch" / "update" / "merge"), a version being the room's
 * snapshot at `snapshot_seq` plus its frames up to `seq` (`…/versions/:id/snapshot` + `…/frames`; the room never
 * decodes kiwi, so the client does). `withRoomVersions` puts it behind `FileRepository`: the editor's history, Name
 * this version, Restore and Duplicate work on a shared file as on a local one, its local copy's own checkpoints left out.
 *
 * Restore (§15.7.1): the editor applies `restoreDiff` (the head → the version) as its own edit, which the file's link
 * sends as a frame; `createVersion({kind: "restore"})` then waits for the room to acknowledge it and posts the
 * "restore" version at the room's head.
 *
 * Pure (no Node, no DOM): the desktop store (LocalStore) and the browser's dev store (MemoryStore) both use it.
 */
import { decodeChangesDown } from "../../shared/multiplayer/protocol";
import { unpackSnapshot } from "../../shared/multiplayer/snapshotWire";
import { decodeMessage, encodeMessage, SCHEMA_BINARY } from "../../shared/schema/codec";
import { NodeTable } from "../../shared/schema/patch";
import { restoreDiff, withNewAssetIdentity } from "../../shared/store/assetIdentity";
import { StoreError } from "../../shared/store/protocol";
import type { FileRepository, OpenedFile } from "../../shared/store/repositories";
import type { FileKey, FileMeta, VersionId, VersionRecord } from "../../shared/store/types";
import { versionDateLabel } from "./versions";

/** The room's `version` (§15.7.1) */
export interface RoomVersion {
  id: string;
  kind: VersionRecord["kind"];
  title: string | null;
  description: string | null;
  createdAt: number;
  seq: number;
  snapshotSeq?: number;
  sizeBytes?: number;
  restoredFrom?: string | null;
  libraryVersion?: number | null;
  user?: { id: string | null; name: string | null } | null;
}

export interface RoomVersionDeps {
  /** The file's room key; null when it isn't shared */
  roomKey(fileKey: FileKey): Promise<string | null>;
  /** A JSON call to the server with the session */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** A call answering bytes */
  callBytes(method: string, path: string): Promise<{ bytes: Uint8Array; headers: Headers }>;
  /** The link: frames sent and not acknowledged, the last local seq the room acknowledged, the connection */
  /** `unsent`: this copy's own frames not acknowledged (MultiplayerService.syncState); absent: `acked` against the head */
  syncState(fileKey: FileKey): Promise<{ acked: number; pending: number; unsent?: number; connection: "live" | "connecting" | "offline" } | null>;
  /** The local journal's head, after a flush */
  flushedHead(fileKey: FileKey): Promise<number>;
  /** The local copy's document now */
  headTable(fileKey: FileKey): Promise<NodeTable>;
  /** Images the store lacks, fetched from the room (`MultiplayerService.downloadBlobs`) */
  downloadBlobs(roomKey: string, sha1s: string[]): Promise<void>;
  getMeta(fileKey: FileKey): FileMeta;
  /** A new local file (Drafts) holding this snapshot */
  addFile(input: { name: string; snapshot: Uint8Array; images: string[]; enabledLibraries: FileKey[] }): Promise<FileMeta>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** How long a restore / named version waits for the room to acknowledge this copy's frames */
export const ACK_WAIT_MS = 15_000;
const POLL_MS = 50;

const seg = encodeURIComponent;

export function versionRecordOf(v: RoomVersion): VersionRecord {
  return {
    id: v.id,
    kind: v.kind,
    title: v.title ?? null,
    description: v.description ?? null,
    createdAt: v.createdAt,
    seq: v.seq,
    sizeBytes: v.sizeBytes ?? 0,
    blobRefs: [],
    restoredFrom: v.restoredFrom ?? null,
    libraryVersion: v.libraryVersion ?? null,
  };
}

/** `[u32 BE length][changes-down frame]…` (GET …/frames) → the frames' messages in order */
export function unpackFrames(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 4 <= bytes.length; ) {
    const n = view.getUint32(at);
    const f = decodeChangesDown(bytes.subarray(at + 4, at + 4 + n));
    if (f) out.push(f.message);
    at += 4 + n;
  }
  return out;
}

export class RoomVersions {
  constructor(private readonly d: RoomVersionDeps) {}

  /** The room key of a shared file, null for a local one */
  shared(fileKey: FileKey): Promise<string | null> {
    return this.d.roomKey(fileKey).catch(() => null);
  }

  async list(key: string): Promise<VersionRecord[]> {
    const { versions } = await this.d.call<{ versions: RoomVersion[] }>("GET", `/files/${seg(key)}/versions`);
    return versions.map(versionRecordOf);
  }

  async get(key: string, id: VersionId): Promise<VersionRecord> {
    const { version } = await this.d.call<{ version: RoomVersion }>("GET", `/files/${seg(key)}/versions/${seg(id)}`);
    return versionRecordOf(version);
  }

  /** The document at the version: the room's snapshot it starts from with its frames applied */
  async table(key: string, id: VersionId): Promise<{ table: NodeTable; record: VersionRecord }> {
    const record = await this.get(key, id);
    const snap = await this.d.callBytes("GET", `/files/${seg(key)}/versions/${seg(id)}/snapshot`);
    let table: NodeTable;
    try {
      table = NodeTable.fromMessage(decodeMessage(await unpackSnapshot(snap.bytes)));
    } catch (e) {
      throw new StoreError("corrupt", `This version couldn't be read: ${(e as Error).message}`);
    }
    const snapshotSeq = Number(snap.headers.get("x-snapshot-seq") ?? record.seq);
    if (snapshotSeq < record.seq) {
      const frames = await this.d.callBytes("GET", `/files/${seg(key)}/versions/${seg(id)}/frames`);
      for (const m of unpackFrames(frames.bytes)) {
        try {
          table.apply(decodeMessage(m));
        } catch (e) {
          throw new StoreError("corrupt", `This version couldn't be read: ${(e as Error).message}`);
        }
      }
    }
    await this.d.downloadBlobs(key, [...table.imageHashes()]);
    return { table, record };
  }

  async open(fileKey: FileKey, key: string, id: VersionId): Promise<OpenedFile> {
    const { table, record } = await this.table(key, id);
    return {
      meta: { ...this.d.getMeta(fileKey) },
      mode: "view",
      sessionID: 0,
      schema: SCHEMA_BINARY.slice(),
      snapshot: encodeMessage(table.toMessage()),
      snapshotSeq: record.seq,
      derivedDataVersion: table.derivedDataVersion,
      journal: [],
      headSeq: record.seq,
      ui: null,
      recovery: null,
    };
  }

  /** The NODE_CHANGES message that turns the local copy's head into the version (non-destructive restore, §6) */
  async restoreDiff(fileKey: FileKey, key: string, id: VersionId): Promise<Uint8Array> {
    const { table } = await this.table(key, id);
    return encodeMessage(restoreDiff(await this.d.headTable(fileKey), table));
  }

  /** The room has every local frame (bounded wait): a version posted now is at the copy's head */
  async caughtUp(fileKey: FileKey): Promise<void> {
    const head = await this.d.flushedHead(fileKey);
    const until = this.d.now() + ACK_WAIT_MS;
    for (;;) {
      const s = await this.d.syncState(fileKey);
      if (!s) throw new StoreError("invalid", "This file isn't shared");
      if (s.pending === 0 && (s.unsent !== undefined ? s.unsent === 0 : s.acked >= head)) return;
      if (this.d.now() >= until) throw new StoreError("offline", "This file isn't up to date with its room. Try again when you're online.");
      await this.d.sleep(POLL_MS);
    }
  }

  async create(fileKey: FileKey, key: string, input: { kind?: "named" | "restore"; title?: string; description?: string; restoredFrom?: VersionId }): Promise<VersionRecord> {
    const kind = input?.kind ?? "named";
    if (kind !== "named" && kind !== "restore") throw new StoreError("invalid", `bad version kind ${String(kind)}`);
    if (kind === "restore" && !input.restoredFrom) throw new StoreError("invalid", "a restore version names the version it restored");
    const title = typeof input?.title === "string" && input.title.trim() ? input.title.trim() : undefined;
    const description = typeof input?.description === "string" && input.description.trim() ? input.description.trim() : undefined;
    await this.caughtUp(fileKey);
    const { version } = await this.d.call<{ version: RoomVersion }>("POST", `/files/${seg(key)}/versions`, { kind, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(kind === "restore" ? { restoredFrom: input.restoredFrom } : {}) });
    return versionRecordOf(version);
  }

  async update(key: string, id: VersionId, patch: { title?: string; description?: string }): Promise<VersionRecord> {
    const { version } = await this.d.call<{ version: RoomVersion }>("PATCH", `/files/${seg(key)}/versions/${seg(id)}`, { ...(patch?.title !== undefined ? { title: patch.title } : {}), ...(patch?.description !== undefined ? { description: patch.description } : {}) });
    return versionRecordOf(version);
  }

  /** Duplicate a version as a new local file in Drafts (its local assets new ones, as Duplicate) */
  async duplicate(fileKey: FileKey, key: string, id: VersionId): Promise<FileMeta> {
    const src = this.d.getMeta(fileKey);
    const { table, record } = await this.table(key, id);
    const fresh = withNewAssetIdentity(table.toMessage());
    return this.d.addFile({ name: `${src.name} (${record.title ?? versionDateLabel(record.createdAt)})`, snapshot: encodeMessage(fresh), images: [...table.imageHashes()].sort(), enabledLibraries: [...src.enabledLibraries] });
  }
}

/** `files` with a shared file's version calls going to its room (`rv`); a local file's stay with `files`. */
export function withRoomVersions(files: FileRepository, rv: RoomVersions): FileRepository {
  const via = async <T>(fileKey: FileKey, room: (key: string) => Promise<T>, local: () => Promise<T>): Promise<T> => {
    const key = await rv.shared(fileKey);
    return key ? room(key) : local();
  };
  return {
    ...files,
    listVersions: (fileKey) => via(fileKey, (k) => rv.list(k), () => files.listVersions(fileKey)),
    createVersion: (fileKey, input) => via(fileKey, (k) => rv.create(fileKey, k, input ?? {}), () => files.createVersion(fileKey, input)),
    updateVersion: (fileKey, id, patch) => via(fileKey, (k) => rv.update(k, id, patch ?? {}), () => files.updateVersion(fileKey, id, patch)),
    openVersion: (fileKey, id) => via(fileKey, (k) => rv.open(fileKey, k, id), () => files.openVersion(fileKey, id)),
    restoreDiff: (fileKey, id) => via(fileKey, (k) => rv.restoreDiff(fileKey, k, id), () => files.restoreDiff(fileKey, id)),
    duplicateVersion: (fileKey, id) => via(fileKey, (k) => rv.duplicate(fileKey, k, id), () => files.duplicateVersion(fileKey, id)),
  };
}
