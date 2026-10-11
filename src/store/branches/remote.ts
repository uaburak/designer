/**
 * Branches of shared (room) files over the server's routes (docs/data.md §15.7). A shared main's branch is a room of
 * its own, linked to a local copy as any shared file (docs/multiplayer.md §5); the records live in D1 (`branches`,
 * `branch_reviews`, `branch_reviewers`) and the base in the branch room's storage. The merge itself is computed here
 * (the room never decodes kiwi): its batch is one journal frame on main's local copy, which main's link sends as one
 * room frame; `POST /branches/:key/merged` follows once the room acknowledged it.
 *
 * The routes are built by round 2c; until then `fake/server.ts` answers them (as src/store/org/fake does for §14.12).
 *
 * The rows' JSON (`BranchRow`) is this client's reading of §15.7's columns in camelCase — 2c answers in this shape.
 */
import type { BranchRecord, BranchReview, BranchStatus } from "../../shared/merge/branches";
import { StoreError } from "../../shared/store/protocol";
import type { FileKey, VersionRecord } from "../../shared/store/types";

/** `branches` row as the server answers it (docs/data.md §15.7) */
export interface BranchRow {
  key: string;
  mainKey: string;
  name: string;
  status: BranchStatus;
  createdBy: string;
  createdByName?: string | null;
  createdAt: number;
  /** The main room's seq the base is */
  baseSeq: number;
  mainSeenSeq: number;
  /** First session id of the branch room's block */
  sessionBase: number;
  archivedAt: number | null;
  mergedAt: number | null;
  mergedBy: string | null;
  mergeVersion: string | null;
  /** The latest review, with its reviewers */
  review?: BranchReview | null;
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
  sleep(ms: number): Promise<void>;
}

const seg = (s: string) => encodeURIComponent(s);
/** How long a merge waits for the room to acknowledge its frame */
export const SEND_TIMEOUT_MS = 30_000;

export class RemoteBranches {
  constructor(private readonly d: RemoteDeps) {}

  /** Is the file a shared one (its branches live on the server)? */
  async isShared(fileKey: FileKey): Promise<boolean> {
    return (await this.d.syncState(fileKey)) !== null;
  }

  private async keyOf(fileKey: FileKey): Promise<SyncState> {
    const s = await this.d.syncState(fileKey);
    if (!s) throw new StoreError("invalid", "This file isn't shared");
    if (!this.d.signedIn()) throw new StoreError("offline", "Log in to work with this file's branches");
    return s;
  }

  /** The room seq main's local copy holds (the notice compares it with the base) */
  async mainRoomSeq(mainFileKey: FileKey): Promise<number> {
    return (await this.keyOf(mainFileKey)).since;
  }

  /** `POST /files/:key/branches`, then the branch room's snapshot and base; the local copy linked to it. */
  async create(input: { mainFileKey: FileKey; branchFileKey: FileKey; name: string; snapshot: Uint8Array; localBaseSeq: number }): Promise<BranchRecord> {
    const main = await this.keyOf(input.mainFileKey);
    const baseSeq = main.since;
    let row: BranchRow | null = null;
    await this.d.shareTo(
      input.branchFileKey,
      { snapshot: input.snapshot, headSeq: 0 },
      async (key, name) => {
        const r = await this.d.call<{ branch: BranchRow; sessionBase: number }>("POST", `/files/${seg(main.key)}/branches`, { branchKey: key, name, baseSeq });
        row = r.branch;
        return r;
      },
      this.d.newRoomKey(input.branchFileKey),
    );
    if (!row) throw new StoreError("invalid", "The server didn't make the branch");
    const made: BranchRow = row;
    await this.d.call("PUT", `/branches/${seg(made.key)}/base?seq=${baseSeq}`, input.snapshot);
    return recordOf(made, input.branchFileKey, input.mainFileKey);
  }

  async list(mainFileKey: FileKey, tab: "active" | "archived" | "yours"): Promise<BranchRecord[]> {
    const main = await this.keyOf(mainFileKey);
    const { branches } = await this.d.call<{ branches: BranchRow[] }>("GET", `/files/${seg(main.key)}/branches?tab=${tab}`);
    const copies = await this.d.linkedCopies();
    return branches.map((b) => recordOf(b, copies.get(b.key) ?? "", mainFileKey));
  }

  async patch(r: BranchRecord, patch: { name?: string; status?: "archived" | "active" }): Promise<BranchRecord> {
    const { branch } = await this.d.call<{ branch: BranchRow }>("PATCH", `/branches/${seg(r.branchKey!)}`, patch);
    return recordOf(branch, r.branchFileKey, r.mainFileKey);
  }

  /** After Update from main's frame is in the branch room: the new base, then `POST /branches/:key/updated`. */
  async updated(r: BranchRecord, base: Uint8Array): Promise<BranchRecord> {
    const baseSeq = await this.mainRoomSeq(r.mainFileKey);
    await this.d.call("PUT", `/branches/${seg(r.branchKey!)}/base?seq=${baseSeq}`, base);
    const { branch } = await this.d.call<{ branch: BranchRow }>("POST", `/branches/${seg(r.branchKey!)}/updated`, { baseSeq, mainSeenSeq: baseSeq });
    return recordOf(branch, r.branchFileKey, r.mainFileKey);
  }

  /** After the merge frame is acknowledged by main's room. */
  async merged(r: BranchRecord, version: VersionRecord): Promise<BranchRecord> {
    const mainSeq = await this.mainRoomSeq(r.mainFileKey);
    const { branch } = await this.d.call<{ branch: BranchRow }>("POST", `/branches/${seg(r.branchKey!)}/merged`, { mainSeq, versionId: version.id });
    return recordOf(branch, r.branchFileKey, r.mainFileKey);
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

  /** Main's link is live, with nothing waiting to be sent (a merge needs it: §15.5 step 1). */
  async caughtUp(fileKey: FileKey): Promise<boolean> {
    const s = await this.d.syncState(fileKey);
    return !!s && s.connection === "live" && s.pending === 0 && s.acked >= (await this.d.headSeq(fileKey));
  }

  /** Resolves once the room acknowledged every local frame of the file (`offline` after SEND_TIMEOUT_MS). */
  async whenSent(fileKey: FileKey, timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
    const head = await this.d.headSeq(fileKey);
    for (let waited = 0; ; waited += 100) {
      const s = await this.d.syncState(fileKey);
      if (!s) return;
      if (s.acked >= head && s.pending === 0) return;
      if (waited >= timeoutMs) throw new StoreError("offline", "The change couldn't be sent to the file's room. Try again when you're online.");
      await this.d.sleep(100);
    }
  }
}

/** A server row as the store's record (the local copy's key and main's) */
export function recordOf(b: BranchRow, branchFileKey: FileKey, mainFileKey: FileKey): BranchRecord {
  return {
    branchFileKey,
    mainFileKey,
    mainKey: b.mainKey,
    branchKey: b.key,
    name: b.name,
    createdBy: { id: b.createdBy, name: b.createdByName ?? null },
    createdAt: b.createdAt,
    status: b.status,
    base: { mainSeq: b.baseSeq, mainVersionId: null, at: b.createdAt },
    mainSeenSeq: b.mainSeenSeq,
    archivedAt: b.archivedAt,
    mergedAt: b.mergedAt,
    mergedBy: b.mergedBy,
    mergeVersionId: b.mergeVersion,
    review: b.review ?? null,
  };
}
