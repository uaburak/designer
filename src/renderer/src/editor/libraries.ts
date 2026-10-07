/**
 * Libraries in the editor (docs/editor.md "Round 7", docs/data.md §9, docs/research/figma/R5-libraries.md): this
 * file as a library (Publish library: what changed since the last publish, per-asset choice — what a published asset
 * uses goes with it — Hide when publishing, Move to this file / Publish as a copy, assets moved out) and the
 * libraries it uses (the Libraries modal's Add to file / Remove from file, remote components inserted as instances
 * of read-only copies, remote styles and variables applied through their copies, updates found, reviewed and
 * accepted, removed and moved assets).
 *
 * The store keeps the registry (`DocumentSource.libraries`); the document keeps copies (docs/schema.md §8.2), which
 * only the engine writes (docs/engine-build.md "E6 libraries API" and "Libraries — review fixes"): `ensureAssetKeys` /
 * `localAssets` / `encodeAssets` / `markPublished` to publish, `importLibraryAssets` (`asNew` for Update selected
 * instance) / `applyLibraryUpdate` / `libraryUsage` to consume, `setFileKey` for the clipboard between files,
 * RESTORE_COMPONENT for a removed component. Library bookkeeping (the document's enabled list, published versions,
 * moves) is never an undo step: `applyChanges(…, "system")` and `markPublished`. Libraries are on when the source has
 * a registry and the engine in hand exports these calls (`libraryEngine`).
 */
import { showToast } from "@/ds";
import { Status } from "@/engine/abi";
import type { EncodedAsset, Guid, LibraryAssetUsage, LocalAssetInfo, Message, Pixels } from "@/engine/codec";
import type { LibraryDiff, LibraryRecord, LibraryVersion, PublishPreview, Redirect, LibraryAsset } from "../../../shared/store/types";
import type { EditorController } from "./controller";
import type { EditorPublishAsset, LibraryAccess, LibraryEntry } from "./documentSource";
import { engineExports, engineMethod, runEngineCommand } from "./engineCompat";
import { frameAt, toPage } from "./placeImages";
import { editorUrl } from "../files/desktop";
import { copiesHave, guidText, type LibraryCopy, type LNode, type LocalAsset, type PayloadIn } from "./model/libraries";

const THUMB = 256;

// ---- The engine's library API ---------------------------------------------------------------------------------------

/** The C exports the libraries need (the facade can be ahead of the wasm in hand). */
const LIBRARY_EXPORTS = ["set_file_key", "ensure_asset_keys", "local_assets", "encode_assets", "mark_published", "import_library_assets", "apply_library_update", "library_usage"];

/** Does the engine in hand have the library API? (Libraries are off without it.) */
export const libraryEngine = (ed: EditorController): boolean => !ed.engine.destroyed && LIBRARY_EXPORTS.every((name) => engineExports(ed.engine, name)) && typeof (ed.engine as { importLibraryAssets?: unknown }).importLibraryAssets === "function";

/**
 * Library bookkeeping on the document — journaled and sent to the store, never an undo step (`applyChanges` kind
 * "system": docs/engine-build.md "Libraries — review fixes" (d)).
 */
function systemChange(ed: EditorController, nodeChanges: Message["nodeChanges"]): number {
  return ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges }, "system");
}

/** How long a bookkeeping write waits for an open step (a scrub, a drag) to close: tries × ms (tests shorten it). */
export const BOOKKEEPING_WAIT = { tries: 100, ms: 100 };

/**
 * A bookkeeping write (`markPublished`, a "system" change) the engine refuses with `E_BUSY` while a step is open —
 * it would become part of that undo step — tried again until the step closes (`BOOKKEEPING_WAIT`). The last status.
 */
async function whenIdle(ed: EditorController, write: () => number): Promise<number> {
  for (let i = 0; ; i++) {
    if (ed.engine.destroyed) return Status.E_HANDLE;
    const status = write();
    if (status !== Status.E_BUSY || i >= BOOKKEEPING_WAIT.tries) return status;
    await new Promise((resolve) => setTimeout(resolve, BOOKKEEPING_WAIT.ms));
  }
}

/** Restore version's undo label (VersionDialogs): the step that writes a saved version back. */
export const RESTORE_VERSION = "Restore version";

/** Does a change carry library bookkeeping (a published version, a move) — written, or on a node brought back? */
const touchesBookkeeping = (c: Message["nodeChanges"][number]): boolean => {
  const f = c as unknown as Record<string, unknown>;
  return "publishedVersion" in f || "libraryMoveInfo" in f;
};

