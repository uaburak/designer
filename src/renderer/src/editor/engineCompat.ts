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
import { CMD_ENABLED, CommandId, Status, type CommandName } from "@/engine/abi";
import type { NodeChange } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";

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

/**
 * Loads a document the source already encoded in the engine's wire form (the load worker's bytes): through the
 * facade's own method when it has one (`loadEncoded` / `loadBytes`), else straight through the module's
 * `engine_load` — the same call `Engine.load` makes after encoding — followed by the facade's event pump.
 */
export function loadEngineBytes(engine: Engine, bytes: Uint8Array): number {
  const direct = engineMethod<(b: Uint8Array) => number>(engine, "loadEncoded", "loadBytes");
  if (direct) return direct(bytes);
  // Engine.ts keeps its exports and handle private; this is the one place outside it that reaches them (the engine
  // owner can replace it with a facade method — see docs/editor.md "Needed from other workstreams").
  const x = engine["x" as keyof Engine] as unknown as { load(h: number, bytes: Uint8Array): number } | undefined;
  const h = engine["h" as keyof Engine] as unknown as number | undefined;
  if (!x || typeof x.load !== "function" || !h) return Status.E_UNSUPPORTED;
  const status = x.load(h, bytes);
  engine.pump();
  return status;
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
