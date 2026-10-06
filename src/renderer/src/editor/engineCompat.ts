/**
 * The one place the editor reaches engine features that are still landing
 * (docs/editor.md §6). Everything here feature-detects at runtime, so the
 * editor typechecks against today's facade and lights up as the engine
 * grows: a command name absent from `CommandId`, a method absent from
 * `Engine`, a field the engine doesn't keep — each reads as "unsupported"
 * and the UI shows it disabled. When a name exists, call it directly
 * instead and drop it from here.
 */
import { CMD_CHECKED, CMD_ENABLED, CommandId, Status, type CommandName } from "@/engine/abi";
import type { Guid, Message, NodeChange } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";

/** Commands the editor calls whose ids the engine is adding (docs/engine.md §10.6). */
export type PendingCommand =
  | "GROUP"
  | "UNGROUP"
  | "FRAME_SELECTION"
  | "DUPLICATE"
  | "FLIP_HORIZONTAL"
  | "FLIP_VERTICAL"
  | "ALIGN_LEFT"
  | "ALIGN_HORIZONTAL_CENTER"
  | "ALIGN_RIGHT"
  | "ALIGN_TOP"
  | "ALIGN_VERTICAL_CENTER"
  | "ALIGN_BOTTOM"
  | "DISTRIBUTE_HORIZONTAL"
  | "DISTRIBUTE_VERTICAL"
  | "ADD_AUTO_LAYOUT"
  | "REMOVE_AUTO_LAYOUT"
  | "CREATE_PAGE"
  | "DELETE_PAGE"
  | "DUPLICATE_PAGE"
  | "SELECT_INVERSE";

export type AnyCommand = CommandName | PendingCommand;

const ids = CommandId as Readonly<Record<string, number>>;

/** Does the engine know this command (its id is in abi.ts)? */
export const hasCommand = (name: AnyCommand): boolean => Object.prototype.hasOwnProperty.call(ids, name);

/** Runs a command if the engine has it; E_UNSUPPORTED otherwise. */
export function runCommand(engine: Engine, name: AnyCommand, args?: Record<string, number>): number {
  if (!hasCommand(name)) return Status.E_UNSUPPORTED;
  return engine.command(name as CommandName, args);
}

/** The command's menu state: enabled only when the engine has it and says so. */
export function commandState(engine: Engine, name: AnyCommand): { enabled: boolean; checked: boolean } {
  if (!hasCommand(name)) return { enabled: false, checked: false };
  const bits = engine.commandState(name as CommandName);
  return { enabled: (bits & CMD_ENABLED) !== 0, checked: (bits & CMD_CHECKED) !== 0 };
}

/** A page argument as the engine's command args carry it (numbers only): its GUID's two halves. */
export function pageArgs(page: Guid): Record<string, number> {
  const [sessionID, localID] = page.split(":").map(Number);
  return { page: localID, pageSession: sessionID, sessionID, localID };
}

// ---- Methods the engine is adding to its facade -------------------------------------------

interface PendingEngine {
  /** Reorders/reparents `refs` under `parent` at `index` in paint order (0 = bottom), among its other children. */
  moveNodes?(refs: readonly Guid[], parent: Guid, index: number): number;
  /** The selection as a clipboard Message (the selected subtrees as CREATED), or null with nothing selected. */
  encodeSelection?(): Message | null;
  /** Pastes a clipboard Message: over the selection / at the viewport's centre, or where it was copied (`inPlace`). */
  paste?(message: Message, options?: { inPlace?: boolean }): number;
}

const pending = (engine: Engine) => engine as unknown as PendingEngine;

export const canMoveNodes = (engine: Engine): boolean => typeof pending(engine).moveNodes === "function";
export const canCopy = (engine: Engine): boolean => typeof pending(engine).encodeSelection === "function";
export const canPaste = (engine: Engine): boolean => typeof pending(engine).paste === "function";

export function moveNodes(engine: Engine, refs: readonly Guid[], parent: Guid, index: number): number {
  const move = pending(engine).moveNodes;
  return move ? move.call(engine, refs, parent, index) : Status.E_UNSUPPORTED;
}

export function encodeSelection(engine: Engine): Message | null {
  const encode = pending(engine).encodeSelection;
  return encode ? encode.call(engine) : null;
}

export function paste(engine: Engine, message: Message, options: { inPlace?: boolean } = {}): number {
  const run = pending(engine).paste;
  return run ? run.call(engine, message, options) : Status.E_UNSUPPORTED;
}

// ---- Fields the engine keeps ----------------------------------------------------------------

const keptFields = new WeakMap<Engine, Set<string>>();

/**
 * Does the engine keep this NodeChange field? A read returns every field the
 * engine keeps (docs/engine.md §10.3 engine_read_nodes), so one read of the
 * document node tells. A field it doesn't keep is dropped on write
 * (engine_set_props answers E_INVALID when nothing is left).
 */
export function supportsField(engine: Engine, field: keyof NodeChange | string): boolean {
  let fields = keptFields.get(engine);
  if (!fields) {
    const node = engine.destroyed ? null : engine.readNode("0:0");
    fields = new Set(node ? Object.keys(node) : []);
    if (node) keptFields.set(engine, fields);
  }
  return fields.has(field as string);
}
