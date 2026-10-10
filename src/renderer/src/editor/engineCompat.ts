/**
 * Feature detection (docs/editor.md): what the engine build in hand can do,
 * so a control whose engine side isn't there yet shows disabled instead of
 * writing into the void or throwing.
 *
 * - Fields: `supportsField` = the engine types the field (a read of a node
 *   lists every typed field); `keepsField` = it at least keeps it (since E3
 *   the engine round-trips every schema field it doesn't model: written,
 *   undone, copied and saved, just not drawn yet).
 * - Commands: `hasCommand` = abi.ts's CommandId names it (E4's booleans,
 *   Flatten, Outline stroke, Use as mask, PLACE_IMAGES…).
 * - Methods: `engineMethod` = the Engine facade has it (E4's vector editing,
 *   E5's gradient handles and image upload), looked up by the names
 *   docs/engine-build.md publishes.
 */
import * as abi from "@/engine/abi";
import { CMD_ENABLED, CommandId, Status, type CommandName } from "@/engine/abi";
import type { NodeChange } from "@/engine/codec";
import { Engine } from "@/engine/Engine";

// ---- Fields ------------------------------------------------------------------------------------

const typedFields = new WeakMap<Engine, Set<string>>();
const keepsExtras = new WeakMap<Engine, boolean>();

/**
 * Does the engine type this NodeChange field? A read returns every field the
 * engine models (docs/engine.md §10.3 engine_read_nodes), so one read of the
 * document node tells.
 */
export function supportsField(engine: Engine, field: keyof NodeChange | string): boolean {
  let fields = typedFields.get(engine);
  if (!fields) {
    const node = engine.destroyed ? null : engine.readNode("0:0");
    fields = new Set(node ? Object.keys(node) : []);
    if (node) typedFields.set(engine, fields);
  }
  return fields.has(field as string);
}

/**
 * Does the engine keep fields it doesn't model (E3: `NodeProps::extra`)? Probed
 * once: a write of an untyped schema field to the current page inside a
 * transaction that is cancelled at once (nothing is emitted or kept).
 */
function engineKeepsExtras(engine: Engine): boolean {
  let known = keepsExtras.get(engine);
  if (known !== undefined) return known;
  if (engine.destroyed) return false;
  const page = engine.getSelection().pageId;
  // Busy (a scrub's transaction is open): ask again later. EditorController probes at mount, before any edit.
  if (!page || engine.txnBegin("probe") !== Status.OK) return false;
  known = engine.setProps([page], { guides: [] } as never) === Status.OK;
  engine.txnCancel();
  keepsExtras.set(engine, known);
  return known;
}

/** Probes the keep-extras write now (a panel asking for an untyped field would otherwise run it, and emit, mid-render). */
export function probeKeeps(engine: Engine): void {
  engineKeepsExtras(engine);
}

/** Does the engine keep this field (typed, or round-tripped as it came)? Panels gate their controls on it. */
export function keepsField(engine: Engine, field: keyof NodeChange | string): boolean {
  return supportsField(engine, field) || engineKeepsExtras(engine);
}

// ---- Commands ----------------------------------------------------------------------------------

/** Is `name` one of the engine's commands in this build? */
export const hasCommand = (name: string): name is CommandName => Object.prototype.hasOwnProperty.call(CommandId, name);

/** A command's arguments (E6's take booleans, string arrays and, for variables, any JSON value). */
export type CommandArgs = Record<string, unknown>;

/** Runs an engine command by name if this build has it (Status.E_UNSUPPORTED otherwise). */
export function runEngineCommand(engine: Engine, name: string, args?: CommandArgs): number {
  return hasCommand(name) ? engine.command(name, args as Record<string, number | string> | undefined) : Status.E_UNSUPPORTED;
}

/** The command exists and the engine says it can run now. */
export function engineCommandEnabled(engine: Engine, name: string): boolean {
  return hasCommand(name) && (engine.commandState(name) & CMD_ENABLED) !== 0;
}

// ---- Loading -------------------------------------------------------------------------------------

/** The engine's wire form (src/renderer/src/store/loadDocument.ts): the schema's kiwi, or the interim JSON. */
export type EngineWireFormat = "json" | "kiwi";

/** The optional ABI constants a kiwi-reading engine publishes (docs/engine-build.md "Figma parity round 3"), if any. */
const optionalAbi = abi as unknown as Record<string, unknown>;
const abiFlag = (...names: string[]): number => {
  for (const n of names) if (typeof optionalAbi[n] === "number") return optionalAbi[n] as number;
  return 0;
};

/** The facade's private exports and handle (Engine.ts keeps them private; this is the one place outside it that reaches them). */
function rawEngine(engine: Engine): { x: { module: Record<string, unknown>; load(h: number, b: Uint8Array): number; applyChanges(h: number, b: Uint8Array, flags: number): number; encodeDocument(h: number, flags: number): number; result(): Uint8Array }; h: number } | null {
  const x = engine["x" as keyof Engine] as unknown as { module: Record<string, unknown>; load(h: number, b: Uint8Array): number; applyChanges(h: number, b: Uint8Array, flags: number): number; encodeDocument(h: number, flags: number): number; result(): Uint8Array } | undefined;
  const h = engine["h" as keyof Engine] as unknown as number | undefined;
  return x && h ? { x, h } : null;
}

