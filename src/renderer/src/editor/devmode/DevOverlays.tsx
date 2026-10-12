/**
 * Dev Mode's smaller overlays (R9 "Round 6"): "Edit categories…" (a colour and a name per category; Figma's presets can
 * be edited or deleted), a saved measurement's custom text ("double-click on the measurement to customize its text"),
 * a design's status menu (Ready for dev: Show in focus view, Compare changes, Mark as completed, Remove status;
 * Changed: a reason, "Done with changes"), and focus view's bar ("See all ready for dev", "Inspect on page",
 * "Mark as completed").
 */
import { useMemo, useState } from "react";
import { Button, ContextMenu, Dialog, IconButton, Popover, Select, TextInput, type MenuEntry } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { useDocumentVersion, useUI } from "../hooks";
import { setDevStatusOf } from "../devStatus";
import { canSetStatus, frameStatusOf } from "../frameStatus";
import { StatusTag } from "./StatusTag";
import { frameStatusMenu, isStatusRow, pickFrameStatus } from "../panels/design/FrameStatusButton";
import { CATEGORY_COLORS, CATEGORY_COLOR_LABEL, CATEGORY_HEX, type Category, type CategoryColor } from "./annotations";
import { closeFocus, modeOf, openFocus, readCategories, setMode, writeCategories } from "./devMode";
import styles from "./DevMode.module.css";

// ---- Edit categories… ----------------------------------------------------------------------------------------------

export function CategoriesDialog() {
  const open = useUI((s) => !!s.categoriesOpen);
  if (!open) return null;
  return <Categories />;
}

