/**
 * The annotation menu (help.figma.com 20774752502935: "Write a note in the text field, or click + Property to select a
 * property from the list"; the menu has "options to add text, property, and category"): a layer's note with its
 * category, its markdown text and its pinned properties (live values), opened by the Annotation tool's click (a new
 * note) or a click on a label. Every change is written at once (one undo step each); Delete removes the note.
 */
import { useMemo, useState } from "react";
import { Button, IconButton, MenuButton, Popover, Select, TextArea, type MenuEntry, type SelectOption } from "@/ds";
import type { NodeChange } from "@/engine/codec";
import { annotationProperty } from "../../../../viewer/inspect/devMode";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import type { UIState } from "../uiStore";
import { CATEGORY_HEX, PROPERTY_LABEL, propertiesFor, type Note, type PropertyType } from "./annotations";
import { ensureCategoryId, readCategories, readNotes, writeNotes } from "./devMode";
import styles from "./DevMode.module.css";

const EDIT_CATEGORIES = "__edit";
const NONE = "__none";

export function AnnotationEditor() {
  const at = useUI((s) => s.annotationEditor);
  if (!at) return null;
  return <Editor key={`${at.ref}/${at.index}`} at={at} />;
}

function Editor({ at }: { at: NonNullable<UIState["annotationEditor"]> }) {
  const ed = useEditor();
  // The note's index once it exists (a new one is written at its first change).
  const [index, setIndex] = useState(at.index);
  const [version, setVersion] = useState(0);
  const notes = useMemo(() => readNotes(ed, at.ref), [ed, at.ref, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const note: Note = (index >= 0 ? notes[index] : null) ?? { markdown: "", properties: [], categoryId: null };
  const categories = useMemo(() => readCategories(ed), [ed, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const node = useMemo(() => ed.engine.readNode(at.ref) as NodeChange | null, [ed, at.ref, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const parent = node?.parentIndex?.guid ? ed.engine.readNode(node.parentIndex.guid, { fields: ["stackMode"] }) : null;
  const offered = propertiesFor({ type: ed.withRealType(node ?? ({} as NodeChange)).type, stackMode: node?.stackMode, parentStackMode: parent?.stackMode ?? null, resizeToFit: (node as { resizeToFit?: boolean } | null)?.resizeToFit });

  const close = () => {
    ed.ui.set({ annotationEditor: null });
    if (ed.store.tool === "ANNOTATION") ed.setTool("MOVE");
    ed.focusCanvas();
  };
  const save = (next: Note, label: string) => {
    const list = [...notes];
    let i = index;
    if (i < 0 || i >= list.length) {
      list.push(next);
      i = list.length - 1;
    } else list[i] = next;
    writeNotes(ed, at.ref, list, label);
    // An emptied note is removed by the write: it is gone.
    setIndex(next.markdown.trim() || next.properties.length ? i : -1);
    setVersion((v) => v + 1);
  };
  const remove = () => {
    if (index >= 0) writeNotes(ed, at.ref, notes.filter((_, i) => i !== index), "Delete annotation");
    close();
  };

  const categoryOptions: (SelectOption | "-")[] = [
    { value: NONE, label: "No category" },
    ...categories.map((c, i) => ({ value: String(i), label: c.label, hint: c.color.toLowerCase() })),
    "-",
    { value: EDIT_CATEGORIES, label: "Edit categories…" },
  ];
  const catIndex = categories.findIndex((c) => c.id && c.id === note.categoryId);
  const current = categories[catIndex];
  const propEntries: MenuEntry[] = offered.filter((p) => !note.properties.includes(p)).map((p) => ({ id: p, label: PROPERTY_LABEL[p] }));
  const anchor = new DOMRect(at.x, at.y, at.width, at.height);
  return (
    <Popover anchor={anchor} placement="right" onClose={close} label="Annotation" width={280} title={node?.name ?? "Annotation"}>
      <div className={styles.noteEditor} data-annotation-editor="">
        <div className={styles.noteRow}>
          <span className={styles.categoryDot} style={{ background: current ? CATEGORY_HEX[current.color] : "var(--figma-color-bg-success)" }} />
          <Select
            label="Category"
            value={catIndex >= 0 ? String(catIndex) : NONE}
            options={categoryOptions}
            onChange={(v) => {
              if (v === EDIT_CATEGORIES) return ed.ui.set({ categoriesOpen: true });
              const id = v === NONE ? null : ensureCategoryId(ed, categories, Number(v));
              save({ ...note, categoryId: id }, "Edit annotation");
            }}
          />
        </div>
        <TextArea
          label="Note"
          value={note.markdown}
          placeholder="Add a note"
          autoFocus
          minRows={3}
          onCommit={(v) => save({ ...note, markdown: v }, index < 0 ? "Add annotation" : "Edit annotation")}
          onExit={(r) => (r === "escape" ? close() : undefined)}
        />
        {note.properties.length > 0 && (
          <div className={styles.pinned} data-pinned="">
            {note.properties.map((p) => (
              <div key={p} className={styles.pinnedRow}>
                <span className={styles.pinnedLabel}>{PROPERTY_LABEL[p]}</span>
                <span className={styles.pinnedValue}>{node ? annotationProperty(p, node).value : "—"}</span>
                <IconButton
                  icon="24.minus.small"
                  label={`Remove ${PROPERTY_LABEL[p]}`}
                  onClick={() => save({ ...note, properties: note.properties.filter((x) => x !== p) }, "Edit annotation")}
                />
              </div>
            ))}
          </div>
        )}
        <div className={styles.noteActions}>
          <MenuButton entries={propEntries} label="Property" onSelect={(id) => save({ ...note, properties: [...note.properties, id as PropertyType] }, index < 0 ? "Add annotation" : "Edit annotation")} className={styles.addProperty}>
            + Property
          </MenuButton>
          <span className={styles.grow} />
          {index >= 0 && (
            <Button variant="secondary" onClick={remove}>
              Delete
            </Button>
          )}
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </div>
      </div>
    </Popover>
  );
}
