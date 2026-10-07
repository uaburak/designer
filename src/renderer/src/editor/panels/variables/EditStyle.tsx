/**
 * The style popovers (UI3): "Edit style" — the name, the description and the
 * style's own values (a color style's paints, a text style's font, size, line
 * height and letter spacing, an effect style's effects, a layout guide style's
 * guides); every layer using the style follows each edit — and "Create
 * style": a name and a description for a new style taking the selection's
 * look (or Figma's defaults), applied to the selection.
 */
import { useState } from "react";
import { Button, ColorInput, ColorPicker, IconButton, NumericInput, Popover, Select, TextArea, TextInput, type ChangeInfo, type PopoverPlacement } from "@/ds";
import type { Effect, Guid, Paint } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets } from "../../hooks";
import { hexToColor, colorToHex, toPercent } from "../../model/color";
import { fromPicker, paintLabel, paintSwatch, toPicker, type FullPaint } from "../../model/paints";
import { STYLE_KIND_SINGULAR, type Style, type StyleKind, type StyleSlot } from "../../model/styles";
import { createStyle, renameStyle, updateStyle } from "../../variables";
import { EFFECT_TYPES, EffectSettings, GUIDE_ICON, GuideSettings, defaultEffect, defaultGuide, guideKind, guideLabel, withEffectType } from "../design/Effects";
import { FALLBACK_STYLES, FONT_SIZES, lineHeightView, TEXT_DEFAULTS } from "../design/Typography";
import type { LayoutGrid } from "../design/shared";
import { StyleGlyph } from "./VariablePicker";
import styles from "./Variables.module.css";

const FINAL: ChangeInfo = { final: true, source: "pick" };

export function EditStylePopover({ id, anchor, placement = "left-of-panel", onClose }: { id: Guid; anchor: HTMLElement | DOMRect | null; placement?: PopoverPlacement; onClose: () => void }) {
  const ed = useEditor();
  const a = useLocalAssets();
  const style = a.style(id);
  if (!style) return null;
  const title = `Edit ${STYLE_KIND_SINGULAR[style.kind].toLowerCase()}`;
  return (
    <Popover anchor={anchor} title={title} width={240} placement={placement} onClose={onClose} label={title}>
      <div className={styles.form} data-edit-style={style.name}>
        <TextInput label="Name" value={style.name} onCommit={(name) => renameStyle(ed, id, name)} autoFocus />
        <TextArea label="Description" value={style.description} placeholder="Description" minRows={2} onCommit={(description) => updateStyle(ed, id, { description }, "Edit style description")} />
        <div className={styles.formSection}>Properties</div>
        <StyleValues style={style} />
      </div>
    </Popover>
  );
}

/** A style's own values, edited in place (one undo step each; a drag one open step). */
function StyleValues({ style }: { style: Style }) {
  switch (style.kind) {
    case "FILL":
      return <PaintValues style={style} />;
    case "TEXT":
      return <TextValues style={style} />;
    case "EFFECT":
      return <EffectValues style={style} />;
    case "GRID":
      return <GridValues style={style} />;
  }
}

