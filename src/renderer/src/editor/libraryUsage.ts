/**
 * Library usage events (docs/data.md §17.3): insertions and detaches of org libraries' components, styles and
 * variables, read from the editor's own change batches and handed to the store's analytics queue
 * (`store.analytics.record`, debounced 2 s). One module, no call sites spread over the editor: the store's document
 * source hands every appended batch here (`noteLibraryUsage`, its one hook line), and the editor attaches a recorder
 * with the engine for its source (`attachLibraryUsage`, from the library index).
 *
 * Rules (per batch; only kind `edit` counts — undo, redo, system, remote, restore never do):
 * - **Component insert**: a node CREATED as an INSTANCE of an org library copy, not inside another such instance
 *   created in the same batch (a pasted frame of three instances: three; an instance nested in a pasted instance: no).
 *   An instance created inside slot content counts (its parent instance existed before). A **swap**: an existing
 *   instance's main changes to a copy of another component (a variant switch inside one set is not a swap — ours).
 * - **Component detach**: an existing node gains `detachedSymbolId` pointing at a copy (by GUID, or by the copy's asset
 *   key — what a detach of a library main records) and stops being an INSTANCE.
 * - **Style insert**: a `styleIdFor*` newly set to an org style copy, once per (node, style), not on a node inside a
 *   counted component insert (only the component counts).
 * - **Style detach**: a `styleIdFor*` that pointed at an org style copy is cleared and the matching field written in
 *   the same change.
 * - **Variable insert**: a binding newly pointing at an org variable copy (a field binding, a paint's or an effect's
 *   colour), not under a counted component insert or a style insert of the same node.
 * - **Variable detach**: such a binding removed with the raw value written ("Detach variable").
 *
 * What a node pointed at before a batch (needed for swaps and detaches) comes from what the recorder saw: every batch's
 * nodes, and the selected nodes read when the selection changes (detaches act on the selection). A node never seen is
 * judged by the batch's undo label (the engine's "Swap instance", "Apply style", "Apply variable", "Detach variable").
 */
import { isLocalLibraryKey, type AnalyticsAssetType, type LibraryUsageEvent, type UsageAction } from "../../../shared/libraries/orgTypes";
import type { BatchKind } from "../../../shared/store/types";
import type { EditorController } from "./controller";

/** An org library copy here, as the events name it (the copy's `sourceLibraryKey` and `key`) */
export interface UsageCopy {
  library: string;
  key: string;
  type: AnalyticsAssetType;
  /** A variant's set (its key) */
  set?: string;
}

/** What the recorder needs of the document: the org copies by GUID ("s:l"), and a node's current fields. */
export interface UsageWorld {
  copy(guid: string): UsageCopy | null;
  /** A copy by its asset key (a detach of a library main records the asset, not the copy's GUID) */
  copyByKey?(key: string, type: AnalyticsAssetType): UsageCopy | null;
  /** The copies changed (an import): `copy` reads them again */
  invalidate(): void;
  /** Reads nodes as they are now (engine or kiwi shape) */
  read(guids: readonly string[]): unknown[];
}

/** One counted action, before the file and the time are added */
export interface UsageCount {
  library: string;
  asset: string;
  type: AnalyticsAssetType;
  action: UsageAction;
  count: number;
}

type Slot = "fill" | "stroke" | "text" | "effect" | "grid";
type VarSource = "params" | "fill" | "stroke" | "effects";
const STYLE_FIELD: Record<Slot, string> = { fill: "styleIdForFill", stroke: "styleIdForStrokeFill", text: "styleIdForText", effect: "styleIdForEffect", grid: "styleIdForGrid" };
/** The fields a style's detach writes inline */
const STYLE_LOOK: Record<Slot, readonly string[]> = {
  fill: ["fillPaints"],
  stroke: ["strokePaints"],
  text: ["fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration", "paragraphSpacing", "fontVariations"],
  effect: ["effects"],
  grid: ["layoutGrids"],
};
const VAR_FIELD: Record<VarSource, string> = { params: "parameterConsumptionMap", fill: "fillPaints", stroke: "strokePaints", effects: "effects" };
/** A style slot's variables come with the style (a variable used by an inserted style isn't counted) */
const VAR_SLOT: Record<VarSource, Slot | null> = { params: null, fill: "fill", stroke: "stroke", effects: "effect" };