/** A fresh asset key: 40 lowercase hex characters, 160 random bits (docs/schema.md §8.1). */
function newAssetKey(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- The index -------------------------------------------------------------------------------------------------------

export interface LibraryState {
  /** Libraries are on for this file (its source has a registry) */
  on: boolean;
  loading: boolean;
  /** This file is in Drafts (can't publish) */
  inDrafts: boolean;
  /** This file's own record (null: never published) */
  own: LibraryRecord | null;
  /** Every other published library of the workspace */
  available: LibraryEntry[];
  /** Enabled in this file (in the order they were added) */
  enabled: string[];
  /** Latest manifest of each enabled library (and of libraries copies come from) */
  manifests: Map<string, LibraryVersion>;
  /** Names of libraries copies come from, even when they're gone ("Missing library") */
  names: Map<string, string>;
  /** What each library has that the copies here don't */
  diffs: Map<string, LibraryDiff>;
}

const OFF: LibraryState = { on: false, loading: false, inDrafts: true, own: null, available: [], enabled: [], manifests: new Map(), names: new Map(), diffs: new Map() };

/**
 * One asset's update (one row of Figma's Updates list): an asset is the pair (library, key) — a file can hold several
 * copies of one asset (Update selected instance leaves the others on the old version), and the row covers them all.
 */
export interface UpdateItem {
  library: string;
  libraryName: string;
  kind: "modified" | "removed" | "moved";
  /** The asset's key in its library */
  key: string;
  /** The copy shown for it (the first of `copies`) */
  copy: LibraryCopy;
  /** Every copy here the update concerns (modified: those behind the latest version) */
  copies: LibraryCopy[];
  /** The new version (modified) */
  asset?: LibraryAsset;
  redirect?: Redirect;
}

/** A row's id in the Updates list (the asset). */
export const updateId = (u: Pick<UpdateItem, "library" | "key">): string => `${u.library}/${u.key}`;

export class LibraryIndex {
  private state: LibraryState = OFF;
  private version = 0;
  private usageCache: { version: number; usage: LibraryAssetUsage[] } | null = null;
  private docVersion = 0;
  private readonly listeners = new Set<() => void>();
  private readonly offs: (() => void)[] = [];
  private refreshing: Promise<void> | null = null;
  private again = false;
  /** Payloads of styles / variables fetched for previews and pickers, by library */
  private readonly previews = new Map<string, Promise<Map<string, Message>>>();
  private toasted = false;
  /** This file's own latest version as this editor published it: a manifest read before that is out of date */
  private publishedHere = 0;
  /** This file's own record and latest manifest, as last read */
  private own: { record: LibraryRecord | null; manifest: LibraryVersion | null } | null = null;
  /** The own version the assets were last checked against (-1: not yet) — a refresh checks again when it moves */
  private checkedVersion = -1;
  private reconciling: Promise<void> | null = null;
  private reconcileAgain = false;
  private busyRetries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ed: EditorController) {
    const access = ed.source.libraries;
    if (!access || !libraryEngine(ed)) return;
    // The engine marks its clipboard with this file's key (a paste elsewhere knows where it came from).
    ed.engine.setFileKey(access.fileKey);
    this.state = { ...OFF, on: true, loading: true, inDrafts: access.inDrafts(), enabled: [...access.enabled()] };
    this.offs.push(
      access.onChange((e) => {
        if (e.type === "published" || e.type === "status") this.previews.delete(e.libraryFileKey);
        void this.refresh();
      }),
      ed.engine.on("DOCUMENT_CHANGED", (e) => {
        this.docVersion++; // usage may have changed
        const copiesChanged = e.message.nodeChanges.some((c) => {
          const f = c as unknown as Record<string, unknown>;
          return c.phase !== undefined || "sourceLibraryKey" in f || "version" in f || "key" in f;
        });
        // Undo / redo and Restore version bring back document states, bookkeeping included (a deleted main with the
        // version a later publish removed): checked against this file's latest manifest at once (the last one read),
        // then against a fresh read.
        const back = (e.kind === "UNDO" || e.kind === "REDO" || e.label === RESTORE_VERSION) && e.message.nodeChanges.some(touchesBookkeeping);
        if (back && this.own) this.reconcileWith(this.own.record, this.own.manifest);
        if (copiesChanged) void this.refresh();
        else if (back) void this.reconcile();
      })
    );
    void this.refresh();
  }

  dispose(): void {
    this.offs.splice(0).forEach((off) => off());
    this.listeners.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  readonly getVersion = (): number => this.version;

  get(): LibraryState {
    return this.state;
  }

  get access(): LibraryAccess | null {
    return this.ed.source.libraries ?? null;
  }

  private set(patch: Partial<LibraryState>): void {
    this.state = { ...this.state, ...patch };
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /** The engine's `libraryUsage()`: every library copy here (asset roots; a set's variants travel with it). */
  private libraryUsage(): LibraryAssetUsage[] {
    if (this.usageCache?.version === this.docVersion) return this.usageCache.usage;
    const usage = this.state.on && !this.ed.engine.destroyed ? this.ed.engine.libraryUsage().filter((u) => !u.componentSetId) : [];
    this.usageCache = { version: this.docVersion, usage };
    return usage;
  }

  /** The library copies in this file. */
  copies(): LibraryCopy[] {
    return this.libraryUsage().map((u) => ({ guid: u.id, library: u.libraryKey, key: u.key, version: u.version, publishID: u.publishID ?? "", kind: u.kind, name: u.name }));
  }

  /** How many layers here use each copy (instances; style users; bound layers and aliases). */
  usage(): Map<Guid, number> {
    return new Map(this.libraryUsage().map((u) => [u.id, u.usageCount]));
  }

  /** How many layers here use an update's copies (every copy of the asset it covers). */
  usageOf(u: Pick<UpdateItem, "copies">): number {
    const usage = this.usage();
    return u.copies.reduce((n, c) => n + (usage.get(c.guid) ?? 0), 0);
  }

  /**
   * Reads the registry again: this file's record, the workspace's libraries, the manifests of the enabled ones and
   * of every library a copy here comes from, and what each has that the copies don't (a removed library's copies
   * keep getting updates, as long as it is published).
   */
  refresh(): Promise<void> {
    const access = this.access;
    if (!access) return Promise.resolve();
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        try {
          const [ownRead, available] = await Promise.all([this.readOwn(), access.available().catch(() => [] as LibraryEntry[])]);
          if (ownRead && (ownRead.manifest?.version ?? 0) !== this.checkedVersion) this.reconcileWith(ownRead.record, ownRead.manifest);
          const own = ownRead?.record ?? null;
          const enabled = [...access.enabled()];
          const copies = this.copies();
          const libs = [...new Set([...enabled, ...copies.map((c) => c.library)])].filter((lib) => lib !== access.fileKey);
          const manifests = new Map<string, LibraryVersion>();
          const diffs = new Map<string, LibraryDiff>();
          const names = new Map(this.state.names);
          for (const e of available) names.set(e.fileKey, e.name);
          for (const lib of libs) {
            if (!names.has(lib)) names.set(lib, (await access.fileName(lib).catch(() => null)) ?? "Missing library");
            const v = await access.version(lib).catch(() => null);
            if (v) manifests.set(lib, v);
            const have = copiesHave(copies, lib);
            if (have.length) {
              const d = await access.diff(lib, have).catch(() => null);
              if (d) diffs.set(lib, d);
            }
          }
          this.set({ loading: false, own: own && own.status !== "deleted" ? own : null, available, enabled, manifests, diffs, names, inDrafts: access.inDrafts() });
        } catch {
          this.set({ loading: false });
        }
      } while (this.again);
      this.refreshing = null;
      this.announceUpdates();
    })();
    return this.refreshing;
  }

  /** This file published `version` (a manifest older than that, read before, is out of date). */
  notePublished(version: number): void {
    this.publishedHere = Math.max(this.publishedHere, version);
  }

  /** This file's own record and latest manifest; null when the store didn't answer (nothing is known then). */
  private async readOwn(): Promise<{ record: LibraryRecord | null; manifest: LibraryVersion | null } | null> {
    const access = this.access;
    if (!access) return null;
    try {
      const record = await access.record(access.fileKey);
      const manifest = record && record.status !== "deleted" && record.latestVersion > 0 ? await access.version(access.fileKey) : null;
      if ((manifest?.version ?? 0) >= (this.own?.manifest?.version ?? 0)) this.own = { record, manifest };
      return { record, manifest };
    } catch {
      return null;
    }
  }

  /**
   * This file's assets against its own latest published version (docs/data.md §9.1, §9.5, §9.6): an asset the version
   * lists has that version's `publishedVersion`, and a published main is no longer "moved"; every other asset has
   * none (never published, or removed since — a cross-file paste then treats it as unpublished). A SYSTEM change
   * (`markPublished`), never an undo step. On open and when a refresh finds a new version, after undo / redo and
   * Restore version (which bring back document states, bookkeeping included), and after a publish whose own marking
   * couldn't run.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) {
      this.reconcileAgain = true;
      return this.reconciling;
    }
    this.reconciling = (async () => {
      do {
        this.reconcileAgain = false;
        const own = await this.readOwn();
        if (own) this.reconcileWith(own.record, own.manifest);
      } while (this.reconcileAgain);
      this.reconciling = null;
    })();
    return this.reconciling;
  }

  private reconcileWith(record: LibraryRecord | null, manifest: LibraryVersion | null): void {
    const ed = this.ed;
    const fileKey = this.access?.fileKey;
    if (!this.state.on || !fileKey || ed.engine.destroyed || (manifest?.version ?? 0) < this.publishedHere) return;
    const listed = new Map((manifest?.assets ?? []).map((a) => [a.key, a.versionHash]));
    const movedHere = (m: { oldKey?: string; pasteFileKey?: string }) => !!record?.movedIn.some((r) => r.fromLibraryFileKey === m.pasteFileKey && r.fromKey === m.oldKey && r.toLibraryFileKey === fileKey);
    const entries = new Map<string, string | null>();
    const clears: Record<string, unknown>[] = [];
    // A move matters only once this library has recorded one (a publish with Move to this file records it): until
    // then no node is read — on an engine with lazy per-page derivation a read of a main derives its whole page, and
    // reading every main derived every page of the file at open.
    const movesRecorded = (record?.movedIn.length ?? 0) > 0;
    for (const a of ed.engine.localAssets()) {
      const main = a.kind === "COMPONENT" || a.kind === "COMPONENT_SET";
      const move = main ? moveOf(ed, a, movesRecorded) : null;
      const want = a.key ? (listed.get(a.key) ?? null) : null;
      if (a.key && ((a.publishedVersion || null) !== want || (move && main && want !== null))) {
        entries.set(a.key, want);
        continue;
      }
      // No key (never published from here), or nothing markPublished would change: by GUID.
      const clear: Record<string, unknown> = {};
      if (!a.key && a.publishedVersion) clear.publishedVersion = null;
      if (move && main && movedHere(move)) clear.libraryMoveInfo = null; // the move was published (a restored state)
      if (Object.keys(clear).length) clears.push({ guid: a.id, ...clear });
    }
    let status: number = Status.OK;
    if (entries.size) status = ed.engine.markPublished([...entries].map(([key, versionHash]) => ({ key, versionHash })));
    if (status === Status.OK && clears.length) status = systemChange(ed, clears as never);
    if (status !== Status.E_BUSY) {
      this.busyRetries = 0;
      this.checkedVersion = manifest?.version ?? 0;
      return;
    }
    // Inside an open step: again once it has closed.
    if (this.retryTimer || this.busyRetries++ >= BOOKKEEPING_WAIT.tries) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile();
    }, BOOKKEEPING_WAIT.ms);
  }

  /**
   * Every update the libraries have for the assets used here (Figma's Updates list): one per asset — (library, key) —
   * however many copies of it the file holds.
   */
  updates(): UpdateItem[] {
    const out: UpdateItem[] = [];
    const copies = this.copies();
    for (const [lib, d] of this.state.diffs) {
      const libraryName = this.state.names.get(lib) ?? "Library";
      const byKey = new Map<string, LibraryCopy[]>();
      for (const c of copies) if (c.library === lib) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
      const seen = new Set<string>();
      const add = (key: string, list: LibraryCopy[], item: Pick<UpdateItem, "kind" | "asset" | "redirect">) => {
        if (seen.has(key) || !list.length) return;
        seen.add(key);
        out.push({ library: lib, libraryName, key, copy: list[0], copies: list, ...item });
      };
      for (const r of d.moved) add(r.fromKey, byKey.get(r.fromKey) ?? [], { kind: "moved", redirect: r });
      for (const a of d.updated) add(a.key, (byKey.get(a.key) ?? []).filter((c) => c.version !== a.versionHash), { kind: "modified", asset: a });
      for (const key of d.removed) add(key, byKey.get(key) ?? [], { kind: "removed" });
    }
    return out;
  }

  /** Updates that can be accepted (modified and moved assets; a removed one only says so). */
  pendingCount(): number {
    return this.updates().filter((u) => u.kind !== "removed").length;
  }

  /** "Library updates available" once per session, when the file opens with updates waiting. */
  private announceUpdates(): void {
    if (this.toasted) return;
    const n = this.pendingCount();
    if (!n) return;
    this.toasted = true;
    showToast({ message: n === 1 ? "1 library update available" : `${n} library updates available`, action: { label: "Review", onAction: () => this.ed.ui.set({ librariesDialog: { tab: "updates" } }) }, duration: 8000 });
  }

  /** A library's latest manifest (the enabled ones' are in the state; others are read on demand). */
  async manifest(lib: string): Promise<LibraryVersion | null> {
    return this.state.manifests.get(lib) ?? (await this.access?.version(lib).catch(() => null)) ?? null;
  }

  /** The styles', variables' and collections' payloads of a library's latest version (pickers, previews). */
  previewPayloads(lib: string): Promise<Map<string, Message>> {
    let p = this.previews.get(lib);
    if (!p) {
      const access = this.access;
      p = (async () => {
        const out = new Map<string, Message>();
        const v = await this.manifest(lib);
        if (!access || !v) return out;
        const wants = v.assets.filter((a) => a.kind === "STYLE" || a.kind === "VARIABLE" || a.kind === "VARIABLE_COLLECTION").map((a) => ({ key: a.key, versionHash: a.versionHash }));
        if (!wants.length) return out;
        for (const x of await access.payloads(lib, wants, { withDependencies: false }).catch(() => [])) out.set(x.key, x.message);
        return out;
      })();
      this.previews.set(lib, p);
    }
    return p;
  }
}

