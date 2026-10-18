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
import { t, tp } from "@/i18n";
import { showToast } from "@/ds";
import { Status } from "@/engine/abi";
import type { EncodedAsset, Guid, LibraryAssetUsage, LocalAssetInfo, Message, Pixels } from "@/engine/codec";
import type { LibraryDiff, LibraryPublish, LibraryRecord, LibraryVersion, PublishPreview, Redirect, LibraryAsset } from "../../../shared/store/types";
import { publishOf } from "../../../shared/store/libraryRules";
import type { Engine } from "@/engine/Engine";
import type { EditorController } from "./controller";
import type { EditorPublishAsset, LibraryAccess, LibraryEntry, OrgPublishContext } from "./documentSource";
import { changesOf, engineCall, engineExports, engineMethod, runEngineCommand } from "./engineCompat";
import { frameAt, toPage } from "./placeImages";
import { editorUrl } from "../files/desktop";
import { copiesHave, guidText, type LibraryCopy, type LNode, type LocalAsset, type PayloadIn } from "./model/libraries";
import { viewCentre } from "./canvas/viewInsets";
import { attachLibraryUsage, gid } from "./libraryUsage";
import { setExplicitMode } from "./variables";
import { LIMITS } from "./model/variables";
import type { DefaultMode } from "../../../shared/libraries/orgTypes";
import { readSocial, templateSlotsIn, type PluginDataEntry, type SocialTemplateData, type TemplateSlotSummary } from "../../../shared/social/types";

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
  /** An org copy: its org, whether the person may change its link, its library's scope (docs/data.md §16.6); null: a local file */
  org: OrgPublishContext | null;
}

const OFF: LibraryState = { on: false, loading: false, inDrafts: true, own: null, available: [], enabled: [], manifests: new Map(), names: new Map(), diffs: new Map(), org: null };

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
  /** The publish its new content comes from (modified; atlas 12 §6.3 groups the Updates tab by it) */
  publish?: LibraryPublish;
}

/** A row's id in the Updates list (the asset). */
export const updateId = (u: Pick<UpdateItem, "library" | "key">): string => `${u.library}/${u.key}`;

/** Figma's update order (atlas 12 §6.3, §6.4): components, state groups, styles, variable sets, other library assets. */
const UPDATE_ORDER: Partial<Record<LibraryCopy["kind"], number>> = { COMPONENT: 0, COMPONENT_SET: 1, STYLE: 2, VARIABLE_COLLECTION: 3, VARIABLE: 3 };
export const updateOrder = (u: Pick<UpdateItem, "copy">): number => UPDATE_ORDER[u.copy.kind] ?? 4;

/** One group of the Updates tab: the updates one publish of a library brought (moved and removed ones: no publish). */
export interface UpdateGroup {
  id: string;
  library: string;
  libraryName: string;
  publish: LibraryPublish | null;
  items: UpdateItem[];
}

/**
 * The Updates tab's groups (atlas 12 §6.3): by publish, newest first, each in Figma's order (`updateOrder`); a
 * library's moved and removed assets last, in a group of their own.
 */
