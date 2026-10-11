/**
 * Branches of shared (room) files over the server's routes (docs/data.md §15.7, as built §15.7.1). A shared main's
 * branch is a room of its own, linked to a local copy as any shared file (docs/multiplayer.md §5); the records live in
 * D1 and the base in the branch room. The merge is computed here (the room never decodes kiwi) and sent as ONE call:
 * `POST /branches/:key/merge|update` with the envelope `[u32 BE JSON length][JSON][kiwi Message]`; the target room
 * appends the batch as its next frame only if its head is still the seq the merge read (409 `stale` otherwise), and
 * makes the versions. The frame then reaches every client — this one's local copy too, through its link — as a remote
 * change.
 */
import type { BranchRecord, BranchReview, BranchStatus } from "../../shared/merge/branches";
import { decodeMessage } from "../../shared/schema/codec";
import { messageImageHashes } from "../../shared/schema/patch";
import { isStoreError, StoreError } from "../../shared/store/protocol";
import type { FileKey, VersionRecord } from "../../shared/store/types";

/** The server's `branch` (§15.7.1): BranchRecord with the room's fields */
export interface BranchRow {
  branchKey: string;
  mainKey: string;
  name: string;
  status: BranchStatus;
  createdBy: { id: string | null; name: string | null };
  createdAt: number;
  /** The main room's seq the base is */
  baseSeq: number;
  mainSeenSeq: number;
  sessionBase: number;
  archivedAt: number | null;
  archivedBy?: string | null;
  mergedAt: number | null;
  mergedBy: string | null;
  mergeVersionId: string | null;
  review: BranchReview | null;
}

/** A shared file's link as the multiplayer service keeps it */
export interface SyncState {
  key: string;
  /** The last room seq the local copy holds */
  since: number;
  /** The last local journal seq the room acknowledged */
  acked: number;
  connection: "live" | "connecting" | "offline";
  /** Local frames sent and not acknowledged yet */
  pending: number;
  /** This copy's own journal frames the room hasn't acknowledged (other people's frames at the tail don't count). Absent: `acked` against the head. */
  unsent?: number;
}

export interface RemoteDeps {
  /** A JSON call to the server with the session (Uint8Array bodies go as bytes) */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** The file's link, null when it isn't shared */
  syncState(fileKey: FileKey): Promise<SyncState | null>;
  /** Registers a local file through `register`, uploads its images and snapshot, links it to room `key` */
  shareTo<T>(fileKey: FileKey, input: { snapshot: Uint8Array; headSeq: number }, register: (key: string, name: string) => Promise<T>, key?: string): Promise<T>;
  newRoomKey(base: string): string;
  /** Room key → the local copy linked to it */
  linkedCopies(): Promise<Map<string, FileKey>>;
  /** The local journal's head of a file */
  headSeq(fileKey: FileKey): Promise<number>;
  signedIn(): boolean;
  /**
   * Uploads the images (SHA-1s) a room doesn't have yet from the store's blobs (`MultiplayerService.uploadBlobs`, as a
   * link does before each of its frames). A merge / update batch is sent by the Worker, not by a link: its images go
   * up first through this. Absent: nothing is uploaded.
   */
  uploadBlobs?(roomKey: string, sha1s: string[]): Promise<void>;
  /** A call answering bytes (a branch's base); absent: branches made elsewhere aren't taken in */
  callBytes?(method: string, path: string): Promise<{ bytes: Uint8Array; headers: Headers }>;
  /**
   * Joins a file's room for a while when this client isn't in it (`MultiplayerService.visit`: a browser tab joins only
   * the file it edits, so a merge from the branch's tab joins main's room); returns the release. Absent: every shared
   * file's room is joined already.
   */
  visit?(fileKey: FileKey): Promise<() => void>;
  /** Waits (tests: a fake clock); default setTimeout */
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** How long a merge or an update waits for both copies to catch up with their rooms before it gives up */
export const CATCH_UP_TIMEOUT_MS = 15_000;

/** The images a batch uses (none when it isn't a kiwi Message) */
export function batchImages(batch: Uint8Array): string[] {
  try {
    return [...messageImageHashes(decodeMessage(batch))];
  } catch {
    return [];
  }
}

const seg = (s: string) => encodeURIComponent(s);

/** `roomBox.ts encodeEnvelope`: [u32 BE JSON length][JSON, UTF-8][kiwi Message] */
export function encodeEnvelope(meta: unknown, message: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + head.length + message.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(message, 4 + head.length);
  return out;
}

/** The server's 409 `stale` as the store's `stale` */
async function staleAware<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isStoreError(e) && (e.detail as { code?: unknown } | undefined)?.code === "stale") throw new StoreError("stale", "The files changed since the preview. Review the changes again.", e.detail);
    throw e;
  }
}

