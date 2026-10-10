/**
 * The store's `multiplayer` repository (docs/multiplayer.md §5): what views and main may ask of the store about shared
 * files. The session token goes in through `setSession` (main only, desktop; the page itself in the browser).
 */
import type { FileKey } from "../store/types";
import type { PeerInfo, Role } from "./protocol";

export interface MultiplayerSession {
  server: string;
  token: string;
}

export interface MultiplayerStatus {
  signedIn: boolean;
  server: string | null;
  deviceOrdinal: number;
}

/** A file on the server, as Home lists it */
export interface RemoteFile {
  key: string;
  name: string;
  role: Role;
  ownerId: string;
  /** "From <name>" */
  ownerName: string | null;
  /** When it was shared with the user */
  sharedAt: number;
  updatedAt: number;
  /** The local file linked to it, if this installation has one */
  fileKey: FileKey | null;
}

export interface FileMember {
  email: string;
  userId: string | null;
  name: string | null;
  role: Role;
  /** Invited by email; no account signed in with it yet */
  pending: boolean;
}

export interface FileShareState {
  shared: boolean;
  /** The room's file key */
  key: string | null;
  role: Role | null;
  connection: "offline" | "connecting" | "live";
  peers: PeerInfo[];
  /** "Ask to edit" requests waiting (editors only; the Share button's badge) */
  requests: number;
  /** This client's session in the room while live (peers' `sessionID`s are the same kind) */
  me?: number | null;
  /** The file's link password changed and this user (in by the link) must enter it: the link waits (`unlockFile`) */
  locked?: boolean;
}

export interface AccessRequest {
  userId: string;
  email: string;
  name: string | null;
  createdAt: number;
}

export type MultiplayerNotice = { kind: "access-request" | "access-granted" | "access-denied"; name?: string };

export interface MultiplayerEvent {
  fileKey: FileKey;
  state: FileShareState;
  /** This copy fell behind the room's history and a fresh copy replaced it as the linked one (the old one stays) */
  replacedBy?: FileKey;
  notice?: MultiplayerNotice;
  /** A message from one session of the room to this one ("Ask to spotlight", audio's WebRTC signalling) */
  signal?: { from: number; data: unknown };
}

/** What a person in a file shares with the others (docs/multiplayer.md §6), at most ~10 times a second */
export interface PresenceData {
  /** Page coordinates on `page`; null when the pointer is off the canvas */
  cursor: { x: number; y: number } | null;
  page: string;
  selection: string[];
  /** The page point at the centre of their visible canvas, and their zoom (followers centre on it) */
  view: { x: number; y: number; zoom: number } | null;
  /** "Spotlight me": everyone in the file follows them */
  spotlight?: boolean;
  /** Cursor chat: what they are typing ("" = the bubble is open, nothing typed yet); absent = no bubble */
  chat?: string;
  /** In the file's audio conversation (Figma: one per file); `muted` their microphone */
  audio?: { muted: boolean };
}

export type LinkAccess = "none" | "viewer" | "editor";

/** A shared file's name, the caller's role, the link setting and the link itself */
export interface SharedFileInfo {
  key: string;
  name: string;
  role: Role;
  linkAccess: LinkAccess;
  /** "Viewers can copy, save, and export from this file" */
  viewersCanCopy: boolean;
  /** "Password required" for people who reach it by the link */
  passwordProtected?: boolean;
  /** The caller is in by the link alone and hasn't entered the current password */
  needsPassword?: boolean;
  link: string;
}

/** Where a link lands in its file: a frame or page (Figma's `node-id=1-2`) and a mode (`m=dev` Dev Mode, `m=proto` the
 *  prototype) */
export interface OpenIntent {
  nodeId?: string;
  mode?: "dev" | "proto";
}