// ---- Publishing --------------------------------------------------------------------------------------------------------

export interface PublishItem {
  asset: LocalAsset;
  /** The key it publishes under (a new one when it has none yet) */
  key: string;
  versionHash: string;
  dependencies: string[];
  dependencyOnly: boolean;
  payload: Message;
  status: "created" | "modified" | "unchanged" | "dependency";
  /** A variable's collection's key */
  collectionKey?: string;
  /** A variant's set's key */
  componentSetKey?: string;
}

export interface PublishDraft {
  items: PublishItem[];
  preview: PublishPreview;
  /** Removed since the last publish (deleted or hidden), from the last manifest */
  removed: LibraryAsset[];
  /** Pasted from another library: Move to this file (default) or Publish as a copy */
  moves: { item: PublishItem; fromLibraryFileKey: string; fromKey: string; fromName: string }[];
  /** Moved out: another library published them with Move to this file — this publish takes them out as moved (§9.5) */
  movedOut: { key: string; name: string; kind: LibraryAsset["kind"]; asset: LibraryAsset | null; toLibraryFileKey: string; toName: string }[];
  previous: LibraryVersion | null;
  /** Hidden when publishing on purpose (Hide when publishing, `_` / `.` names, hidden collections) */
  hiddenCount: number;
}

const RESOLVED = new Set(["COLOR", "FLOAT", "STRING", "BOOLEAN"]);

