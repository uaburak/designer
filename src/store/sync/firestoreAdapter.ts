/**
 * The workspace in Firestore and Storage (docs/data.md §8.2, §12.4–§12.5), as the Replicator uses it: records merged
 * field by field against their `_clk` in a transaction; node documents written per property with `_clk/_t/_del/_dev`
 * (≤ 100 documents per transaction, blobs and spills uploaded before any document that points at them); pulls by
 * `_t` after a cursor. The UI never talks to this: `LocalAdapter` stays authoritative and the Replicator moves changes
 * between the two.
 *
 * Not here yet: "Download a workspace" (creating local files from remote ones), version snapshots, thumbnails,
 * libraries and device ordinals from `devices/_counter`; record deletions (delete forever) aren't propagated.
 */
import { createHash } from "node:crypto";
import type { Message, NodeChange } from "../../shared/schema/document.generated";
import { MODEL } from "../../shared/schema/model";
import { messageImageHashes, rebaseBlobIndices } from "../../shared/schema/patch";
import type { FileKey, Hlc } from "../../shared/store/types";
import type { FileClocks } from "./clocks";
import type { DocData, FirestoreDriver, StorageDriver } from "./drivers";
import { decodeNodeFields, encodeNodeFields, type EncodeContext } from "./fieldCodec";
import { coalesce, mergeRecord, planPull, planPush, type RemoteNode } from "./lww";
import { firestorePaths, storagePaths } from "./paths";

/* eslint-disable @typescript-eslint/no-explicit-any -- documents are dynamically shaped */

/** Documents per push transaction (data.md §12.5; Firestore allows 500 operations). */
export const PUSH_CHUNK = 100;

export interface LocalBlobs {
  get(sha1: string): Promise<Uint8Array>;
  has(sha1s: string[]): Promise<boolean[]>;
  put(bytes: Uint8Array): Promise<{ sha1: string }>;
}

export interface FirestoreAdapterDeps {
  firestore: FirestoreDriver;
  storage: StorageDriver;
  wid: string;
  /** The signed-in owner (prefs are per user) */
  uid: string;
  deviceOrdinal: number;
  /** The workspace's blob store: images go up before the documents that use them, and come down on pull */
  blobs: LocalBlobs;
}

export interface PushResult {
  /** Node documents looked at */
  nodes: number;
  /** Node documents written */
  written: number;
  /** Blobs and spills uploaded */
  uploaded: number;
}

export interface PullResult {
  /** The kept remote fields as one change (REMOVED, CREATED for nodes new here, updates), or null */
  message: Message | null;
  /** The newest `_t` seen (store.json's pullCursor) */
  cursor: string | null;
  docs: number;
  /** Every remote HLC taken (the store's clock observes them) */
  stamps: Hlc[];
}

const sha1Hex = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");

