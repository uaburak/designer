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
}

export interface MultiplayerEvent {
  fileKey: FileKey;
  state: FileShareState;
  /** This copy fell behind the room's history and a fresh copy replaced it as the linked one (the old one stays) */
  replacedBy?: FileKey;
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
}

export type LinkAccess = "none" | "viewer" | "editor";

/** A shared file's name, the caller's role, the link setting and the link itself */
export interface SharedFileInfo {
  key: string;
  name: string;
  role: Role;
  linkAccess: LinkAccess;
  link: string;
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
  /** The local copy of a file shared with the user — by invite or by its link (made from the room's snapshot the first time) */
  openShared(key: string): Promise<{ fileKey: FileKey }>;
  members(fileKey: FileKey): Promise<FileMember[]>;
  fileInfo(fileKey: FileKey): Promise<SharedFileInfo>;
  /** "Anyone with the link" (owner only) */
  setLinkAccess(fileKey: FileKey, access: LinkAccess): Promise<SharedFileInfo>;
  invite(fileKey: FileKey, email: string, role: "editor" | "viewer"): Promise<FileMember[]>;
  removeMember(fileKey: FileKey, email: string): Promise<FileMember[]>;
  /** Cursor, selection, page … for the file's other people (not stored) */
  presence(fileKey: FileKey, data: unknown): Promise<void>;
  watch(listener: (e: MultiplayerEvent) => void): () => void;
}