/**
 * A main's `libraryMoveInfo` (a published main cut from another file and pasted here): from the asset record when the
 * engine's `localAssets` carries it, else from the node — only when `always` or a move was recorded (a node read
 * derives the main's page on an engine with lazy per-page derivation).
 */
function moveOf(ed: EditorController, a: LocalAssetInfo, always: boolean): { oldKey?: string; pasteFileKey?: string } | null {
  const info = a as LocalAssetInfo & { libraryMoveInfo?: { oldKey?: string; pasteFileKey?: string } | null };
  if ("libraryMoveInfo" in info) return info.libraryMoveInfo?.oldKey ? info.libraryMoveInfo : null;
  if (!always) return null;
  const n = ed.engine.readNode(a.id) as LNode | null;
  return n?.libraryMoveInfo?.oldKey ? n.libraryMoveInfo : null;
}

/** The engine's asset, in the editor's LocalAsset shape (Hide when publishing and moves read from the node). */
function fromEngineAsset(ed: EditorController, e: LocalAssetInfo): LocalAsset {
  const n = ed.engine.readNode(e.id) as LNode | null;
  const flag = !!n && (n.isSymbolPublishable === false || n.isPublishable === false);
  const move = n?.libraryMoveInfo;
  return {
    guid: e.id,
    kind: e.kind,
    name: e.name,
    description: e.description ?? "",
    key: e.key || null,
    ...(e.styleType ? { styleType: e.styleType } : {}),
    ...(e.resolvedType && RESOLVED.has(e.resolvedType) ? { resolvedType: e.resolvedType as LocalAsset["resolvedType"] } : {}),
    ...(e.collectionId ? { collection: e.collectionId } : {}),
    ...(e.containingFrame ? { containingFrame: { pageName: e.containingFrame.pageName, ...(e.containingFrame.frameName !== undefined ? { frameName: e.containingFrame.frameName } : {}) } } : {}),
    hidden: e.hiddenFromPublishing,
    hiddenByFlag: flag,
    publishedVersion: e.publishedVersion,
    softDeleted: e.softDeleted,
    movedFrom: move?.oldKey && move.pasteFileKey ? { oldKey: move.oldKey, pasteFileKey: move.pasteFileKey } : null,
  };
}

/** Keys given to every asset that lacks one, then the publishable ones encoded with what they need (closures). */
function draftItems(ed: EditorController): { items: PublishItem[]; hiddenCount: number } {
  ed.engine.ensureAssetKeys();
  // A publish hashes every main: on an engine with lazy per-page derivation the mains' pages are derived first, so
  // `localAssets`' versionHash and `encodeAssets`' agree (a main hashed before its page was derived came out as
  // "modified" right after its own publish). The editor avoids this read everywhere else (opening a file derives only
  // the page shown); a publish is the user's own action over the whole file.
  const mains = ed.engine.localAssets().filter((a) => (a.kind === "COMPONENT" || a.kind === "COMPONENT_SET") && !a.softDeleted);
  if (mains.length) ed.engine.readNodes(mains.map((a) => a.id), { fields: ["guid"] } as never);
  const all = ed.engine.localAssets();
  const top = all.filter((a) => !a.componentSetId && !a.softDeleted); // a variant publishes with its set
  const listed = top.filter((a) => !a.hiddenFromPublishing && !!a.key && (a.kind !== "VARIABLE" || RESOLVED.has(a.resolvedType ?? "")));
  const encoded: EncodedAsset[] = listed.length ? ed.engine.encodeAssets(listed.map((a) => a.key)).assets : [];
  const items = encoded.map(
    (a): PublishItem => ({
      asset: fromEngineAsset(ed, a),
      key: a.key,
      versionHash: a.versionHash,
      dependencies: [...a.dependencies],
      dependencyOnly: a.dependencyOnly,
      payload: a.message,
      status: "unchanged",
      ...(a.collectionKey ? { collectionKey: a.collectionKey } : {}),
      ...(a.componentSetKey ? { componentSetKey: a.componentSetKey } : {}),
    })
  );
  return { items, hiddenCount: top.filter((a) => a.hiddenFromPublishing).length };
}

/** What publishing would change (the Publish library modal's lists). */
export async function draftPublish(ed: EditorController): Promise<PublishDraft> {
  const access = ed.source.libraries;
  if (!access || !libraryEngine(ed)) throw new Error("Libraries aren't available here");
  const { items, hiddenCount } = draftItems(ed);
  const previous = await access.version(access.fileKey).catch(() => null);
  const preview = await access.previewPublish(items.map((i) => toPublishAsset(i, false)));
  const created = new Set(preview.created.map((a) => a.key));
  const modified = new Set(preview.modified.map((a) => a.key));
  for (const i of items) i.status = i.dependencyOnly ? "dependency" : created.has(i.key) ? "created" : modified.has(i.key) ? "modified" : "unchanged";
  const moves: PublishDraft["moves"] = [];
  for (const i of items) {
    const m = i.asset.movedFrom;
    if (!m || i.dependencyOnly) continue;
    moves.push({ item: i, fromLibraryFileKey: m.pasteFileKey, fromKey: m.oldKey, fromName: (await access.fileName(m.pasteFileKey).catch(() => null)) ?? "another file" });
  }
  const movedOut: PublishDraft["movedOut"] = [];
  for (const r of preview.moved) {
    const asset = previous?.assets.find((a) => a.key === r.fromKey) ?? null;
    movedOut.push({ key: r.fromKey, name: asset?.name ?? "Component", kind: asset?.kind ?? "COMPONENT", asset, toLibraryFileKey: r.toLibraryFileKey, toName: (await access.fileName(r.toLibraryFileKey).catch(() => null)) ?? "another file" });
  }
  return { items, preview, removed: preview.removed, moves, movedOut, previous, hiddenCount };
}

/** Is there anything to publish (a change, a move here, an asset moved out)? */
export const hasPublishChanges = (draft: PublishDraft): boolean =>
  draft.items.some((i) => i.status === "created" || i.status === "modified") || draft.removed.length > 0 || draft.moves.length > 0 || draft.movedOut.length > 0;

export interface PublishPlan {
  /** Keys of the new and modified assets that go out (the selection, and what the published ones use) */
  chosen: Set<string>;
  /**
   * Asset key → the names of the published assets that use it. A new or modified asset a published one uses can't be
   * left out (its new content is inside theirs): it goes with them. A removed asset one still uses keeps shipping
   * with it (unlisted; `dependencyOnly`), so the copies consumers have keep getting its updates.
   */
  usedBy: Map<string, string[]>;
}

