// Panel edits on a live engine, as the editor makes them: one setProps per change, and a scrub (`final: false` until
// the release) wrapped in one transaction — one undo step.
import type { ChangeInfo } from "@/ds/types";
import type { Engine } from "@/engine/Engine";
import type { Guid, NodeFieldsPatch } from "@/engine/codec";

const open = new WeakSet<Engine>();

export function write(engine: Engine, refs: readonly Guid[], fields: NodeFieldsPatch, label: string, info?: ChangeInfo): void {
  if (!refs.length) return;
  if (info && !info.final) {
    if (!open.has(engine)) {
      engine.txnBegin(label);
      open.add(engine);
    }
    engine.setProps(refs, fields);
    return;
  }
  engine.setProps(refs, fields);
  if (open.has(engine)) {
    open.delete(engine);
    engine.txnCommit();
  }
}

export function cancelWrite(engine: Engine): void {
  if (!open.has(engine)) return;
  open.delete(engine);
  engine.txnCancel();
}
