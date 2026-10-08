/**
 * "Selection colors" (Figma UI3): the distinct solid colours and gradients of
 * the selection's fills and strokes and of every visible layer inside it, each
 * once (a gradient as one row: its swatch and type, its picker edits every use); editing a
 * row (hex, opacity, the picker) recolours every paint using it, as one undo
 * step; the target button selects the layers using it. The first three rows
 * show, then "See all N colors". Rules and grouping: model/selectionColors.ts.
 */
import { useMemo, useState } from "react";
import { Button, ColorInput, IconButton, PanelSection, type ChangeInfo } from "@/ds";
import * as abi from "@/engine/abi";
import type { Color, Guid, NodeChange } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import { useEditor, type EditorController } from "../../controller";
import { engineExports } from "../../engineCompat";
import { useSelectionColorsVersion } from "../../hooks";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { paintLabel, paintSwatch } from "../../model/paints";
import { SELECTION_COLORS_MAX_NODES, SELECTION_COLORS_SHOWN, collectColors, recolor, showSelectionColors, type PaintUse, type SelectionColor } from "../../model/selectionColors";
import type { PickerTarget } from "./Paints";
import type { PanelNode } from "./shared";
import styles from "./Design.module.css";

/** What Selection colors reads of a layer (docs/engine-build.md "Performance round 2": a paints-only read). */
const COLOR_FIELDS = ["fillPaints", "strokePaints", "visible", "mask"];

/**
 * Does the engine build read a subtree with chosen fields in one call? abi.ts names READ_SUBTREE and the module in
 * hand is the round that added it (its `engine_layer_changes` export) — the facade can be ahead of the wasm, and an
 * older wasm given the flag would answer the refs alone.
 */
const hasSubtreeRead = (engine: Engine): boolean => "READ_SUBTREE" in abi && engineExports(engine, "layer_changes");

/**
 * The visible layers inside `refs` (not the selected ones), each selected
 * layer's subtree children first (first child first), a boolean's operands left out; null past `max` layers. One engine read of the
 * paints alone when the build has it (`readNodes` with `fields`, `subtree`,
 * `visibleOnly`: hidden subtrees left out by the engine), else read one level
 * at a time with every field.
 */
export function readInside(engine: Engine, refs: readonly Guid[], max = SELECTION_COLORS_MAX_NODES): NodeChange[] | null {
  const byId = new Map<Guid, NodeChange>();
  if (hasSubtreeRead(engine)) {
    const rows = (engine.readNodes as (r: readonly Guid[], o: object) => NodeChange[])(refs, { childIds: true, fields: COLOR_FIELDS, subtree: true, visibleOnly: true });
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
  const out: NodeChange[] = [];
  // Figma's live order: a layer's children before it, the first child first (a frame's child's colour, then the
  // frame's; a group's g_a, then g_b). A boolean's operands draw only through the boolean: not read.
  const walk = (id: Guid) => {
    const n = byId.get(id);
    if (!n || n.type === "BOOLEAN_OPERATION") return;
    for (const child of n.childIds ?? []) {
      const c = byId.get(child);
      if (!c || c.visible === false) continue;
      walk(c.guid);
      out.push(c);
    }
  };
  for (const r of refs) if (byId.get(r)?.visible !== false) walk(r);
  return out;
}

/** The colours of the selection and what's inside it, and whether the section shows. */
export function selectionColorsOf(engine: Engine, nodes: readonly PanelNode[]): { show: boolean; colors: SelectionColor[] } {
  const inside = readInside(
    engine,
    nodes.map((n) => n.guid)
  );
  if (!inside) return { show: false, colors: [] };
  const selected = nodes.filter((n) => n.visible !== false) as NodeChange[];
  return { show: showSelectionColors(selected, inside), colors: collectColors([...inside, ...selected]) };
}

/** The picker's "On this page": every solid colour on the current page, as CSS colours (rgba() when not opaque). */
export function pageColors(ed: EditorController, max = 48): string[] {
  const nodes = readInside(ed.engine, [ed.store.page]);
  if (!nodes) return [];
  const out = new Set<string>();
  for (const c of collectColors(nodes)) {
    if (c.gradient) continue;
    const { r, g, b } = c.color;
    out.add(c.opacity >= 1 ? colorToHex(c.color) : `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.round(c.opacity * 100) / 100})`);
    if (out.size >= max) break;
  }
  return [...out];
}

/** Writes a colour (and/or opacity) to every paint in `uses`, as one undo step (a scrub: one open transaction). */
export function writeSelectionColor(ed: EditorController, uses: readonly PaintUse[], next: { color?: Color; opacity?: number }, info: ChangeInfo) {
  ed.edit("Selection colors", info, () => {
    const ids = [...new Set(uses.map((u) => u.guid))];
    const fresh = new Map(ed.engine.readNodes(ids).map((n) => [n.guid, n]));
    for (const [guid, f] of recolor(fresh, uses, next)) ed.engine.setProps([guid], f);
  });
}

export function SelectionColorsSection({ nodes, onPick }: { nodes: PanelNode[]; onPick: (t: PickerTarget) => void }) {
  const ed = useEditor();
  // The subtree is read again only when a paint, a visibility or the layers inside changed — a move or a resize
  // re-renders the panel each frame but leaves the colours as they were (engine.md §10.4's groups).
  const version = useSelectionColorsVersion();
  const key = nodes.map((n) => n.guid).join(",");
  const [all, setAll] = useState<{ key: string; on: boolean }>({ key: "", on: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when a colour-bearing change happened (version) or the selection did (key)
  const { show, colors } = useMemo(() => selectionColorsOf(ed.engine, nodes), [ed, key, version]);
  if (!show || !colors.length) return null;
  const expanded = all.key === key && all.on;
  const shown = expanded ? colors : colors.slice(0, SELECTION_COLORS_SHOWN);
  return (
    <PanelSection title="Selection colors">
      {/* Keyed by place: a scrub changes the colour's identity and must not remount its field */}
      {shown.map((c, i) => (
        <div key={i} className={`${styles.paintRow} ${styles.colorRow}`}>
          <ColorInput
            className={styles.paintField}
            label="Color"
            swatchLabel={c.gradient ? paintLabel(c.gradient) : `Solid color hex: ${colorToHex(c.color).slice(1).toUpperCase()}`}
            color={c.gradient ? paintSwatch(c.gradient) : colorToHex(c.color)}
            valueLabel={c.gradient ? paintLabel(c.gradient) : undefined}
            opacity={toPercent(c.opacity)}
            onColor={(hex, info) => writeSelectionColor(ed, c.uses, { color: hexToColor(hex) }, info)}
            onOpacity={(o, info) => writeSelectionColor(ed, c.uses, { opacity: o / 100 }, info)}
            onSwatchClick={(anchor) => onPick({ kind: "colors", uses: c.uses, anchor })}
          />
          {/* Figma's live panel: the field as wide as a fill's (156), the target button only on hover */}
          <span className={styles.colorRowSlot} />
          <IconButton className={styles.colorRowAction} icon="24.select-matching.small" label="Select matching layers" tone="secondary" onClick={() => ed.engine.setSelection([...new Set(c.uses.map((u) => u.guid))])} />
        </div>
      ))}
      {colors.length > SELECTION_COLORS_SHOWN && (
        <div className={styles.seeAll}>
          <Button variant="link" onClick={() => setAll({ key, on: !expanded })}>
            {expanded ? "Show less" : `See all ${colors.length} colors`}
          </Button>
        </div>
      )}
    </PanelSection>
  );
}
