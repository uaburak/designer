/**
 * File settings (ours — Figma has no such screen; docs/home.md "File settings [ours]"): what Home's "File settings…"
 * dialog shows about one file. The local half comes from the store (`files.details`: the file's bytes on this
 * computer, its versions and the edit sessions its journal still holds); the server half from the file's room
 * (`multiplayer.fileReport` / `multiplayer.fileActivity` → `GET /files/:key/report`, `GET /files/:key/activity`).
 * Pure helpers here (the activity merged, filtered and paged; the storage bars) are shared by the store and the view.
 */
import type { FileKey, FileMeta, VersionRecord } from "./types";

/** What the file's bytes are, on this computer or on the server */
export type StorageKind = "document" | "images" | "media" | "versions" | "previews" | "thumbnail" | "other";
export const STORAGE_KINDS: readonly StorageKind[] = ["document", "images", "media", "versions", "previews", "thumbnail", "other"];

export interface StoragePart {
  kind: StorageKind;
  bytes: number;
  /** How many items (images, videos and sounds, versions, previews); absent where a count says nothing (the document) */
  count?: number;
}

/** One entry of a file's activity log, local or from the server */
export type FileActivityKind =
  | "created"
  | "imported"
  | "opened"
  | "edited"
  | "version"
  | "restored"
  | "published"
  | "branch"
  | "merged"
  | "shared"
  | "access"
  | "comment"
  | "exported"
  | "preview";
export const FILE_ACTIVITY_KINDS: readonly FileActivityKind[] = ["created", "imported", "opened", "edited", "version", "restored", "published", "branch", "merged", "shared", "access", "comment", "exported", "preview"];

/** The log's filter groups (the dialog's "All activity" select) */
export type ActivityFilter = "all" | "edits" | "versions" | "sharing" | "comments" | "views";
export const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "edits", "versions", "sharing", "comments", "views"];
const FILTER_KINDS: Record<Exclude<ActivityFilter, "all">, readonly FileActivityKind[]> = {
  edits: ["created", "imported", "edited", "exported", "preview"],
  versions: ["version", "restored", "published", "branch", "merged"],
  sharing: ["shared", "access"],
  comments: ["comment"],
  views: ["opened"],
};
export const kindsOf = (f: ActivityFilter): readonly FileActivityKind[] => (f === "all" ? FILE_ACTIVITY_KINDS : FILTER_KINDS[f]);

export interface FileActivityEvent {
  /** Unique within the merged log ("l:" local, "s:" server) */
  id: string;
  at: number;
  kind: FileActivityKind;
  /** The exact thing within the kind ("renamed", "member-added", "reply", "autosave" …; FileSettings' ACTION_LABEL) */
  action: string;
  /** Who did it: a name or an email; null: this computer (a local file) or not recorded */
  actor: string | null;
  /** What exactly (a version's title, "3 changes", an email given access, the role …), in the log's second line */
  detail: string | null;
  /** How many changes an "edited" entry holds, or how many opens an "opened" one */
  count?: number;
  /** Where it was recorded */
  source: "local" | "server";
}

/** `files.details(fileKey)`: the file on this computer */
export interface FileDetails {
  fileKey: FileKey;
  /** The document's own bytes here (head snapshot, journal, its previous generation, ui and undo state) */
  storage: StoragePart[];
  /** Every byte the file takes here (images counted once each, even when shared with other files) */
  totalBytes: number;
  /** False: listed (a cloud draft) but its document isn't on this computer */
  documentHere: boolean;
  versions: { total: number; named: number; autosaves: number; latestAt: number | null };
  /** The journal's newest frame (null: nothing since the last compaction) */
  lastEditAt: number | null;
  /** Images and media the file uses that aren't here yet */
  missingImages: number;
  /** The local half of the activity log, newest first */
  activity: FileActivityEvent[];
}