function PaintValues({ style }: { style: Style }) {
  const ed = useEditor();
  const [picker, setPicker] = useState<{ index: number; anchor: DOMRect } | null>(null);
  const paints = (style.node.fillPaints ?? []) as FullPaint[];
  const write = (next: Paint[], info: ChangeInfo = FINAL) => updateStyle(ed, style.id, { fillPaints: next }, "Edit style", info);
  return (
    <>
      {paints
        .map((p, i) => ({ p, i }))
        .reverse()
        .map(({ p, i }) => (
          <div key={i} className={styles.effectEditRow}>
            <ColorInput
              label="Color"
              color={p.type === "SOLID" ? colorToHex(p.color ?? { r: 0, g: 0, b: 0 }) : paintSwatch(p, ed.images.urlOf(null))}
              valueLabel={p.type === "SOLID" ? undefined : paintLabel(p)}
              opacity={toPercent(p.opacity ?? 1)}
              onColor={(hex, info) => write(paints.map((q, j) => (j === i ? { ...q, color: hexToColor(hex, 1) } : q)), info)}
              onOpacity={(o, info) => write(paints.map((q, j) => (j === i ? { ...q, opacity: o / 100 } : q)), info)}
              onSwatchClick={(anchor) => setPicker({ index: i, anchor })}
            />
            <IconButton icon="24.minus.small" label="Remove fill" tone="secondary" disabled={paints.length < 2} onClick={() => write(paints.filter((_, j) => j !== i))} />
          </div>
        ))}
      <div className={styles.formFooter}>
        <Button variant="secondary" icon="24.plus.small" onClick={() => write([...paints, { type: "SOLID", color: hexToColor("#000000"), opacity: 0.2, visible: true }])}>
          Add fill
        </Button>
      </div>
      {picker && paints[picker.index] && (
        <ColorPicker
          value={toPicker(paints[picker.index])}
          anchor={picker.anchor}
          placement="bottom-start"
          paintTypes={["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"]}
          onChange={(next, info) => write(paints.map((q, j) => (j === picker.index ? fromPicker(q, next) : q)), info)}
          onCancel={() => ed.cancelEdit()}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}

function TextValues({ style }: { style: Style }) {
  const ed = useEditor();
  const n = style.node;
  const font = n.fontName ?? TEXT_DEFAULTS.fontName;
  const lh = lineHeightView(n.lineHeight as never);
  const ls = n.letterSpacing ?? TEXT_DEFAULTS.letterSpacing;
  const write = (f: Record<string, unknown>, info: ChangeInfo = FINAL) => updateStyle(ed, style.id, f, "Edit style", info);
  const families = [...new Set([font.family, "Inter"])];
  return (
    <>
      <Select label="Font family" value={font.family} options={families.map((f) => ({ value: f, label: f }))} onChange={(family) => write({ fontName: { ...font, family, postscript: "" } })} />
      <div className={styles.formPair}>
        <Select label="Font style" value={font.style} options={[...new Set([font.style, ...FALLBACK_STYLES])].map((s) => ({ value: s, label: s }))} onChange={(s) => write({ fontName: { ...font, style: s, postscript: "" } })} />
        <NumericInput label="Font size" value={n.fontSize ?? 12} min={1} max={1000} onChange={(v, info) => write({ fontSize: v }, info)} onCancel={() => ed.cancelEdit()} />
      </div>
      <div className={styles.formPair}>
        <NumericInput
          label="Line height"
          prefix="24.text.line-height"
          value={lh.value}
          valueLabel={lh.label}
          unit={lh.unit}
          placeholder="Auto"
          min={0}
          onChange={(v, info) => write({ lineHeight: lh.unit === "%" ? { value: v / 100, units: "RAW" } : { value: v, units: "PIXELS" } }, info)}
          onClear={() => write({ lineHeight: TEXT_DEFAULTS.lineHeight })}
          onCancel={() => ed.cancelEdit()}
        />
        <NumericInput
          label="Letter spacing"
          prefix="24.text.letter-spacing"
          value={ls.value}
          unit={ls.units === "PIXELS" ? undefined : "%"}
          onChange={(v, info) => write({ letterSpacing: { value: v, units: ls.units === "PIXELS" ? "PIXELS" : "PERCENT" } }, info)}
          onCancel={() => ed.cancelEdit()}
        />
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Sizes</span>
        <Select label="Font size presets" value={String(n.fontSize ?? 12)} options={[...new Set([n.fontSize ?? 12, ...FONT_SIZES])].sort((x, y) => x - y).map((s) => ({ value: String(s), label: String(s) }))} onChange={(v) => write({ fontSize: Number(v) })} />
      </div>
    </>
  );
}

function EffectValues({ style }: { style: Style }) {
  const ed = useEditor();
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const effects = (style.node.effects ?? []) as Effect[];
  const write = (next: Effect[], info: ChangeInfo = FINAL) => updateStyle(ed, style.id, { effects: next }, "Edit style", info);
  return (
    <>
      {effects
        .map((e, i) => ({ e, i }))
        .reverse()
        .map(({ e, i }) => {
          const type = EFFECT_TYPES.find((t) => t.value === e.type) ?? EFFECT_TYPES[0];
          return (
            <div key={i} className={styles.effectEditRow}>
              <IconButton icon={type.icon} label="Effect settings" aria-expanded={open?.index === i} onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })} />
              <Select label="Effect type" variant="ghost" value={e.type} options={EFFECT_TYPES.map((t) => ({ value: t.value, label: t.label }))} onChange={(v) => write(effects.map((x, j) => (j === i ? withEffectType(x, v as Effect["type"]) : x)))} />
              <IconButton icon="24.minus.small" label="Remove effect" tone="secondary" disabled={effects.length < 2} onClick={() => write(effects.filter((_, j) => j !== i))} />
            </div>
          );
        })}
      <div className={styles.formFooter}>
        <Button variant="secondary" icon="24.plus.small" onClick={() => write([...effects, defaultEffect()])}>
          Add effect
        </Button>
      </div>
      {open && effects[open.index] && <EffectSettings effect={effects[open.index]} anchor={open.anchor} onClose={() => setOpen(null)} onCancel={() => ed.cancelEdit()} onChange={(next, info) => write(effects.map((x, j) => (j === open.index ? next : x)), info)} />}
    </>
  );
}

