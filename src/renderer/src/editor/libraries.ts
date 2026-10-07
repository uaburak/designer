/**
 * Libraries in the editor (docs/editor.md "Round 7", docs/data.md §9, docs/research/figma/R5-libraries.md): this
 * file as a library (Publish library: what changed since the last publish, per-asset choice, Hide when publishing,
 * Move to this file / Publish as a copy) and the libraries it uses (the Libraries modal's Add to file / Remove from
 * file, remote components inserted as instances of read-only copies, remote styles and variables applied through
 * their copies, updates found, reviewed and accepted, removed and moved assets).
 *
 * The store keeps the registry (`DocumentSource.libraries`); the document keeps copies (docs/schema.md §8.2), which
 * the engine writes (docs/engine-build.md "E6 libraries API"): `ensureAssetKeys` / `localAssets` / `encodeAssets` /
 * `markPublished` to publish, `importLibraryAssets` / `applyLibraryUpdate` / `libraryUsage` to consume,
 * `setFileKey` for the clipboard between files, RESTORE_COMPONENT for a removed component. Libraries are on when the
 * source has a registry and the engine in hand exports these calls (`libraryEngine`). The one write the editor makes
 * itself is a second copy of an asset at a newer version (Update selected instance: `model/libraries.planImport`).
 */
import { showToast } from "@/ds";
import { Status } from "@/engine/abi";
import type { EncodedAsset, Guid, LibraryAssetUsage, LocalAssetInfo, Message, NodeChange, Pixels } from "@/engine/codec";
import type { LibraryDiff, LibraryRecord, LibraryVersion, PublishPreview, Redirect, LibraryAsset } from "../../../shared/store/types";
import type { EditorController } from "./controller";
import type { EditorPublishAsset, LibraryAccess, LibraryEntry } from "./documentSource";
import { engineExports, engineMethod, runEngineCommand } from "./engineCompat";
import { frameAt, toPage } from "./placeImages";
import { editorUrl } from "../files/desktop";
import { ensureInternal, newNodeGuid } from "./variables";
import { positionAfter } from "./model/variables";
import { copiesHave, guidText, indexDocument, planImport, type DocIndex, type LibraryCopy, type LNode, type LocalAsset, type PayloadIn } from "./model/libraries";

const THUMB = 256;

// ---- The engine's library API ---------------------------------------------------------------------------------------

/** The C exports the libraries need (the facade can be ahead of the wasm in hand). */
const LIBRARY_EXPORTS = ["set_file_key", "ensure_asset_keys", "local_assets", "encode_assets", "mark_published", "import_library_assets", "apply_library_update", "library_usage"];

/** Does the engine in hand have the library API? (Libraries are off without it.) */
export const libraryEngine = (ed: EditorController): boolean => !ed.engine.destroyed && LIBRARY_EXPORTS.every((name) => engineExports(ed.engine, name)) && typeof (ed.engine as { importLibraryAssets?: unknown }).importLibraryAssets === "function";

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

