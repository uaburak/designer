/**
 * The store's side of the port protocol (docs/data.md §8.3): one Connection per MessagePort, with its role, its edit
 * sessions (bound to the port: when the port closes, the store ends them and releases the locks, §7.4) and its file
 * subscriptions. Events go to every port, except `file.changes`, which goes only to ports that subscribed.
 */
import { isKnownMethod, roleMayCall, serializeError, StoreError, type PortRole, type RpcMessage, type RpcRequest, type RpcTransport } from "../shared/store/protocol";
import type { FileChange, OpenedFile, StoreApi } from "../shared/store/repositories";
import type { FileKey } from "../shared/store/types";
import type { LocalStore } from "./localStore";

/* eslint-disable @typescript-eslint/no-explicit-any -- arguments arrive as structured clones and are checked by the repositories */

interface Subscription {
  last: number;
  caughtUp: boolean;
  queued: FileChange[];
}

export class Connection {
  readonly owner = {};
  readonly api: StoreApi;
  readonly subscriptions = new Map<FileKey, Subscription>();
  closed = false;

  constructor(
    readonly server: StoreServer,
    readonly transport: RpcTransport,
    readonly role: PortRole,
  ) {
    this.api = server.store.api(this.owner);
  }

  send(message: RpcMessage): void {
    if (this.closed) return;
    try {
      this.transport.send(message);
    } catch {
      this.closed = true;
    }
  }

  fileChange(c: FileChange): void {
    const sub = this.subscriptions.get(c.fileKey);
    if (!sub) return;
    if (!sub.caughtUp) {
      sub.queued.push(c);
      return;
    }
    if (c.seq <= sub.last) return;
    sub.last = c.seq;
    this.send({ t: "evt", topic: "file.changes", d: c });
  }

  /** Registers the subscription, returns the backlog after `fromSeq`, then releases what arrived meanwhile. */
  async subscribe(fileKey: FileKey, fromSeq: number): Promise<FileChange[]> {
    const sub: Subscription = { last: fromSeq, caughtUp: false, queued: [] };
    this.subscriptions.set(fileKey, sub);
    let backlog: FileChange[];
    try {
      backlog = await this.server.store.files.backlog(fileKey, fromSeq);
    } catch (e) {
      this.subscriptions.delete(fileKey);
      throw e;
    }
    for (const c of backlog) sub.last = Math.max(sub.last, c.seq);
    return backlog;
  }

  /** After the subscribe reply was sent: the live changes that arrived meanwhile follow it, in order. */
  release(fileKey: FileKey): void {
    const sub = this.subscriptions.get(fileKey);
    if (!sub || sub.caughtUp) return;
    sub.caughtUp = true;
    for (const c of sub.queued.splice(0)) this.fileChange(c);
  }
}

export interface StoreServerOptions {
  generation: number;
  /** Called after `store.shutdown` has been answered (the entry exits the process) */
  onShutdown?: () => void;
}

export class StoreServer {
  private readonly connections = new Set<Connection>();
  private readonly offs: (() => void)[] = [];

  constructor(
    readonly store: LocalStore,
    readonly opts: StoreServerOptions,
  ) {
    this.offs.push(store.workspaceEvents.on((d) => this.broadcast({ t: "evt", topic: "workspace", d })));
    this.offs.push(store.libraryEvents.on((d) => this.broadcast({ t: "evt", topic: "library", d })));
    this.offs.push(store.fileChanges.on((c) => this.connections.forEach((conn) => conn.fileChange(c))));
  }

  get size(): number {
    return this.connections.size;
  }

  /** Takes a new port: says hello, then serves it until it closes. */
  connect(transport: RpcTransport, role: PortRole): Connection {
    const conn = new Connection(this, transport, role);
    this.connections.add(conn);
    transport.listen(
      (data) => void this.handle(conn, data),
      () => void this.disconnect(conn),
    );
    conn.send({ t: "hello", role, generation: this.opts.generation });
    return conn;
  }

  private async disconnect(conn: Connection): Promise<void> {
    if (!this.connections.delete(conn)) return;
    conn.closed = true;
    conn.subscriptions.clear();
    await this.store.files.endSessionsOf(conn.owner).catch((e) => this.store.log("warn", "ending a closed port's sessions failed", e));
  }

  private broadcast(message: RpcMessage): void {
    for (const c of this.connections) c.send(message);
  }

  private async handle(conn: Connection, data: unknown): Promise<void> {
    const msg = data as Partial<RpcRequest>;
    if (!msg || msg.t !== "req" || typeof msg.id !== "number") return;
    const id = msg.id;
    try {
      if (typeof msg.m !== "string" || !isKnownMethod(msg.m)) throw new StoreError("invalid", `unknown method ${String(msg.m)}`);
      if (!roleMayCall(conn.role, msg.m)) throw new StoreError("forbidden", `${conn.role} may not call ${msg.m}`);
      const args = Array.isArray(msg.a) ? msg.a : [];
      const v = await this.dispatch(conn, msg.m, args);
      conn.send({ t: "res", id, ok: true, v });
      const opts = args[1] as { subscribe?: boolean } | undefined;
      if (msg.m === "files.subscribe" || (msg.m === "files.open" && opts?.subscribe)) conn.release(String(args[0]));
      if (msg.m === "store.shutdown") {
        for (const c of this.connections) c.closed = true;
        this.opts.onShutdown?.();
      }
    } catch (e) {
      conn.send({ t: "res", id, ok: false, e: serializeError(e) });
    }
  }

  private async dispatch(conn: Connection, m: string, a: any[]): Promise<unknown> {
    switch (m) {
      case "files.open": {
        const opened: OpenedFile = await conn.api.files.open(a[0], a[1] ?? { mode: "view" });
        if (a[1]?.subscribe) await conn.subscribe(a[0], opened.headSeq);
        return opened;
      }
      case "files.subscribe":
        return conn.subscribe(a[0], Number(a[1]) || 0);
      case "files.unsubscribe":
        conn.subscriptions.delete(a[0]);
        return undefined;
      case "files.close": {
        await conn.api.files.close(a[0], a[1]);
        return undefined;
      }
    }
    const dot = m.indexOf(".");
    const repo = (conn.api as unknown as Record<string, Record<string, (...args: any[]) => unknown>>)[m.slice(0, dot)];
    const fn = repo?.[m.slice(dot + 1)];
    if (typeof fn !== "function") throw new StoreError("invalid", `unknown method ${m}`);
    return fn(...a);
  }

  /** Stops serving (the process is going away). */
  close(): void {
    for (const off of this.offs) off();
    for (const c of this.connections) {
      c.closed = true;
      try {
        c.transport.close();
      } catch {
        /* already closed */
      }
    }
    this.connections.clear();
  }
}