/**
 * What publishing `selected` ships (docs/data.md §9.1, §9.3): the version's manifest and its payloads always agree —
 * an asset whose payload this publish writes carries what it uses as it is now, so each of those goes out at that
 * same version, listed (a new or modified one, selected or not) or as it was (unlisted, a hidden or removed one).
 */
export function publishPlan(draft: PublishDraft, selected: ReadonlySet<string>): PublishPlan {
  const byKey = new Map(draft.items.map((i) => [i.key, i]));
  const prev = new Map((draft.previous?.assets ?? []).map((a) => [a.key, a]));
  const chosen = new Set(draft.items.filter((i) => (i.status === "created" || i.status === "modified") && selected.has(i.key)).map((i) => i.key));
  const shipped = (i: PublishItem) => i.status === "unchanged" || i.status === "dependency" || chosen.has(i.key);
  // Its payload is written now (a new version), so the dependencies inside it are the current ones.
  const writes = (i: PublishItem) => chosen.has(i.key) || (i.status === "dependency" && prev.get(i.key)?.versionHash !== i.versionHash);
  const usedBy = new Map<string, string[]>();
  const note = (key: string, name: string) => {
    const list = usedBy.get(key) ?? [];
    if (!list.includes(name)) usedBy.set(key, [...list, name]);
  };
  const queue = draft.items.filter(writes);
  const queued = new Set(queue.map((i) => i.key));
  while (queue.length) {
    const i = queue.shift()!;
    for (const dep of i.dependencies) {
      const d = byKey.get(dep);
      if (!d || dep === i.key) continue;
      note(dep, i.asset.name);
      if (d.status === "created" || d.status === "modified") chosen.add(dep);
      if (!queued.has(dep) && writes(d)) {
        queued.add(dep);
        queue.push(d);
      }
    }
  }
  // Removed rows still shipped for an asset that stays — as it is now, or, deselected, at its last published version
  // (its stored payload carries what that version used): who uses them.
  const removed = new Set(draft.removed.map((r) => r.key));
  for (const i of draft.items) {
    const deps = shipped(i) ? i.dependencies : (prev.get(i.key)?.dependencies ?? []);
    for (const dep of deps) if (removed.has(dep) && dep !== i.key) note(dep, i.asset.name);
  }
  return { chosen, usedBy };
}

function toPublishAsset(i: PublishItem, withPayload: boolean, thumbnailPng?: Uint8Array): EditorPublishAsset {
  const a = i.asset;
  return {
    key: i.key,
    kind: a.kind,
    ...(a.styleType ? { styleType: a.styleType } : {}),
    ...(a.resolvedType ? { resolvedType: a.resolvedType } : {}),
    name: a.name,
    description: a.description,
    guid: a.guid,
    versionHash: i.versionHash,
    dependencyOnly: i.dependencyOnly,
    dependencies: i.dependencies,
    ...(a.containingFrame ? { containingFrame: a.containingFrame } : {}),
    ...(i.collectionKey ? { collectionKey: i.collectionKey } : {}),
    ...(i.componentSetKey ? { componentSetKey: i.componentSetKey } : {}),
    ...(withPayload ? { payload: i.payload } : {}),
    ...(thumbnailPng ? { thumbnailPng } : {}),
  };
}

export interface PublishChoices {
  description: string;
  /** Keys of created / modified / removed assets to publish (all of them by default) */
  selected: ReadonlySet<string>;
  /** fromKey → "move" (Move to this file) or "copy" (Publish as a copy) */
  moveModes: ReadonlyMap<string, "move" | "copy">;
}

/** A published version, and whether this file recorded it on its assets (`markPublished`) yet. */
export type PublishedLibrary = LibraryVersion & { recorded: boolean };

/**
 * Publishes (`publishPlan`): selected new / modified assets — and the new / modified ones they use — go out with
 * their new payloads (and thumbnails); a deselected modified one keeps its last published version; a deselected
 * removed one stays published (listed again if it now ships only for what uses it); unchanged assets and
 * dependencies always go. Then the engine records the version on the assets (`markPublished`, SYSTEM: published
 * versions written, removed assets' cleared, moved ones no longer "moved" — never an undo step, docs/data.md §9.5);
 * refused while a step is open, it runs once that step closes (`whenIdle`). Should it still not run, `recorded` is
 * false (the dialog says so) and the library index records it at its next check (`reconcile`).
 */
export async function publishLibrary(ed: EditorController, draft: PublishDraft, choices: PublishChoices, onProgress?: (done: number, total: number) => void): Promise<PublishedLibrary> {
  const access = ed.source.libraries;
  if (!access || !libraryEngine(ed)) throw new Error("Libraries aren't available here");
  const plan = publishPlan(draft, choices.selected);
  const prevByKey = new Map((draft.previous?.assets ?? []).map((a) => [a.key, a]));
  const removedKeys = new Set(draft.removed.map((r) => r.key));
  const assets: EditorPublishAsset[] = [];
  const total = draft.items.length;
  let done = 0;
  for (const i of draft.items) {
    onProgress?.(done++, total);
    const chosen = i.status === "dependency" || i.status === "unchanged" || plan.chosen.has(i.key);
    if (!chosen) {
      // Deselected: as last published (a modified asset's previous version; a new one that only shipped unlisted
      // before, for what used it, stays so); never published before → not in this version.
      const prev = prevByKey.get(i.key);
      if (prev) assets.push({ ...prev, dependencies: [...prev.dependencies] } as EditorPublishAsset);
      continue;
    }
    const needsThumb = (i.status === "created" || i.status === "modified") && (i.asset.kind === "COMPONENT" || i.asset.kind === "COMPONENT_SET");
    const png = needsThumb ? await assetThumbnail(ed, i.asset.guid) : undefined;
    const entry = toPublishAsset(i, i.status !== "unchanged", png ?? undefined);
    // Hidden or deleted but still used by a published asset, its Removed row deselected: it stays listed.
    if (i.status === "dependency" && removedKeys.has(i.key) && !choices.selected.has(i.key)) entry.dependencyOnly = false;
    assets.push(entry);
  }
  const shipped = new Set(assets.map((a) => a.key));
  for (const r of draft.removed) if (!choices.selected.has(r.key) && !shipped.has(r.key)) assets.push({ ...r, dependencies: [...r.dependencies] } as EditorPublishAsset);
  onProgress?.(total, total);
  const moves = draft.moves.filter((m) => assets.some((a) => a.key === m.item.key)).map((m) => ({ key: m.item.key, fromLibraryFileKey: m.fromLibraryFileKey, fromKey: m.fromKey, mode: choices.moveModes.get(m.fromKey) ?? ("move" as const) }));
  const version = await access.publish({ description: choices.description, assets, moves });
  ed.libraries.notePublished(version.version);
  let recorded = true;
  if (!ed.engine.destroyed) {
    // Every asset of the new version — dependencies and kept versions too (a paste elsewhere treats an asset with
    // `publishedVersion` as published) — and the ones it removed (no longer published).
    const listed = new Set(version.assets.map((a) => a.key));
    const gone = [...draft.removed.map((r) => r.key), ...draft.movedOut.map((m) => m.key)].filter((k) => !listed.has(k));
    const entries = [...version.assets.map((a) => ({ key: a.key, versionHash: a.versionHash })), ...gone.map((key) => ({ key, versionHash: null }))];
    recorded = (await whenIdle(ed, () => ed.engine.markPublished(entries))) === Status.OK;
    if (!recorded) void ed.libraries.reconcile();
  }
  void ed.libraries.refresh();
  return { ...version, recorded };
}

