/**
 * "Selection colors" (Figma UI3): the distinct solid colours and gradients of
 * the selection's fills and strokes and of every visible layer inside it, each
 * once (a gradient as one row: its swatch and type, its picker edits every use); editing a
 * row (hex, opacity, the picker) recolours every paint using it, as one undo
 * step; the target button selects the layers using it. The first four rows
 * show, then "See all N colors". Rules and order: model/selectionColors.ts.
 */
import { useMemo, useState } from "react";
import { Button, ColorInput, IconButton, PanelSection, Swatch, type ChangeInfo } from "@/ds";
import * as abi from "@/engine/abi";
import type { Color, Guid, NodeChange } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import { useEditor, type EditorController } from "../../controller";
import { engineExports } from "../../engineCompat";
import { useSelectionColorsVersion } from "../../hooks";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { paintLabel, paintSwatch } from "../../model/paints";
import {
  SELECTION_COLORS_DEBOUNCE_USES,
  SELECTION_COLORS_MAX_NODES,
  SELECTION_COLORS_NO_LIMIT,
  SELECTION_COLORS_PEEK,
  collectColors,
  collectSelectionColors,
  recolor,
  selectionColorsLayout,
  showSelectionColors,
  type PaintUse,
  type SelectionColor,
} from "../../model/selectionColors";
import type { PickerTarget } from "./Paints";
import { ColorVariablePill } from "./Variables";
import type { PanelNode } from "./shared";
import { t, tp, useT } from "@/i18n";
import styles from "./Design.module.css";

/** What Selection colors reads of a layer (docs/engine-build.md "Performance round 2": a paints-only read). */
const COLOR_FIELDS = ["fillPaints", "strokePaints", "visible", "mask", "styleIdForFill", "styleIdForStrokeFill"];

/**
 * Does the engine build read a subtree with chosen fields in one call? abi.ts names READ_SUBTREE and the module in
 * hand is the round that added it (its `engine_layer_changes` export) — the facade can be ahead of the wasm, and an
 * older wasm given the flag would answer the refs alone.
 */
const hasSubtreeRead = (engine: Engine): boolean => "READ_SUBTREE" in abi && engineExports(engine, "layer_changes");

/**
 * The visible layers inside each of `refs` (not the selected ones), each selected layer's subtree children first
 * (first child first), a boolean's operands left out; null past `max` layers. One engine read of the paints alone when
 * the build has it (`readNodes` with `fields`, `subtree`, `visibleOnly`: hidden subtrees left out by the engine), else
 * read one level at a time with every field.
 */
export function readInsideGroups(engine: Engine, refs: readonly Guid[], max = SELECTION_COLORS_MAX_NODES): NodeChange[][] | null {
  const byId = new Map<Guid, NodeChange>();
  if (hasSubtreeRead(engine)) {
    // One row past `max` says "too many" without reading (and decoding) the rest of a huge selection.
    const rows = (engine.readNodes as (r: readonly Guid[], o: object) => NodeChange[])(refs, { childIds: true, fields: COLOR_FIELDS, subtree: true, visibleOnly: true, limit: max + 1 });
    if (rows.length > max) return null;
    for (const n of rows) byId.set(n.guid, n);
  } else {
    let level = [...refs];
    while (level.length) {
      const next: Guid[] = [];
      for (const n of engine.readNodes(level, { childIds: true })) {
        if (byId.has(n.guid)) continue;
        byId.set(n.guid, n);
        if (n.visible === false) continue;
        for (const c of n.childIds ?? []) if (!byId.has(c)) next.push(c);
      }
      if (byId.size > max) return null;
      level = next;
    }
  }
  // Figma's live order: a layer's children before it, the first child first (a frame's child's colour, then the
  // frame's; a group's g_a, then g_b). A boolean's operands draw only through the boolean: not read.
  const walk = (id: Guid, out: NodeChange[]) => {
    const n = byId.get(id);
    if (!n || n.type === "BOOLEAN_OPERATION") return;
    for (const child of n.childIds ?? []) {
      const c = byId.get(child);
      if (!c || c.visible === false) continue;
      walk(c.guid, out);
      out.push(c);
    }
  };
  return refs.map((r) => {
    const out: NodeChange[] = [];
    if (byId.get(r)?.visible !== false) walk(r, out);
    return out;
  });
}