export function updateGroups(items: readonly UpdateItem[]): UpdateGroup[] {
  const groups = new Map<string, UpdateGroup>();
  for (const u of items) {
    const publish = u.kind === "modified" ? (u.publish ?? null) : null;
    const id = `${u.library}#${publish?.version ?? "-"}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, library: u.library, libraryName: u.libraryName, publish, items: [] }));
    g.items.push(u);
  }
  for (const g of groups.values()) g.items.sort((a, b) => updateOrder(a) - updateOrder(b));
  return [...groups.values()].sort((a, b) => (b.publish?.publishedAt ?? -1) - (a.publish?.publishedAt ?? -1) || (b.publish?.version ?? 0) - (a.publish?.version ?? 0));
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
  private unpublishedCache: { version: number; value: boolean } | null = null;
  /** Collections imported with a default mode for this file, until the insertion's step sets it (§16.5) */
  private pendingModes: { collection: Guid; mode: string }[] = [];

  constructor(private readonly ed: EditorController) {
    const access = ed.source.libraries;
    if (!access || !libraryEngine(ed)) return;
    // The engine marks its clipboard with this file's library key (a paste elsewhere knows where it came from); a
    // local file moved into an org gets its room key from then on (docs/data.md §16.9).
    let markedKey = access.libraryKey;
    ed.engine.setFileKey(markedKey);
    this.state = { ...OFF, on: true, loading: true, inDrafts: access.inDrafts(), enabled: [...access.enabled()] };
    this.offs.push(
      access.onChange((e) => {
        if (e.type === "published" || e.type === "status") this.previews.delete(e.libraryFileKey);
        if (access.libraryKey !== markedKey && !ed.engine.destroyed) ed.engine.setFileKey((markedKey = access.libraryKey));
        void this.refresh();
      }),
      // Usage of org libraries (docs/data.md §17.3)
      attachLibraryUsage(ed),
      ed.engine.on("DOCUMENT_CHANGED", (e) => {
        this.docVersion++; // usage may have changed
        const copiesChanged = changesOf(e).some((c) => {
          const f = c as unknown as Record<string, unknown>;
          return c.phase !== undefined || "sourceLibraryKey" in f || "version" in f || "key" in f;
        });
        // Undo / redo and Restore version bring back document states, bookkeeping included (a deleted main with the
        // version a later publish removed): checked against this file's latest manifest at once (the last one read),
        // then against a fresh read.
        const back = (e.kind === "UNDO" || e.kind === "REDO" || e.label === RESTORE_VERSION) && changesOf(e).some(touchesBookkeeping);
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
    return this.libraryUsage().map((u) => ({ guid: u.id, library: u.libraryKey, key: u.key, version: u.version, publishID: u.publishID ?? "", kind: u.kind, name: u.name, ...(u.styleType ? { styleType: u.styleType } : {}), ...(u.collectionKey ? { collectionKey: u.collectionKey } : {}) }));
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
          const [ownRead, available, org] = await Promise.all([this.readOwn(), access.available().catch(() => [] as LibraryEntry[]), access.org ? access.org().catch(() => null) : Promise.resolve(null)]);
          if (ownRead && (ownRead.manifest?.version ?? 0) !== this.checkedVersion) this.reconcileWith(ownRead.record, ownRead.manifest);
          const own = ownRead?.record ?? null;
          const enabled = [...access.enabled()];
          const copies = this.copies();
          const libs = [...new Set([...enabled, ...copies.map((c) => c.library)])].filter((lib) => lib !== access.libraryKey);
          const manifests = new Map<string, LibraryVersion>();
          const diffs = new Map<string, LibraryDiff>();
          const names = new Map(this.state.names);
          for (const e of available) names.set(e.fileKey, e.name);
          for (const lib of libs) {
            if (!names.has(lib)) names.set(lib, (await access.fileName(lib).catch(() => null)) ?? t("Missing library"));
            const v = await access.version(lib).catch(() => null);
            if (v) manifests.set(lib, v);
            const have = copiesHave(copies, lib);
            if (have.length) {
              const d = await access.diff(lib, have).catch(() => null);
              if (d) diffs.set(lib, d);
            }
          }
          this.set({ loading: false, own: own && own.status !== "deleted" ? own : null, available, enabled, manifests, diffs, names, inDrafts: access.inDrafts(), org });
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
      const record = await access.record(access.libraryKey);
      const manifest = record && record.status !== "deleted" && record.latestVersion > 0 ? await access.version(access.libraryKey) : null;
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
    const fileKey = this.access?.libraryKey;
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
      const libraryName = this.state.names.get(lib) ?? t("Library");
      const byKey = new Map<string, LibraryCopy[]>();
      for (const c of copies) if (c.library === lib) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
      const seen = new Set<string>();
      const latest = this.state.manifests.get(lib);
      const publishes = d.publishes ?? (latest ? [{ version: latest.version, publishedAt: latest.publishedAt, description: latest.description }] : []);
      const publishFor = (a: LibraryAsset) => publishes.find((p) => p.version === publishOf(a, d.latestVersion)) ?? (d.publishes ? undefined : publishes[0]);
      const add = (key: string, list: LibraryCopy[], item: Pick<UpdateItem, "kind" | "asset" | "redirect" | "publish">) => {
        if (seen.has(key) || !list.length) return;
        seen.add(key);
        out.push({ library: lib, libraryName, key, copy: list[0], copies: list, ...item });
      };
      for (const r of d.moved) add(r.fromKey, byKey.get(r.fromKey) ?? [], { kind: "moved", redirect: r });
      for (const a of d.updated) {
        const publish = publishFor(a);
        add(a.key, (byKey.get(a.key) ?? []).filter((c) => c.version !== a.versionHash), { kind: "modified", asset: a, ...(publish ? { publish } : {}) });
      }
      for (const key of d.removed) add(key, byKey.get(key) ?? [], { kind: "removed" });
    }
    return out;
  }

  /** Updates that can be accepted (modified and moved assets; a removed one only says so). */
  pendingCount(): number {
    return this.updates().filter((u) => u.kind !== "removed").length;
  }

  /**
   * The updates of the Updates tab's scope (atlas 12 §6.3): "current" — the current page's: a component's when an
   * instance on the page (nested in another one too) uses one of its copies (styles and variables are listed on every
   * page: which layers of a page use them isn't read); "all" — every update.
   */
  updatesIn(scope: "current" | "all"): UpdateItem[] {
    const all = this.updates();
    if (scope === "all") return all;
    const page = this.ed.store.page;
    if (!page || this.ed.engine.destroyed) return all;
    const used = new Set(instancesOn(this.ed, [page], { nested: true }).map((i) => i.main));
    return all.filter((u) => {
      if (u.copy.kind !== "COMPONENT" && u.copy.kind !== "COMPONENT_SET") return true;
      return u.copies.some((c) => used.has(c.guid) || mainsOf(this.ed, c.guid).some((m) => used.has(m)));
    });
  }

  /** "Library updates available" once per session, when the file opens with updates waiting. */
  private announceUpdates(): void {
    if (this.toasted) return;
    const n = this.pendingCount();
    if (!n) return;
    this.toasted = true;
    showToast({ message: tp(n, "{n} library update available", "{n} library updates available"), action: { label: t("Review"), onAction: () => this.ed.ui.set({ librariesDialog: { tab: "updates" } }) }, duration: 8000 });
  }

  /**
   * Does this file have unpublished changes (the Libraries button's "Review unpublished changes")? Only once it has
   * been published: an asset never published (listed, keyed, not hidden), one removed since, or a style / variable /
   * collection whose content no longer matches its published version. Mains are judged by new or removed only — their
   * hash depends on their page being derived, and opening a file derives only the page shown (a whole check is the
   * Publish dialog's). Cached per document change.
   */
  unpublishedChanges(): boolean {
    if (!this.state.on || !this.state.own || this.state.own.latestVersion < 1 || this.state.inDrafts || this.ed.engine.destroyed) return false;
    if (this.unpublishedCache?.version === this.docVersion) return this.unpublishedCache.value;
    let value = false;
    try {
      for (const a of this.ed.engine.localAssets()) {
        if (a.componentSetId) continue; // a variant publishes with its set
        if (a.softDeleted || a.hiddenFromPublishing) {
          if (a.publishedVersion) value = true; // removed (or hidden) since its publish
        } else if (!a.publishedVersion) value = true; // new
        else if (a.kind !== "COMPONENT" && a.kind !== "COMPONENT_SET" && a.versionHash !== a.publishedVersion) value = true;
        if (value) break;
      }
    } catch {
      value = false;
    }
    this.unpublishedCache = { version: this.docVersion, value };
    return value;
  }

  /** The default modes an org library has for this file (docs/data.md §16.5), from the libraries listed for it. */
  defaultModesOf(lib: string): DefaultMode[] {
    return this.state.available.find((e) => e.fileKey === lib)?.org?.defaultModes ?? [];
  }

  /**
   * A library's collections brought into this file for the first time (an import's created VARIABLE_COLLECTION copies):
   * those with a default mode for this file wait for `applyDefaultModes`, which the insertion's own step runs.
   */
  noteImported(lib: string, assets: readonly { key: string; id: Guid; kind: string; created: boolean }[]): void {
    const defaults = this.defaultModesOf(lib);
    if (!defaults.length) return;
    for (const a of assets) {
      if (!a.created || a.kind !== "VARIABLE_COLLECTION") continue;
      const d = defaults.find((x) => x.collectionKey === a.key);
      if (d) this.pendingModes.push({ collection: a.id, mode: d.modeId });
    }
  }

  /**
   * "Applying a default mode" (docs/data.md §16.5): each collection noted by `noteImported` gets its default mode as the
   * explicit mode of every page (`variableModeBySetMap`). Run inside the insertion's undo step. A mode the copy doesn't
   * have is skipped. Returns how many were set.
   */
  applyDefaultModes(): number {
    const todo = this.pendingModes.splice(0);
    if (!todo.length || this.ed.engine.destroyed) return 0;
    const pages = this.ed.engine.pages().map((p) => p.guid);
    let n = 0;
    for (const t of todo) {
      const node = this.ed.engine.readNode(t.collection, { fields: ["variableSetModes"] } as never) as { variableSetModes?: { id?: unknown }[] } | null;
      const has = (node?.variableSetModes ?? []).some((m) => gid(m.id) === t.mode);
      if (!has || !pages.length) continue;
      setExplicitMode(this.ed, pages, t.collection, t.mode);
      n++;
    }
    return n;
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

/**
 * The Libraries button's tooltip (help "Share libraries in an organization"): "Review library updates" when libraries
 * used here have updates, "Review unpublished changes" when this file has unpublished changes, else "Libraries".
 */
export function librariesButtonLabel(ed: EditorController): string {
  if (ed.libraries.pendingCount() > 0) return t("Review library updates");
  if (ed.libraries.unpublishedChanges()) return t("Review unpublished changes");
  return t("Libraries");
}

// ---- Publishing --------------------------------------------------------------------------------------------------------

export interface PublishItem {
  asset: LocalAsset;
  /** The key it publishes under (a new one when it has none yet) */
  key: string;
  versionHash: string;
  dependencies: string[];
  dependencyOnly: boolean;
  /** The payload as the engine's Message (an engine with the interim JSON), or … */
  payload?: Message;
  /** … as the kiwi bytes a kiwi-writing engine gave (`encodeAssetsKiwi`): the store keeps them as they are */
  payloadBytes?: Uint8Array;
  status: "created" | "modified" | "unchanged" | "dependency";
  /** A variable's collection's key */
  collectionKey?: string;
  /** A variant's set's key */
  componentSetKey?: string;
  /** A Social template's marker and slots (docs/social.md §3.5): the manifest lists them so the gallery and list_templates needn't fetch payloads */
  social?: { template: SocialTemplateData; slots?: TemplateSlotSummary[] };
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
  /** Those assets (the modal's Hidden section, atlas 12 §3.4) */
  hidden: LocalAsset[];
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
function draftItems(ed: EditorController): { items: PublishItem[]; hiddenCount: number; hidden: LocalAsset[] } {
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
  // A kiwi-writing engine hands the payloads as the bytes the store keeps (`encodeAssetsKiwi`); else the JSON Messages.
  const keys = listed.map((a) => a.key);
  const encodeKiwi = engineCall<(keys: string[]) => { assets: (Omit<EncodedAsset, "message"> & { bytes: Uint8Array })[] }>(ed.engine, "encodeAssetsKiwi", "set_wire_format");
  const encoded: (Omit<EncodedAsset, "message"> & { message?: Message; bytes?: Uint8Array })[] = !listed.length ? [] : encodeKiwi ? encodeKiwi(keys).assets : ed.engine.encodeAssets(keys).assets;
  const items = encoded.map(
    (a): PublishItem => ({
      asset: fromEngineAsset(ed, a),
      key: a.key,
      versionHash: a.versionHash,
      dependencies: [...a.dependencies],
      dependencyOnly: a.dependencyOnly,
      ...(a.bytes ? { payloadBytes: a.bytes } : { payload: a.message }),
      status: "unchanged",
      ...(a.collectionKey ? { collectionKey: a.collectionKey } : {}),
      ...(a.componentSetKey ? { componentSetKey: a.componentSetKey } : {}),
      ...socialOf(ed, a),
    })
  );
  const hidden = top.filter((a) => a.hiddenFromPublishing).map((a) => fromEngineAsset(ed, a));
  return { items, hiddenCount: hidden.length, hidden };
}

/** A component set's (or lone component's) Social template marker and its slots, as the manifest carries them (docs/social.md §3.5). */
function socialOf(ed: EditorController, a: { kind: string; id: Guid; componentSetId?: Guid }): Pick<PublishItem, "social"> {
  if (a.kind !== "COMPONENT_SET" && !(a.kind === "COMPONENT" && !a.componentSetId)) return {};
  const n = ed.engine.readNode(a.id, { fields: ["pluginData"] }) as { pluginData?: PluginDataEntry[] } | null;
  const template = readSocial<SocialTemplateData>(n?.pluginData, "template");
  if (!template || typeof template !== "object" || !template.formats || !Object.keys(template.formats).length) return {};
  const slots = templateSlotsIn(ed.engine.readNodes([a.id], { subtree: true, fields: ["pluginData"] }) as { pluginData?: PluginDataEntry[] }[]);
  return { social: { template, slots } };
}

/** Why an asset can't be published (atlas 12 §3.5, §3.10): too many modes (the plan's limit) or variables in a collection. */
export type PublishLimitError = "TOO_MANY_MODES_ERROR" | "TOO_MANY_VARIABLES_ERROR";

/**
 * The publish modal's mode-limit check (atlas 12 §3.3): each collection's modes against the plan's limit (a personal
 * app is Enterprise: 40, `LIMITS.modes`) and its variables against Figma's 5,000. Asset key → its error.
 */
export function publishLimitErrors(ed: EditorController, draft: Pick<PublishDraft, "items">): Map<string, PublishLimitError> {
  const out = new Map<string, PublishLimitError>();
  const collections = draft.items.filter((i) => i.asset.kind === "VARIABLE_COLLECTION" && i.status !== "dependency");
  if (!collections.length || ed.engine.destroyed) return out;
  const variables = ed.engine.localAssets().filter((a) => a.kind === "VARIABLE" && !a.softDeleted);
  for (const c of collections) {
    const modes = (ed.engine.readNode(c.asset.guid, { fields: ["variableSetModes"] } as never) as { variableSetModes?: unknown[] } | null)?.variableSetModes?.length ?? 0;
    if (modes > LIMITS.modes) out.set(c.key, "TOO_MANY_MODES_ERROR");
    else if (variables.filter((v) => v.collectionId === c.asset.guid).length > LIMITS.variables) out.set(c.key, "TOO_MANY_VARIABLES_ERROR");
  }
  return out;
}

/** What publishing would change (the Publish library modal's lists). */
export async function draftPublish(ed: EditorController): Promise<PublishDraft> {
  const access = ed.source.libraries;
  if (!access || !libraryEngine(ed)) throw new Error(t("Libraries aren't available here"));
  const { items, hiddenCount, hidden } = draftItems(ed);
  const previous = await access.version(access.libraryKey).catch(() => null);
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
  return { items, preview, removed: preview.removed, moves, movedOut, previous, hiddenCount, hidden };
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
    ...(i.social ? { social: i.social } : {}),
    ...(withPayload ? (i.payloadBytes ? { payloadBytes: i.payloadBytes } : { payload: i.payload }) : {}),
    ...(thumbnailPng ? { thumbnailPng } : {}),
  };
}

export interface PublishChoices {
  description: string;
  /** Keys of created / modified / removed assets to publish (all of them by default) */
  selected: ReadonlySet<string>;
  /** fromKey → "move" (Move to this file) or "copy" (Publish as a copy) */
  moveModes: ReadonlyMap<string, "move" | "copy">;
  /** An org file: "Allow any member of ‹org› to access the file" checked ("org") or not ("team") — docs/data.md §16.6 */
  scope?: "team" | "org";
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
  if (!access || !libraryEngine(ed)) throw new Error(t("Libraries aren't available here"));
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
  const version = await access.publish({ description: choices.description, assets, moves, ...(choices.scope ? { scope: choices.scope } : {}) });
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
      throw new Error(enabled ? t("The library couldn't be added") : t("The library couldn't be removed"));
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
/**
 * The engine's import / update with the payloads as the store holds them (kiwi) when the engine reads kiwi
 * (`importLibraryAssetsKiwi` / `applyLibraryUpdateKiwi`, docs/engine-build.md "Figma parity round 3") — nothing
 * decoded or converted on the way — else as the interim JSON Messages.
 */
function importAssets(ed: EditorController, payloads: readonly PayloadIn[], opts: Parameters<Engine["importLibraryAssets"]>[1]): ReturnType<Engine["importLibraryAssets"]> {
  const kiwi = engineCall<(messages: Uint8Array[], o: typeof opts) => ReturnType<Engine["importLibraryAssets"]>>(ed.engine, "importLibraryAssetsKiwi", "set_wire_format");
  if (kiwi && payloads.every((p) => p.bytes)) return kiwi(payloads.map((p) => p.bytes!), opts);
  return ed.engine.importLibraryAssets(payloads.map((p) => p.message), opts);
}
function updateAssets(ed: EditorController, payloads: readonly PayloadIn[], opts: Parameters<Engine["applyLibraryUpdate"]>[1]): ReturnType<Engine["applyLibraryUpdate"]> {
  const kiwi = engineCall<(messages: Uint8Array[], o: typeof opts) => ReturnType<Engine["applyLibraryUpdate"]>>(ed.engine, "applyLibraryUpdateKiwi", "set_wire_format");
  if (kiwi && payloads.every((p) => p.bytes)) return kiwi(payloads.map((p) => p.bytes!), opts);
  return ed.engine.applyLibraryUpdate(payloads.map((p) => p.message), opts);
}

function importCopies(ed: EditorController, lib: string, payloads: PayloadIn[]): Map<string, Guid> {
  if (!payloads.length) return new Map();
  const r = importAssets(ed, payloads, { libraryKey: lib });
  if (r.status !== Status.OK) return new Map();
  ed.libraries.noteImported(lib, r.assets.filter((a) => a.libraryKey === lib));
  return new Map(r.assets.filter((a) => a.libraryKey === lib).map((a) => [a.key, a.id]));
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
  // A collection brought in with a default mode for this file (§16.5): set at once, its own step (the style or
  // variable applied next is the caller's step).
  ed.libraries.applyDefaultModes();
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
  const point = at ?? viewCentre(canvas);
  const centre = toPage(ed, point.x, point.y);
  const frame = at ? frameAt(ed, at.x, at.y) : null;
  const roots = importCopies(ed, lib, payloads);
  const main = roots.get(asset.key) ?? ed.libraries.copies().find((c) => c.library === lib && c.key === asset.key)?.guid;
  if (!main) return null;
  const insert = () => runEngineCommand(ed.engine, "INSERT_INSTANCE", { main, x: centre.x, y: centre.y, ...(frame ? { parent: frame } : {}) });
  let status: number = Status.OK;
  // The default modes of collections it brought in (§16.5) are part of the insertion's step.
  ed.batch("Insert instance", () => {
    status = insert();
    if (status === Status.OK) ed.libraries.applyDefaultModes();
  });
  if (status === Status.E_BUSY) status = insert(); // an engine that can't join the open step
  return status === Status.OK ? (ed.selection[0] ?? null) : null;
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

/** Figma's update batches (atlas 12 §6.4): the payloads of five assets per round trip, the progress bell after each. */
export const UPDATE_BATCH = 5;

/**
 * "Update all" (or the items given): every copy of each asset replaced by its library's latest version in place —
 * instances keep their overrides — and a moved asset's copies re-pointed at its new library (enabled here for it)
 * and updated from there. In Figma's order (atlas 12 §6.4: components, state groups, styles, variable sets, other
 * assets); the payloads fetched five assets at a time (`onProgress` after each batch: Figma's progress bell); then
 * all of it written as **one undo step** "Update library assets" (docs/data.md §9.4 — Figma makes a step per asset).
 * Returns how many assets were updated.
 */
export async function acceptUpdates(ed: EditorController, items: readonly UpdateItem[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const access = ed.source.libraries;
  if (!access) return 0;
  type Call = { lib: string; keys: string[]; redirects: { fromKey: string; toKey: string; fromLibraryKey: string }[]; items: UpdateItem[] };
  // One call per kind and library, in Figma's order.
  const calls = new Map<string, Call>();
  const call = (lib: string, u: UpdateItem): Call => {
    const id = `${updateOrder(u)}#${lib}`;
    let c = calls.get(id);
    if (!c) calls.set(id, (c = { lib, keys: [], redirects: [], items: [] }));
    return c;
  };
  const sorted = [...items].sort((a, b) => updateOrder(a) - updateOrder(b));
  const wants: { lib: string; key: string; versionHash: string }[][] = [];
  const enable = new Set<string>();
  for (const u of sorted) {
    if (u.kind === "modified" && u.asset) {
      const c = call(u.library, u);
      // The asset, and the hidden assets it uses that are behind (an item accepted on its own).
      const ws = [{ key: u.key, versionHash: u.asset.versionHash }, ...outdatedHiddenDependencies(ed, u.library, ed.libraries.get().manifests.get(u.library), u.key)];
      for (const w of ws) if (!c.keys.includes(w.key)) c.keys.push(w.key);
      wants.push(ws.map((w) => ({ lib: u.library, ...w })));
      c.items.push(u);
    } else if (u.kind === "moved" && u.redirect) {
      const r = u.redirect;
      const v = await access.version(r.toLibraryFileKey).catch(() => null);
      const a = v?.assets.find((x) => x.key === r.toKey);
      if (!a) continue;
      if (!access.enabled().includes(r.toLibraryFileKey)) enable.add(r.toLibraryFileKey);
      const c = call(r.toLibraryFileKey, u);
      if (!c.keys.includes(r.toKey)) c.keys.push(r.toKey);
      c.redirects.push({ fromKey: r.fromKey, toKey: r.toKey, fromLibraryKey: u.library });
      c.items.push(u);
      wants.push([{ lib: r.toLibraryFileKey, key: a.key, versionHash: a.versionHash }]);
    }
  }
  // The payloads, five assets at a time; each library's kept once per key (an asset asked for wins over the same key
  // brought as another's dependency).
  const payloads = new Map<string, Map<string, PayloadIn>>();
  onProgress?.(0, wants.length);
  for (let i = 0; i < wants.length; i += UPDATE_BATCH) {
    const byLib = new Map<string, Map<string, { key: string; versionHash: string }>>();
    for (const w of wants.slice(i, i + UPDATE_BATCH).flat()) byLib.set(w.lib, (byLib.get(w.lib) ?? new Map<string, { key: string; versionHash: string }>()).set(w.key, { key: w.key, versionHash: w.versionHash }));
    for (const [lib, m] of byLib) {
      const have = payloads.get(lib) ?? new Map<string, PayloadIn>();
      for (const p of await access.payloads(lib, [...m.values()], { withDependencies: true })) if (!have.has(p.key) || m.has(p.key)) have.set(p.key, p);
      payloads.set(lib, have);
    }
    onProgress?.(Math.min(wants.length, i + UPDATE_BATCH), wants.length);
  }
  // A moved asset's new library is added to the file (Figma) — bookkeeping, not part of the step.
  for (const lib of enable) await setLibraryEnabled(ed, lib, true, { refresh: false }).catch(() => {});
  if (ed.engine.destroyed || !calls.size) return 0;
  // The copies the engine actually wrote ("library/key"): a copy already at that version is reused, not written.
  const written = new Set<string>();
  const run = (c: Call) => {
    const r = updateAssets(ed, [...(payloads.get(c.lib)?.values() ?? [])], { libraryKey: c.lib, keys: c.keys, ...(c.redirects.length ? { redirects: c.redirects } : {}) });
    if (r.status === Status.OK) for (const a of r.assets) if (a.updated) written.add(`${a.libraryKey}/${a.key}`);
    return r;
  };
  const list = [...calls.values()];
  let next = 0;
  ed.batch("Update library assets", () => {
    for (; next < list.length; next++) if (run(list[next]).status === Status.E_BUSY) return; // an engine that can't join the open step: one step per call below
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
export function updateSelectedInstances(ed: EditorController, item: UpdateItem): Promise<number> {
  return updateInstances(ed, item, selectedInstancesOf(ed, item.copies.map((c) => c.guid)));
}

/**
 * `instances` of the asset to the new version (the review's "Update instance", atlas 12 §6.5; Update selected
 * instance): as `updateSelectedInstances` says. Returns how many moved.
 */
export async function updateInstances(ed: EditorController, item: UpdateItem, instances: readonly Guid[]): Promise<number> {
  const access = ed.source.libraries;
  if (!access || item.kind !== "modified" || !item.asset) return 0;
  if (!instances.length) return 0;
  // The hidden assets it uses that are behind get new copies with it (the other instances keep the old ones).
  const hidden = outdatedHiddenDependencies(ed, item.library, await ed.libraries.manifest(item.library), item.key);
  const payloads = await access.payloads(item.library, [{ key: item.asset.key, versionHash: item.asset.versionHash }, ...hidden], { withDependencies: true });
  if (ed.engine.destroyed) return 0;
  const before = new Set(ed.libraries.copies().map((c) => c.guid));
  let n = 0;
  ed.batch("Update instance", () => {
    // Inside the step: undo takes the new copy away with the swap.
    const r = importAssets(ed, payloads, { libraryKey: item.library, asNew: true, keys: [item.key, ...hidden.map((h) => h.key)] });
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

/** A copy's mains: itself, and a set's variants. */
export function mainsOf(ed: EditorController, copy: Guid): Guid[] {
  return [copy, ...(ed.engine.readNode(copy, { childIds: true })?.childIds ?? [])];
}

/**
 * The real instances on `pages` (with `nested`, the instances inside other instances' sublayers too), each with its
 * main and page — one subtree read per page (a page not derived yet is derived by the read: callers ask for the
 * current page, or for all pages when the person chose them).
 */
export function instancesOn(ed: EditorController, pages: readonly Guid[], opts: { nested?: boolean } = {}): { id: Guid; main: Guid; page: Guid }[] {
  const out: { id: Guid; main: Guid; page: Guid }[] = [];
  for (const page of pages) {
    for (const n of ed.engine.readNodes([page], { subtree: true, fields: ["type", "symbolData", "overriddenSymbolID"] }) as { guid: Guid; type?: string; symbolData?: { symbolID?: unknown }; overriddenSymbolID?: unknown }[]) {
      if (n.type !== "INSTANCE" || (!opts.nested && n.guid.startsWith("I"))) continue;
      const main = n.overriddenSymbolID ?? n.symbolData?.symbolID;
      if (main) out.push({ id: n.guid, main: guidText(main as never), page });
    }
  }
  return out;
}

/**
 * The instances an update concerns (the review's ◀ ▶, atlas 12 §6.5): those whose main is one of its copies (or a
 * variant of one), on the current page or on every page.
 */
export function instancesOfUpdate(ed: EditorController, item: Pick<UpdateItem, "copies">, scope: "current" | "all"): { id: Guid; page: Guid }[] {
  if (ed.engine.destroyed) return [];
  const mains = new Set(item.copies.flatMap((c) => mainsOf(ed, c.guid)));
  const pages = scope === "current" ? (ed.store.page ? [ed.store.page] : []) : ed.engine.pages().map((p) => p.guid);
  return instancesOn(ed, pages).filter((i) => mains.has(i.main));
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

// ---- Swap library (atlas 12 §7.1) ----------------------------------------------------------------------------------------

/** Figma's name match for Swap library: names equal once every whitespace character is taken out (case kept). */
export const swapName = (name: string): string => name.replace(/\s+/g, "");

/** One row of the Swap library view: a used asset of the library swapped from, and its match in the target. */
export interface SwapRow {
  copy: LibraryCopy;
  /** Layers here that use it */
  usage: number;
  /** Its match in the target (null: "None found") */
  match: LibraryAsset | null;
}

export interface SwapPlan {
  from: string;
  to: string;
  /** Components and component sets, then styles, then variable collections (each with its target's collections) */
  rows: SwapRow[];
  /** The target's collections (a collection row's dropdown) */
  collections: LibraryAsset[];
  /** The target's latest manifest */
  target: LibraryVersion;
}

/**
 * A used asset's match among a target library's listed assets (figma_app's Qp, atlas 12 §7.1): same name ignoring
 * whitespace; a style of the same style type; a component among components first, then among sets, and a set among
 * sets first, then components; a collection by name. Variables aren't rows: they follow their collection
 * (`swapVariables`).
 */
export function swapMatch(copy: Pick<LibraryCopy, "kind" | "name" | "styleType">, target: readonly LibraryAsset[]): LibraryAsset | null {
  const name = swapName(copy.name);
  const listed = target.filter((a) => !a.dependencyOnly && swapName(a.name) === name);
  const of = (kind: LibraryAsset["kind"]) => listed.find((a) => a.kind === kind) ?? null;
  switch (copy.kind) {
    case "COMPONENT":
      return of("COMPONENT") ?? of("COMPONENT_SET");
    case "COMPONENT_SET":
      return of("COMPONENT_SET") ?? of("COMPONENT");
    case "STYLE":
      return listed.find((a) => a.kind === "STYLE" && a.styleType === copy.styleType) ?? null;
    case "VARIABLE_COLLECTION":
      return of("VARIABLE_COLLECTION");
    default:
      return null;
  }
}

/**
 * The Swap library view's rows for swapping `from` (an added library, or a missing one) to `to`: the assets of `from`
 * used here — components and sets, styles used by a layer (Figma skips a style nobody uses), variable collections —
 * each with its match in `to`'s latest version. Null when `to` has no published version.
 */
export async function swapPlan(ed: EditorController, from: string, to: string): Promise<SwapPlan | null> {
  const target = await ed.libraries.manifest(to);
  if (!target) return null;
  const usage = ed.libraries.usage();
  const order = (c: LibraryCopy) => (c.kind === "COMPONENT" || c.kind === "COMPONENT_SET" ? 0 : c.kind === "STYLE" ? 1 : 2);
  // One row per asset: its copies here (Update instance leaves several) are swapped together.
  const byKey = new Map<string, SwapRow>();
  for (const c of ed.libraries.copies()) {
    if (c.library !== from || c.kind === "VARIABLE") continue;
    const row = byKey.get(c.key);
    if (row) row.usage += usage.get(c.guid) ?? 0;
    else byKey.set(c.key, { copy: c, usage: usage.get(c.guid) ?? 0, match: swapMatch(c, target.assets) });
  }
  const rows = [...byKey.values()]
    .filter((r) => r.copy.kind !== "STYLE" || r.usage > 0)
    .sort((a, b) => order(a.copy) - order(b.copy) || a.copy.name.localeCompare(b.copy.name));
  return { from, to, rows, collections: target.assets.filter((a) => a.kind === "VARIABLE_COLLECTION" && !a.dependencyOnly), target };
}

/** A collection's variables matched by name in the target collection (Figma's swapVariableSetVariablesByName). */
function swapVariables(ed: EditorController, from: string, collection: LibraryCopy, to: LibraryAsset, target: LibraryVersion): { copy: LibraryCopy; match: LibraryAsset }[] {
  const theirs = target.assets.filter((a) => a.kind === "VARIABLE" && a.collectionKey === to.key);
  const out: { copy: LibraryCopy; match: LibraryAsset }[] = [];
  for (const v of ed.libraries.copies()) {
    if (v.library !== from || v.kind !== "VARIABLE" || v.collectionKey !== collection.key) continue;
    const match = theirs.find((a) => swapName(a.name) === swapName(v.name));
    if (match) out.push({ copy: v, match });
  }
  return out;
}

export interface SwapChoices {
  /** Row keys (the used asset's key) to swap — the checked `swap_asset` boxes */
  keys: ReadonlySet<string>;
  /** A collection row's chosen target collection (its key), when not its match */
  collections?: ReadonlyMap<string, string>;
  /**
   * "Swap default styles and collections in instances" (Figma's createOverridesOnSwap, on by default). Off: a style or
   * collection that a component of the library left unswapped uses inside it stays (a copy here is replaced in place,
   * so its users can't be told apart).
   */
  swapDefaults: boolean;
}

/**
 * Swap library (atlas 12 §7.1; the undo step Figma calls replace-libraries): each chosen asset's copy here becomes its
 * match in the target library — replaced in place by the target's latest version (the engine's redirect, as Move to
 * this file's: every user stays linked, overrides kept by key), its collection's variables matched by name with it —
 * and a component matched to a set (or a set to a component) has its instances swapped onto the set's variant of the
 * same name (else its first) or the component. One undo step "Swap library"; the target library is added to the file
 * when it isn't. Returns what was swapped (assets, and of them variables).
 */
export async function swapLibrary(ed: EditorController, plan: SwapPlan, choices: SwapChoices): Promise<{ assets: number; variables: number }> {
  const access = ed.source.libraries;
  if (!access) return { assets: 0, variables: 0 };
  const byKey = new Map(plan.target.assets.map((a) => [a.key, a]));
  const chosen = plan.rows.filter((r) => choices.keys.has(r.copy.key)).map((r) => ({ ...r, match: r.copy.kind === "VARIABLE_COLLECTION" && choices.collections?.has(r.copy.key) ? (byKey.get(choices.collections.get(r.copy.key)!) ?? null) : r.match })).filter((r): r is SwapRow & { match: LibraryAsset } => !!r.match);
  // Off: what the source library's unswapped components use inside them stays.
  const keptInside = new Set<string>();
  if (!choices.swapDefaults) {
    const source = await ed.libraries.manifest(plan.from);
    const swappedMains = new Set(chosen.filter((r) => r.copy.kind === "COMPONENT" || r.copy.kind === "COMPONENT_SET").map((r) => r.copy.key));
    for (const a of source?.assets ?? []) if ((a.kind === "COMPONENT" || a.kind === "COMPONENT_SET") && !swappedMains.has(a.key)) for (const d of a.dependencies) keptInside.add(d);
  }
  const redirects: { fromKey: string; toKey: string; fromLibraryKey: string }[] = [];
  const crossKind: { copy: LibraryCopy; match: LibraryAsset }[] = [];
  let variables = 0;
  for (const r of chosen) {
    if ((r.copy.kind === "STYLE" || r.copy.kind === "VARIABLE_COLLECTION") && keptInside.has(r.copy.key)) continue;
    if (r.copy.kind !== r.match.kind) {
      crossKind.push({ copy: r.copy, match: r.match });
      continue;
    }
    redirects.push({ fromKey: r.copy.key, toKey: r.match.key, fromLibraryKey: plan.from });
    if (r.copy.kind !== "VARIABLE_COLLECTION") continue;
    for (const v of swapVariables(ed, plan.from, r.copy, r.match, plan.target)) {
      redirects.push({ fromKey: v.copy.key, toKey: v.match.key, fromLibraryKey: plan.from });
      variables++;
    }
  }
  const keys = [...new Set([...redirects.map((r) => r.toKey), ...crossKind.map((c) => c.match.key)])];
  if (!keys.length) return { assets: 0, variables: 0 };
  const payloads = await access.payloads(plan.to, keys.map((key) => ({ key, versionHash: byKey.get(key)!.versionHash })), { withDependencies: true });
  if (!access.enabled().includes(plan.to)) await setLibraryEnabled(ed, plan.to, true, { refresh: false }).catch(() => {});
  if (ed.engine.destroyed) return { assets: 0, variables: 0 };
  // The instances a cross-kind swap moves (every page: the swap is the whole file's).
  const instances = crossKind.length ? instancesOn(ed, ed.engine.pages().map((p) => p.guid)) : [];
  let swapped = 0;
  const run = () => {
    if (redirects.length) {
      const r = updateAssets(ed, payloads, { libraryKey: plan.to, keys: redirects.map((x) => x.toKey), redirects });
      if (r.status !== Status.OK) return r.status;
      swapped += new Set(r.assets.filter((a) => a.updated && a.libraryKey === plan.to).map((a) => a.key)).size;
    }
    if (!crossKind.length) return Status.OK;
    const r = importAssets(ed, payloads, { libraryKey: plan.to });
    if (r.status !== Status.OK) return r.status;
    for (const c of crossKind) {
      const target = r.assets.find((a) => a.key === c.match.key && a.libraryKey === plan.to)?.id;
      if (!target) continue;
      const mains = new Set(ed.libraries.copies().filter((x) => x.library === plan.from && x.key === c.copy.key).flatMap((x) => mainsOf(ed, x.guid)));
      let moved = 0;
      for (const inst of instances) {
        if (!mains.has(inst.main)) continue;
        const to = c.match.kind === "COMPONENT_SET" ? variantMatch(ed, inst.id, target) : target;
        if (to && runEngineCommand(ed.engine, "SWAP_INSTANCE", { main: to, ref: inst.id }) === Status.OK) moved++;
      }
      if (moved) swapped++;
    }
    return Status.OK;
  };
  let status: number = Status.OK;
  ed.batch("Swap library", () => {
    status = run();
  });
  if (status === Status.E_BUSY) run(); // an engine that can't join the open step
  await ed.libraries.refresh();
  return { assets: swapped, variables };
}

/**
 * The libraries copies here come from that aren't published any more (atlas 12 §7.2: "View missing libraries"):
 * deleted, unpublished or unknown — each with how many of its assets are used here.
 */
export function missingLibraries(state: LibraryState, copies: readonly LibraryCopy[], own: string | undefined): { library: string; name: string; assets: number }[] {
  const available = new Set(state.available.map((e) => e.fileKey));
  const out = new Map<string, { library: string; name: string; assets: number }>();
  for (const c of copies) {
    if (c.library === own || available.has(c.library) || state.manifests.has(c.library)) continue;
    const m = out.get(c.library) ?? { library: c.library, name: state.names.get(c.library) ?? t("Missing library"), assets: 0 };
    m.assets++;
    out.set(c.library, m);
  }
  return [...out.values()];
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
