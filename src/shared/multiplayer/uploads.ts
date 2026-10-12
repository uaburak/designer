/**
 * Uploads to the server (docs/multiplayer.md §5.1): a file moved into an org or team folder, shared, or made in an org —
 * its images and snapshot going up — as the store reports them on the `uploads` event topic, for the upload panel
 * (Home and every editor) and main's quit question. Plain data: structured clones over the store's ports.
 */
import type { FileKey } from "../store/types";

export type UploadStateKind = "queued" | "uploading" | "retrying" | "done" | "failed";

export interface UploadProgress {
  id: string;
  fileKey: FileKey;
  /** The file's name */
  name: string;
  /** Where it goes, as the panel says it: "Anex Tour › Design › KOC", "Drafts" */
  destination: string;
  bytesSent: number;
  /** 0 until the store knows (the images the room lacks are asked first) */
  bytesTotal: number;
  state: UploadStateKind;
  /** `retrying`: the try under way (2, 3, …) */
  attempt?: number;
  /** `failed`: the words to show */
  error?: string;
  startedAt: number;
  /** `done` / `failed`: when */
  endedAt?: number;
  /** The panel offers Retry when it fails (a share or move does; a library publish is published again instead) */
  retryable: boolean;
}

/** The topic's events: an upload's latest state (the panel keeps the last per id), or one gone (cancelled) */
export type UploadEvent = { upload: UploadProgress } | { removed: string };

/** Still going: the panel's "Uploading", main's "Uploads in progress" */
export const uploadInFlight = (u: Pick<UploadProgress, "state">): boolean => u.state === "queued" || u.state === "uploading" || u.state === "retrying";

/** The store says an upload was cancelled (`StoreError.detail.code`) */
export const UPLOAD_CANCELED = "upload_canceled";
export const UPLOAD_CANCELED_TEXT = "Upload canceled";