/** What a node points at; a field left out is unknown (never seen) */
interface NodeRefs {
  symbol?: string | null;
  styles: Partial<Record<Slot, string | null>>;
  vars: Partial<Record<VarSource, string[]>>;
}

type Any = Record<string, unknown>;

/** A GUID in either shape — the engine's "s:l" or kiwi's {sessionID, localID} — as "s:l"; null when absent. */
export function gid(x: unknown): string | null {
  if (typeof x === "string") return x || null;
  if (x && typeof x === "object" && "sessionID" in x && "localID" in x) {
    const g = x as { sessionID: number; localID: number };
    return `${g.sessionID}:${g.localID}`;
  }
  return null;
}

const refGuid = (ref: unknown): string | null => gid((ref as Any | undefined)?.guid);
const aliasOf = (data: unknown): string | null => refGuid(((data as Any | undefined)?.value as Any | undefined)?.alias);

function varsOf(n: Any, source: VarSource): string[] {
  const out = new Set<string>();
  const field = n[VAR_FIELD[source]];
  if (source === "params") {
    for (const e of ((field as Any | undefined)?.entries as Any[] | undefined) ?? []) {
      const a = aliasOf(e.variableData);
      if (a) out.add(a);
    }
  } else {
    for (const p of (field as Any[] | undefined) ?? []) {
      const a = aliasOf(p?.colorVar);
      if (a) out.add(a);
    }
  }
  return [...out];
}

/** The fields a change (or a read node) states about what it points at */
function refsIn(n: Any, all: boolean): NodeRefs {
  const r: NodeRefs = { styles: {}, vars: {} };
  if (all || "symbolData" in n) r.symbol = gid((n.symbolData as Any | undefined)?.symbolID);
  for (const slot of Object.keys(STYLE_FIELD) as Slot[]) if (all || STYLE_FIELD[slot] in n) r.styles[slot] = refGuid(n[STYLE_FIELD[slot]]);
  for (const src of Object.keys(VAR_FIELD) as VarSource[]) if (all || VAR_FIELD[src] in n) r.vars[src] = varsOf(n, src);
  return r;
}

