/**
 * The store's `multiplayer` repository (docs/multiplayer.md §5): what views and main may ask of the store about shared
 * files. The session token goes in through `setSession` (main only, desktop; the page itself in the browser).
 */
import type { FilePolicy, RoomPolicy } from "../org/identity";
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
  /** The org's room policy (cursor chat, audio — docs/multiplayer.md §15.9) as the room last said it (`welcome.policy`,
   *  `{t: "policy"}`); null outside orgs or before the room spoke: everything allowed */
  policy?: RoomPolicy | null;
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
  /** The room's policy changed while the file is open (`{t: "policy"}`, docs/multiplayer.md §15.9); also `state.policy` */
  policy?: RoomPolicy;
}

/**
 * The server ended the session (docs/multiplayer.md §15.8, docs/desktop.md §18.2): a 401 on one of the store's calls,
 * said at most once per session; the store has already dropped the session itself (sockets closed, as
 * `setSession(null)`) — main / the web page signs out locally. `idle_timeout`: the org's idle session timeout passed
 * ("You were logged out because you were inactive."). `expired`: any other 401 (signed out everywhere, the token's 30
 * days) — and also an idle timeout first refused on a socket upgrade, which the store can't see: the server deleted
 * the session there, so the next call is a plain 401 (main's `GET /me` / its own timer tell the two apart).
 */
export interface SessionEnded {
  reason: "idle_timeout" | "expired";
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
  /** The org's sharing policy for this file (docs/multiplayer.md §15.6, §15.16); null outside orgs */
  policy?: FilePolicy | null;
  /** Org files (§14.12): "Anyone at ‹org›" with the link */
  orgLinkAccess?: LinkAccess;
  /** When the links stop working (Require design file links to expire); null: never */
  linkExpiresAt?: number | null;
  /** Prototype-only access (docs/editor.md D-6): "Anyone with the link" to the prototype, and org members with it */
  protoLinkAccess?: "none" | "viewer";
  protoOrgLinkAccess?: "none" | "viewer";
  /** The file's org, team and folder (null outside orgs) */
  org?: { id: string; name: string; teamId: string | null; teamName: string | null } | null;
  /** The caller's access in an org (`capped: "external"`: their own org restricts external content — view only) */
  access?: { canShare: boolean; canManage: boolean; capped: "seat" | "external" | null; /** Only a prototype grant reaches the file (docs/editor.md D-6) */ prototypeOnly?: boolean; canExport?: boolean } | null;
}

/** One PATCH of a file's link settings (Share settings' Save): the org's policy checks them together (§15.16) */
export interface LinkSettingsPatch {
  linkAccess?: LinkAccess;
  orgLinkAccess?: LinkAccess;
  /** null: no password */
  linkPassword?: string | null;
  /** null: never */
  linkExpiresAt?: number | null;
  viewersCanCopy?: boolean;
  /** Share prototype (docs/editor.md D-6): the prototype's links */
  protoLinkAccess?: "none" | "viewer";
  protoOrgLinkAccess?: "none" | "viewer";
}

/** Where a link lands in its file: a frame or page (Figma's `node-id=1-2`) and a mode (`m=dev` Dev Mode, `m=proto` the
 *  prototype) */
export interface OpenIntent {
  nodeId?: string;
  mode?: "dev" | "proto";
  /** A comment thread to open (a notification about it: docs/multiplayer.md §12; the link's `#comment-<id>`) */
  commentId?: string;
  /** Open in Dev Mode on the ready-for-dev view (a Dev Mode notification: docs/editor.md D-4; ours) */
  devMode?: "ready";
}

/** A link's `node-id` and `m`, as Figma writes them; null fields are left out. */
export function intentFromLink(text: string): OpenIntent {
  const out: OpenIntent = {};
  const node = /[?&]node-id=([0-9]+)[-:]([0-9]+)/.exec(text);
  if (node) out.nodeId = `${node[1]}:${node[2]}`;
  const mode = /[?&]m=(dev|proto)\b/.exec(text);
  if (mode) out.mode = mode[1] as "dev" | "proto";
  const comment = /[?&#]comment[-=]([A-Za-z0-9_-]{6,64})/.exec(text);
  if (comment) out.commentId = comment[1];
  // A Dev Mode status notification's link (docs/editor.md D-4): `dev=ready` opens the ready-for-dev view
  if (/[?&]dev=ready\b/.test(text)) out.devMode = "ready";
  return out;
}

/** A file's link with a frame and mode: `node-id` with a hyphen, as Figma's links. */
export function linkWith(link: string, intent: OpenIntent): string {
  const u = new URL(link);
  if (intent.nodeId) u.searchParams.set("node-id", intent.nodeId.replace(":", "-"));
  if (intent.mode) u.searchParams.set("m", intent.mode);
  if (intent.commentId) u.hash = `comment-${intent.commentId}`;
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
  /** Share settings' Save as one PATCH — the link, the org link, the password, the expiry, viewers can copy — so the
   *  org's policy (a password or an expiry required with a public link) is met in one request */
  updateLink(fileKey: FileKey, patch: LinkSettingsPatch): Promise<SharedFileInfo>;
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
  /** The server ended the session (event topic `session`): main and the web page sign out on `idle_timeout` */
  watchSession(listener: (e: SessionEnded) => void): () => void;
}