export interface UpdateItem {
  library: string;
  libraryName: string;
  kind: "modified" | "removed" | "moved";
  /** The copy here */
  copy: LibraryCopy;
  /** The new version (modified) */
  asset?: LibraryAsset;
  redirect?: Redirect;
}

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
        if (copiesChanged) void this.refresh();
      })
    );
    void this.refresh();
  }

  dispose(): void {
    this.offs.splice(0).forEach((off) => off());
    this.listeners.clear();
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
          const [own, available] = await Promise.all([access.record(access.fileKey).catch(() => null), access.available().catch(() => [] as LibraryEntry[])]);
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

  /** Every update the libraries have for the copies here (Figma's Updates list). */
  updates(): UpdateItem[] {
    const out: UpdateItem[] = [];
    const copies = this.copies();
    for (const [lib, d] of this.state.diffs) {
      const libraryName = this.state.names.get(lib) ?? "Library";
      for (const a of d.updated) for (const copy of copies.filter((c) => c.library === lib && c.key === a.key && c.version !== a.versionHash)) out.push({ library: lib, libraryName, kind: "modified", copy, asset: a });
      for (const key of d.removed) for (const copy of copies.filter((c) => c.library === lib && c.key === key)) out.push({ library: lib, libraryName, kind: "removed", copy });
      for (const r of d.moved) for (const copy of copies.filter((c) => c.library === lib && c.key === r.fromKey)) out.push({ library: lib, libraryName, kind: "moved", copy, redirect: r });
    }
    return out;
  }

  /** Updates that can be accepted (modified and moved; a removed asset only says so). */
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

/** The internal canvas and its subtrees as a DocIndex (copies live there). */
function internalIndex(ed: EditorController): DocIndex {
  const doc = ed.engine.readNode("0:0", { childIds: true });
  const nodes: NodeChange[] = doc ? [doc] : [];
  const canvases = doc?.childIds?.length ? ed.engine.readNodes(doc.childIds, { childIds: true }) : [];
  nodes.push(...canvases);
  const internal = canvases.find((c) => (c as LNode).internalOnly);
  let level = internal?.childIds ?? [];
  while (level.length) {
    const read = ed.engine.readNodes(level, { childIds: true });
    nodes.push(...read);
    level = read.flatMap((n) => n.childIds ?? []);
  }
  return indexDocument({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: nodes });
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
  previous: LibraryVersion | null;
  /** Hidden when publishing on purpose (Hide when publishing, `_` / `.` names, hidden collections) */
  hiddenCount: number;
}

const RESOLVED = new Set(["COLOR", "FLOAT", "STRING", "BOOLEAN"]);

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
  return { items, preview, removed: preview.removed, moves, previous, hiddenCount };
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

/**
 * Publishes: selected created / modified assets go out with their new payloads (and thumbnails); a deselected
 * modified one keeps its last published version; a deselected removed one stays published; dependencies always go.
 * Then the engine writes `publishedVersion` on every asset of the version (`markPublished`).
 */
export async function publishLibrary(ed: EditorController, draft: PublishDraft, choices: PublishChoices, onProgress?: (done: number, total: number) => void): Promise<LibraryVersion> {
  const access = ed.source.libraries;
  if (!access || !libraryEngine(ed)) throw new Error("Libraries aren't available here");
  const prevByKey = new Map((draft.previous?.assets ?? []).map((a) => [a.key, a]));
  const assets: EditorPublishAsset[] = [];
  const written: PublishItem[] = [];
  const total = draft.items.length;
  let done = 0;
  for (const i of draft.items) {
    onProgress?.(done++, total);
    const chosen = i.status === "dependency" || i.status === "unchanged" || choices.selected.has(i.key);
    if (!chosen) {
      if (i.status === "modified") {
        const prev = prevByKey.get(i.key);
        if (prev) assets.push({ ...prev, dependencies: [...prev.dependencies] } as EditorPublishAsset);
      }
      continue; // a deselected new asset isn't published
    }
    const needsThumb = (i.status === "created" || i.status === "modified") && (i.asset.kind === "COMPONENT" || i.asset.kind === "COMPONENT_SET");
    const png = needsThumb ? await assetThumbnail(ed, i.asset.guid) : undefined;
    assets.push(toPublishAsset(i, i.status !== "unchanged", png ?? undefined));
    written.push(i);
  }
  for (const r of draft.removed) if (!choices.selected.has(r.key)) assets.push({ ...r, dependencies: [...r.dependencies] } as EditorPublishAsset);
  onProgress?.(total, total);
  const moves = draft.moves.filter((m) => assets.some((a) => a.key === m.item.key)).map((m) => ({ key: m.item.key, fromLibraryFileKey: m.fromLibraryFileKey, fromKey: m.fromKey, mode: choices.moveModes.get(m.fromKey) ?? ("move" as const) }));
  const version = await access.publish({ description: choices.description, assets, moves });
  if (!ed.engine.destroyed) {
    // The engine's SYSTEM write (journaled, not undoable), for every asset of the new version — dependencies and
    // kept versions too: a paste elsewhere treats an asset with `publishedVersion` as published.
    ed.engine.markPublished(assets.map((a) => ({ key: a.key, versionHash: a.versionHash })));
    // Moved here: published now (Move to this file / Publish as a copy recorded), so no longer "moved".
    const moved = written.filter((i) => i.asset.movedFrom);
    if (moved.length) ed.batch("Publish library", () => moved.forEach((i) => ed.engine.setProps([i.asset.guid], { libraryMoveInfo: null } as never)));
  }
  void ed.libraries.refresh();
  return version;
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
  ed.setProps([guid], { [field]: hidden ? false : null } as never, hidden ? "Hide when publishing" : "Show when publishing");
}

/** Is a local asset hidden from publishing by its flag? */
export function isHiddenWhenPublishing(ed: EditorController, guid: Guid): boolean {
  const n = ed.engine.readNode(guid) as LNode | null;
  return !!n && (n.isSymbolPublishable === false || n.isPublishable === false);
}

// ---- Consuming ----------------------------------------------------------------------------------------------------------

/** "Add to file" / "Remove from file" (removing keeps the copies already used here). */
export async function setLibraryEnabled(ed: EditorController, lib: string, enabled: boolean): Promise<void> {
  const access = ed.source.libraries;
  if (!access) return;
  await access.setEnabled(lib, enabled);
  // The document keeps its own list too (docs/schema.md §8.2: DOCUMENT.librarySubscriptions).
  if (!ed.engine.destroyed) {
    const doc = ed.engine.readNode("0:0") as { librarySubscriptions?: { libraryKey: string; name: string }[] } | null;
    const list = (doc?.librarySubscriptions ?? []).filter((s) => s.libraryKey !== lib);
    if (enabled) list.push({ libraryKey: lib, name: (await access.fileName(lib).catch(() => null)) ?? "" });
    ed.setProps(["0:0"], { librarySubscriptions: list.length ? list : null } as never, enabled ? "Add library" : "Remove library");
  }
  await ed.libraries.refresh();
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
  return r.status === Status.OK ? new Map(r.assets.map((a) => [a.key, a.id])) : new Map();
}

/**
 * A second copy of an asset at a newer version beside the one here (Update selected instance) — the engine reuses
 * a copy by key, so this one is written by the editor (`planImport` fresh, in the open step).
 */
function freshCopy(ed: EditorController, lib: string, payloads: PayloadIn[], key: string): Guid | null {
  const internal = ensureInternal(ed);
  const doc = internalIndex(ed);
  const positions = (doc.children.get(internal) ?? []).map((id) => doc.byId.get(id)?.parentIndex?.position ?? "");
  let last = positionAfter(positions);
  const plan = planImport(doc, lib, payloads, internal, () => newNodeGuid(ed), () => {
    const p = last;
    last = positionAfter([last]);
    return p;
  }, { fresh: true, keys: [key] });
  if (plan.changes.length) ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges: plan.changes }, "user");
  return plan.roots.get(key) ?? null;
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
 * "Update all" (or the items given): each copy replaced by the library's latest version in place — instances keep
 * their overrides — one undo step per library ("Update library assets"); a moved asset's copy re-pointed at its new
 * library (enabled here for it) and updated from there.
 */