/** Fields of a node document that are properties (not `_clk`, `_t`, `_del`, `_dev`). */
function propertyFields(doc: DocData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

/** Storage objects a document points at ({$blob}/{$kiwi}, at any depth). */
function spilledShas(v: unknown, out = new Set<string>()): Set<string> {
  if (!v || typeof v !== "object" || v instanceof Uint8Array) return out;
  if (Array.isArray(v)) {
    for (const e of v) spilledShas(e, out);
    return out;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.$blob === "string") out.add(o.$blob);
  if (typeof o.$kiwi === "string") out.add(o.$kiwi);
  for (const [k, e] of Object.entries(o)) if (k !== "$b") spilledShas(e, out);
  return out;
}

export class FirestoreAdapter {
  constructor(readonly d: FirestoreAdapterDeps) {}

  get paths() {
    const { wid, uid } = this.d;
    return {
      workspace: firestorePaths.workspace(wid),
      prefs: firestorePaths.prefs(wid, uid),
      folders: firestorePaths.folders(wid),
      folder: (id: string) => firestorePaths.folder(wid, id),
      fileMetas: firestorePaths.fileMetas(wid),
      fileMeta: (key: FileKey) => firestorePaths.fileMeta(wid, key),
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Merges one record with its remote copy in a transaction (field-level LWW on `_clk`) and writes the merge when
   * this side had newer fields. Returns the merged record and which fields came from the remote.
   */
  async syncRecord<T extends { _clk: Record<string, Hlc> }>(path: string, local: T): Promise<{ merged: T; pulled: string[]; pushed: string[] }> {
    return this.d.firestore.transaction(async (tx) => {
      const remote = (await tx.get(path)) as T | null;
      const known = remote && typeof remote === "object" && remote._clk ? remote : null;
      const r = mergeRecord(local, known);
      if (!known || r.pushFields.length) tx.set(path, structuredClone(r.merged) as unknown as DocData);
      return { merged: r.merged, pulled: r.pullFields, pushed: r.pushFields };
    });
  }

  async getRecord<T>(path: string): Promise<T | null> {
    return (await this.d.firestore.get(path)) as T | null;
  }

  async listRecords<T>(collection: string): Promise<T[]> {
    return (await this.d.firestore.list(collection)).map((d) => d.data as T);
  }

  /** `files/{fileKey}`: who owns the file's nodes (written once, before its first nodes). */
  async ensureFileDoc(fileKey: FileKey, info: { documentFormatVersion: number; schemaSha1: string; createdAt: number }): Promise<void> {
    const path = firestorePaths.file(fileKey);
    if (await this.d.firestore.get(path)) return;
    await this.d.firestore.set(path, { wid: this.d.wid, ownerUid: this.d.uid, ...info });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Blobs
  // -------------------------------------------------------------------------------------------------------------------

  /** Uploads bytes to `blobs/<sha1>` unless they are there (immutable, so existence is enough). */
  async uploadBlob(sha1: string, bytes: Uint8Array | (() => Promise<Uint8Array>), contentType?: string): Promise<boolean> {
    const path = storagePaths.blob(sha1);
    if (await this.d.storage.exists(path)) return false;
    await this.d.storage.put(path, typeof bytes === "function" ? await bytes() : bytes, { contentType, cacheControl: "public, max-age=31536000, immutable" });
    return true;
  }

  async uploadSchema(sha1: string, bytes: Uint8Array): Promise<void> {
    const path = storagePaths.schema(sha1);
    if (!(await this.d.storage.exists(path))) await this.d.storage.put(path, bytes, { contentType: "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Nodes: push
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Push (§12.5): the frames (already decoded, in seq order, each with the HLC the store stamped) coalesced per
   * (guid, field); images and spills uploaded first; then each node document written where the local write wins.
   * The file's clocks learn every local write pushed.
   */
  async pushNodes(fileKey: FileKey, frames: { hlc: Hlc; message: Message }[], clocks: FileClocks): Promise<PushResult> {
    const { firestore } = this.d;
    const ops = coalesce(frames);
    let uploaded = 0;

    // 1. Images the frames use, before any document that points at them.
    const images = new Set<string>();
    for (const f of frames) for (const h of messageImageHashes(f.message)) images.add(h);
    if (images.size) {
      const list = [...images];
      const have = await this.d.blobs.has(list);
      for (let i = 0; i < list.length; i++) {
        if (!have[i]) continue; // not in this workspace's blob store (yet): nothing to upload
        if (await this.uploadBlob(list[i], () => this.d.blobs.get(list[i]))) uploaded++;
      }
    }

    // 2. Encode the carried values field by field (each against its own frame's blob table); spills go up next.
    const spills = new Map<string, Uint8Array>();
    const encoded = new Map<string, Record<string, unknown>>();
    for (const [guid, op] of ops) {
      const fields: Record<string, unknown> = {};
      for (const [field, w] of op.fields) {
        if (w.value === undefined) continue;
        const ctx: EncodeContext = {
          bytes: firestore.bytes,
          blob: (i) => op.blobsOf.get(field)?.[i]?.bytes,
          spill: (b) => {
            const sha1 = sha1Hex(b);
            spills.set(sha1, b);
            return sha1;
          },
        };
        const node = { guid: { sessionID: 0, localID: 0 }, [field]: w.value } as NodeChange;
        fields[field] = encodeNodeFields(node, ctx, [field])[field];
      }
      encoded.set(guid, fields);
    }
    for (const [sha1, bytes] of spills) if (await this.uploadBlob(sha1, bytes)) uploaded++;

    // 3. ≤ 100 documents per transaction: read them all, then write what wins.
    const guids = [...ops.keys()];
    let written = 0;
    for (let i = 0; i < guids.length; i += PUSH_CHUNK) {
      const chunk = guids.slice(i, i + PUSH_CHUNK);
      written += await firestore.transaction(async (tx) => {
        const remotes = await Promise.all(chunk.map((g) => tx.get(firestorePaths.node(fileKey, g))));
        let n = 0;
        chunk.forEach((guid, j) => {
          const doc = remotes[j];
          const remote: RemoteNode | null = doc ? { fields: propertyFields(doc), clk: (doc._clk as Record<string, Hlc>) ?? {}, del: (doc._del as Hlc) ?? null } : null;
          const op = ops.get(guid)!;
          const plan = planPush(op, remote);
          if (plan.empty) return;
          const values = encoded.get(guid)!;
          const data: DocData = {};
          for (const f of plan.set) data[f] = values[f];
          for (const f of plan.clear) if (remote && f in remote.fields) data[f] = firestore.deleteField();
          data._clk = { ...(remote?.clk ?? {}), ...plan.clk };
          if (plan.del) data._del = plan.del;
          data._t = firestore.serverTimestamp();
          data._dev = this.d.deviceOrdinal;
          tx.set(firestorePaths.node(fileKey, guid), data, { merge: true });
          n++;
        });
        return n;
      });
    }

    // 4. What this device now knows it wrote.
    for (const [guid, op] of ops) {
      if (op.removed) clocks.tombstone(guid, op.removed);
      if (op.replacedAt) clocks.replace(guid, op.replacedAt);
      for (const [field, w] of op.fields) clocks.write(guid, field, w.hlc);
    }
    return { nodes: guids.length, written, uploaded };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Nodes: pull
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Pull (§12.5): node documents written after `cursor`, kept where the remote write is newer than the local clocks,
   * as one change Message for `FileStore.appendRemote`. A node that doesn't exist locally arrives whole (CREATED).
   */
  async pullNodes(fileKey: FileKey, cursor: string | null, clocks: FileClocks, existsLocally: (guid: string) => Promise<boolean>): Promise<PullResult> {
    const { firestore, storage } = this.d;
    const docs = await firestore.list(firestorePaths.nodes(fileKey), cursor === null ? undefined : { field: "_t", op: ">", value: firestore.cursorValue(cursor) }, "_t");
    // Ordered by _t: the last document's stamp is the new cursor.
    const next = docs.length ? (firestore.cursorOf(docs[docs.length - 1].data._t) ?? cursor) : cursor;
    const nodeChanges: NodeChange[] = [];
    const blobs: { bytes: Uint8Array }[] = [];
    const stamps: Hlc[] = [];
    for (const { id: guid, data: doc } of docs) {
      const fetched = new Map<string, Uint8Array>();
      for (const sha1 of spilledShas(propertyFields(doc))) fetched.set(sha1, await storage.get(storagePaths.blob(sha1)));
      const { node, blobs: docBlobs } = decodeNodeFields(guid, doc, {
        bytes: firestore.bytes,
        fetch: (sha1) => {
          const b = fetched.get(sha1);
          if (!b) throw new Error(`blob ${sha1} is missing`);
          return b;
        },
      });
      const { guid: g, ...fields } = node as any;
      const remote: RemoteNode = { fields, clk: (doc._clk as Record<string, Hlc>) ?? {}, del: (doc._del as Hlc) ?? null };
      const local = clocks.get(guid);
      const plan = planPull(guid, remote, local);
      if (plan.removed) {
        if (await existsLocally(guid)) nodeChanges.push({ guid: g, phase: "REMOVED" });
        clocks.tombstone(guid, remote.del!);
        stamps.push(remote.del!);
        continue;
      }
      if (!plan.change) continue;
      const base = blobs.length;
      let change: NodeChange;
      if (await existsLocally(guid)) change = plan.change;
      else {
        // New here: the whole remote node, as of every field it has.
        change = { ...fields, guid: g, phase: "CREATED" };
        for (const [f, h] of Object.entries(remote.clk)) if (f in fields) plan.taken[f] = h;
      }
      for (const b of docBlobs) blobs.push({ bytes: b });
      nodeChanges.push(base ? rebaseBlobIndices(MODEL, change, (i) => base + i) : change);
      for (const [f, h] of Object.entries(plan.taken)) {
        clocks.write(guid, f, h);
        stamps.push(h);
      }
    }
    const message: Message | null = nodeChanges.length ? { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges, blobs } : null;
    // Images the pulled values use: into the local blob store before the frame that needs them.
    if (message) {
      const hashes = [...messageImageHashes(message)];
      const have = hashes.length ? await this.d.blobs.has(hashes) : [];
      for (let i = 0; i < hashes.length; i++) {
        if (have[i]) continue;
        try {
          await this.d.blobs.put(await storage.get(storagePaths.blob(hashes[i])));
        } catch {
          /* not uploaded (yet): the image shows as missing until a later pull */
        }
      }
    }
    return { message, cursor: next, docs: docs.length, stamps };
  }
}