export class LibraryUsageRecorder {
  private readonly known = new Map<string, NodeRefs>();
  private pending = new Map<string, UsageCount>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly world: UsageWorld,
    private readonly sink: (counts: UsageCount[]) => void,
    private readonly debounceMs = 2000
  ) {}

  /** Remembers what these nodes point at now (the selection: what a detach will act on). */
  prime(guids: readonly string[]): void {
    const fresh = guids.filter((g) => !g.startsWith("I")).slice(0, 500);
    if (!fresh.length) return;
    for (const n of this.world.read(fresh) as Any[]) {
      const g = gid(n?.guid);
      if (g) this.known.set(g, refsIn(n, true));
    }
  }

  /** One appended batch: counts what it inserted or detached, then remembers its nodes. */
  onBatch(kind: BatchKind, changes: readonly unknown[], label?: string): UsageCount[] {
    const list = changes as Any[];
    if (list.some((c) => "sourceLibraryKey" in c)) this.world.invalidate();
    const counts = kind === "edit" ? this.count(list, label ?? "") : [];
    for (const c of list) {
      const g = gid(c.guid);
      if (!g) continue;
      if (c.phase === "REMOVED") {
        this.known.delete(g);
        continue;
      }
      const now = refsIn(c, c.phase === "CREATED");
      const was = c.phase === "CREATED" ? undefined : this.known.get(g);
      this.known.set(g, was ? { symbol: "symbol" in now ? now.symbol : was.symbol, styles: { ...was.styles, ...now.styles }, vars: { ...was.vars, ...now.vars } } : now);
    }
    if (this.known.size > 50_000) this.known.clear();
    for (const c of counts) {
      const k = `${c.library}\u0000${c.asset}\u0000${c.type}\u0000${c.action}`;
      const row = this.pending.get(k);
      if (row) row.count += c.count;
      else this.pending.set(k, { ...c });
    }
    if (counts.length && !this.timer) this.timer = setTimeout(() => this.flush(), this.debounceMs);
    return counts;
  }

  /** Hands what was counted to the sink now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.size) return;
    const rows = [...this.pending.values()];
    this.pending = new Map();
    this.sink(rows);
  }

  dispose(): void {
    this.flush();
    this.known.clear();
  }

  private count(list: Any[], label: string): UsageCount[] {
    const world = this.world;
    const byGuid = new Map<string, Any>();
    for (const c of list) {
      const g = gid(c.guid);
      if (g) byGuid.set(g, c);
    }
    const created = (g: string | null): boolean => !!g && byGuid.get(g)?.phase === "CREATED";
    const copyAs = (g: string | null | undefined, type: AnalyticsAssetType): UsageCopy | null => {
      if (!g) return null;
      const c = world.copy(g);
      return c && c.type === type ? c : null;
    };
    const out = new Map<string, UsageCount>();
    const seen = new Set<string>();
    const add = (node: string, copy: UsageCopy, action: UsageAction) => {
      const once = `${node}\u0000${copy.library}\u0000${copy.key}\u0000${action}`;
      if (seen.has(once)) return;
      seen.add(once);
      const k = `${copy.library}\u0000${copy.key}\u0000${copy.type}\u0000${action}`;
      const row = out.get(k);
      if (row) row.count++;
      else out.set(k, { library: copy.library, asset: copy.key, type: copy.type, action, count: 1 });
    };

    // Created instances of org components; counted unless a created one encloses them (nested in a pasted instance).
    const candidates = new Set<string>();
    for (const [g, c] of byGuid) if (c.phase === "CREATED" && c.type === "INSTANCE" && !c.sourceLibraryKey && copyAs(gid((c.symbolData as Any | undefined)?.symbolID), "component")) candidates.add(g);
    const ancestorIn = (g: string, set: ReadonlySet<string>): boolean => {
      let p = refGuid(byGuid.get(g)?.parentIndex);
      for (let i = 0; p && created(p) && i < 4096; i++) {
        if (set.has(p)) return true;
        p = refGuid(byGuid.get(p)?.parentIndex);
      }
      return false;
    };
    const counted = new Set([...candidates].filter((g) => !ancestorIn(g, candidates)));
    const insideInsert = (g: string) => counted.has(g) || ancestorIn(g, counted);
    for (const g of counted) add(g, copyAs(gid((byGuid.get(g)!.symbolData as Any).symbolID), "component")!, "insert");

    for (const [g, c] of byGuid) {
      if (c.phase === "REMOVED" || c.sourceLibraryKey) continue;
      const isNew = c.phase === "CREATED";
      const prev = isNew ? undefined : this.known.get(g);
      // Swap / detach of an existing instance
      if (!isNew && "symbolData" in c) {
        const next = gid((c.symbolData as Any | undefined)?.symbolID);
        const to = copyAs(next, "component");
        const before = prev?.symbol;
        if (to && next !== before) {
          const from = before ? world.copy(before) : null;
          const swapped = before === undefined ? label === "Swap instance" : !(from && from.set && from.set === to.set) && !(from && from.key === to.key && from.library === to.library);
          if (swapped) add(g, to, "insert");
        }
      }
      if (!isNew && "detachedSymbolId" in c && c.type !== undefined && c.type !== "INSTANCE") {
        // A library main is recorded by its asset (assetRef {key}); a main of the file by its GUID.
        const assetKey = ((c.detachedSymbolId as Any | undefined)?.assetRef as Any | undefined)?.key;
        const from =
          copyAs(refGuid(c.detachedSymbolId), "component") ??
          (typeof assetKey === "string" ? (copyAs(prev?.symbol, "component") ?? world.copyByKey?.(assetKey, "component") ?? null) : null);
        if (from) add(g, from, "detach");
      }
      if (insideInsert(g)) continue;
      // Styles
      const styled = new Set<Slot>();
      for (const slot of Object.keys(STYLE_FIELD) as Slot[]) {
        const field = STYLE_FIELD[slot];
        if (!(field in c)) continue;
        const next = refGuid(c[field]);
        const before = isNew ? null : prev?.styles[slot];
        if (next) {
          const to = copyAs(next, "style");
          if (to && (isNew || (before === undefined ? label === "Apply style" : before !== next))) {
            add(g, to, "insert");
            styled.add(slot);
          }
        } else if (before) {
          const from = copyAs(before, "style");
          if (from && STYLE_LOOK[slot].some((f) => f in c)) add(g, from, "detach");
        }
      }
      // Variables
      for (const src of Object.keys(VAR_FIELD) as VarSource[]) {
        if (!(VAR_FIELD[src] in c)) continue;
        const slot = VAR_SLOT[src];
        const next = varsOf(c, src);
        const before = isNew ? [] : prev?.vars[src];
        if (!(slot && styled.has(slot))) {
          for (const v of next) {
            const to = copyAs(v, "variable");
            if (to && (before === undefined ? label === "Apply variable" : !before.includes(v))) add(g, to, "insert");
          }
        }
        for (const v of before ?? []) {
          if (next.includes(v)) continue;
          const from = copyAs(v, "variable");
          if (!from) continue;
          // The raw value written: a paint / effect list carries it; a field binding needs another field in the change.
          const raw = src === "params" ? Object.keys(c).some((k) => k !== "guid" && k !== "parameterConsumptionMap" && k !== "phase") : label === "Detach variable";
          if (raw) add(g, from, "detach");
        }
      }
    }
    return [...out.values()];
  }
}

// ---- Wiring ------------------------------------------------------------------------------------------------------------

const recorders = new WeakMap<object, LibraryUsageRecorder>();

/**
 * The store's document source hands every batch it appends here (its one hook line, docs/data.md §17.3): the
 * recorder the editor attached for that source counts it. `changes`: the batch's node changes (kiwi).
 */
