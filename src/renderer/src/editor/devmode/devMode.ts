/**
 * Dev Mode in the editor (docs/research/figma/R9-dev-mode.md "Round 6"; docs/editor.md "round 6"): the mode switch
 * (⇧D), annotations (the Annotation tool ⇧T, notes and categories written to Figma's fields), saved measurements (the
 * Measurement tool ⇧M; the engine writes them), statuses on the canvas (the engine draws them and the `</>` that
 * toggles Ready for dev; the status menu here), focus view and Compare changes. The engine draws and hit-tests; this file
 * turns its events into the panels' state and writes what the panels edit.
 */
import type { Guid, NodeFields } from "@/engine/codec";
import type { EditorController } from "../controller";
import { setDevStatusOf, statusOfTargets } from "../devStatus";
import { categoriesOf, encodeCategories, encodeNotes, notesOf, type AnnotationData, type CategoriesJson, type Category, type Note } from "./annotations";

/** Design, Dev Mode, or Draw (round 10, View › Switch to Draw: the Design editor with the Pencil to hand — Figma Draw's own brushes and panels aren't built). */
export type Mode = "design" | "dev" | "draw";

export const modeOf = (ed: EditorController): Mode => ed.ui.get().mode ?? "design";
export const annotationsShown = (ed: EditorController): boolean => ed.ui.get().annotations ?? true;

/** The engine's view of the mode and of View › Annotations. */
function syncEngine(ed: EditorController): void {
  if (ed.engine.destroyed) return;
  const dev = modeOf(ed) === "dev";
  ed.engine.setViewerMode(dev, { devEdits: true });
  ed.engine.setAnnotationView(annotationsShown(ed), dev);
}

/** Design ⇄ Dev Mode (⇧D, the toolbar's switch) ⇄ Draw. Leaving Dev Mode leaves focus view. */
export function setMode(ed: EditorController, mode: Mode): void {
  if (modeOf(ed) === mode) return;
  if (mode !== "dev" && ed.ui.get().focus) closeFocus(ed);
  ed.ui.set({ mode, statusMenu: null, annotationEditor: null, measurementEditor: null });
  syncEngine(ed);
  ed.focusCanvas();
}

export function toggleAnnotations(ed: EditorController): void {
  ed.ui.set({ annotations: !annotationsShown(ed) });
  syncEngine(ed);
}

/** The canvas's rect (canvas CSS px) in viewport px. */
function toViewport(ed: EditorController, r: { x: number; y: number; width: number; height: number }) {
  const c = ed.canvas?.getBoundingClientRect();
  return { x: (c?.left ?? 0) + r.x, y: (c?.top ? c.top : 0) + r.y, width: r.width, height: r.height };
}

/** The engine's Dev Mode events → the panels' state. */
export function attachDevMode(ed: EditorController): () => void {
  syncEngine(ed);
  const offs = [
    ed.engine.on("ANNOTATION_OPEN", (e) => {
      // Dev Mode's dots open their label on the canvas; the note editor opens from a label (and from the tool).
      if (modeOf(ed) === "dev" && e.index >= 0 && !ed.ui.get().annotationEditor) {
        const open = ed.engine.devInfo().hits.annotations.some((h) => h.ref === e.ref && h.index === e.index && !h.dot);
        if (!open) return;
      }
      ed.ui.set({ annotationEditor: { ref: e.ref, index: e.index, ...toViewport(ed, e) } });
    }),
    ed.engine.on("MEASUREMENT_EDIT", (e) => ed.ui.set({ measurementEditor: { id: e.id, text: e.text, ...toViewport(ed, e) } })),
    ed.engine.on("DEV_STATUS", (e) => {
      if (e.action === "mark") {
        // The `</>` at a selected design's top right toggles Ready for dev (live Figma's canvas icon, the header's
        // "Toggle ready for dev status").
        setDevStatusOf(ed, [e.ref], statusOfTargets(ed, [e.ref]) === "BUILD" ? null : "BUILD");
        return;
      }
      ed.ui.set({ statusMenu: { ref: e.ref, ...toViewport(ed, e) } });
    }),
  ];
  return () => offs.forEach((off) => off());
}

// ---- Notes -------------------------------------------------------------------------------------------------------

export function readNotes(ed: EditorController, ref: Guid): Note[] {
  const n = ed.engine.readNode(ref, { fields: ["annotations"] }) as { annotations?: AnnotationData[] } | null;
  return notesOf(n);
}

/** Writes a layer's notes (one undo step). */
export function writeNotes(ed: EditorController, ref: Guid, notes: readonly Note[], label: string): void {
  ed.setProps([ref], { annotations: encodeNotes(notes) } as unknown as NodeFields, label);
}

// ---- Categories ----------------------------------------------------------------------------------------------------

function documentId(ed: EditorController): Guid | null {
  const page = ed.engine.readNode(ed.store.page, { fields: ["parentIndex"] });
  return page?.parentIndex?.guid ?? null;
}

export function readCategories(ed: EditorController): Category[] {
  const doc = documentId(ed);
  const n = doc ? (ed.engine.readNode(doc, { fields: ["annotationCategories"] }) as { annotationCategories?: CategoriesJson } | null) : null;
  return categoriesOf(n?.annotationCategories ?? null);
}

/** A fresh id for a category (an id inside the field, not a node: unique among the file's categories). */
function categoryIdMaker(ed: EditorController, taken: readonly (Guid | null)[]): () => Guid {
  const session = ed.source.sessionID ?? 1;
  const used = new Set(taken.filter(Boolean));
  return () => {
    for (;;) {
      const id = `${session}:${0x40000000 + Math.floor(Math.random() * 0x3fffffff)}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
}

/** Writes the file's categories (giving Figma's presets their ids the first time); returns them with ids. */
export function writeCategories(ed: EditorController, list: readonly Category[], label = "Edit categories"): Category[] {
  const doc = documentId(ed);
  if (!doc) return [...list];
  const { list: withIds, json } = encodeCategories(list, categoryIdMaker(ed, list.map((c) => c.id)));
  ed.setProps([doc], { annotationCategories: json } as unknown as NodeFields, label);
  return withIds;
}

/** The id of a category to put on a note: a preset not in the file yet is written first. */
export function ensureCategoryId(ed: EditorController, list: readonly Category[], index: number): Guid | null {
  if (list[index]?.id) return list[index].id;
  return writeCategories(ed, list, "Edit categories")[index]?.id ?? null;
}

// ---- Focus view ------------------------------------------------------------------------------------------------------

/** Focus view (help.figma.com 23919923330455): the design alone, zoomed to; Dev Mode. */
export function openFocus(ed: EditorController, ref: Guid): void {
  if (modeOf(ed) !== "dev") setMode(ed, "dev");
  ed.ui.set({ focus: ref, statusMenu: null });
  ed.engine.setFocus(ref);
  ed.engine.setSelection([ref]);
  ed.engine.command("ZOOM_TO_SELECTION");
  ed.engine.setSelection([]);
}

export function closeFocus(ed: EditorController, opts: { inspectOnPage?: boolean } = {}): void {
  const ref = ed.ui.get().focus;
  ed.ui.set({ focus: null });
  ed.engine.setFocus(null);
  if (ref && opts.inspectOnPage) {
    ed.engine.setSelection([ref]);
    ed.engine.command("ZOOM_TO_SELECTION");
  }
}