/** `GET /files/:key/report` (server/src/files/report.ts) through `multiplayer.fileReport` */
export interface FileServerReport {
  key: string;
  name: string;
  owner: { id: string; name: string | null; email: string; picture: string | null } | null;
  createdAt: number;
  updatedAt: number;
  /** Who last changed it (the room's last writer), when known */
  lastEditedBy: string | null;
  /** The caller's role */
  role: string;
  /** Where it lives on the server */
  place: { kind: "drafts" | "shared" | "org"; orgName: string | null; teamName: string | null; projectName: string | null };
  /** The file's bytes on the server (snapshot, images, media, versions, previews, thumbnail) */
  storage: StoragePart[];
  totalBytes: number;
  versions: number;
  branches: number;
  comments: { threads: number; open: number };
  previews: number;
  /** People who opened it (the room's sessions), most recent first */
  visitors: { userId: string; name: string | null; email: string; picture: string | null; lastAt: number; opens: number }[];
  /** The owner's account quota (the public sign-up limits, src/shared/quota.ts), when the caller is the owner */
  quota: { storageBytes: number; storageLimit: number; files: number; filesLimit: number; previews: number; previewsLimit: number } | null;
}

/** One page of the server's log (`GET /files/:key/activity?cursor=&kinds=&limit=`) */
export interface FileActivityPage {
  events: FileActivityEvent[];
  /** Pass as `cursor` for the next page; null: no more */
  next: number | null;
}

export const ACTIVITY_PAGE = 50;

/** Local and server events in one log, newest first; the same event recorded twice (a version saved here and in the
 *  room) kept once — the server's. */