function Categories() {
  const ed = useEditor();
  const [list, setList] = useState<Category[]>(() => readCategories(ed));
  const close = () => ed.ui.set({ categoriesOpen: false });
  const change = (i: number, patch: Partial<Category>) => setList((l) => l.map((c, k) => (k === i ? { ...c, ...patch, custom: true } : c)));
  return (
    <Dialog
      title="Edit categories"
      size="medium"
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={() => setList((l) => [...l, { id: null, preset: null, label: "New category", color: unusedColor(l), custom: true }])}>
            Add category
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              writeCategories(ed, list);
              close();
            }}
          >
            Done
          </Button>
        </>
      }
    >
      <div className={styles.categories} data-categories="">
        {list.map((c, i) => (
          <div key={c.id ?? `new-${i}`} className={styles.categoryRow} data-category={c.label}>
            <span className={styles.categoryDot} style={{ background: CATEGORY_HEX[c.color] }} />
            <Select
              label="Color"
              value={c.color}
              width={120}
              options={CATEGORY_COLORS.map((k) => ({ value: k, label: CATEGORY_COLOR_LABEL[k] }))}
              onChange={(v) => change(i, { color: v as CategoryColor })}
            />
            <TextInput label="Category name" value={c.label} onCommit={(v) => change(i, { label: v.trim() || c.label })} className={styles.grow} />
            <IconButton icon="24.minus.small" label={`Delete ${c.label}`} onClick={() => setList((l) => l.filter((_, k) => k !== i))} />
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function unusedColor(list: readonly Category[]): CategoryColor {
  return CATEGORY_COLORS.find((c) => !list.some((x) => x.color === c)) ?? "GREEN";
}

// ---- A measurement's custom text -------------------------------------------------------------------------------------

export function MeasurementText() {
  const ed = useEditor();
  const at = useUI((s) => s.measurementEditor);
  if (!at) return null;
  const close = () => {
    ed.ui.set({ measurementEditor: null });
    ed.focusCanvas();
  };
  return (
    <Popover anchor={new DOMRect(at.x, at.y, at.width, at.height)} placement="bottom" onClose={close} label="Measurement" width={220}>
      <TextInput
        label="Measurement text"
        value={at.text}
        autoFocus
        onCommit={(v) => {
          // An emptied field (or the value itself) goes back to the measured value.
          const auto = ed.engine.devInfo().measurements.find((m) => m.id === at.id)?.value;
          const free = v.trim() === "" || (auto !== undefined && v.trim() === String(Math.round(auto * 100) / 100)) ? "" : v;
          ed.engine.command("MEASUREMENT_UPDATE", { id: at.id, freeText: free });
          close();
        }}
        onExit={(r) => (r === "escape" ? close() : undefined)}
      />
    </Popover>
  );
}

// ---- A design's status menu ------------------------------------------------------------------------------------------

export function statusOf(ed: EditorController, ref: Guid): "READY" | "COMPLETED" | "CHANGED" | null {
  return ed.engine.devInfo().statuses.find((s) => s.ref === ref)?.status ?? null;
}

/**
 * The status menu, opened from the status in a design's title or its `</>` (docs/editor.md "Frame status (ours)": the
 * owner's statuses replace Ready for dev's own menu). A design marked Ready to Dev: first Figma's own actions — Design
 * mode "Open in Dev Mode", "Copy link" (the owner's recording at 21 s); Dev Mode "Show in focus view", "Compare
 * changes" (Done too) — then the statuses with their dots, the current one checked, and "No status". "Changed" (a Ready
 * to Dev design edited since): Figma's reason and "Done with changes".
 */
export function StatusMenu() {
  const ed = useEditor();
  const at = useUI((s) => s.statusMenu);
  if (!at) return null;
  const dev = statusOf(ed, at.ref);
  const current = frameStatusOf(ed, at.ref);
  const close = () => ed.ui.set({ statusMenu: null });
  if (dev === "CHANGED" && current === "ready-to-dev") return <DoneWithChanges at={at} onClose={close} />;
  const inDev = modeOf(ed) === "dev";
  const figma: MenuEntry[] =
    !inDev && current === "ready-to-dev"
      ? [{ id: "dev", label: "Open in Dev Mode" }, { id: "link", label: "Copy link", disabled: true }, "-"]
      : inDev && dev
        ? [{ id: "focus", label: "Show in focus view" }, { id: "compare", label: "Compare changes" }, "-"]
        : [];
  return (
    <ContextMenu
      at={{ x: at.x, y: at.y + at.height + 4 }}
      entries={[...figma, ...frameStatusMenu(current, { disabled: !canSetStatus(ed) })]}
      label="Status"
      onClose={close}
      onSelect={(id) => {
        close();
        if (id === "dev") {
          setMode(ed, "dev");
          ed.engine.setSelection([at.ref]);
        } else if (id === "focus") openFocus(ed, at.ref);
        else if (id === "compare") ed.ui.set({ compare: { ref: at.ref } });
        else if (isStatusRow(id)) pickFrameStatus(ed, [at.ref], id);
      }}
    />
  );
}

/** "Changed": optionally a reason, then "Done with changes" (back to Ready for dev). */
function DoneWithChanges({ at, onClose }: { at: { ref: Guid; x: number; y: number; width: number; height: number }; onClose: () => void }) {
  const ed = useEditor();
  const [reason, setReason] = useState("");
  return (
    <Popover anchor={new DOMRect(at.x, at.y, at.width, at.height)} placement="bottom-start" onClose={onClose} label="Changed" width={260} title="Changed">
      <div className={styles.doneWithChanges} data-done-with-changes="">
        <div className={styles.hint}>This design was edited after it was marked ready for dev.</div>
        <TextInput label="Reason" value={reason} placeholder="Add a reason (optional)" onChange={setReason} />
        <div className={styles.noteActions}>
          <Button
            variant="secondary"
            onClick={() => {
              onClose();
              ed.ui.set({ compare: { ref: at.ref } });
            }}
          >
            Compare changes
          </Button>
          <span className={styles.grow} />
          <Button
            variant="primary"
            onClick={() => {
              setDevStatusOf(ed, [at.ref], "BUILD", { description: reason.trim() || undefined, label: "Done with changes" });
              onClose();
            }}
          >
            Done with changes
          </Button>
        </div>
      </div>
    </Popover>
  );
}

// ---- Focus view ----------------------------------------------------------------------------------------------------

export function FocusBar() {
  const ed = useEditor();
  const focus = useUI((s) => s.focus ?? null);
  useDocumentVersion();
  const name = useMemo(() => (focus ? (ed.engine.readNode(focus, { fields: ["name"] })?.name ?? "") : ""), [ed, focus]);
  if (!focus) return null;
  const status = statusOf(ed, focus);
  const workflow = frameStatusOf(ed, focus);
  return (
    <div className={styles.focusBar} data-focus-bar="">
      <Button variant="secondary" onClick={() => closeFocus(ed)}>
        See all ready for dev
      </Button>
      <span className={styles.focusName}>{name}</span>
      {workflow && (
        <StatusTag
          workflow={workflow}
          dev={status}
          variant="chip"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            ed.ui.set({ statusMenu: { ref: focus, x: r.left, y: r.top, width: r.width, height: r.height } });
          }}
        />
      )}
      <span className={styles.grow} />
      <Button variant="secondary" onClick={() => closeFocus(ed, { inspectOnPage: true })}>
        Inspect on page
      </Button>
      {status === "READY" && (
        <Button variant="primary" onClick={() => setDevStatusOf(ed, [focus], "COMPLETED")}>
          Mark as completed
        </Button>
      )}
      <IconButton icon="24.close.small" label="Close focus view" onClick={() => closeFocus(ed)} />
    </div>
  );
}