/** Does the module export `engine_<name>` (without an engine in hand)? */
export function moduleExports(module: Record<string, unknown> | undefined, cName: string): boolean {
  return !module || typeof module[`_engine_${cName}`] === "function";
}

/**
 * Which wire form the engine in hand loads and applies (docs/engine-build.md "Figma parity round 3 — API"): "kiwi"
 * when the facade has `loadKiwi` and the module is of that round (it exports `engine_set_wire_format`); else the
 * interim JSON. A kiwi-reading engine takes the store's snapshot and journal bytes as they are (`engine_load`,
 * `engine_apply_changes` and `engine_paste` tell the two forms apart by the first byte).
 */
export function engineWireFormat(engine: Engine | { module?: Record<string, unknown> } | null): EngineWireFormat {
  if (!engine) return "json";
  const facade = engine instanceof Engine ? engine : null;
  const module = facade ? rawEngine(facade)?.x.module : (engine as { module?: Record<string, unknown> }).module;
  if (!moduleExports(module, "set_wire_format")) return "json";
  if (facade && !engineMethod(facade, "loadKiwi", "loadBytes")) return "json";
  return "kiwi";
}

/**
 * The engine version of the `@derived` fields it reads and writes (`Message.derivedDataVersion`, docs/schema.md
 * §1.3; `engine_derived_data_version()`): a snapshot carrying another version draws nothing from them. 0 when this
 * build doesn't say (no derived data is then stored or trusted).
 */
export function engineDerivedDataVersion(engine: Engine): number {
  const method = engineMethod<() => number>(engine, "derivedDataVersion");
  if (method) {
    const v = method();
    return typeof v === "number" && v > 0 ? v : 0;
  }
  const statics = Engine as unknown as Record<string, unknown>;
  if (typeof statics.DERIVED_DATA_VERSION === "number") return statics.DERIVED_DATA_VERSION as number;
  const raw = rawEngine(engine);
  const fn = raw?.x.module._engine_derived_data_version;
  if (typeof fn === "function") return ((fn as () => number)() >>> 0) || 0;
  return abiFlag("DERIVED_DATA_VERSION");
}

/**
 * Loads a document the source already encoded in the engine's wire form. Kiwi: the facade's `loadKiwi(bytes,
 * {page})` (alias `loadBytes`) — `page`, the page to show first, is the only one derived (`engine_load_at`). JSON:
 * the facade's `loadEncoded` / `loadBytes` when it has one, else the module's `engine_load` — the same call
 * `Engine.load` makes after encoding — followed by the facade's event pump.
 */
export function loadEngineBytes(engine: Engine, bytes: Uint8Array, format: EngineWireFormat = "json", options: { page?: string | null } = {}): number {
  if (format === "kiwi") {
    const kiwi = engineMethod<(b: Uint8Array, o?: { page?: string }) => number>(engine, "loadKiwi", "loadBytes");
    if (kiwi) return kiwi(bytes, options.page ? { page: options.page } : undefined);
    const raw = rawEngine(engine);
    if (!raw) return Status.E_UNSUPPORTED;
    const status = raw.x.load(raw.h, bytes); // the engine tells kiwi from JSON by the first byte
    engine.pump();
    return status;
  }
  const direct = engineMethod<(b: Uint8Array) => number>(engine, "loadEncoded", "loadBytes");
  if (direct) return direct(bytes);
  const raw = rawEngine(engine);
  if (!raw) return Status.E_UNSUPPORTED;
  const status = raw.x.load(raw.h, bytes);
  engine.pump();
  return status;
}

type ApplyKind = Parameters<Engine["applyChanges"]>[1];
const APPLY_FLAGS: Record<NonNullable<ApplyKind>, number> = {
  user: abi.APPLY_USER,
  system: abi.APPLY_SYSTEM,
  restore: abi.APPLY_USER | abi.APPLY_EXACT,
  remote: abi.APPLY_REMOTE,
  load: abi.APPLY_LOAD,
};

/**
 * Applies a change given as the store's kiwi bytes (a journal frame replayed at load, a frame from elsewhere, a
 * restore diff) without converting it: the facade's `applyChangesKiwi(bytes, kind)`, else the module's
 * `engine_apply_changes` of a round-3 build (it tells kiwi from JSON by the first byte). Null when this build has
 * no such path (the caller converts and uses `applyChanges`).
 */
export function applyEngineBytes(engine: Engine, bytes: Uint8Array, kind: NonNullable<ApplyKind>): number | null {
  const kiwi = engineMethod<(b: Uint8Array, k: ApplyKind) => number>(engine, "applyChangesKiwi");
  if (kiwi) return kiwi(bytes, kind);
  const raw = rawEngine(engine);
  if (!raw || !moduleExports(raw.x.module, "set_wire_format")) return null;
  const status = raw.x.applyChanges(raw.h, bytes, APPLY_FLAGS[kind]);
  engine.pump();
  return status;
}