function GridValues({ style }: { style: Style }) {
  const ed = useEditor();
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const grids = (style.node.layoutGrids ?? []) as LayoutGrid[];
  const write = (next: LayoutGrid[], info: ChangeInfo = FINAL) => updateStyle(ed, style.id, { layoutGrids: next }, "Edit style", info);
  return (
    <>
      {grids
        .map((g, i) => ({ g, i }))
        .reverse()
        .map(({ g, i }) => (
          <div key={i} className={styles.effectEditRow}>
            <IconButton icon={GUIDE_ICON[guideKind(g)]} label="Layout guide settings" aria-expanded={open?.index === i} onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })} />
            <span className={styles.styleName}>{guideLabel(g)}</span>
            <IconButton icon="24.minus.small" label="Remove layout guide" tone="secondary" disabled={grids.length < 2} onClick={() => write(grids.filter((_, j) => j !== i))} />
          </div>
        ))}
      <div className={styles.formFooter}>
        <Button variant="secondary" icon="24.plus.small" onClick={() => write([...grids, defaultGuide()])}>
          Add layout guide
        </Button>
      </div>
      {open && grids[open.index] && <GuideSettings grid={grids[open.index]} anchor={open.anchor} onClose={() => setOpen(null)} onCancel={() => ed.cancelEdit()} onChange={(next, info) => write(grids.map((x, j) => (j === open.index ? next : x)), info)} />}
    </>
  );
}

/** "Create style": a name (folders with "/"), a description; the new style takes `from`'s look and is applied to `applyTo`. */
export function CreateStylePopover({ kind, from, slot, applyTo, anchor, placement = "left-of-panel", onClose, onCreated }: { kind: StyleKind; from: Guid | null; slot?: StyleSlot; applyTo: readonly Guid[]; anchor: HTMLElement | DOMRect | null; placement?: PopoverPlacement; onClose: () => void; onCreated?: (id: Guid) => void }) {
  const ed = useEditor();
  const a = useLocalAssets();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const title = `Create new ${STYLE_KIND_SINGULAR[kind].toLowerCase()}`;
  const create = () => {
    const id = createStyle(ed, kind, name, from, slot, applyTo);
    if (id && description.trim()) updateStyle(ed, id, { description: description.trim() }, "Edit style description");
    if (id) onCreated?.(id);
    onClose();
  };
  const preview: Style = { id: "", kind, name: name || STYLE_KIND_SINGULAR[kind], description: "", sortPosition: "", hidden: false, node: { guid: "", ...(from ? (ed.engine.readNode(from) as object) : {}), ...(slot === "stroke" && from ? { fillPaints: ed.engine.readNode(from)?.strokePaints } : {}) } };
  void a;
  return (
    <Popover anchor={anchor} title={title} width={240} placement={placement} onClose={onClose} label={title}>
      <div
        className={styles.form}
        data-create-style={kind}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) create();
        }}
      >
        <div className={styles.effectEditRow}>
          <StyleGlyph style={preview} />
          <TextInput label="Name" value={name} placeholder="Name" onChange={setName} autoFocus />
        </div>
        <TextArea label="Description" value={description} placeholder="Description" minRows={2} onChange={setDescription} />
        <div className={styles.formFooter}>
          <Button variant="primary" onClick={create}>
            Create style
          </Button>
        </div>
      </div>
    </Popover>
  );
}