export function mergeActivity(local: readonly FileActivityEvent[], server: readonly FileActivityEvent[]): FileActivityEvent[] {
  const seen = new Set(server.map((e) => `${e.kind}:${Math.round(e.at / 1000)}`));
  const out = [...server, ...local.filter((e) => !seen.has(`${e.kind}:${Math.round(e.at / 1000)}`))];
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

export function filterActivity(events: readonly FileActivityEvent[], filter: ActivityFilter, text = ""): FileActivityEvent[] {
  const kinds = new Set(kindsOf(filter));
  const needle = text.trim().toLowerCase();
  return events.filter((e) => kinds.has(e.kind) && (!needle || `${e.actor ?? ""} ${e.detail ?? ""}`.toLowerCase().includes(needle)));
}

/** A bar's share, 0–1 (an empty or unknown limit: 0) */
export const share = (used: number, limit: number): number => (limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0);

/** The local activity a file's versions say: created / imported, named versions, restores, publishes, branches, merges
 *  and the autosaves' editing sessions */
export function versionActivity(versions: readonly VersionRecord[], created: { at: number; imported: string | null }): FileActivityEvent[] {
  const out: FileActivityEvent[] = [];
  const hasImport = versions.some((v) => v.kind === "import");
  if (!hasImport) out.push({ id: "l:created", at: created.at, kind: created.imported ? "imported" : "created", action: created.imported ? "imported" : "created", actor: null, detail: created.imported, source: "local" });
  for (const v of versions) {
    const kind: FileActivityKind | null =
      v.kind === "named" ? "version" : v.kind === "restore" ? "restored" : v.kind === "publish" ? "published" : v.kind === "branch" ? "branch" : v.kind === "merge" || v.kind === "update" ? "merged" : v.kind === "import" ? "imported" : v.kind === "autosave" ? "edited" : null;
    if (!kind) continue;
    const detail = v.kind === "import" ? created.imported : v.title || (v.kind === "publish" && v.libraryVersion !== null ? `v${v.libraryVersion}` : null);
    // Local versions name their editors by account id: not shown
    out.push({ id: `l:v:${v.id}`, at: v.createdAt, kind, action: v.kind === "named" ? "named" : v.kind === "branch" ? "branch-created" : v.kind === "restore" ? "restored" : v.kind === "merge" ? "merged" : v.kind === "update" ? "updated" : v.kind, actor: null, detail, source: "local" });
  }
  return out;
}

/** The journal's frames since the last compaction, one "edited" entry per editing session */
export function sessionActivity(frames: readonly { sessionID: number; wallClock: number; kind: string }[]): FileActivityEvent[] {
  const bySession = new Map<number, { last: number; n: number }>();
  for (const f of frames) {
    if (f.kind !== "edit" && f.kind !== "undo" && f.kind !== "redo" && f.kind !== "restore") continue;
    const s = bySession.get(f.sessionID) ?? { last: 0, n: 0 };
    s.last = Math.max(s.last, f.wallClock);
    s.n++;
    bySession.set(f.sessionID, s);
  }
  return [...bySession.entries()].map(([sid, s]) => ({ id: `l:s:${sid}`, at: s.last, kind: "edited" as const, action: "session", actor: null, detail: null, count: s.n, source: "local" as const }));
}

/** What the store read about one file, for `fileDetailsOf` (the desktop store from disk, the dev store from memory) */
export interface FileDetailsInput {
  meta: FileMeta;
  documentHere: boolean;
  disk: { document: number; versions: number; thumbnail: number; frames: readonly { sessionID: number; wallClock: number; kind: string }[] };
  versions: readonly VersionRecord[];
  /** The file's images and media (`null`: not here yet) */
  blobs: readonly ({ size: number; kind: "image" | "media" | "other" } | null)[];
  /** Its developer previews: how many, when each was published, and the bytes of images only they keep */
  previews: { count: number; at: readonly number[]; bytes: number };
}

export function fileDetailsOf(i: FileDetailsInput): FileDetails {
  const sum = (kind: "image" | "media" | "other") => {
    const of = i.blobs.filter((b): b is { size: number; kind: typeof kind } => !!b && b.kind === kind);
    return { bytes: of.reduce((n, b) => n + b.size, 0), count: of.length };
  };
  const images = sum("image");
  const media = sum("media");
  const other = sum("other");
  const storage: StoragePart[] = [
    { kind: "document", bytes: i.disk.document },
    { kind: "images", ...images },
    { kind: "media", ...media },
    { kind: "versions", bytes: i.disk.versions, count: i.versions.length },
    { kind: "previews", bytes: i.previews.bytes, count: i.previews.count },
    { kind: "thumbnail", bytes: i.disk.thumbnail },
    ...(other.count ? [{ kind: "other" as const, ...other }] : []),
  ];
  const named = i.versions.filter((v) => v.kind !== "autosave").length;
  const lastEditAt = i.disk.frames.reduce<number | null>((n, f) => (n === null || f.wallClock > n ? f.wallClock : n), null);
  const activity = [
    ...versionActivity(i.versions, { at: i.meta.createdAt, imported: i.meta.importedFrom?.name ?? null }),
    ...sessionActivity(i.disk.frames),
    ...i.previews.at.map((at, n): FileActivityEvent => ({ id: `l:p:${n}`, at, kind: "preview", action: "preview", actor: null, detail: null, source: "local" })),
  ].sort((a, b) => b.at - a.at);
  return {
    fileKey: i.meta.fileKey,
    storage,
    totalBytes: storage.reduce((n, p) => n + p.bytes, 0),
    documentHere: i.documentHere,
    versions: { total: i.versions.length, named, autosaves: i.versions.length - named, latestAt: i.versions.reduce<number | null>((n, v) => (n === null || v.createdAt > n ? v.createdAt : n), null) },
    lastEditAt,
    missingImages: i.blobs.filter((b) => !b).length,
    activity,
  };
}

export type BlobKind = "image" | "media" | "other";

/** An image (PNG, JPEG, GIF, WebP, SVG), a video or sound (MP4 / MOV, WebM, MP3, WAV, Ogg), or something else, from a
 *  blob's first bytes (16 are enough) */
export function blobKind(b: Uint8Array): BlobKind {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
  if (b.length >= 4 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "image";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image";
  if (ascii(0, 4) === "GIF8") return "image";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image";
  if (ascii(4, 8) === "ftyp") return "media";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "media";
  if (ascii(0, 3) === "ID3") return "media";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "media";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "media";
  if (ascii(0, 4) === "OggS") return "media";
  const text = ascii(0, 16).trimStart();
  if (text.startsWith("<svg") || text.startsWith("<?xml")) return "image";
  return "other";
}
