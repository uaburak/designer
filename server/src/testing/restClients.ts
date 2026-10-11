/**
 * A test bench for the REST clients (docs/multiplayer.md §16.6): the real Worker handler and rooms (server restWorld:
 * node:sqlite, RoomBox + Room + RestJobs), one installation's MultiplayerService on an in-process WebSocket into the
 * file's room, and a shared file made from `snapshot`. The editor's runner test (src/renderer/src/editor/rest)
 * imports it dynamically, so the web project doesn't typecheck the server's code. Node only; never bundled.
 */
import { handle } from "../api";
import { REST_TIMING } from "../rest/roomJobs";
import { restWorld, type RestWorld } from "./restWorld";
import type { Connection, Room } from "../../../src/shared/multiplayer/room";
import type { FileChange } from "../../../src/shared/store/repositories";
import type { FileKey, FileMeta } from "../../../src/shared/store/types";
import { multiplayerApi } from "../../../src/store/multiplayer/api";
import { MultiplayerService, type MultiplayerHost } from "../../../src/store/multiplayer/service";

const ORIGIN = "https://designer.example.workers.dev";
/** The file's thumbnail (a PNG's signature and a few bytes) */
export const THUMBNAIL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** An installation's store: a journal per file (service.test.ts's, plus a thumbnail) */
class Host implements MultiplayerHost {
  deviceOrdinal = 1;
  files = new Map<FileKey, { meta: FileMeta; snapshot: Uint8Array; frames: FileChange[]; thumbnail: Uint8Array | null }>();
  saved: { installationId?: string; links: Record<string, unknown> } = { links: {} };
  private listeners = new Set<(c: FileChange) => void>();
  readonly fileChanges = { on: (l: (c: FileChange) => void) => (this.listeners.add(l), () => this.listeners.delete(l)) };
  addFile(name: string, snapshot: Uint8Array): FileKey {
    const fileKey = `local${this.files.size + 1}`;
    this.files.set(fileKey, { meta: { fileKey, name, updatedAt: Date.UTC(2026, 9, 11) } as FileMeta, snapshot, frames: [], thumbnail: THUMBNAIL });
    return fileKey;
  }
  /** An edit, journaled as the editor's source does */
  journal(fileKey: FileKey, message: Uint8Array): void {
    const f = this.files.get(fileKey)!;
    const change = { fileKey, seq: f.frames.length + 1, sessionID: this.deviceOrdinal * 2 ** 20 + 1, kind: "edit", message } as FileChange;
    f.frames.push(change);
    for (const l of this.listeners) l(change);
  }
  async backlog(fileKey: FileKey, fromSeq: number) {
    return this.files.get(fileKey)!.frames.filter((c) => c.seq > fromSeq);
  }
  async appendRemote(fileKey: FileKey, message: Uint8Array) {
    const f = this.files.get(fileKey)!;
    const c = { fileKey, seq: f.frames.length + 1, sessionID: 0, kind: "remote", message } as FileChange;
    f.frames.push(c);
    return { seq: c.seq };
  }
  async createSharedFile(): Promise<FileMeta> {
    throw new Error("not in this bench");
  }
  getMeta(fileKey: FileKey) {
    return this.files.get(fileKey)?.meta ?? null;
  }
  async setDeviceOrdinal(o: number) {
    this.deviceOrdinal = o;
  }
  async load() {
    return structuredClone(this.saved);
  }
  async saveInstallationId(id: string) {
    this.saved.installationId = id;
  }
  async saveLink(fileKey: FileKey, link: unknown) {
    if (link) this.saved.links[fileKey] = structuredClone(link);
    else delete this.saved.links[fileKey];
  }
  log() {}
  async hasBlobs(sha1s: string[]) {
    return sha1s.map(() => false);
  }
  async getBlob(): Promise<Uint8Array> {
    throw new Error("no blobs in this bench");
  }
  async putBlob() {}
  async headSnapshot(fileKey: FileKey) {
    return this.files.get(fileKey)!.snapshot;
  }
  async thumbnail(fileKey: FileKey) {
    return this.files.get(fileKey)?.thumbnail ?? null;
  }
}

export interface RestClientBench {
  w: RestWorld;
  svc: MultiplayerService;
  api: ReturnType<typeof multiplayerApi>;
  host: Host;
  fileKey: FileKey;
  /** The room key */
  key: string;
  timing: typeof REST_TIMING;
  until(cond: () => boolean | Promise<boolean>, ms?: number): Promise<void>;
  close(): void;
}

async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** alice's installation with `snapshot` shared as a draft of hers, its link live */
export async function restClientBench(snapshot: Uint8Array, name = "Tokens"): Promise<RestClientBench> {
  const w = await restWorld();
  // A real client takes longer than the fake ones restWorld times
  REST_TIMING.clientMs = 3000;
  REST_TIMING.waitMs = 6000;
  const sockets = new Set<{ close(): void }>();

  /** A WebSocket straight into the file's room, after the Worker's checks (token → user → role) */
  class RoomSocket {
    binaryType = "arraybuffer";
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private conn: Connection | null = null;
    private room: Room | null = null;
    constructor(url: string) {
      sockets.add(this);
      void this.open(new URL(url));
    }
    private async open(u: URL) {
      const key = u.pathname.split("/")[2];
      const me = await handle(new Request(`${ORIGIN}/me`, { headers: { authorization: `Bearer ${u.searchParams.get("token")}` } }), w.deps);
      if (!me.ok) return this.closed(1008, "unauthorized");
      const user = (await me.json()) as { id: string; name: string };
      const role = await w.deps.db.roleOf(key, user.id);
      if (!role) return this.closed(1008, "no access");
      this.room = w.mem.get(key).room;
      this.conn = {
        send: (d) => queueMicrotask(() => this.onmessage?.({ data: typeof d === "string" ? d : d.slice().buffer })),
        close: (code = 1000, reason = "") => queueMicrotask(() => this.closed(code, reason)),
      };
      this.room.connect(this.conn, { userId: user.id, name: user.name, role });
      this.readyState = 1;
      this.onopen?.({});
    }
    send(d: string | Uint8Array) {
      if (this.readyState !== 1) return;
      const data = typeof d === "string" ? d : d.slice();
      queueMicrotask(() => this.conn && this.room?.receive(this.conn, data));
    }
    close(code = 1000, reason = "") {
      if (this.conn) this.room?.leave(this.conn);
      this.closed(code, reason);
    }
    private closed(code: number, reason: string) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this);
      this.onclose?.({ code, reason });
    }
  }

  const host = new Host();
  const serverFetch = (async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(String(input), init), w.deps)) as typeof fetch;
  const svc = new MultiplayerService(host, { fetch: serverFetch, WebSocket: RoomSocket as never, random: Math.random, backoff: () => 5 });
  await svc.setSession({ server: ORIGIN, token: w.people.alice.token });
  const fileKey = host.addFile(name, snapshot);
  await svc.share(fileKey, { snapshot, headSeq: 0 });
  const key = (await svc.fileState(fileKey)).key!;
  await until(async () => (await svc.fileState(fileKey)).connection === "live");
  return {
    w,
    svc,
    api: multiplayerApi(svc),
    host,
    fileKey,
    key,
    timing: REST_TIMING,
    until,
    close: () => {
      svc.close();
      for (const s of [...sockets]) s.close();
    },
  };
}