/** Every visible layer inside `refs`, in the order readInsideGroups gives (null past `max`). */
export function readInside(engine: Engine, refs: readonly Guid[], max = SELECTION_COLORS_MAX_NODES): NodeChange[] | null {
  return readInsideGroups(engine, refs, max)?.flat() ?? null;
}

/**
 * The colours of the selection and what's inside it (live's order: collectSelectionColors), and whether the section
 * shows; `overLimit` when more than `max` layers would be read (Figma's `emptyDueToLimitExceeded`).
 */
export function selectionColorsOf(engine: Engine, nodes: readonly PanelNode[], max = SELECTION_COLORS_MAX_NODES): { show: boolean; colors: SelectionColor[]; overLimit?: boolean } {
  const groups = readInsideGroups(
    engine,
    nodes.map((n) => n.guid),
    max
  );
  if (!groups) return { show: false, colors: [], overLimit: true };
  const selected = nodes.filter((n) => n.visible !== false) as NodeChange[];
  const own = nodes.map((n, i) => (n.visible !== false ? [...groups[i], n as NodeChange] : []));
  return { show: showSelectionColors(selected, groups.flat()), colors: collectSelectionColors(own) };
}

/**
 * The picker's "On this page": every solid colour on the current page, as CSS colours (rgba() when not opaque), the
 * most used first. Live's list (popovers/fill-picker-solid.txt) opens with FFFFFF, E5664D, D9D9D9 — the colours of the
 * page's frames, auto layout children and shapes — and ends with the single uses (3380FF, 1E1E1E), where document
 * order would start with the first frame's child. Equal counts keep document order: live's order among the single
 * uses follows no order the capture fixture shows (unverified).
 */
export function pageColors(ed: EditorController, max = 48): string[] {
  const nodes = readInside(ed.engine, [ed.store.page]);
  if (!nodes) return [];
  const out = new Set<string>();
  const used = collectColors(nodes)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.uses.length - a.c.uses.length || a.i - b.i);
  for (const { c } of used) {
    if (c.gradient) continue;
    const { r, g, b } = c.color;
    out.add(c.opacity >= 1 ? colorToHex(c.color) : `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.round(c.opacity * 100) / 100})`);
    if (out.size >= max) break;
  }
  return [...out];
}

/** How long a much-used colour's drag waits for a pause before it writes (ms; Figma's own delay is unread). */
const DEBOUNCE_MS = 100;
const debounced = new WeakMap<EditorController, ReturnType<typeof setTimeout>>();

/**
 * Writes a colour (and/or opacity) to every paint in `uses`, as one undo step (a scrub: one open transaction). A colour
 * used more than 500 times (Figma's selection paints) writes a drag's moves only once it pauses; the release at once.
 */
export function writeSelectionColor(ed: EditorController, uses: readonly PaintUse[], next: { color?: Color; opacity?: number }, info: ChangeInfo) {
  const run = () =>
    ed.edit("Selection colors", info, () => {
      const ids = [...new Set(uses.map((u) => u.guid))];
      const fresh = new Map(ed.engine.readNodes(ids).map((n) => [n.guid, n]));
      for (const [guid, f] of recolor(fresh, uses, next)) ed.engine.setProps([guid], f);
    });
  if (uses.length <= SELECTION_COLORS_DEBOUNCE_USES) return run();
  const waiting = debounced.get(ed);
  if (waiting) clearTimeout(waiting);
  debounced.delete(ed);
  if (info.final) return run();
  debounced.set(
    ed,
    setTimeout(() => {
      debounced.delete(ed);
      if (!ed.engine.destroyed) run();
    }, DEBOUNCE_MS)
  );
}