/**
 * The whole document as the engine's kiwi snapshot, every node with its `@derived` fields (docs/data.md §5.5): the
 * facade's `encodeDocumentKiwi({derived})`; else, on a round-3 module, `engine_encode_document(h, ENCODE_DERIVED)`
 * with the engine's wire format set to kiwi for the call. Null when this build can't (an engine without kiwi: its
 * JSON drops derived fields, and the store would gain nothing from a snapshot of them).
 */
export function encodeDocumentBytes(engine: Engine, options: { derived: boolean }): Uint8Array | null {
  const kiwi = engineMethod<(o: { derived?: boolean }) => Uint8Array | null | undefined>(engine, "encodeDocumentKiwi");
  if (kiwi) return kiwi({ derived: options.derived }) ?? null;
  const raw = rawEngine(engine);
  if (!raw) return null;
  const module = raw.x.module;
  const setWire = module._engine_set_wire_format;
  const getWire = module._engine_wire_format;
  if (typeof setWire !== "function" || typeof getWire !== "function") return null;
  const before = (getWire as (h: number) => number)(raw.h) >>> 0;
  if (before !== 1) (setWire as (h: number, w: number) => number)(raw.h, 1);
  try {
    const flags = options.derived ? abiFlag("ENCODE_DERIVED") || 1 : 0;
    const status = raw.x.encodeDocument(raw.h, flags);
    return status === Status.OK ? raw.x.result() : null;
  } finally {
    if (before !== 1) (setWire as (h: number, w: number) => number)(raw.h, before);
    engine.pump();
  }
}

/** A DOCUMENT_CHANGED event's change as the kiwi bytes the engine wrote, when this build gives them (`bytes` / `kiwi`). */
export function changeBytesOf(event: object): Uint8Array | undefined {
  const e = event as { bytes?: unknown; kiwi?: unknown };
  if (e.bytes instanceof Uint8Array) return e.bytes;
  if (e.kiwi instanceof Uint8Array) return e.kiwi;
  return undefined;
}

// ---- Methods -------------------------------------------------------------------------------------

/**
 * Does the loaded module export `engine_<name>`? The facade (Engine.ts) can be ahead of the wasm in hand — its
 * method is there, the C export not yet — so calls new in a round check both.
 */
export function engineExports(engine: Engine, cName: string): boolean {
  const module = (engine as unknown as { x?: { module?: Record<string, unknown> } }).x?.module;
  return !module || typeof module[`_engine_${cName}`] === "function";
}

/** A facade method that the module in hand also exports (`cName`: its C name without `engine_`), bound; else null. */
export function engineCall<F extends (...args: never[]) => unknown>(engine: Engine, name: string, cName: string): F | null {
  return engineExports(engine, cName) ? engineMethod<F>(engine, name) : null;
}

/** One of the facade's methods by name (the first of `names` it has), bound; null when the build has none. */
export function engineMethod<F extends (...args: never[]) => unknown>(engine: Engine, ...names: string[]): F | null {
  const e = engine as unknown as Record<string, unknown>;
  for (const name of names) {
    const f = e[name];
    if (typeof f === "function") return (f as F).bind(engine) as F;
  }
  return null;
}

// ---- Change events on either wire --------------------------------------------------------------------------------

type GuidLike = string | { sessionID: number; localID: number } | undefined;
const guidText = (g: GuidLike): string => (typeof g === "string" ? g : g ? `${g.sessionID}:${g.localID}` : "");

const viewCache = new WeakMap<object, NodeChange[]>();

/**
 * A DOCUMENT_CHANGED's node changes with GUIDs as "s:l" strings (`guid`, `parentIndex.guid`), whatever the engine's
 * wire: with `wire: "kiwi"` the event's `message` is the kiwi-shaped Message (GUID objects, decoded lazily from its
 * `bytes`), with JSON the engine's interim form. A shallow view — every other field is as the wire gives it, so
 * readers test keys (`"name" in c`), phases and GUIDs, not values. One view per event, shared by every reader.
 */
export function changesOf(event: { message: { nodeChanges?: readonly unknown[] } }): readonly NodeChange[] {
  const cached = viewCache.get(event);
  if (cached) return cached;
  const list = (event.message?.nodeChanges ?? []) as (NodeChange & { guid: GuidLike })[];
  const view =
    list.length && typeof list[0]?.guid !== "string"
      ? list.map((c) => {
          const v = { ...c, guid: guidText(c.guid) } as NodeChange;
          const p = (c as { parentIndex?: { guid: GuidLike; position: string } }).parentIndex;
          if (p) v.parentIndex = { ...p, guid: guidText(p.guid) };
          return v;
        })
      : (list as NodeChange[]);
  viewCache.set(event, view);
  return view;
}