export function noteLibraryUsage(source: object, kind: BatchKind, changes: readonly unknown[] | undefined, label?: string): void {
  const r = recorders.get(source);
  if (!r || !changes?.length) return;
  try {
    r.onBatch(kind, changes, label);
  } catch (e) {
    console.warn("library usage: a batch couldn't be read", e);
  }
}

/** The engine's org library copies, by GUID (rebuilt after imports; variants carry their set's key). */
export function engineUsageWorld(ed: EditorController): UsageWorld {
  let map: Map<string, UsageCopy> | null = null;
  let missRebuilt = false;
  const build = () => {
    map = new Map();
    missRebuilt = false;
    if (ed.engine.destroyed) return;
    for (const u of ed.engine.libraryUsage()) {
      if (!u.libraryKey || isLocalLibraryKey(u.libraryKey) || !u.key) continue;
      const type: AnalyticsAssetType | null = u.kind === "COMPONENT" || u.kind === "COMPONENT_SET" ? "component" : u.kind === "STYLE" ? "style" : u.kind === "VARIABLE" ? "variable" : null;
      if (type) map.set(u.id, { library: u.libraryKey, key: u.key, type, ...(u.componentSetKey ? { set: u.componentSetKey } : {}) });
    }
  };
  return {
    copy(guid) {
      if (!map) build();
      const hit = map!.get(guid);
      if (hit || missRebuilt) return hit ?? null;
      // A copy imported since (its batch may not have reached us yet): read once more.
      build();
      missRebuilt = true;
      return map!.get(guid) ?? null;
    },
    copyByKey(key, type) {
      if (!map) build();
      for (const c of map!.values()) if (c.key === key && c.type === type) return c;
      return null;
    },
    invalidate() {
      map = null;
    },
    read(guids) {
      if (ed.engine.destroyed) return [];
      try {
        return ed.engine.readNodes(guids, { fields: ["guid", "type", "symbolData", ...Object.values(STYLE_FIELD), ...Object.values(VAR_FIELD)] });
      } catch {
        return [];
      }
    },
  };
}

/**
 * Starts counting this editor's usage of org libraries (an org copy in a folder; the source's `analytics` decides):
 * a recorder over the engine, registered for the source, primed with each selection. Returns its stop.
 */
export function attachLibraryUsage(ed: EditorController, now: () => number = Date.now): () => void {
  const access = ed.source.libraries;
  const analytics = access?.analytics;
  if (!access || !analytics) return () => {};
  const recorder = new LibraryUsageRecorder(engineUsageWorld(ed), (rows) => {
    if (!analytics.reports()) return;
    const at = now();
    const events: LibraryUsageEvent[] = rows.map((r) => ({ fileKey: access.fileKey, libraryKey: r.library, assetKey: r.asset, assetType: r.type, action: r.action, count: r.count, at }));
    void analytics.record(events).catch(() => {});
  });
  recorders.set(ed.source, recorder);
  const offSelection = ed.engine.onSelectionChanged((s) => recorder.prime(s.refs));
  return () => {
    offSelection();
    recorder.dispose();
    if (recorders.get(ed.source) === recorder) recorders.delete(ed.source);
  };
}