/** A component's PNG thumbnail (≤ 256 px, the engine's node render), or null where it can't be drawn. */
export async function assetThumbnail(ed: EditorController, guid: Guid): Promise<Uint8Array | null> {
  const render = engineMethod<(o: { node: Guid; maxSize: number }) => Pixels | null>(ed.engine, "renderNodeThumbnailPixels");
  if (!render || typeof document === "undefined" || typeof document.createElement !== "function") return null;
  let px: Pixels | null = null;
  try {
    px = render({ node: guid, maxSize: THUMB });
  } catch {
    return null;
  }
  if (!px || !px.width || !px.height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = px.width;
  canvas.height = px.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** "Hide when publishing" on a local asset (components, sets, styles, collections, variables). */
export function setHiddenWhenPublishing(ed: EditorController, guid: Guid, hidden: boolean): void {
  const n = ed.engine.readNode(guid) as LNode | null;
  if (!n) return;
  const field = n.type === "SYMBOL" ? "isSymbolPublishable" : "isPublishable";
  // Shown again: written as `true` (what absence means, docs/schema.md §3.4) rather than cleared — the engine keeps
  // these flags without modelling them, and a cleared one would not reach the store.
  ed.setProps([guid], { [field]: !hidden } as never, hidden ? "Hide when publishing" : "Show when publishing");
}

/** Is a local asset hidden from publishing by its flag? */
export function isHiddenWhenPublishing(ed: EditorController, guid: Guid): boolean {
  const n = ed.engine.readNode(guid) as LNode | null;
  return !!n && (n.isSymbolPublishable === false || n.isPublishable === false);
}

// ---- Consuming ----------------------------------------------------------------------------------------------------------

/**
 * "Add to file" / "Remove from file" (removing keeps the copies already used here). The document keeps its own list
 * too (docs/schema.md §8.2: DOCUMENT.librarySubscriptions), written as a system change: like the store's list it is
 * not undone with ⌘Z (Figma doesn't undo enabling a library), so the two never disagree — the write waits for an
 * open step to close (`whenIdle`), and should it still be refused the store's change is taken back and this throws.
 */
export async function setLibraryEnabled(ed: EditorController, lib: string, enabled: boolean, opts: { refresh?: boolean } = {}): Promise<void> {
  const access = ed.source.libraries;
  if (!access) return;
  await access.setEnabled(lib, enabled);
  if (!ed.engine.destroyed) {
    const name = enabled ? ((await access.fileName(lib).catch(() => null)) ?? "") : "";
    const status = await whenIdle(ed, () => {
      const doc = ed.engine.readNode("0:0") as { librarySubscriptions?: { libraryKey: string; name: string }[] } | null;
      const list = (doc?.librarySubscriptions ?? []).filter((s) => s.libraryKey !== lib);
      if (enabled) list.push({ libraryKey: lib, name });
      return systemChange(ed, [{ guid: "0:0", librarySubscriptions: list } as never]); // (a DOCUMENT field NodeChange leaves out)
    });
    if (status !== Status.OK && !ed.engine.destroyed) {
      await access.setEnabled(lib, !enabled).catch(() => {});
      throw new Error(enabled ? "The library couldn't be added" : "The library couldn't be removed");
    }
  }
  if (opts.refresh !== false) await ed.libraries.refresh();
}

/** The payloads `wants` need (with their dependencies) that aren't copied here yet; assets already here stay as they are. */
async function fetchForImport(ed: EditorController, lib: string, wants: { key: string; versionHash: string }[]): Promise<PayloadIn[]> {
  const access = ed.source.libraries;
  if (!access) return [];
  const have = new Set(ed.libraries.copies().filter((c) => c.library === lib).map((c) => c.key));
  const missing = wants.filter((w) => !have.has(w.key));
  if (!missing.length) return [];
  const payloads = await access.payloads(lib, missing, { withDependencies: true });
  return payloads.filter((p) => !have.has(p.key));
}

/**
 * Library copies in (docs/schema.md §8.2): the engine's `importLibraryAssets` — a SYSTEM change (journaled, not an
 * undo step); a copy already here is reused. Returns asset key → the copy root here.
 */
function importCopies(ed: EditorController, lib: string, payloads: PayloadIn[]): Map<string, Guid> {
  if (!payloads.length) return new Map();
  const r = ed.engine.importLibraryAssets(payloads.map((p) => p.message), { libraryKey: lib });
  return r.status === Status.OK ? new Map(r.assets.filter((a) => a.libraryKey === lib).map((a) => [a.key, a.id])) : new Map();
}

/** The copy of a library asset here (importing it, with what it needs, when it isn't) — its GUID, or null. */
export async function ensureCopy(ed: EditorController, lib: string, key: string): Promise<Guid | null> {
  const existing = ed.libraries.copies().find((c) => c.library === lib && c.key === key);
  if (existing) return existing.guid;
  const asset = (await ed.libraries.manifest(lib))?.assets.find((a) => a.key === key);
  if (!asset) return null;
  const payloads = await fetchForImport(ed, lib, [{ key, versionHash: asset.versionHash }]);
  if (ed.engine.destroyed) return null;
  const roots = importCopies(ed, lib, payloads);
  return roots.get(key) ?? ed.libraries.copies().find((c) => c.library === lib && c.key === key)?.guid ?? null;
}

/**
 * Inserts an instance of a library component (or a set's default variant): the copy (with its dependencies) and
 * the instance — centred on a canvas point (a drop from Assets) in the innermost frame there, else in the middle of
 * the view. One undo step (the engine's import is a SYSTEM change; the instance is the step). Returns the new layer.
 */
export async function insertLibraryComponent(ed: EditorController, lib: string, asset: Pick<LibraryAsset, "key" | "versionHash">, at?: { x: number; y: number }): Promise<Guid | null> {
  const payloads = await fetchForImport(ed, lib, [asset]);
  if (ed.engine.destroyed) return null;
  const canvas = ed.canvas;
  const point = at ?? { x: (canvas?.clientWidth ?? 0) / 2, y: (canvas?.clientHeight ?? 0) / 2 };
  const centre = toPage(ed, point.x, point.y);
  const frame = at ? frameAt(ed, at.x, at.y) : null;
  const roots = importCopies(ed, lib, payloads);
  const main = roots.get(asset.key) ?? ed.libraries.copies().find((c) => c.library === lib && c.key === asset.key)?.guid;
  if (!main) return null;
  return runEngineCommand(ed.engine, "INSERT_INSTANCE", { main, x: centre.x, y: centre.y, ...(frame ? { parent: frame } : {}) }) === Status.OK ? (ed.selection[0] ?? null) : null;
}

// ---- Updates --------------------------------------------------------------------------------------------------------------

/**
 * The hidden assets (`dependencyOnly` in the library's latest manifest) an asset uses — through chains of hidden ones
 * — whose copies here are behind that manifest. They are never listed on their own in the library, and the engine
 * updates only the keys it is given (a copy of a dependency is otherwise reused as it is), so accepting the asset
 * alone has to bring them too, or what it shows of them (a hidden variable's value, a nested private component)
 * stays old. Keys with their latest versionHash.
 */
function outdatedHiddenDependencies(ed: EditorController, lib: string, manifest: LibraryVersion | null | undefined, key: string): { key: string; versionHash: string }[] {
  if (!manifest) return [];
  const byKey = new Map(manifest.assets.map((a) => [a.key, a]));
  const copies = ed.libraries.copies().filter((c) => c.library === lib);
  const out: { key: string; versionHash: string }[] = [];
  const seen = new Set([key]);
  const queue = [key];
  while (queue.length) {
    for (const d of byKey.get(queue.shift()!)?.dependencies ?? []) {
      const dep = byKey.get(d);
      if (!dep?.dependencyOnly || seen.has(d)) continue;
      seen.add(d);
      queue.push(d);
      if (copies.some((c) => c.key === d && c.version !== dep.versionHash)) out.push({ key: d, versionHash: dep.versionHash });
    }
  }
  return out;
}

/**
 * "Update all" (or the items given): every copy of each asset replaced by its library's latest version in place —
 * instances keep their overrides — and a moved asset's copies re-pointed at its new library (enabled here for it)
 * and updated from there; all of it **one undo step** "Update library assets" (docs/data.md §9.4). Returns how many
 * assets were updated.
 */
export async function acceptUpdates(ed: EditorController, items: readonly UpdateItem[]): Promise<number> {
  const access = ed.source.libraries;
  if (!access) return 0;
  type Call = { lib: string; payloads: PayloadIn[]; keys: string[]; redirects: { fromKey: string; toKey: string; fromLibraryKey: string }[]; items: UpdateItem[] };
  const calls = new Map<string, Call>();
  const call = (lib: string): Call => {
    let c = calls.get(lib);
    if (!c) calls.set(lib, (c = { lib, payloads: [], keys: [], redirects: [], items: [] }));
    return c;
  };
  const wants = new Map<string, Map<string, { key: string; versionHash: string }>>();
  const want = (lib: string, key: string, versionHash: string) => {
    const m = wants.get(lib) ?? new Map<string, { key: string; versionHash: string }>();
    m.set(key, { key, versionHash });
    wants.set(lib, m);
  };
  const enable = new Set<string>();
  for (const u of items) {
    if (u.kind === "modified" && u.asset) {
      const c = call(u.library);
      // The asset, and the hidden assets it uses that are behind (an item accepted on its own).
      for (const w of [{ key: u.key, versionHash: u.asset.versionHash }, ...outdatedHiddenDependencies(ed, u.library, ed.libraries.get().manifests.get(u.library), u.key)]) {
        if (!c.keys.includes(w.key)) c.keys.push(w.key);
        want(u.library, w.key, w.versionHash);
      }
      c.items.push(u);
    } else if (u.kind === "moved" && u.redirect) {
      const r = u.redirect;
      const v = await access.version(r.toLibraryFileKey).catch(() => null);
      const a = v?.assets.find((x) => x.key === r.toKey);
      if (!a) continue;
      if (!access.enabled().includes(r.toLibraryFileKey)) enable.add(r.toLibraryFileKey);
      const c = call(r.toLibraryFileKey);
      if (!c.keys.includes(r.toKey)) c.keys.push(r.toKey);
      c.redirects.push({ fromKey: r.fromKey, toKey: r.toKey, fromLibraryKey: u.library });
      c.items.push(u);
      want(r.toLibraryFileKey, a.key, a.versionHash);
    }
  }
  for (const [lib, m] of wants) call(lib).payloads = await access.payloads(lib, [...m.values()], { withDependencies: true });
  // A moved asset's new library is added to the file (Figma) — bookkeeping, not part of the step.
  for (const lib of enable) await setLibraryEnabled(ed, lib, true, { refresh: false }).catch(() => {});
  if (ed.engine.destroyed || !calls.size) return 0;
  // The copies the engine actually wrote ("library/key"): a copy already at that version is reused, not written.
  const written = new Set<string>();
  const run = (c: Call) => {
    const r = ed.engine.applyLibraryUpdate(c.payloads.map((p) => p.message), { libraryKey: c.lib, keys: c.keys, ...(c.redirects.length ? { redirects: c.redirects } : {}) });
    if (r.status === Status.OK) for (const a of r.assets) if (a.updated) written.add(`${a.libraryKey}/${a.key}`);
    return r;
  };
  const list = [...calls.values()];
  let next = 0;
  ed.batch("Update library assets", () => {
    for (; next < list.length; next++) if (run(list[next]).status === Status.E_BUSY) return; // an engine that can't join the open step: one step per library below
  });
  for (; next < list.length; next++) run(list[next]);
  // A moved asset whose new library is this file: its copies are gone, their users relinked to the main here.
  const relinked = (u: UpdateItem) => u.copies.every((c) => {
    const n = ed.engine.readNode(c.guid) as LNode | null;
    return !n || n.sourceLibraryKey !== u.library || n.key !== u.key;
  });
  const updated = new Set<string>();
  for (const u of items) {
    const done = u.kind === "modified" ? written.has(updateId(u)) : u.kind === "moved" && !!u.redirect && (written.has(`${u.redirect.toLibraryFileKey}/${u.redirect.toKey}`) || relinked(u));
    if (done) updated.add(updateId(u));
  }
  await ed.libraries.refresh();
  return updated.size;
}

/**
 * "Update selected instance": only the selected instances of the asset move to the new version — a second, complete
 * copy of it at that version (the engine's `importLibraryAssets {asNew}`) and the instances swapped onto it, one undo
 * step (overrides follow by key); the others keep their copy (and the update stays listed for them). Returns how
 * many instances moved.
 */
export async function updateSelectedInstances(ed: EditorController, item: UpdateItem): Promise<number> {
  const access = ed.source.libraries;
  if (!access || item.kind !== "modified" || !item.asset) return 0;
  const instances = selectedInstancesOf(ed, item.copies.map((c) => c.guid));
  if (!instances.length) return 0;
  // The hidden assets it uses that are behind get new copies with it (the other instances keep the old ones).
  const hidden = outdatedHiddenDependencies(ed, item.library, await ed.libraries.manifest(item.library), item.key);
  const payloads = await access.payloads(item.library, [{ key: item.asset.key, versionHash: item.asset.versionHash }, ...hidden], { withDependencies: true });
  if (ed.engine.destroyed) return 0;
  const before = new Set(ed.libraries.copies().map((c) => c.guid));
  let n = 0;
  ed.batch("Update instance", () => {
    // Inside the step: undo takes the new copy away with the swap.
    const r = ed.engine.importLibraryAssets(payloads.map((p) => p.message), { libraryKey: item.library, asNew: true, keys: [item.key, ...hidden.map((h) => h.key)] });
    const fresh = r.status === Status.OK ? r.assets.find((a) => a.key === item.key && a.libraryKey === item.library && a.created && !before.has(a.id)) : undefined;
    if (!fresh) return; // an engine without `asNew` reuses the copy here: nothing to swap onto
    const target = item.copy.kind === "COMPONENT_SET" ? null : fresh.id;
    for (const inst of instances) {
      const to = target ?? variantMatch(ed, inst, fresh.id);
      if (!to) continue;
      if (runEngineCommand(ed.engine, "SWAP_INSTANCE", { main: to, ref: inst }) === Status.OK) n++;
    }
  });
  await ed.libraries.refresh();
  return n;
}

/** In a re-imported set, the variant with the instance's current variant's name. */
function variantMatch(ed: EditorController, instance: Guid, set: Guid): Guid | null {
  const inst = ed.engine.readNode(instance) as { symbolData?: { symbolID?: unknown } } | null;
  const current = inst?.symbolData?.symbolID ? (ed.engine.readNode(guidText(inst.symbolData.symbolID as never)) as LNode | null) : null;
  const kids = ed.engine.readNode(set, { childIds: true })?.childIds ?? [];
  const variants = kids.length ? (ed.engine.readNodes(kids) as LNode[]) : [];
  return (variants.find((v) => v.name === current?.name) ?? variants.find((v) => v.type === "SYMBOL"))?.guid ?? null;
}

/** The selected instances (top-level, real) whose main is one of `copies` or one of their variants. */
export function selectedInstancesOf(ed: EditorController, copies: Guid | readonly Guid[]): Guid[] {
  const mains = new Set<Guid>();
  for (const copy of typeof copies === "string" ? [copies] : copies) {
    mains.add(copy);
    for (const kid of ed.engine.readNode(copy, { childIds: true })?.childIds ?? []) mains.add(kid);
  }
  return ed.selection.filter((id) => {
    if (id.startsWith("I")) return false;
    const n = ed.engine.readNode(id) as { type?: string; symbolData?: { symbolID?: unknown } } | null;
    return n?.type === "INSTANCE" && !!n.symbolData?.symbolID && mains.has(guidText(n.symbolData.symbolID as never));
  });
}

/**
 * "Restore component" for a component its library removed (offered only for what the diff says was removed): the
 * engine's RESTORE_COMPONENT makes the copy (its whole set) this file's main on the current page, in the middle of
 * the view — library identity cleared, every instance still linked. The asset's other copies here (Update selected
 * instance leaves several) go too: their users — instances, nested instances — are relinked to the restored main,
 * overrides kept (the engine's relink of copies to one of this file's own assets, a redirect to its new key). One
 * undo step.
 */
export function restoreRemovedComponent(ed: EditorController, copy: Guid): Guid | null {
  const n = ed.engine.readNode(copy) as LNode | null;
  if (!n || !n.sourceLibraryKey) return null;
  const lib = n.sourceLibraryKey;
  const key = n.key ?? "";
  const others = key ? ed.libraries.copies().filter((c) => c.library === lib && c.key === key && c.guid !== copy).map((c) => c.guid) : [];
  let restored = false;
  ed.batch("Restore component", () => {
    if (runEngineCommand(ed.engine, "RESTORE_COMPONENT", { ref: copy }) !== Status.OK || (ed.engine.readNode(copy) as LNode | null)?.sourceLibraryKey) return;
    restored = true;
    if (!others.length) return;
    const localKey = newAssetKey();
    if (ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges: [{ guid: copy, key: localKey } as never] }, "user") !== Status.OK) return;
    ed.engine.applyLibraryUpdate([], { libraryKey: lib, keys: [], copies: others, redirects: [{ fromKey: key, toKey: localKey, fromLibraryKey: lib }] });
  });
  if (!restored) return null;
  ed.engine.setSelection([copy]);
  return copy;
}

