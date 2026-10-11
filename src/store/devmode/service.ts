/**
 * The store's `devMode` repository (docs/editor.md "Dev Mode — round 5", D-1, D-3, D-4, D-6; round 5g): dev resources,
 * Code Connect UI mappings, the ready-for-dev report, Dev Mode viewers and prototype-only members.
 *
 * - **Where records live.** A shared file's are the server's (`/files/:key/dev-resources…`, `/files/:key/code-connect…`,
 *   `/files/:key/dev-status…`, `/files/:key/prototype-members…`, server/src/devmode/); a local file's are the store's
 *   own (`files/<key>/dev-resources.json` / `code-connect.json` on the desktop, `designer.devStore.v1.devResources.<key>`
 *   / `.codeConnect.<key>` in the browser), with the server's rules (10 links per layer, a URL once per layer, http(s),
 *   a name from the URL; UI mappings only).
 * - **Keys.** Callers name a local file key (the editor's) or a room key (a library's, from an instance's
 *   `sharedSymbolReference`). Dev resources and Code Connect live on **main**: a branch's key maps to its main file's
 *   (its room key when main is shared, else main's local key) — a branch's nodes keep main's GUIDs. Status reports and
 *   Dev Mode viewers go to the file's own room (the server tells no one about a branch's statuses).
 * - **Events** (topic `devmode`): each change made here says `{fileKey, what}` for the key the caller named and, when it
 *   differs, for the key the records live under.
 *
 * No Node or DOM imports: the desktop store (LocalStore) and the browser's dev store (MemoryStore) both run it.
 */
import { DEV_RESOURCE_LIMIT, type CodeConnectMapping, type DevModeEvent, type DevModeRepository, type DevResourceRecord, type DevStatusReport } from "../../shared/devmode/types";
import { isLocalLibraryKey } from "../../shared/libraries/orgTypes";
import { StoreError } from "../../shared/store/protocol";
import type { Unsubscribe } from "../../shared/store/repositories";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { callJson, seg, type LibraryServer } from "../libraries/org";

export type LocalDevRecord = "dev-resources" | "code-connect";

/** What the store gives the service. */
export interface DevModeHost {
  server: LibraryServer;
  getMeta(fileKey: FileKey): FileMeta | null;
  /** A shared file's room key; null when it isn't shared */
  roomKey(fileKey: FileKey): Promise<string | null>;
  /** The local copy linked to a room, if any */
  linkedCopy(roomKey: string): Promise<FileKey | null>;
  /** The branch record of a branch file (its main's local key and, for a shared main, room key); null otherwise */
  branchOf(fileKey: FileKey): Promise<{ mainFileKey: FileKey; mainKey: string | null } | null>;
  /** A local file's records (null: none yet) */
  readLocal(fileKey: FileKey, what: LocalDevRecord): Promise<unknown>;
  writeLocal(fileKey: FileKey, what: LocalDevRecord, value: unknown): Promise<void>;
  now(): number;
}

type Target = { remote: false; key: FileKey } | { remote: true; key: string };

export const NODE_ID = /^I?-?\d{1,10}:-?\d{1,10}(?:;-?\d{1,10}:-?\d{1,10}){0,31}$/;
/** Our wording (the server's; Figma's is unverified) */
export const TOO_MANY = `You can add up to ${DEV_RESOURCE_LIMIT} links to a layer.`;
export const DUPLICATE = "This link has already been added.";

const line = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

function nodeId(v: unknown): string {
  if (typeof v !== "string" || !NODE_ID.test(v)) throw new StoreError("invalid", 'nodeId is a node id like "1:2"');
  return v;
}

/** An http(s) URL, ≤ 2048 characters */
export function cleanUrl(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new StoreError("invalid", "url is a link (https://…)");
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || s.length > 2048) throw new StoreError("invalid", "url is an http(s) link of at most 2048 characters");
  return s;
}

