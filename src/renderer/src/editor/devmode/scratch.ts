/**
 * The component playground's scratch document (docs/editor.md D-2): a second engine that holds one instance of the
 * component, made from a clipboard copy of it (the copy carries its main, component set, styles and variables — the
 * same Message a paste in another file reads). The playground's controls change that instance only: the file, its
 * journal and its undo history are never touched (the editor's selection is put back the moment the copy is taken).
 */
import { Engine } from "@/engine/Engine";
import type { ComponentInfo, Guid, Message } from "@/engine/codec";
import { runEngineCommand } from "../engineCompat";
import { EMPTY_DOCUMENT } from "../fixtures";

export interface Scratch {
  engine: Engine;
  /** The instance the controls change */
  instance: Guid;
}

/** The clipboard copy of `id` from the editor's engine (its selection restored); null when it can't be copied. */
export function copyOf(engine: Engine, id: Guid): Message | null {
  const before = engine.getSelection();
  try {
    engine.setSelection([id]);
    const m = engine.encodeSelection();
    // Always another file's copy for the scratch engine (a file with no key yet copies without one).
    return m ? ({ ...m, pasteFileKey: (m as { pasteFileKey?: string }).pasteFileKey || "designer-source" } as Message) : null;
  } finally {
    engine.setSelection(before.refs);
  }
}

/** What the scratch copy starts from: the instance itself, a variant's component set, or the main component. */
export function copyRoot(info: ComponentInfo | null, id: Guid): Guid | null {
  if (!info) return null;
  if (info.kind === "INSTANCE" || info.kind === "NESTED_INSTANCE") return id;
  if (info.kind === "VARIANT") return info.main?.set ?? id;
  if (info.kind === "COMPONENT" || info.kind === "COMPONENT_SET") return id;
  return null;
}

/**
 * The scratch engine with one instance: an instance is pasted as it is (its overrides kept); a main component or
 * a set is pasted, then an instance of it is inserted (a set's: its default variant, or the variant opened on).
 */
export async function buildScratch(source: Engine, id: Guid, canvas: HTMLCanvasElement | null, images: ((sha1: string) => Promise<Uint8Array | null>) | null): Promise<Scratch | null> {
  const info = source.componentInfo(id);
  const root = copyRoot(info, id);
  if (!root) return null;
  const message = copyOf(source, root);
  if (!message) return null;
  const engine = await Engine.create(canvas, { sessionID: 1 });
  try {
    engine.load(EMPTY_DOCUMENT);
    // Another file: the copy brings its main (and set, styles, variables) along, as a paste across files does.
    engine.setFileKey("designer-playground");
    if (images) engine.setImageSource(images);
    engine.setSelection([]);
    if (engine.paste(message, { inPlace: true }) <= 0) throw new Error("the copy couldn't be pasted");
    let instance = engine.getSelection().refs[0] ?? null;
    const pasted = instance ? engine.componentInfo(instance) : null;
    if (pasted && pasted.kind !== "INSTANCE") {
      // A main or a set: an instance of it beside it (a variant opened on: that variant of the pasted set).
      let main = instance!;
      if (info?.kind === "VARIANT" && pasted.kind === "COMPONENT_SET") {
        const name = source.readNode(id, { fields: ["name"] })?.name;
        const kids = (engine.readNode(main, { childIds: true, fields: ["name"] }) as { childIds?: Guid[] } | null)?.childIds ?? [];
        main = kids.find((k) => engine.readNode(k, { fields: ["name"] })?.name === name) ?? main;
      }
      engine.setSelection([]);
      if (runEngineCommand(engine, "INSERT_INSTANCE", { main, x: 100_000, y: 100_000 }) < 0) throw new Error("no instance could be made");
      instance = engine.getSelection().refs[0] ?? null;
    }
    if (!instance) throw new Error("nothing was pasted");
    engine.setSelection([]);
    engine.setViewerMode(true);
    return { engine, instance };
  } catch {
    engine.destroy();
    return null;
  }
}

/** One control's change: a property of the scratch instance (a variant by its name, the others by id). */
export function setScratchProperty(s: Scratch, prop: { id: Guid; name: string; type: string }, value: boolean | string): boolean {
  s.engine.setViewerMode(false);
  try {
    return runEngineCommand(s.engine, "SET_COMPONENT_PROPERTY", { ref: s.instance, prop: prop.type === "VARIANT" ? prop.name : prop.id, value: value as never }) >= 0;
  } finally {
    s.engine.setViewerMode(true);
  }
}

/** A variable collection's mode on the scratch instance ("" = Auto). */
export function setScratchMode(s: Scratch, collection: Guid, mode: string): boolean {
  s.engine.setViewerMode(false);
  try {
    return runEngineCommand(s.engine, "SET_VARIABLE_MODE", { refs: [s.instance] as never, collection, mode }) >= 0;
  } finally {
    s.engine.setViewerMode(true);
  }
}