// ---- Paste between files: Move to this file -------------------------------------------------------------------------------

/** How many of `refs` (pasted layers) are components moved from another library. */
export function movedAmong(ed: EditorController, refs: readonly Guid[]): number {
  return refs.filter((id) => !!(ed.engine.readNode(id) as LNode | null)?.libraryMoveInfo?.oldKey).length;
}

/** The library a main component here comes from (it, or its set, is a library copy), or null for a local main. */
export function libraryOfMain(ed: EditorController, main: Guid): string | null {
  const n = ed.engine.readNode(main) as LNode | null;
  if (!n) return null;
  if (n.sourceLibraryKey) return n.sourceLibraryKey;
  const parent = n.parentIndex?.guid ? (ed.engine.readNode(n.parentIndex.guid) as LNode | null) : null;
  return parent?.sourceLibraryKey ?? null;
}

/** Opens a library file (Go to main component on a library instance): its tab in the app, a new browser tab else. */
export async function openLibraryFile(lib: string, title?: string): Promise<void> {
  const nav = typeof window === "undefined" ? null : (window as unknown as { designer?: { nav?: { openFile?: (fileKey: string, options?: { title?: string }) => Promise<unknown> } } }).designer?.nav;
  if (nav?.openFile) {
    await nav.openFile(lib, title ? { title } : undefined);
    return;
  }
  if (typeof window !== "undefined") window.open(editorUrl(lib), "_blank", "noopener");
}

/** The asset key of a library copy's local GUID (for pickers listing "used" assets). */
export function copyOf(ed: EditorController, guid: Guid): LibraryCopy | null {
  return ed.libraries.copies().find((c) => c.guid === guid) ?? null;
}
