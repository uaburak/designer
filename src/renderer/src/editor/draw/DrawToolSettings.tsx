/**
 * Draw's secondary toolbar (docs/draw.md §5.2; help.figma.com 31440438150935: "a secondary toolbar sets the stroke's
 * fill, weight and style before you draw"): while the Pencil or the Brush is the tool in Draw mode it sits 8 over the
 * bottom toolbar, as vector edit's does —
 * - the colour swatch (the colour picker, opacity included);
 * - the weight (0.5–100 [ours]; ↑ ↓ and scrubbing as every numeric field);
 * - the style: the Pencil's Basic / Dynamic (Dynamic's Frequency, Wiggle and Smoothen in its popover), or the Brush's
 *   Brush styles menu (the current brush's preview and name).
 * Every change goes to the engine with setDrawToolSettings (drawTools.ts); the settings last the session.
 */
import { useState, type MouseEvent } from "react";
import { ColorPicker, hexToRgba, Icon, IconButton, NumericInput, Popover, rgbToHex, SegmentedControl, Swatch, Toolbar, ToolbarDivider, type PickerPaint } from "@/ds";
import { DRAW_WEIGHT_RANGE, DYNAMIC_RANGE, type DynamicSettings } from "@shared/draw/types";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { BrushMenu, BrushPreview } from "./BrushMenu";
import { chooseBrush, DRAW_TOOLS_DEFAULT, setBrushTool, setPencil } from "./drawTools";
import styles from "./Draw.module.css";

export type DrawTool = "PENCIL" | "BRUSH";

/** Is this engine tool one the secondary toolbar sets? */
export const isDrawTool = (tool: string): tool is DrawTool => tool === "PENCIL" || tool === "BRUSH";

/** Dynamic's popover rows (labels Figma's: Advanced stroke settings › Dynamic stroke). */
const DYNAMIC_FIELDS: { id: keyof DynamicSettings; label: string; step: number; precision: number }[] = [
  { id: "frequency", label: "Frequency", step: 0.1, precision: 2 },
  { id: "wiggle", label: "Wiggle", step: 0.1, precision: 2 },
  { id: "smoothen", label: "Smoothen", step: 0.01, precision: 2 },
];

export function DrawToolSettings({ tool }: { tool: DrawTool }) {
  const ed = useEditor();
  const state = useUI((s) => s.drawTools) ?? DRAW_TOOLS_DEFAULT;
  const settings = tool === "PENCIL" ? state.settings.pencil : state.settings.brush;
  const set = (patch: { color?: string; opacity?: number; weight?: number }) => (tool === "PENCIL" ? setPencil(ed, patch) : setBrushTool(ed, patch));
  // The open popover and the button it opens from
  const [popover, setPopover] = useState<{ what: "color" | "brush" | "dynamic"; anchor: HTMLElement } | null>(null);
  const open = popover?.what ?? null;
  const toggle = (what: "color" | "brush" | "dynamic") => (e: MouseEvent<HTMLElement>) => {
    const anchor = e.currentTarget;
    setPopover((o) => (o?.what === what ? null : { what, anchor }));
  };
  const close = () => setPopover(null);
  const paint: PickerPaint = { type: "SOLID", color: { ...(hexToRgba(settings.color) ?? { r: 0, g: 0, b: 0 }), a: 1 }, opacity: settings.opacity };
  return (
    <Toolbar floating secondary label={tool === "PENCIL" ? "Pencil settings" : "Brush settings"} data-draw-toolbar={tool}>
      <button type="button" aria-label="Color" aria-haspopup="dialog" aria-expanded={open === "color"} className={styles.swatchButton} onClick={toggle("color")}>
        <Swatch color={settings.color} opacity={Math.round(settings.opacity * 100)} shape="round" size={16} />
      </button>
      {open === "color" && (
        <ColorPicker
          value={paint}
          anchor={popover!.anchor}
          placement="top"
          paintTypes={["SOLID"]}
          onChange={(next) => set({ color: next.color ? rgbToHex(next.color) : settings.color, opacity: next.opacity ?? 1 })}
          onClose={close}
        />
      )}
      <ToolbarDivider />
      <NumericInput
        className={styles.weight}
        label="Weight"
        prefix="24.stroke-weight"
        value={settings.weight}
        min={DRAW_WEIGHT_RANGE[0]}
        max={DRAW_WEIGHT_RANGE[1]}
        step={1}
        precision={1}
        onChange={(v) => set({ weight: v })}
      />
      <ToolbarDivider />
      {tool === "PENCIL" ? (
        <div className={styles.group}>
          <SegmentedControl
            className={styles.style}
            label="Style"
            value={state.settings.pencil.kind}
            options={[
              { value: "BASIC", label: "Basic" },
              { value: "DYNAMIC", label: "Dynamic" },
            ]}
            onChange={(v) => setPencil(ed, { kind: v as "BASIC" | "DYNAMIC" })}
          />
          {state.settings.pencil.kind === "DYNAMIC" && (
            <IconButton icon="24.dynamic-stroke" label="Dynamic stroke settings" onClick={toggle("dynamic")} />
          )}
          {open === "dynamic" && (
            <Popover anchor={popover!.anchor} placement="top" title="Dynamic stroke" onClose={close}>
              <div className={styles.settings} data-dynamic-settings="">
                {DYNAMIC_FIELDS.map((f) => (
                  <label key={f.id} style={{ display: "contents" }}>
                    <span className={styles.settingLabel}>{f.label}</span>
                    <NumericInput
                      label={f.label}
                      value={state.settings.pencil.dynamic[f.id]}
                      min={DYNAMIC_RANGE[f.id][0]}
                      max={DYNAMIC_RANGE[f.id][1]}
                      step={f.step}
                      bigStep={f.step * 10}
                      precision={f.precision}
                      onChange={(v) => setPencil(ed, { dynamic: { [f.id]: v } })}
                    />
                  </label>
                ))}
              </div>
            </Popover>
          )}
        </div>
      ) : (
        <>
          <button type="button" aria-label="Brush styles" aria-haspopup="listbox" aria-expanded={open === "brush"} className={styles.brushButton} data-brush-current={state.brush.builtin ?? state.brush.guid ?? ""} onClick={toggle("brush")}>
            <BrushPreview entry={state.brush} className={styles.preview} />
            <span>{state.brush.name}</span>
            <Icon name="16.chevron.down" />
          </button>
          {open === "brush" && (
            <BrushMenu
              anchor={popover!.anchor}
              current={state.brush}
              onPick={(entry) => {
                chooseBrush(ed, entry);
                close();
                ed.focusCanvas();
              }}
              onClose={close}
            />
          )}
        </>
      )}
    </Toolbar>
  );
}