/** A link's `node-id` and `m`, as Figma writes them; null fields are left out. */
export function intentFromLink(text: string): OpenIntent {
  const out: OpenIntent = {};
  const node = /[?&]node-id=([0-9]+)[-:]([0-9]+)/.exec(text);
  if (node) out.nodeId = `${node[1]}:${node[2]}`;
  const mode = /[?&]m=(dev|proto)\b/.exec(text);
  if (mode) out.mode = mode[1] as "dev" | "proto";
  return out;
}

/** A file's link with a frame and mode: `node-id` with a hyphen, as Figma's links. */
export function linkWith(link: string, intent: OpenIntent): string {
  const u = new URL(link);
  if (intent.nodeId) u.searchParams.set("node-id", intent.nodeId.replace(":", "-"));
  if (intent.mode) u.searchParams.set("m", intent.mode);
  return u.toString();
}

/** The room key in a file's link (https://…/f/<key>) or a bare key; null when it is neither. */
export function keyFromLink(text: string): string | null {
  const t = text.trim();
  const m = /\/f\/([A-Za-z0-9_-]{6,64})(?:[/?#]|$)/.exec(t) ?? /[?&]key=([A-Za-z0-9_-]{6,64})/.exec(t);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{6,64}$/.test(t) ? t : null;
}

export interface MultiplayerRepository {
  setSession(session: MultiplayerSession | null): Promise<MultiplayerStatus>;
  status(): Promise<MultiplayerStatus>;
  fileState(fileKey: FileKey): Promise<FileShareState>;
  /** Shares a local file: `snapshot` is the editor's `encodeDocumentKiwi()` of it at journal seq `headSeq` */
  share(fileKey: FileKey, input: { snapshot: Uint8Array; headSeq: number }): Promise<FileShareState>;
  listRemote(): Promise<RemoteFile[]>;
  /** The local copy of a file shared with the user — by invite or by its link (made from the room's snapshot the first
   *  time). A link with a password needs `password` (the error's detail is `{passwordRequired: true, wrong?: true}`). */
  openShared(key: string, password?: string, intent?: OpenIntent): Promise<{ fileKey: FileKey }>;
  /** Where the link that opened this file asked to land (once; the editor reads it when it opens) */
  takeOpenIntent(fileKey: FileKey): Promise<OpenIntent | null>;
  /** A changed link password for an open shared file (`FileShareState.locked`) */
  unlockFile(fileKey: FileKey, password: string): Promise<FileShareState>;
  /** "Password required" (null: off) — anyone who can edit */
  setLinkPassword(fileKey: FileKey, password: string | null): Promise<SharedFileInfo>;
  /** "Transfer ownership" to an invited member — owner only, can't be undone */
  transferOwnership(fileKey: FileKey, email: string): Promise<FileMember[]>;
  /** A message to one session in the room (`FileShareState.me` / `PeerInfo.sessionID`) */
  signal(fileKey: FileKey, to: number, data: unknown): Promise<void>;
  members(fileKey: FileKey): Promise<FileMember[]>;
  fileInfo(fileKey: FileKey): Promise<SharedFileInfo>;
  /** "Anyone with the link" (owner only) */
  setLinkAccess(fileKey: FileKey, access: LinkAccess): Promise<SharedFileInfo>;
  setViewersCanCopy(fileKey: FileKey, on: boolean): Promise<SharedFileInfo>;
  /** "Ask to edit" (a viewer) */
  requestEdit(fileKey: FileKey): Promise<void>;
  requests(fileKey: FileKey): Promise<AccessRequest[]>;
  answerRequest(fileKey: FileKey, userId: string, approve: boolean): Promise<AccessRequest[]>;
  invite(fileKey: FileKey, email: string, role: "editor" | "viewer"): Promise<FileMember[]>;
  removeMember(fileKey: FileKey, email: string): Promise<FileMember[]>;
  /** Cursor, selection, page … for the file's other people (not stored) */
  presence(fileKey: FileKey, data: unknown): Promise<void>;
  watch(listener: (e: MultiplayerEvent) => void): () => void;
}