export async function acceptUpdates(ed: EditorController, items: readonly UpdateItem[]): Promise<number> {
  const access = ed.source.libraries;
  if (!access) return 0;
  const byLib = new Map<string, UpdateItem[]>();
  for (const u of items) if (u.kind !== "removed") byLib.set(u.library, [...(byLib.get(u.library) ?? []), u]);
  const work: { lib: string; payloads: PayloadIn[]; keys: string[] }[] = [];
  const moves: { lib: string; payloads: PayloadIn[]; items: UpdateItem[] }[] = [];
  for (const [lib, list] of byLib) {
    const modified = list.filter((u) => u.kind === "modified" && u.asset);
    const wants = [...new Map(modified.map((u) => [u.asset!.key, { key: u.asset!.key, versionHash: u.asset!.versionHash }])).values()];
    if (wants.length) work.push({ lib, payloads: await access.payloads(lib, wants, { withDependencies: true }), keys: wants.map((w) => w.key) });
    for (const u of list.filter((x) => x.kind === "moved")) {
      const r = u.redirect!;
      const v = await access.version(r.toLibraryFileKey).catch(() => null);
      const a = v?.assets.find((x) => x.key === r.toKey);
      if (!a) continue;
      if (!access.enabled().includes(r.toLibraryFileKey)) await setLibraryEnabled(ed, r.toLibraryFileKey, true).catch(() => {});
      moves.push({ lib: r.toLibraryFileKey, payloads: await access.payloads(r.toLibraryFileKey, [{ key: a.key, versionHash: a.versionHash }], { withDependencies: true }), items: [u] });
    }
  }
  if (ed.engine.destroyed) return 0;
  let count = 0;
  // The engine's `applyLibraryUpdate`: copies replaced in place (GUIDs kept), one undo step per call.
  for (const w of work) if (ed.engine.applyLibraryUpdate(w.payloads.map((p) => p.message), { libraryKey: w.lib, keys: w.keys }).status === Status.OK) count += w.keys.length;
  // Moved: the copy of fromKey re-pointed at toKey's payload in its new library (its users keep their links).
  for (const m of moves) {
    for (const u of m.items) {
      const r = u.redirect!;
      if (ed.engine.applyLibraryUpdate(m.payloads.map((p) => p.message), { libraryKey: m.lib, keys: [r.toKey], redirects: [{ fromKey: r.fromKey, toKey: r.toKey }] }).status === Status.OK) count++;
    }
  }
  await ed.libraries.refresh();
  return count;
}