export class RemoteBranches {
  constructor(private readonly d: RemoteDeps) {}

  /** Is the file a shared one (its branches live on the server)? */
  async isShared(fileKey: FileKey): Promise<boolean> {
    return (await this.d.syncState(fileKey)) !== null;
  }

  private async link(fileKey: FileKey): Promise<SyncState> {
    const s = await this.d.syncState(fileKey);
    if (!s) throw new StoreError("invalid", "This file isn't shared");
    if (!this.d.signedIn()) throw new StoreError("offline", "Log in to work with this file's branches");
    return s;
  }

  /** The room seq a file's local copy holds (main's: the notice compares it with the base) */
  async roomSeq(fileKey: FileKey): Promise<number> {
    return (await this.link(fileKey)).since;
  }

  /** The link is live, nothing waits to be sent and the room has every local frame (a merge needs it: §15.5 step 1). */
  async caughtUp(fileKey: FileKey): Promise<boolean> {
    const s = await this.d.syncState(fileKey);
    if (!s || s.connection !== "live" || s.pending !== 0) return false;
    return s.unsent !== undefined ? s.unsent === 0 : s.acked >= (await this.d.headSeq(fileKey));
  }

  /**
   * Brings a shared file's local copy up to date with its room (§15.5 step 1): joins the room when this client isn't in
   * it (`visit`), then waits until the link is live with nothing unacknowledged. Resolves with the release (the caller
   * releases once it's done); rejects `offline` after `timeoutMs` — a merge never waits forever on a room.
   */
  async catchUp(fileKey: FileKey, timeoutMs = CATCH_UP_TIMEOUT_MS): Promise<() => void> {
    await this.link(fileKey);
    const release = this.d.visit ? await this.d.visit(fileKey) : () => {};
    const now = this.d.now ?? Date.now;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = now() + timeoutMs;
    try {
      while (!(await this.caughtUp(fileKey))) {
        if (now() >= until) {
          const s = await this.d.syncState(fileKey);
          throw new StoreError("offline", s?.connection === "live" ? "Changes to this file are still being saved. Try again in a moment." : "Couldn’t reach this file’s room. Check your connection and try again.", { fileKey, connection: s?.connection ?? "offline", pending: s?.pending ?? 0 });
        }
        await sleep(50);
      }
    } catch (e) {
      release();
      throw e;
    }
    return release;
  }

  /** `POST /files/:main/branches`, then the branch room's snapshot (its "Branch created") and base; the local copy linked. */
  async create(input: { mainFileKey: FileKey; branchFileKey: FileKey; name: string; snapshot: Uint8Array }): Promise<{ record: BranchRecord; mainVersionId: string | null }> {
    const main = await this.link(input.mainFileKey);
    const baseSeq = main.since;
    let answer: { branch: BranchRow; sessionBase: number; mainVersionId?: string } | null = null;
    await this.d.shareTo(
      input.branchFileKey,
      { snapshot: input.snapshot, headSeq: 0 },
      async (key, name) => {
        answer = await this.d.call<{ branch: BranchRow; sessionBase: number; mainVersionId?: string }>("POST", `/files/${seg(main.key)}/branches`, { branchKey: key, name, baseSeq });
        return answer;
      },
      this.d.newRoomKey(input.branchFileKey),
    );
    if (!answer) throw new StoreError("invalid", "The server didn't make the branch");
    const made = answer as { branch: BranchRow; mainVersionId?: string };
    await this.d.call("PUT", `/branches/${seg(made.branch.branchKey)}/base?seq=${baseSeq}`, input.snapshot);
    return { record: recordOf(made.branch, input.branchFileKey, input.mainFileKey), mainVersionId: made.mainVersionId ?? null };
  }

  async list(mainFileKey: FileKey, tab: "active" | "archived" | "yours"): Promise<BranchRecord[]> {
    const main = await this.link(mainFileKey);
    const { branches } = await this.d.call<{ branches: BranchRow[] }>("GET", `/files/${seg(main.key)}/branches?tab=${tab}`);
    const copies = await this.d.linkedCopies();
    return branches.map((b) => recordOf(b, copies.get(b.branchKey) ?? "", mainFileKey));
  }

  async patch(r: BranchRecord, patch: { name?: string; status?: "archived" | "active" }): Promise<BranchRecord> {
    const { branch } = await this.d.call<{ branch: BranchRow }>("PATCH", `/branches/${seg(r.branchKey!)}`, patch);
    return recordOf(branch, r.branchFileKey, r.mainFileKey);
  }