/** The name, or the URL's host and path when none is given (docs/editor.md D-3) */
export function nameFor(name: unknown, url: string): string {
  const n = line(name, 200);
  if (n) return n;
  const u = new URL(url);
  return `${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 200);
}

/** The language a label implies when none is given (the server's `languageOf`) */
export function languageOf(label: string, given?: unknown): string {
  const g = line(given, 50);
  if (g) return g;
  const l = label.toLowerCase();
  if (l === "react" || l === "storybook") return "tsx";
  if (l === "swiftui" || l === "uikit") return "swift";
  if (l === "compose" || l === "jetpack compose") return "kotlin";
  if (l === "vue") return "vue";
  if (l === "html" || l === "web components" || l === "angular") return "html";
  return "raw";
}

function cleanLabel(v: unknown): string {
  const l = line(v, 50);
  if (!l) throw new StoreError("invalid", "label is required (React, SwiftUI, Compose …)");
  return l;
}

function cleanImports(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 100 || !v.every((x) => typeof x === "string" && x.length <= 1000)) throw new StoreError("invalid", "imports is a list of strings");
  return [...(v as string[])];
}

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
function fileKeyArg(v: unknown): string {
  if (typeof v !== "string" || !KEY.test(v)) throw new StoreError("invalid", "bad file key");
  return v;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isResource = (r: unknown): r is DevResourceRecord => !!r && typeof r === "object" && typeof (r as DevResourceRecord).id === "string" && typeof (r as DevResourceRecord).nodeId === "string" && typeof (r as DevResourceRecord).url === "string";
const isMapping = (m: unknown): m is CodeConnectMapping => !!m && typeof m === "object" && typeof (m as CodeConnectMapping).nodeId === "string" && typeof (m as CodeConnectMapping).label === "string";

export class DevModeService {
  private readonly listeners = new Set<(e: DevModeEvent) => void>();
  /** One local file's writes at a time (read, change, write) */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly host: DevModeHost) {}

  onEvent(listener: (e: DevModeEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(asked: string, t: Target, what: DevModeEvent["what"]): void {
    const keys = asked === t.key ? [asked] : [asked, t.key];
    for (const fileKey of keys) for (const l of [...this.listeners]) l({ fileKey, what });
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  /** The local copy a key names: itself, or a room's linked copy */
  private async localOf(fileKey: string): Promise<FileKey | null> {
    if (this.host.getMeta(fileKey)) return fileKey;
    return isLocalLibraryKey(fileKey) ? null : this.host.linkedCopy(fileKey);
  }

  /** Where a file's dev resources and Code Connect mappings live: main's room, or main's local records */
  async recordsOf(fileKey: string): Promise<Target> {
    const asked = fileKeyArg(fileKey);
    let local = await this.localOf(asked);
    if (!local) return isLocalLibraryKey(asked) ? { remote: false, key: asked } : { remote: true, key: asked };
    const branch = await this.host.branchOf(local);
    if (branch) {
      if (branch.mainKey) return { remote: true, key: branch.mainKey };
      local = branch.mainFileKey;
    }
    const room = await this.host.roomKey(local);
    return room ? { remote: true, key: room } : { remote: false, key: local };
  }

  /** The file's own room (statuses, viewers, prototype members); null for a local file */
  private async roomOf(fileKey: string): Promise<string | null> {
    const asked = fileKeyArg(fileKey);
    const local = await this.localOf(asked);
    if (!local) return isLocalLibraryKey(asked) ? null : asked;
    return this.host.roomKey(local);
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return callJson<T>(this.host.server, method, path, body);
  }

  // ---- local records ----

  private async localResources(key: FileKey): Promise<DevResourceRecord[]> {
    const raw = await this.host.readLocal(key, "dev-resources");
    const list = raw && typeof raw === "object" && Array.isArray((raw as { devResources?: unknown }).devResources) ? (raw as { devResources: unknown[] }).devResources : [];
    return list.filter(isResource).map((r) => ({ ...r, fileKey: key }));
  }

  private async localMappings(key: FileKey): Promise<CodeConnectMapping[]> {
    const raw = await this.host.readLocal(key, "code-connect");
    const list = raw && typeof raw === "object" && Array.isArray((raw as { mappings?: unknown }).mappings) ? (raw as { mappings: unknown[] }).mappings : [];
    return list.filter(isMapping).map((m) => ({ ...m, fileKey: key }));
  }

  /** Writing a local file's records needs the file itself */
  private requireLocalFile(key: FileKey): void {
    if (!this.host.getMeta(key)) throw new StoreError("not-found", "This file isn't on this computer");
  }

  private changeResources<T>(key: FileKey, change: (list: DevResourceRecord[]) => { list: DevResourceRecord[]; out: T }): Promise<T> {
    return this.serial(`${key}/res`, async () => {
      this.requireLocalFile(key);
      const { list, out } = change(await this.localResources(key));
      await this.host.writeLocal(key, "dev-resources", { v: 1, devResources: list });
      return out;
    });
  }

  private changeMappings<T>(key: FileKey, change: (list: CodeConnectMapping[]) => { list: CodeConnectMapping[]; out: T }): Promise<T> {
    return this.serial(`${key}/cc`, async () => {
      this.requireLocalFile(key);
      const { list, out } = change(await this.localMappings(key));
      await this.host.writeLocal(key, "code-connect", { v: 1, mappings: list });
      return out;
    });
  }

  // ---- the repository ----

  repository(): DevModeRepository {
    return {
      devResources: async (fileKey, nodeIds) => {
        const ids = nodeIds === undefined || nodeIds === null ? null : Array.isArray(nodeIds) ? nodeIds.map((n) => nodeId(n)) : (() => {
              throw new StoreError("invalid", "nodeIds is a list of node ids");
            })();
        if (ids && !ids.length) return [];
        const t = await this.recordsOf(fileKey);
        if (t.remote) {
          const q = ids ? `?nodeIds=${encodeURIComponent(ids.slice(0, 500).join(","))}` : "";
          return (await this.call<{ devResources: DevResourceRecord[] }>("GET", `/files/${seg(t.key, "file key")}/dev-resources${q}`)).devResources ?? [];
        }
        const all = await this.localResources(t.key);
        const wanted = ids ? new Set(ids) : null;
        return all.filter((r) => !wanted || wanted.has(r.nodeId)).sort((a, b) => (wanted ? 0 : a.nodeId.localeCompare(b.nodeId)) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      },
      addDevResource: async (fileKey, input) => {
        const node = nodeId(input?.nodeId);
        const url = cleanUrl(input?.url);
        const t = await this.recordsOf(fileKey);
        let out: DevResourceRecord;
        if (t.remote) out = (await this.call<{ devResource: DevResourceRecord }>("POST", `/files/${seg(t.key, "file key")}/dev-resources`, { nodeId: node, name: typeof input?.name === "string" ? input.name : "", url })).devResource;
        else {
          out = await this.changeResources(t.key, (list) => {
            const onNode = list.filter((r) => r.nodeId === node);
            if (onNode.length >= DEV_RESOURCE_LIMIT) throw new StoreError("invalid", TOO_MANY);
            if (onNode.some((r) => r.url === url)) throw new StoreError("conflict", DUPLICATE);
            const now = this.host.now();
            const rec: DevResourceRecord = { id: randomId(), fileKey: t.key, nodeId: node, name: nameFor(input?.name, url), url, createdBy: this.host.server.userId, createdAt: now, updatedAt: now };
            return { list: [...list, rec], out: rec };
          });
        }
        this.emit(fileKey, t, "resources");
        return out;
      },
      editDevResource: async (fileKey, id, patch) => {
        if (typeof id !== "string" || !id || id.length > 64) throw new StoreError("invalid", "bad dev resource id");
        const p: { name?: string; url?: string } = {};
        if (patch?.url !== undefined) p.url = cleanUrl(patch.url);
        if (patch?.name !== undefined) p.name = typeof patch.name === "string" ? patch.name : "";
        const t = await this.recordsOf(fileKey);
        let out: DevResourceRecord;
        if (t.remote) out = (await this.call<{ devResource: DevResourceRecord }>("PATCH", `/files/${seg(t.key, "file key")}/dev-resources/${seg(id, "id")}`, p)).devResource;
        else {
          out = await this.changeResources(t.key, (list) => {
            const at = list.findIndex((r) => r.id === id);
            if (at < 0) throw new StoreError("not-found", "no such dev resource");
            const cur = list[at];
            const url = p.url ?? cur.url;
            if (url !== cur.url && list.some((r) => r.nodeId === cur.nodeId && r.id !== id && r.url === url)) throw new StoreError("conflict", DUPLICATE);
            const name = p.name !== undefined ? nameFor(p.name, url) : cur.name;
            const rec: DevResourceRecord = { ...cur, url, name, updatedAt: this.host.now() };
            const next = list.slice();
            next[at] = rec;
            return { list: next, out: rec };
          });
        }
        this.emit(fileKey, t, "resources");
        return out;
      },
      removeDevResource: async (fileKey, id) => {
        if (typeof id !== "string" || !id || id.length > 64) throw new StoreError("invalid", "bad dev resource id");
        const t = await this.recordsOf(fileKey);
        if (t.remote) await this.call("DELETE", `/files/${seg(t.key, "file key")}/dev-resources/${seg(id, "id")}`);
        else
          await this.changeResources(t.key, (list) => {
            if (!list.some((r) => r.id === id)) throw new StoreError("not-found", "no such dev resource");
            return { list: list.filter((r) => r.id !== id), out: undefined };
          });
        this.emit(fileKey, t, "resources");
      },
      codeConnect: async (fileKey) => {
        const t = await this.recordsOf(fileKey);
        if (t.remote) return (await this.call<{ mappings: CodeConnectMapping[] }>("GET", `/files/${seg(t.key, "file key")}/code-connect`)).mappings ?? [];
        return (await this.localMappings(t.key)).sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.label.localeCompare(b.label));
      },
      setCodeConnect: async (fileKey, mapping) => {
        const node = nodeId(mapping?.nodeId);
        const label = cleanLabel(mapping?.label);
        const body = {
          nodeId: node,
          label,
          language: languageOf(label, mapping?.language),
          source: line(mapping?.source, 1000) || null,
          component: line(mapping?.component, 200) || null,
          imports: cleanImports(mapping?.imports),
          nestable: mapping?.nestable !== false,
          instructions: typeof mapping?.instructions === "string" ? mapping.instructions.slice(0, 5000) : "",
        };
        const t = await this.recordsOf(fileKey);
        let out: CodeConnectMapping;
        if (t.remote) out = (await this.call<{ mapping: CodeConnectMapping }>("PUT", `/files/${seg(t.key, "file key")}/code-connect`, body)).mapping;
        else {
          out = await this.changeMappings(t.key, (list) => {
            const rec: CodeConnectMapping = { fileKey: t.key, ...body, origin: "ui", template: null, updatedBy: this.host.server.userId, updatedAt: this.host.now() };
            return { list: [...list.filter((m) => !(m.nodeId === node && m.label === label)), rec], out: rec };
          });
        }
        this.emit(fileKey, t, "codeConnect");
        return out;
      },
      removeCodeConnect: async (fileKey, nid, label) => {
        const node = nodeId(nid);
        const l = cleanLabel(label);
        const t = await this.recordsOf(fileKey);
        if (t.remote) await this.call("DELETE", `/files/${seg(t.key, "file key")}/code-connect/${encodeURIComponent(node)}?label=${encodeURIComponent(l)}`);
        else
          await this.changeMappings(t.key, (list) => {
            if (!list.some((m) => m.nodeId === node && m.label === l)) throw new StoreError("not-found", "no such mapping");
            return { list: list.filter((m) => !(m.nodeId === node && m.label === l)), out: undefined };
          });
        this.emit(fileKey, t, "codeConnect");
      },
      reportStatus: async (fileKey, report) => {
        const r = cleanReport(report);
        const room = await this.roomOf(fileKey);
        if (!room) return; // a local file: one person, nobody to tell
        await this.call("POST", `/files/${seg(room, "file key")}/dev-status`, r);
      },
      viewed: async (fileKey) => {
        const room = await this.roomOf(fileKey);
        if (!room) return;
        await this.call("POST", `/files/${seg(room, "file key")}/dev-status/viewed`);
      },
      setStatusNotifications: async (fileKey, notify) => {
        const room = await this.roomOf(fileKey);
        if (!room) return;
        await this.call("PUT", `/files/${seg(room, "file key")}/dev-status/notify`, { notify: notify === true });
      },
      prototypeMembers: async (fileKey) => {
        const room = await this.roomOf(fileKey);
        if (!room) return [];
        return (await this.call<{ members: { email: string; userId: string | null; name: string | null }[] }>("GET", `/files/${seg(room, "file key")}/prototype-members`)).members ?? [];
      },
      invitePrototype: async (fileKey, email) => {
        const room = await this.roomOf(fileKey);
        if (!room) throw new StoreError("invalid", "Share this file to invite people to its prototype");
        await this.call("PUT", `/files/${seg(room, "file key")}/prototype-members`, { email: cleanEmail(email) });
      },
      removePrototype: async (fileKey, email) => {
        const room = await this.roomOf(fileKey);
        if (!room) throw new StoreError("invalid", "This file isn't shared");
        await this.call("DELETE", `/files/${seg(room, "file key")}/prototype-members/${encodeURIComponent(cleanEmail(email))}`);
      },
      watch: (listener) => this.onEvent(listener),
    };
  }
}

function cleanEmail(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(s)) throw new StoreError("invalid", "Enter an email address");
  return s;
}

const KIND_STATUS: Record<DevStatusReport["kind"], DevStatusReport["status"][]> = { ready: ["READY_FOR_DEV"], completed: ["COMPLETED"], changed_done: ["READY_FOR_DEV", "COMPLETED"], removed: ["NONE"] };

function cleanReport(r: DevStatusReport): DevStatusReport {
  if (!r || typeof r !== "object") throw new StoreError("invalid", "a status report is {nodeId, nodeName, status, kind}");
  const kinds = KIND_STATUS[r.kind];
  if (!kinds || !kinds.includes(r.status)) throw new StoreError("invalid", "the status doesn't go with the kind of change");
  const out: DevStatusReport = { nodeId: nodeId(r.nodeId), nodeName: line(r.nodeName, 200), status: r.status, kind: r.kind };
  if (typeof r.changeMessage === "string" && r.changeMessage.trim()) out.changeMessage = r.changeMessage.trim().slice(0, 1000);
  return out;
}