/**
 * "Update selected instance": only the selected instances of `item`'s component move to the new version — a second
 * copy of the asset at the new version, the instances swapped onto it (overrides follow by key); the others keep
 * the old copy (and the update stays listed for them).
 */
export async function updateSelectedInstances(ed: EditorController, item: UpdateItem): Promise<number> {
  const access = ed.source.libraries;
  if (!access || item.kind !== "modified" || !item.asset) return 0;
  const instances = selectedInstancesOf(ed, item.copy.guid);
  if (!instances.length) return 0;
  const payloads = await access.payloads(item.library, [{ key: item.asset.key, versionHash: item.asset.versionHash }], { withDependencies: true });
  let n = 0;
  ed.batch("Update instance", () => {
    const main = freshCopy(ed, item.library, payloads, item.asset!.key);
    if (!main) return;
    const target = item.copy.kind === "COMPONENT_SET" ? null : main;
    for (const inst of instances) {
      const to = target ?? variantMatch(ed, inst, main);
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

/** The selected instances (top-level, real) whose main is `copy` or one of its variants. */
export function selectedInstancesOf(ed: EditorController, copy: Guid): Guid[] {
  const kids = ed.engine.readNode(copy, { childIds: true })?.childIds ?? [];
  const mains = new Set([copy, ...kids]);
  return ed.selection.filter((id) => {
    if (id.startsWith("I")) return false;
    const n = ed.engine.readNode(id) as { type?: string; symbolData?: { symbolID?: unknown } } | null;
    return n?.type === "INSTANCE" && !!n.symbolData?.symbolID && mains.has(guidText(n.symbolData.symbolID as never));
  });
}

/**
 * "Restore component" for a component its library removed (offered only for what the diff says was removed): the
 * engine's RESTORE_COMPONENT makes the copy (its whole set) this file's main on the current page, in the middle of
 * the view — library identity cleared, a new key at the next publish, every instance still linked; one undo step.
 */
export function restoreRemovedComponent(ed: EditorController, copy: Guid): Guid | null {
  const n = ed.engine.readNode(copy) as LNode | null;
  if (!n || !n.sourceLibraryKey) return null;
  if (runEngineCommand(ed.engine, "RESTORE_COMPONENT", { ref: copy }) !== Status.OK || (ed.engine.readNode(copy) as LNode | null)?.sourceLibraryKey) return null;
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