  /**
   * Update from main: main's head (`mainSeq`) staged as the new base, then the batch applied to the branch room at
   * `branchSeq` — one call; the base moves in the same step.
   */
  async update(r: BranchRecord, input: { mainSeq: number; branchSeq: number; base: Uint8Array; batch: Uint8Array }): Promise<{ record: BranchRecord; seq: number; versionId: string }> {
    // The batch's images reach the branch room before the frame that uses them (as a link's frames do).
    await this.uploadImages(r.branchKey!, input.batch);
    await this.d.call("PUT", `/branches/${seg(r.branchKey!)}/base?seq=${input.mainSeq}`, input.base);
    const res = await staleAware(this.d.call<{ branch: BranchRow; seq: number; versionId: string }>("POST", `/branches/${seg(r.branchKey!)}/update`, encodeEnvelope({ mainSeq: input.mainSeq, branchSeq: input.branchSeq }, input.batch)));
    return { record: recordOf(res.branch, r.branchFileKey, r.mainFileKey), seq: res.seq, versionId: res.versionId };
  }

  /** Merge: the branch frozen at `branchSeq`, main's pre-merge autosave, the batch as main's next frame and the versions — one call. */
  async merge(r: BranchRecord, input: { mainSeq: number; branchSeq: number; title?: string; description?: string; batch: Uint8Array }): Promise<{ record: BranchRecord; mainSeq: number; versionId: string; preVersionId: string; branchVersionId: string }> {
    // The branch's images reach main's room before the merge frame that uses them.
    await this.uploadImages(r.mainKey!, input.batch);
    const meta = { mainSeq: input.mainSeq, branchSeq: input.branchSeq, ...(input.title ? { title: input.title } : {}), ...(input.description ? { description: input.description } : {}) };
    const res = await staleAware(this.d.call<{ branch: BranchRow; mainSeq: number; versionId: string; preVersionId: string; branchVersionId: string }>("POST", `/branches/${seg(r.branchKey!)}/merge`, encodeEnvelope(meta, input.batch)));
    return { record: recordOf(res.branch, r.branchFileKey, r.mainFileKey), mainSeq: res.mainSeq, versionId: res.versionId, preVersionId: res.preVersionId, branchVersionId: res.branchVersionId };
  }

  /** Whether branches made elsewhere can be taken in (their base read from the room) */
  get canAdopt(): boolean {
    return !!this.d.callBytes;
  }

  /** A shared branch's base (`GET /branches/:key/base`): the snapshot Message the merge starts from */
  async base(branchKey: string): Promise<Uint8Array> {
    if (!this.d.callBytes) throw new StoreError("invalid", "This store can't read a branch's base");
    return (await this.d.callBytes("GET", `/branches/${seg(branchKey)}/base`)).bytes;
  }

  private async uploadImages(roomKey: string, batch: Uint8Array): Promise<void> {
    const images = batchImages(batch);
    if (images.length && this.d.uploadBlobs) await this.d.uploadBlobs(roomKey, images);
  }

  /** A room version as a VersionRecord (what `merge` answers with) */
  async version(fileKey: FileKey, id: string): Promise<VersionRecord> {
    const s = await this.link(fileKey);
    const { version } = await this.d.call<{ version: Partial<VersionRecord> & { id: string } }>("GET", `/files/${seg(s.key)}/versions/${seg(id)}`);
    return { kind: "merge", title: null, description: null, createdAt: 0, seq: 0, sizeBytes: 0, blobRefs: [], restoredFrom: null, libraryVersion: null, ...version } as VersionRecord;
  }

  async requestReview(r: BranchRecord, reviewerIds: string[], description: string): Promise<BranchReview> {
    const { review } = await this.d.call<{ review: BranchReview }>("POST", `/branches/${seg(r.branchKey!)}/reviews`, { reviewerIds, description });
    return review;
  }

  async answerReview(r: BranchRecord, verdict: "approved" | "changes-suggested", comment: string): Promise<BranchReview> {
    if (!r.review) throw new StoreError("invalid", "No review was requested");
    const { review } = await this.d.call<{ review: BranchReview }>("POST", `/branches/${seg(r.branchKey!)}/reviews/${seg(r.review.id)}/verdict`, { verdict, ...(comment ? { comment } : {}) });
    return review;
  }
}

/** A server `branch` as the store's record (the local copy's key and main's) */
export function recordOf(b: BranchRow, branchFileKey: FileKey, mainFileKey: FileKey): BranchRecord {
  return {
    branchFileKey,
    mainFileKey,
    mainKey: b.mainKey,
    branchKey: b.branchKey,
    name: b.name,
    createdBy: { id: b.createdBy?.id ?? null, name: b.createdBy?.name ?? null },
    createdAt: b.createdAt,
    status: b.status,
    base: { mainSeq: b.baseSeq, mainVersionId: null, at: b.createdAt },
    mainSeenSeq: b.mainSeenSeq,
    archivedAt: b.archivedAt,
    mergedAt: b.mergedAt,
    mergedBy: b.mergedBy,
    mergeVersionId: b.mergeVersionId,
    review: b.review ?? null,
  };
}
