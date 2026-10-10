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
}

export interface MultiplayerRepository {
  setSession(session: MultiplayerSession | null): Promise<MultiplayerStatus>;
  status(): Promise<MultiplayerStatus>;
  fileState(fileKey: FileKey): Promise<FileShareState>;
  /** Shares a local file: `snapshot` is the editor's `encodeDocumentKiwi()` of it at journal seq `headSeq` */
  share(fileKey: FileKey, input: { snapshot: Uint8Array; headSeq: number }): Promise<FileShareState>;
  listRemote(): Promise<RemoteFile[]>;
  /** The local copy of a file shared with the user (made from the room's snapshot the first time) */
  openShared(key: string): Promise<{ fileKey: FileKey }>;
  members(fileKey: FileKey): Promise<FileMember[]>;
  invite(fileKey: FileKey, email: string, role: "editor" | "viewer"): Promise<FileMember[]>;
  removeMember(fileKey: FileKey, email: string): Promise<FileMember[]>;
  /** Cursor, selection, page … for the file's other people (not stored) */
  presence(fileKey: FileKey, data: unknown): Promise<void>;
  watch(listener: (e: MultiplayerEvent) => void): () => void;
}