export function SelectionColorsSection({ nodes, onPick }: { nodes: PanelNode[]; onPick: (t: PickerTarget) => void }) {
  useT();
  const ed = useEditor();
  // The subtree is read again only when a paint, a visibility or the layers inside changed — a move or a resize
  // re-renders the panel each frame but leaves the colours as they were (engine.md §10.4's groups).
  const version = useSelectionColorsVersion();
  const key = nodes.map((n) => n.guid).join(",");
  // Per selection (a new one starts over, as Figma resets on a selection change): the section opened, "See all"
  // pressed, the node limit lifted ("Show selection colors").
  const [view, setView] = useState<{ key: string; open: boolean; all: boolean; unlimited: boolean }>({ key: "", open: false, all: false, unlimited: false });
  const state = view.key === key ? view : { key, open: false, all: false, unlimited: false };
  const update = (patch: Partial<typeof state>) => setView({ ...state, ...patch });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when a colour-bearing change happened (version) or the selection did (key)
  const { show, colors, overLimit } = useMemo(() => selectionColorsOf(ed.engine, nodes, state.unlimited ? SELECTION_COLORS_NO_LIMIT : SELECTION_COLORS_MAX_NODES), [ed, key, version, state.unlimited]);
  if (overLimit) {
    // Too many layers to collect at once: Figma's button reads them on request.
    return (
      <PanelSection title={t("Selection colors")}>
        <div className={styles.seeAll}>
          <Button variant="link" onClick={() => update({ unlimited: true })}>
            {t("Show selection colors")}
          </Button>
        </div>
      </PanelSection>
    );
  }
  if (!show || !colors.length) return null;
  const layout = selectionColorsLayout(colors.length, state.open, state.all);
  const shown = colors.slice(0, layout.rows);
  return (
    <PanelSection
      title={t("Selection colors")}
      className={layout.collapsible ? styles.colorsCollapsible : undefined}
      // Folded: the title row alone (its toggle is the only child)
      pad={layout.peek ? "none" : "default"}
      // Collapsed: the first three colours and "+N" in the title row (atlas 07 §4).
      actions={
        layout.peek ? (
          <span className={styles.colorsPeek} aria-hidden>
            {colors.slice(0, SELECTION_COLORS_PEEK).map((c, i) => (
              <Swatch key={i} color={c.gradient ? paintSwatch(c.gradient) : colorToHex(c.color)} opacity={c.gradient ? 100 : toPercent(c.opacity)} />
            ))}
            <span className={styles.colorsMore}>+{colors.length - SELECTION_COLORS_PEEK}</span>
          </span>
        ) : undefined
      }
    >
      {/* Four colours or more: the whole title row opens and closes the list (live: a 240 × 40 button) */}
      {layout.collapsible && <button type="button" className={styles.colorsToggle} aria-expanded={state.open} aria-label={t("Selection colors")} onClick={() => update({ open: !state.open, all: false })} />}
      {/* Keyed by place: a scrub changes the colour's identity and must not remount its field */}
      {shown.map((c, i) => (
        <div key={i} className={`${styles.paintRow} ${styles.colorRow}`}>
          {c.variable ? (
            // A colour from a variable: its outlined field (live 2026-10-22), the picker on a click
            <ColorVariablePill id={c.variable} color={c.color} opacity={c.opacity} label="Color" className={styles.paintField} onOpen={(el) => onPick({ kind: "colors", uses: c.uses, anchor: el.getBoundingClientRect() })} />
          ) : (
          <ColorInput
            className={styles.paintField}
            label={t("Color")}
            swatchLabel={c.gradient ? t(paintLabel(c.gradient)) : t("Solid color hex: {hex}", { hex: colorToHex(c.color).slice(1).toUpperCase() })}
            color={c.gradient ? paintSwatch(c.gradient) : colorToHex(c.color)}
            valueLabel={c.gradient ? t(paintLabel(c.gradient)) : undefined}
            opacity={toPercent(c.opacity)}
            onColor={(hex, info, o) => writeSelectionColor(ed, c.uses, { color: hexToColor(hex), ...(o !== undefined ? { opacity: o / 100 } : {}) }, info)}
            onOpacity={(o, info) => writeSelectionColor(ed, c.uses, { opacity: o / 100 }, info)}
            onSwatchClick={(anchor) => onPick({ kind: "colors", uses: c.uses, anchor })}
          />
          )}
          {/* Figma's live panel: the field as wide as a fill's (156), the target button only on hover */}
          <span className={styles.colorRowSlot} />
          <IconButton className={styles.colorRowAction} icon="24.select-matching.small" label={t("Select matching layers")} tone="secondary" onClick={() => ed.engine.setSelection([...new Set(c.uses.map((u) => u.guid))])} />
        </div>
      ))}
      {layout.seeAll && (
        <div className={styles.seeAll}>
          <Button variant="link" onClick={() => update({ all: true })}>
            {tp(colors.length, "See all {n} color", "See all {n} colors")}
          </Button>
        </div>
      )}
    </PanelSection>
  );
}
