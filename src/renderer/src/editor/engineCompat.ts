/**
 * Field detection (docs/editor.md): which NodeChange fields the engine keeps,
 * so a panel control whose field isn't kept yet shows disabled instead of
 * writing into the void. (Round 2 brought every command and method the
 * editor uses into abi.ts / Engine; they are called directly.)
 */
import type { NodeChange } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";

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
