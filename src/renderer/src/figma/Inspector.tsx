import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DesignVariable, InteractionAction, InteractionAnimation, InteractionDirection, InteractionEasing, TextStyle, VariableValue } from "@/types/design";
import { cn } from "@/lib/utils";
import { fi, type FigmaIconName } from "@/components/admin/figmaIcons";
import { ACTIONS, ANIMATIONS, CHANGE_ANIMATIONS, DIRECTED, DIRECTIONS, EASINGS, TRIGGERS, TRIGGER_GROUPS, TRIGGER_SHORT, durationOf } from "@/components/project/interactions";
import { boundValue, splitName, type ThemeMode } from "@/components/project/designVariables";
import { PICKER_WIDTH, VariablePicker, usePopover, type MenuItem } from "./popover";
import { weightLabel } from "./css";
import { type ChevronItem } from "./ui";
import { BASE_LANGUAGE, BLEND_MODES, actionOf, variantLabel, EFFECT_LABEL, EMBED_LABEL, LAYOUT_GRID_LABEL, OVERRIDABLE, PAINT_LABEL, allComponents, resolveInstance, componentAround, findComponent, findNode, freePropertyName, getNode, isFrameLike, captionPatch, layerAt, newEffect, newLayoutGrid, nid, numberOf, propertiesOf, propertyValues, propsIn, setOf, variantName, variantProperties, variantValue, variantsOf, walk, wordsIn, wordsPatch, type ComponentProperty, type Effect, type EffectStyle, type Embed, type ExportSetting, type FrameNode, type Language, type LangCode, type LayoutGrid, type NodeOverride, type Paint, type PropertyType, type Reaction, type SceneNode, type StrokeStyle, type TextNode } from "./model";
import { ColorPicker } from "./ColorPicker";
import { keys, type MenuEntry } from "@/components/admin/ContextMenu";
import { BrandButton, Checkbox, ChevronMenu, Chit, ColorInput, FIELD_OUTLINED, IconButton, NumericInput, Prefix, PropRow, Section, Select, Switch, TextInput, hexDigits } from "./ui";

/**
 * Figma's Design panel (its labels on) for whatever is selected — Position,
 * Layout, Appearance, Fill, Stroke, Effects; a text's Typography; a
 * component's variants, an instance's properties and overrides — and its
 * Prototype panel. With nothing selected: the page, the styles.
 */

export interface EditorOps {
  patch: (id: string, patch: Partial<SceneNode>) => void;
  patchMany: (ids: readonly string[], patch: Partial<SceneNode>) => void;
  /** Several layers changed each from its own (rotate each by 90°, flip each) */
  updateMany: (ids: readonly string[], update: (node: SceneNode) => SceneNode) => void;
  override: (compositeId: string, patch: NodeOverride) => void;
  align: (kind: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") => void;
  setAutoLayout: (id: string, mode: FrameNode["layoutMode"]) => void;
  createComponent: () => void;
  detach: () => void;
  resetOverrides: () => void;
  /** One change of an instance or of a layer inside it reset (see changesAt) — no key: all of that layer's */
  resetChange: (id: string, key?: string) => void;
  /** The selected instance's changes into its main component (every instance then shows them) */
  pushToMain: () => void;
  /** The instance showing another component (Figma's instance swap): only its text changes are kept */
  swapInstance: (id: string, componentId: string) => void;
  /** Every layer like the selected one: its name and kind (Figma's Select matching layers, ⌥⌘A) */
  selectMatching: () => void;
  /** An instance's (or an instance layer's) ⋯ menu: swap, reset, push to main, go to main, select matching, detach */
  instanceActions: (id: string) => MenuEntry[];
  goToMain: () => void;
  /** These layers selected */
  select: (ids: string[]) => void;
  addVariant: (id: string) => void;
  combineAsVariants: () => void;
  setVariantValue: (variantId: string, property: string, value: string) => void;
  renameProperty: (setId: string, from: string, to: string) => void;
  renameValue: (setId: string, property: string, from: string, to: string) => void;
  addProperty: (setId: string) => void;
  removeProperty: (setId: string, name: string) => void;
  swapVariant: (instanceId: string, property: string, value: string) => void;
  /** A padding or gap field focused in the panel: the canvas highlights what it edits (null: none) */
  setLayoutFocus: (focus: { pads?: ("top" | "right" | "bottom" | "left")[]; gap?: boolean } | null) => void;
  /** A main component's (a set's) properties as edited — layers bound to a gone one come unbound */
  setComponentProperties: (holderId: string, properties: ComponentProperty[]) => void;
  /** A property's default, put on every layer bound to it */
  setPropertyValue: (holderId: string, propId: string, value: string | boolean) => void;
  /** A layer inside a main component bound to a property (undefined: detached) */
  bindProperty: (nodeId: string, kind: "visible" | "text" | "instance", propId: string | undefined) => void;
  /** An instance's own value of a property (its words in `language` when it is not the base one) */
  setInstanceProp: (instanceId: string, propId: string, value: string | boolean, language?: LangCode) => void;
  /** A text inside an instance typed in a language: the instance's value of its text property, or its override */
  typeInInstance: (compositeId: string, text: string, lang: LangCode) => void;
  /** The file's languages (the base first), the one edited and its switch; one added (it becomes the edited one) or removed (its words go) */
  languages: Language[];
  setLanguage: (code: LangCode) => void;
  addLanguage: (language: Language) => void;
  removeLanguage: (code: LangCode) => void;
  setReactions: (nodeId: string, reactions: Reaction[]) => void;
  /** The interaction whose window is open (a row clicked, a noodle on the canvas) */
  reactionOpen: string | null;
  openReaction: (id: string | null) => void;
  preview: (id?: string) => void;
  openVariables: () => void;
  setBackground: (color: string) => void;
  /** The header's "…" menu */
  more: (el: HTMLElement) => void;
  /** The layer made a mask over what is above it (^⌘M) */
  maskWith: (id: string) => void;
  /** Several layers put at their places at once */
  placeMany: (moves: { id: string; x?: number; y?: number }[]) => void;
  /** A menu under a button (Figma's dark one) */
  menu: (el: HTMLElement, entries: MenuEntry[]) => void;
  /** Every fill and stroke of `from` in the selection turned to `to` (Selection colors) */
  replaceColor: (from: string, to: string, opacity?: number) => void;
  /** The colours on this page, for the picker */
  pageColors: string[];
  /** A frame without auto layout sized to what is in it */
  fitToContent: (id: string) => void;
  /** The selection's gaps made even along an axis; tidy: laid out as a grid */
  distribute: (axis: "h" | "v") => void;
  tidy: () => void;
  effectStyles: EffectStyle[];
  createEffectStyle: (nodeId: string) => void;
  applyEffectStyle: (nodeId: string, styleId: string) => void;
  detachEffectStyle: (nodeId: string) => void;
  removeEffectStyle: (styleId: string) => void;
  /** A text style from a text layer's typography (or a blank one) */
  createTextStyle: (nodeId: string | null) => void;
  /** A text style as edited in its window; one deleted */
  setTextStyle: (style: TextStyle) => void;
  removeTextStyle: (id: string) => void;
  /** A colour variable from a colour */
  createColorStyle: (hex: string) => void;
  exportNode: (id: string, setting: ExportSetting) => void;
  /** A file put in the site's storage: its URL */
  upload: (file: File) => Promise<string>;
  /** The frame that is the project's page */
  pageId: string;
  /** ⇧A: a frame's auto layout on, or the selection wrapped in a new auto layout frame */
  addAutoLayout: () => void;
  /** Constrain proportions on (the layer's size as drawn taken as its own first, so the kept ratio is what is seen) or off */
  lockProportions: (id: string, on: boolean) => void;
}

/** Where a picker beside the panel opens: at the row's top, to the panel's left. */
function anchorOf(el: Element) {
  const panel = el.closest("[data-design-panel]")?.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { top: r.top, right: (panel?.left ?? r.left) - 4 };
}

const own = (value: string | number): VariableValue => ({ value });

/** A small label over a row's fields, as Figma's labels ("Alignment", "Dimensions"). */
function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("block text-[11px] font-[450] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)] select-none", className)}>{children}</span>;
}

/** Two labels over two fields. */
function Labels({ a, b, className }: { a: ReactNode; b?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 pl-4 pr-3 pt-1", className)}>
      <div className="flex flex-1 min-w-0 items-center gap-2">
        <Label className="flex-1">{a}</Label>
        {b !== undefined && <Label className="flex-1">{b}</Label>}
      </div>
      <span className="w-6 shrink-0" />
    </div>
  );
}

/** A number that may be a variable's: the field, or the variable's pill, the hexagon opening the picker. */
function BoundNumber({ label, prefix, value, variables, byId, mode, onChange, unit, min, max, fallback, suffix, placeholder, onFocusChange, variableMenu = false, kind = "number" }: {
  label: string;
  /** Which variables it can bind to (numbers unless said — weights for a font weight) */
  kind?: "number" | "weight";
  onFocusChange?: (focused: boolean) => void;
  /** The variable is applied and detached from the field's own menu (its suffix): no hexagon, no detach button in the field */
  variableMenu?: boolean;
  prefix: ReactNode;
  value: VariableValue | undefined;
  variables: DesignVariable[];
  byId: Map<string, DesignVariable>;
  mode: ThemeMode;
  onChange: (value: VariableValue) => void;
  unit?: string;
  min?: number;
  max?: number;
  fallback?: number;
  /** After the field's variable button (a sizing menu) */
  suffix?: ReactNode;
  placeholder?: string;
}) {
  const { at, box, toggle, close } = usePopover(PICKER_WIDTH);
  const v = value ?? own(fallback ?? 0);
  const bound = "alias" in v ? byId.get(v.alias) : undefined;
  const targets = variables.filter((x) => x.kind === kind);
  const hex = <IconButton label="Apply variable" icon={fi("variable.small")} onClick={(e) => toggle(e.currentTarget)} className="opacity-0 group-hover/bound:opacity-100 focus:opacity-100" />;
  const picker = at && <VariablePicker at={at} variables={targets} byId={byId} mode={mode} selectedId={bound?.id} onPick={(id) => { onChange({ alias: id }); close(); }} />;
  if (bound) {
    return (
      <div ref={box} className="group/bound relative flex flex-1 min-w-0 items-center h-6 rounded-[5px] bg-[var(--f-bg-secondary)]">
        {typeof prefix === "string" ? <Prefix>{prefix}</Prefix> : prefix}
        {/* Figma's bound value: just the number in its chip (the variable's name as its tooltip); a click opens the picker. */}
        <button type="button" data-tip={bound.name} onClick={(e) => toggle(e.currentTarget)} className="flex shrink-0 items-center h-[18px] mr-1 px-1 rounded-[4px] bg-[var(--f-bg)] border border-[var(--f-border)] text-[11px] leading-4 text-[var(--f-text)] tabular-nums cursor-pointer">
          {String(boundValue(v, mode, byId) ?? "")}{unit ?? ""}
        </button>
        <span className="flex-1" />
        {!variableMenu && <IconButton label="Detach variable" icon={fi("detach.small")} onClick={() => onChange(own(Number(boundValue(v, mode, byId)) || 0))} />}
        {suffix}
        {picker}
      </div>
    );
  }
  return (
    <div ref={box} className="group/bound relative flex flex-1 min-w-0">
      <NumericInput label={label} prefix={prefix} value={"alias" in v ? 0 : Number(v.value) || 0} min={min} max={max} unit={unit} placeholder={placeholder} onChange={(n) => onChange(own(n))} suffix={<>{targets.length && !variableMenu ? hex : null}{suffix}</>} onFocusChange={onFocusChange} />
      {picker}
    </div>
  );
}

/** A paint (a fill's, a stroke's): its colour — a variable's pill when bound — its opacity, its eye, its minus. */
function PaintRow<T extends Paint>({ paint, variables, byId, mode, onChange, onRemove, pageColors, ops }: { paint: T; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode; onChange: (paint: T) => void; onRemove: () => void; pageColors: string[]; ops?: EditorOps }) {
  const [picker, setPicker] = useState<{ top: number; right: number } | null>(null);
  const bound = "alias" in paint.color ? byId.get(paint.color.alias) : undefined;
  const resolved = String(boundValue(paint.color, mode, byId) ?? "#000000");
  // A variable's colour opens onto the variables (Libraries); a colour of its own onto the picker (Custom).
  const pickerNode = picker && (
    <ColorPicker
      initialTab={bound ? "libraries" : "custom"}
      color={resolved}
      opacity={paint.opacity ?? 100}
      anchor={picker}
      variables={variables}
      byId={byId}
      mode={mode}
      pageColors={pageColors}
      selectedId={bound?.id}
      onChange={(hex, opacity) => onChange({ ...paint, color: own(hex), opacity: opacity >= 100 ? undefined : opacity })}
      onVariable={(color) => onChange({ ...paint, color })}
      onCreateVariable={ops?.createColorStyle}
      paint={paint}
      onPaint={(p) => onChange({ ...paint, ...p })}
      onUpload={ops?.upload}
      onClose={() => setPicker(null)}
    />
  );
  const fancy = paint.type === "gradient" || paint.type === "image";
  const preview = paint.type === "gradient" && paint.gradient ? `linear-gradient(${paint.gradient.angle}deg, ${paint.gradient.stops.map((st) => `${st.color} ${st.position}%`).join(", ")})` : paint.type === "image" && paint.image?.url ? `url("${paint.image.url}") center / cover` : undefined;
  return (
    <PropRow
      icons={
        <>
          {bound && !fancy && <IconButton label="Detach variable" icon={fi("detach.small")} onClick={() => onChange({ ...paint, color: own(resolved) })} />}
          <IconButton label={paint.visible === false ? "Show" : "Hide"} icon={fi(paint.visible === false ? "hidden.small" : "eye.small")} onClick={() => onChange({ ...paint, visible: paint.visible === false ? undefined : false })} />
          <IconButton label="Remove" icon={fi("minus.small")} onClick={onRemove} />
        </>
      }
    >
      <div className="relative flex flex-1 min-w-0 items-center">
        {fancy ? (
          <button type="button" data-picker-anchor="" onClick={(e) => setPicker(picker ? null : anchorOf(e.currentTarget))} className="flex flex-1 min-w-0 items-center h-6 rounded-[5px] bg-[var(--f-bg-secondary)] cursor-pointer">
            <span className="flex w-6 h-6 shrink-0 items-center justify-center"><span className="w-4 h-4 rounded-[3px] border border-[var(--f-border-translucent)]" style={{ background: preview ?? "var(--f-bg-hover)" }} /></span>
            <span className="truncate text-[11px] leading-4 text-[var(--f-text)]">{PAINT_LABEL[paint.type!]}</span>
          </button>
        ) : bound ? (
          <button type="button" data-picker-anchor="" onClick={(e) => setPicker(picker ? null : anchorOf(e.currentTarget))} className="flex flex-1 min-w-0 items-center h-6 rounded-[5px] bg-[var(--f-bg-secondary)] border border-transparent hover:border-[var(--f-border)] cursor-pointer">
            <Chit color={resolved} />
            <span className="truncate text-[11px] leading-4 text-[var(--f-text)]">{bound.name}</span>
          </button>
        ) : (
          <ColorInput
            label="Color"
            color={resolved}
            opacity={paint.opacity ?? 100}
            onColor={(hex) => onChange({ ...paint, color: own(hex) })}
            onOpacity={(opacity) => onChange({ ...paint, opacity: opacity >= 100 ? undefined : opacity })}
            chit={
              <button type="button" data-picker-anchor="" aria-label="Color picker" onClick={(e) => setPicker(picker ? null : anchorOf(e.currentTarget))} className="cursor-pointer">
                <Chit color={resolved} />
              </button>
            }
          />
        )}
        {pickerNode}
      </div>
    </PropRow>
  );
}

const ALIGN_GLYPH = {
  left: fi("24.layout-align-left"),
  hcenter: fi("24.layout-align-horizontal-center"),
  right: fi("24.layout-align-right"),
  top: fi("24.layout-align-top"),
  vcenter: fi("24.layout-align-vertical-center"),
  bottom: fi("24.layout-align-bottom"),
};
/** Figma's keys for them: ⌥A / ⌥H / ⌥D along the width, ⌥W / ⌥V / ⌥S along the height. */
const ALIGN_KEYS: Record<keyof typeof ALIGN_GLYPH, string> = { left: "⌥A", hcenter: "⌥H", right: "⌥D", top: "⌥W", vcenter: "⌥V", bottom: "⌥S" };
const ALIGN_LABEL: Record<keyof typeof ALIGN_GLYPH, string> = {
  left: "Align left",
  hcenter: "Align horizontal centers",
  right: "Align right",
  top: "Align top",
  vcenter: "Align vertical centers",
  bottom: "Align bottom",
};
const FLOW_GLYPH = {
  freeform: fi("24.layout.freeform"),
  vertical: fi("24.layout.vertical"),
  horizontal: fi("24.layout.horizontal"),
  grid: fi("24.layout.grid"),
};

/** A group of icon buttons on the secondary background, as Figma's alignment and flow controls. */
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; icon: ReactNode; disabled?: boolean }[]; onChange: (value: T) => void }) {
  return (
    <div className="flex flex-1 min-w-0 items-center h-6 p-0.5 rounded-[5px] bg-[var(--f-bg-secondary)]">
      {options.map((o) => (
        <button key={o.value} type="button" aria-label={o.label} data-tip={o.label} aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)} className={cn("flex flex-1 items-center justify-center h-5 rounded-[3px] cursor-pointer disabled:opacity-40 disabled:cursor-default", o.value === value ? "bg-[var(--f-bg)] text-[var(--f-text)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_1px_3px_rgba(0,0,0,0.15)]" : "text-[var(--f-icon-secondary)] hover:text-[var(--f-text)]")}>
          {o.icon}
        </button>
      ))}
    </div>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

/** Figma's boxed group of buttons (the alignment, the flips): a field-height box on the secondary background, its buttons sharing it. */
/** Figma's boxed group of buttons: each on the secondary background, a hairline of the panel's between them, the group's outer corners 5px. */
function ButtonGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 min-w-0 items-center h-6 gap-px rounded-[5px] bg-[var(--f-bg)]">{children}</div>;
}

/** One of them: hovered, the darker grey; its tooltip the name and its keys (`shortcut`). */
function GroupButton({ label, shortcut, icon, active = false, onClick }: { label: string; shortcut?: string; icon: ReactNode; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} data-tip={label} data-tip-key={shortcut} aria-pressed={active} onClick={onClick} className={cn("flex flex-1 items-center justify-center h-full cursor-pointer first:rounded-l-[5px] last:rounded-r-[5px]", active ? "bg-[var(--f-bg-selected)] text-[var(--f-text-brand)]" : "bg-[var(--f-bg-secondary)] text-[var(--f-icon)] hover:bg-[var(--f-bg-tertiary)]")}>
      {icon}
    </button>
  );
}

/** A row of the styles list, drawn as a layers row: the tinted cell 8px in on hover, a chevron slot (groups) or an icon slot, the name; 24px further in per level. */
function StyleRow({ depth, chevron, icon, onClick, children, trailing }: { depth: number; chevron?: ReactNode; icon?: ReactNode; onClick?: () => void; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div onClick={onClick} className={cn("group/srow relative h-7 select-none", onClick && "cursor-pointer")}>
      <div aria-hidden className="absolute top-0 bottom-0 rounded-[5px] group-hover/srow:bg-[var(--f-bg-row-hover)]" style={{ left: 8, right: 8 }} />
      <div className="relative flex items-center h-7 pr-3" style={{ paddingLeft: 12 + depth * 24 }}>
        {chevron !== undefined && <span className="flex w-4 h-4 shrink-0 items-center justify-center text-[var(--f-icon-secondary)]">{chevron}</span>}
        {icon !== undefined && <span className="flex w-6 h-4 shrink-0 items-center justify-center">{icon}</span>}
        <span className="min-w-0 flex-1 ml-2 truncate text-[11px] font-[450] leading-4 tracking-[0.055px] text-[var(--f-text)]">{children}</span>
        {trailing}
      </div>
    </div>
  );
}

/** A text style group: its subgroups (by the names' path segments) and its own styles. */
interface StyleGroup {
  groups: Map<string, StyleGroup>;
  items: TextStyle[];
}

/**
 * The text styles as Figma lists them: nested groups from their names'
 * paths ("Typography/Mobile/H1"), each opened or closed by its chevron,
 * 24px further in per level; a style as "Ag", its name, its size / line height.
 */
function TextStyleTree({ styles, byId, variables, mode, ops }: { styles: TextStyle[]; byId: Map<string, DesignVariable>; variables: DesignVariable[]; mode: ThemeMode; ops: EditorOps }) {
  // Closed as the panel comes (a click on the empty canvas): the groups opened are the ones in this set.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  // The style being edited in its window (Figma's "Edit text style"), opened from the row's adjust button.
  const [editing, setEditing] = useState<{ id: string; anchor: { top: number; right: number } } | null>(null);
  const edited = editing ? styles.find((st) => st.id === editing.id) : undefined;
  const root: StyleGroup = { groups: new Map(), items: [] };
  for (const st of styles) {
    const parts = st.name.split("/").map((p) => p.trim()).filter(Boolean);
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.groups.get(part);
      if (!next) at.groups.set(part, (next = { groups: new Map(), items: [] }));
      at = next;
    }
    at.items.push(st);
  }
  const rows = (group: StyleGroup, depth: number, path: string): ReactNode[] => [
    ...[...group.groups].map(([name, sub]) => {
      const key = path ? `${path}/${name}` : name;
      const open = opened.has(key);
      return (
        <div key={`g:${key}`} className="flex flex-col">
          <StyleRow depth={depth} chevron={fi(open ? "16.chevron.down" : "16.chevron.right")} onClick={() => setOpened((c) => { const next = new Set(c); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>
            {name}
          </StyleRow>
          {open && rows(sub, depth + 1, key)}
        </div>
      );
    }),
    ...group.items.map((st) => (
      <StyleRow key={st.id} depth={depth} icon={<span className="text-[13px] font-[550] leading-4 text-[var(--f-text)]">Ag</span>} trailing={
        <span data-picker-anchor="" className={cn(editing?.id !== st.id && "opacity-0 group-hover/srow:opacity-100")}>
          <IconButton label="Edit style" icon={fi("24.adjust.small")} active={editing?.id === st.id} onClick={(e) => setEditing(editing?.id === st.id ? null : { id: st.id, anchor: anchorOf(e.currentTarget) })} />
        </span>
      }>
        {splitName(st.name)[1] || st.name}
        <span className="text-[var(--f-text-secondary)]"> · {numberOf(st.fontSize, byId, 16)}/{st.lineHeight ? numberOf(st.lineHeight, byId) : "Auto"}</span>
      </StyleRow>
    )),
  ];
  return (
    <div className="flex flex-col">
      {rows(root, 0, "")}
      {editing && edited && <TextStyleEditor style={edited} anchor={editing.anchor} variables={variables} byId={byId} mode={mode} ops={ops} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** A text style's colour: a variable's pill (its picker opens on Libraries) or a colour of its own. */
function StyleColorRow({ value, variables, byId, mode, ops, onChange }: { value: VariableValue; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode; ops: EditorOps; onChange: (value: VariableValue) => void }) {
  const [picker, setPicker] = useState<{ top: number; right: number } | null>(null);
  const bound = "alias" in value ? byId.get(value.alias) : undefined;
  const resolved = String(boundValue(value, mode, byId) ?? "#000000");
  return (
    <div className="relative flex flex-1 min-w-0 items-center gap-1">
      {bound ? (
        <button type="button" data-picker-anchor="" onClick={(e) => setPicker(picker ? null : anchorOf(e.currentTarget))} className="flex flex-1 min-w-0 items-center h-6 rounded-[5px] bg-[var(--f-bg-secondary)] border border-transparent hover:border-[var(--f-border)] cursor-pointer">
          <Chit color={resolved} />
          <span className="truncate text-[11px] leading-4 text-[var(--f-text)]">{bound.name}</span>
        </button>
      ) : (
        <ColorInput label="Color" color={resolved} opacity={100} onColor={(hex) => onChange(own(hex))} chit={<button type="button" data-picker-anchor="" aria-label="Color picker" onClick={(e) => setPicker(picker ? null : anchorOf(e.currentTarget))} className="cursor-pointer"><Chit color={resolved} /></button>} />
      )}
      {bound && <IconButton label="Detach variable" icon={fi("detach.small")} onClick={() => onChange(own(resolved))} />}
      {picker && <ColorPicker initialTab={bound ? "libraries" : "custom"} color={resolved} opacity={100} anchor={picker} variables={variables} byId={byId} mode={mode} pageColors={ops.pageColors} selectedId={bound?.id} onChange={(hex) => onChange(own(hex))} onVariable={(v) => onChange(v)} onClose={() => setPicker(null)} />}
    </div>
  );
}

/**
 * Figma's "Edit text style" window, beside the panel: the style previewed
 * ("Rag 123" in it), its name and description, its properties — weight and
 * size, line height and letter spacing (each bindable to a variable), its
 * colour — the bin deleting it.
 */
function TextStyleEditor({ style, anchor, variables, byId, mode, ops, onClose }: { style: TextStyle; anchor: { top: number; right: number }; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode; ops: EditorOps; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (!ref.current?.contains(t) && !t.closest("[data-picker-anchor]") && !t.closest("[role=menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [onClose]);
  const set = (patch: Partial<TextStyle>) => ops.setTextStyle({ ...style, ...patch });
  const size = numberOf(style.fontSize, byId, 16);
  const weight = numberOf(style.fontWeight, byId, 400);
  const lineHeight = style.lineHeight ? numberOf(style.lineHeight, byId) : Math.round(size * 1.25);
  const letterSpacing = style.letterSpacing ? numberOf(style.letterSpacing, byId) : 0;
  const color = String(boundValue(style.color, mode, byId) ?? "#000000");
  const width = 288;
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 520));
  const left = Math.max(8, anchor.right - width - 8);
  const field = (label: string, control: ReactNode) => (
    <div className="flex items-center gap-2 h-8 pl-4 pr-4">
      <span className="w-[76px] shrink-0 text-[11px] text-[var(--f-text-secondary)]">{label}</span>
      <div className="flex flex-1 min-w-0 items-center">{control}</div>
    </div>
  );
  return (
    <div ref={ref} role="dialog" aria-label="Edit text style" className="fixed z-50 flex flex-col rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_10px_16px_rgba(0,0,0,0.2)] text-[11px] leading-4 text-[var(--f-text)]" style={{ top, left, width }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between h-10 pl-4 pr-2 border-b border-[var(--f-border)]">
        <span className="font-[550] text-[11px]">Edit text style</span>
        <div className="flex items-center gap-1">
          <IconButton label="Delete style" icon={fi("trash")} onClick={() => { ops.removeTextStyle(style.id); onClose(); }} />
          <IconButton label="Close" icon={fi("close.small")} onClick={onClose} />
        </div>
      </div>
      {/* The preview: the style itself, on the secondary background. */}
      <div className="flex items-center justify-center h-[120px] bg-[var(--f-bg-secondary)] border-b border-[var(--f-border)] overflow-hidden">
        <span style={{ fontSize: size, fontWeight: weight, lineHeight: `${lineHeight}px`, letterSpacing, color, fontFamily: "var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif" }}>Rag 123</span>
      </div>
      <div className="flex flex-col py-2">
        {field("Name", <TextInput label="Name" value={style.name} onCommit={(name) => name.trim() && set({ name: name.trim() })} />)}
        {field("Description", <TextInput label="Description" value={style.description ?? ""} placeholder="What's it for?" onCommit={(description) => set({ description: description.trim() || undefined })} />)}
        {field("On the site", <Select label="On the site" value={style.tag ?? ""} options={[{ value: "", label: "Plain text" }, ...(["h1", "h2", "h3", "h4", "p"] as const).map((t) => ({ value: t, label: TAG_LABEL[t] }))]} onChange={(tag) => set({ tag: (tag || undefined) as TextStyle["tag"] })} />)}
      </div>
      <div className="flex flex-col pb-3 border-t border-[var(--f-border)]">
        <div className="flex items-center h-10 pl-4 pr-4 font-[550]">Properties</div>
        <div className="flex items-center gap-2 pl-4 pr-4 pb-2">
          <div className="flex flex-1 min-w-0 items-center h-6 px-2 rounded-[5px] bg-[var(--f-bg-secondary)] text-[var(--f-text)]"><span className="mr-2 text-[var(--f-icon-secondary)]">{fi("16.text")}</span>Inter</div>
        </div>
        <div className="flex items-center gap-2 pl-4 pr-4 pb-2">
          <BoundNumber label="Font weight" kind="weight" prefix={<Prefix>{fi("16.text")}</Prefix>} value={style.fontWeight} variables={variables} byId={byId} mode={mode} min={100} max={900} onChange={(fontWeight) => set({ fontWeight })} />
          <BoundNumber label="Font size" prefix={<Prefix><span className="text-[10px]">Aa</span></Prefix>} value={style.fontSize} variables={variables} byId={byId} mode={mode} min={1} onChange={(fontSize) => set({ fontSize })} />
        </div>
        <div className="flex items-center gap-2 pl-4 pr-4 pb-2">
          <BoundNumber label="Line height" prefix={<Prefix>{fi("al.height-min")}</Prefix>} value={style.lineHeight} fallback={lineHeight} variables={variables} byId={byId} mode={mode} min={0} onChange={(lineHeight) => set({ lineHeight })} />
          <BoundNumber label="Letter spacing" prefix={<Prefix>{fi("al.width-min")}</Prefix>} value={style.letterSpacing} fallback={letterSpacing} variables={variables} byId={byId} mode={mode} min={-20} onChange={(letterSpacing) => set({ letterSpacing })} />
        </div>
        <div className="flex items-center gap-2 pl-4 pr-4">
          <StyleColorRow value={style.color} variables={variables} byId={byId} mode={mode} ops={ops} onChange={(color) => set({ color })} />
        </div>
      </div>
    </div>
  );
}

/** The colour variables as Figma lists colour styles: grouped by their names' paths, each group opened or closed by its chevron. */
function ColorStyleTree({ variables, byId, mode, onOpen }: { variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode; onOpen: () => void }) {
  // Closed as the panel comes: the groups opened are the ones in this set.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  interface Group { groups: Map<string, Group>; items: DesignVariable[] }
  const root: Group = { groups: new Map(), items: [] };
  for (const v of variables) {
    const parts = v.name.split("/").map((p) => p.trim()).filter(Boolean);
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.groups.get(part);
      if (!next) at.groups.set(part, (next = { groups: new Map(), items: [] }));
      at = next;
    }
    at.items.push(v);
  }
  const rows = (group: Group, depth: number, path: string): ReactNode[] => [
    ...[...group.groups].map(([name, sub]) => {
      const key = path ? `${path}/${name}` : name;
      const open = opened.has(key);
      return (
        <div key={`g:${key}`} className="flex flex-col">
          <StyleRow depth={depth} chevron={fi(open ? "16.chevron.down" : "16.chevron.right")} onClick={() => setOpened((c) => { const next = new Set(c); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>
            {name}
          </StyleRow>
          {open && rows(sub, depth + 1, key)}
        </div>
      );
    }),
    ...group.items.map((v) => (
      <StyleRow key={v.id} depth={depth} icon={<span className="w-4 h-4 rounded-full border border-[var(--f-border-translucent)]" style={{ background: String(boundValue(v.light, mode, byId) ?? "#000") }} />} trailing={<IconButton label="Edit variable" icon={fi("24.adjust.small")} onClick={onOpen} className="opacity-0 group-hover/srow:opacity-100" />}>
        {splitName(v.name)[1] || v.name}
      </StyleRow>
    )),
  ];
  return <div className="flex flex-col">{rows(root, 0, "")}</div>;
}

/** Several layers' one value, or null when they differ (the field then reads "Mixed", as Figma's). */
function sameValue(list: readonly SceneNode[], pick: (n: SceneNode) => number): number | null {
  if (!list.length) return null;
  const first = Math.round(pick(list[0]));
  return list.every((n) => Math.round(pick(n)) === first) ? first : null;
}

function PositionSection({ node, inAuto, ops, multi, selected }: { node: SceneNode; inAuto: boolean; ops: EditorOps; multi: readonly string[]; selected: readonly SceneNode[] }) {
  const set = (patch: Partial<SceneNode>) => (multi.length > 1 ? ops.patchMany(multi, patch) : ops.patch(node.id, patch));
  const all = selected.length > 1 ? selected : [node];
  const xVal = sameValue(all, (n) => n.x);
  const yVal = sameValue(all, (n) => n.y);
  const rotVal = sameValue(all, (n) => n.rotation ?? 0);
  return (
    <Section title="Position" icons={inAuto ? <IconButton label={node.absolute ? "Remove absolute position" : "Absolute position"} icon={fi("24.al.absolute-position")} active={Boolean(node.absolute)} onClick={() => ops.patch(node.id, { absolute: node.absolute ? undefined : true })} /> : undefined}>
      {/* Figma's alignment: two boxed groups — left / centre / right, top / middle / bottom; the distribute menu only with several layers selected. */}
      <PropRow icons={multi.length > 1 ? <IconButton label="Distribute" icon={fi("24.layout-distribute-vertical-spacing")} onClick={(e) => ops.menu(e.currentTarget, [
        { label: "Tidy up", icon: fi("24.layout-tidy-up-grid", 16), shortcut: keys("ctrl", "alt", "t"), onSelect: ops.tidy },
        { label: "Distribute vertical spacing", icon: fi("24.layout-distribute-vertical-spacing", 16), shortcut: keys("ctrl", "alt", "v"), onSelect: () => ops.distribute("v") },
        { label: "Distribute horizontal spacing", icon: fi("24.layout-distribute-horizontal-spacing", 16), shortcut: keys("ctrl", "alt", "h"), onSelect: () => ops.distribute("h") },
      ])} /> : <span className="w-6" />}>
        <ButtonGroup>
          {(["left", "hcenter", "right"] as const).map((k) => <GroupButton key={k} label={ALIGN_LABEL[k]} shortcut={ALIGN_KEYS[k]} icon={ALIGN_GLYPH[k]} onClick={() => ops.align(k)} />)}
        </ButtonGroup>
        <ButtonGroup>
          {(["top", "vcenter", "bottom"] as const).map((k) => <GroupButton key={k} label={ALIGN_LABEL[k]} shortcut={ALIGN_KEYS[k]} icon={ALIGN_GLYPH[k]} onClick={() => ops.align(k)} />)}
        </ButtonGroup>
      </PropRow>
      <PropRow icons={<span className="w-6" />}>
        <NumericInput label="X" prefix="X" value={xVal} placeholder={xVal === null ? "Mixed" : undefined} fallback={Math.round(node.x)} onChange={(x) => set({ x })} disabled={inAuto && !node.absolute} />
        <NumericInput label="Y" prefix="Y" value={yVal} placeholder={yVal === null ? "Mixed" : undefined} fallback={Math.round(node.y)} onChange={(y) => set({ y })} disabled={inAuto && !node.absolute} />
      </PropRow>
      <PropRow icons={<span className="w-6" />}>
        <NumericInput label="Rotation" prefix={<Prefix>{fi("24.rotation")}</Prefix>} value={rotVal} placeholder={rotVal === null ? "Mixed" : undefined} fallback={node.rotation ?? 0} min={-360} max={360} unit={rotVal === null ? undefined : "°"} onChange={(rotation) => set({ rotation: rotation || undefined })} />
        <ButtonGroup>
          {/* Each layer from its own: rotated by 90° more, flipped the other way. */}
          <GroupButton label="Rotate 90°" icon={fi("24.rotate")} onClick={() => ops.updateMany(multi.length > 1 ? multi : [node.id], (n) => ({ ...n, rotation: ((n.rotation ?? 0) + 90) % 360 || undefined }))} />
          <GroupButton label="Flip horizontal" shortcut="⇧H" icon={fi("24.flip.horizontal.small")} active={Boolean(node.flipH)} onClick={() => ops.updateMany(multi.length > 1 ? multi : [node.id], (n) => ({ ...n, flipH: n.flipH ? undefined : true }))} />
          <GroupButton label="Flip vertical" shortcut="⇧V" icon={fi("24.flip.vertical")} active={Boolean(node.flipV)} onClick={() => ops.updateMany(multi.length > 1 ? multi : [node.id], (n) => ({ ...n, flipV: n.flipV ? undefined : true }))} />
        </ButtonGroup>
      </PropRow>
    </Section>
  );
}

/**
 * Several layers' Layout, as Figma's: their width and height (or "Mixed"),
 * and — siblings lined up in a row or a column — the spacing between them,
 * which places them anew when typed.
 */
function MultiLayoutSection({ selected, sameParent, ops }: { selected: readonly SceneNode[]; sameParent: boolean; ops: EditorOps }) {
  const wVal = sameValue(selected, (n) => n.width);
  const hVal = sameValue(selected, (n) => n.height);
  // Which way they line up: the axis along which none overlaps the next (a column, else a row; else the longer span).
  const byY = [...selected].sort((a, b) => a.y - b.y);
  const byX = [...selected].sort((a, b) => a.x - b.x);
  const apart = (list: SceneNode[], vertical: boolean) => list.slice(1).every((n, i) => (vertical ? n.y >= list[i].y + list[i].height - 0.5 : n.x >= list[i].x + list[i].width - 0.5));
  const spanX = Math.max(...selected.map((n) => n.x + n.width)) - Math.min(...selected.map((n) => n.x));
  const spanY = Math.max(...selected.map((n) => n.y + n.height)) - Math.min(...selected.map((n) => n.y));
  const vertical = apart(byY, true) ? true : apart(byX, false) ? false : spanY >= spanX;
  const list = vertical ? byY : byX;
  const gaps = list.slice(1).map((n, i) => (vertical ? n.y - (list[i].y + list[i].height) : n.x - (list[i].x + list[i].width)));
  const gapVal = gaps.length && gaps.every((g) => Math.round(g) === Math.round(gaps[0])) ? Math.round(gaps[0]) : null;
  const setSpacing = (value: number) => {
    let end = vertical ? list[0].y + list[0].height : list[0].x + list[0].width;
    const moves = list.slice(1).map((n) => {
      const at = Math.round(end + value);
      end = at + (vertical ? n.height : n.width);
      return vertical ? { id: n.id, y: at } : { id: n.id, x: at };
    });
    ops.placeMany(moves);
  };
  return (
    <Section title="Layout" icons={<IconButton label="Add auto layout (⇧A)" icon={fi("24.autolayout-add-vertical")} onClick={ops.addAutoLayout} />}>
      <PropRow icons={<span className="w-6" />}>
        <NumericInput label="Width" prefix="W" value={wVal} placeholder={wVal === null ? "Mixed" : undefined} fallback={Math.round(selected[0].width)} min={0} onChange={(width) => ops.patch(selected[0].id, { width, sizingH: undefined } as Partial<SceneNode>)} />
        <NumericInput label="Height" prefix="H" value={hVal} placeholder={hVal === null ? "Mixed" : undefined} fallback={Math.round(selected[0].height)} min={0} onChange={(height) => ops.patch(selected[0].id, { height, sizingV: undefined } as Partial<SceneNode>)} />
      </PropRow>
      {sameParent && (
        <PropRow icons={<span className="w-6" />}>
          <NumericInput label={vertical ? "Vertical spacing" : "Horizontal spacing"} prefix={<Prefix>{fi(vertical ? "al.spacing-vertical" : "al.spacing-horizontal")}</Prefix>} value={gapVal} placeholder={gapVal === null ? "Mixed" : undefined} fallback={gapVal ?? 0} onChange={setSpacing} />
          <span className="flex-1" />
        </PropRow>
      )}
    </Section>
  );
}

function LayoutSection({ node, parent, ops, variables, byId, mode }: { node: SceneNode; parent: FrameNode | null; ops: EditorOps; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode }) {
  const frame = isFrameLike(node) ? node : null;
  const inAuto = Boolean(parent && parent.layoutMode !== "none");
  const [sides, setSides] = useState(false);
  const text = node.type === "text" ? node : null;
  const hSizing = node.sizingH ?? (text && text.textAutoResize === "widthHeight" ? "hug" : "fixed");
  const vSizing = node.sizingV ?? (text && text.textAutoResize !== "none" ? "hug" : "fixed");
  const canHug = Boolean(frame && frame.layoutMode !== "none") || Boolean(text);
  const setSizing = (axis: "H" | "V", value: "fixed" | "hug" | "fill") => {
    if (text) {
      const h = axis === "H" ? value : hSizing;
      const v = axis === "V" ? value : vSizing;
      const auto: TextNode["textAutoResize"] = h === "hug" ? "widthHeight" : v === "hug" ? "height" : "none";
      ops.patch(node.id, { textAutoResize: auto, sizingH: h === "fill" ? "fill" : undefined, sizingV: v === "fill" ? "fill" : undefined } as Partial<SceneNode>);
      return;
    }
    ops.patch(node.id, axis === "H" ? { sizingH: value === "fixed" ? undefined : value } : { sizingV: value === "fixed" ? undefined : value });
  };
  const numberVars = variables.filter((v) => v.kind === "number");
  const [limits, setLimits] = useState(false);
  const hasLimits = limits || [node.minWidth, node.maxWidth, node.minHeight, node.maxHeight].some((v) => v !== undefined);
  const sizingMenu = (axis: "H" | "V") => {
    const isW = axis === "H";
    const sizing = isW ? hSizing : vSizing;
    const size = Math.round(isW ? node.width : node.height);
    const bound = isW ? node.widthVar : node.heightVar;
    const minKey = isW ? "minWidth" : "minHeight";
    const maxKey = isW ? "maxWidth" : "maxHeight";
    const items: ChevronItem[] = [
      { label: isW ? `Fixed width (${size})` : `Fixed height (${size})`, icon: fi(isW ? "24.al.width-minmax" : "24.al.height-minmax", 16), checked: sizing === "fixed", onSelect: () => setSizing(axis, "fixed") },
      ...(canHug ? [{ label: "Hug contents", icon: fi(isW ? "24.al.width-hug" : "24.al.height-hug", 16), checked: sizing === "hug", onSelect: () => setSizing(axis, "hug") }] : []),
      ...(inAuto ? [{ label: "Fill container", icon: fi(isW ? "24.al.width-fill" : "24.al.height-fill", 16), checked: sizing === "fill", onSelect: () => setSizing(axis, "fill") }] : []),
      "-",
      { label: node[minKey] === undefined ? (isW ? "Add min width…" : "Add min height…") : (isW ? "Remove min width" : "Remove min height"), icon: fi(isW ? "al.width-min" : "al.height-min", 16), onSelect: () => { if (node[minKey] === undefined) { setLimits(true); ops.patch(node.id, { [minKey]: 0 }); } else ops.patch(node.id, { [minKey]: undefined }); } },
      { label: node[maxKey] === undefined ? (isW ? "Add max width…" : "Add max height…") : (isW ? "Remove max width" : "Remove max height"), icon: fi(isW ? "al.width-max" : "al.height-max", 16), onSelect: () => { if (node[maxKey] === undefined) { setLimits(true); ops.patch(node.id, { [maxKey]: size }); } else ops.patch(node.id, { [maxKey]: undefined }); } },
      "-",
      bound
        ? { label: "Detach variable", icon: fi("detach.small", 16), onSelect: () => ops.patch(node.id, isW ? { widthVar: undefined } : { heightVar: undefined }) }
        : { label: "Apply variable…", icon: fi("variable.small", 16), disabled: numberVars.length === 0, hint: numberVars.length ? undefined : "no number variables", items: numberVars.map((v) => ({ label: v.name, hint: String(numberOf({ alias: v.id }, byId)), onSelect: () => ops.patch(node.id, isW ? { widthVar: { alias: v.id }, sizingH: undefined } : { heightVar: { alias: v.id }, sizingV: undefined }) })) },
    ];
    return (
      <ChevronMenu hover label={isW ? "Width sizing" : "Height sizing"} items={items}>
        {sizing !== "fixed" && <span className="text-[11px] text-[var(--f-text)]">{sizing === "hug" ? "Hug" : "Fill"}</span>}
      </ChevronMenu>
    );
  };
  const limitMenu = (key: "minWidth" | "maxWidth" | "minHeight" | "maxHeight") => (
    <ChevronMenu label="Limit" items={[{ label: "Remove", onSelect: () => { ops.patch(node.id, { [key]: undefined }); if ([node.minWidth, node.maxWidth, node.minHeight, node.maxHeight].filter((v) => v !== undefined).length <= 1) setLimits(false); } }]} />
  );
  // A padding or gap field focused: the canvas shows the strip it edits (Figma's).
  const focusPads = (sides: ("top" | "right" | "bottom" | "left")[]) => (focused: boolean) => ops.setLayoutFocus(focused ? { pads: sides } : null);
  const focusGap = (focused: boolean) => ops.setLayoutFocus(focused ? { gap: true } : null);
  const advancedMenu = (el: HTMLElement) => frame && ops.menu(el, [
            { label: "Strokes included in layout", checked: Boolean(frame.strokesInLayout), onSelect: () => ops.patch(frame.id, { strokesInLayout: frame.strokesInLayout ? undefined : true }) },
            "-",
            { label: "Last on top", checked: !frame.firstOnTop, onSelect: () => ops.patch(frame.id, { firstOnTop: undefined }) },
            { label: "First on top", checked: Boolean(frame.firstOnTop), onSelect: () => ops.patch(frame.id, { firstOnTop: true }) },
            "-",
            { label: "Text baseline alignment", checked: Boolean(frame.baselineAlign), disabled: frame.layoutMode !== "horizontal", onSelect: () => ops.patch(frame.id, { baselineAlign: frame.baselineAlign ? undefined : true }) },
          ]);
  const gapLabel = frame?.layoutMode === "horizontal" ? "Horizontal gap" : "Vertical gap";
  const gapPrefix = <Prefix>{fi(frame?.layoutMode === "horizontal" ? "al.spacing-horizontal" : "al.spacing-vertical")}</Prefix>;
  // The gap's menu: fixed / auto, and its variable (applied or detached here — the field itself shows no hexagon).
  const gapBound = frame && "alias" in frame.itemSpacing ? byId.get(frame.itemSpacing.alias) : undefined;
  const gapMode = frame && <ChevronMenu label="Gap mode" items={[
    { label: "Fixed", checked: frame.primaryAlign !== "spaceBetween", onSelect: () => ops.patch(frame.id, { primaryAlign: frame.primaryAlign === "spaceBetween" ? "min" : frame.primaryAlign }) },
    { label: "Auto", checked: frame.primaryAlign === "spaceBetween", onSelect: () => ops.patch(frame.id, { primaryAlign: "spaceBetween" }) },
    "-",
    gapBound
      ? { label: "Detach variable", icon: fi("detach.small", 16), hint: gapBound.name, onSelect: () => ops.patch(frame.id, { itemSpacing: own(numberOf(frame.itemSpacing, byId)) }) }
      : { label: "Apply variable…", icon: fi("variable.small", 16), disabled: numberVars.length === 0, hint: numberVars.length ? undefined : "no number variables", items: numberVars.map((v) => ({ label: v.name, hint: String(numberOf({ alias: v.id }, byId)), onSelect: () => ops.patch(frame.id, { itemSpacing: { alias: v.id } }) })) },
  ]} />;
  const flow: "vertical" | "horizontal" | "wrap" | "grid" | "" = frame ? (frame.layoutMode === "none" ? "" : frame.layoutMode === "horizontal" && frame.layoutWrap ? "wrap" : frame.layoutMode) : "";
  const auto = Boolean(frame && frame.layoutMode !== "none");
  const hugAll = () => frame && ops.patch(frame.id, { sizingH: "hug", sizingV: "hug" });
  return (
    <Section
      title={auto ? "Auto layout" : "Layout"}
      icons={
        frame ? (
          auto ? (
            <IconButton label="Remove auto layout (⇧A)" icon={fi("24.autolayout-vertical")} active onClick={() => ops.setAutoLayout(frame.id, "none")} />
          ) : (
            <>
              <IconButton label="Resize to fit" icon={fi("24.resize-to-fit.small")} disabled={!frame.children.length} onClick={() => ops.fitToContent(frame.id)} />
              <IconButton label="Add auto layout (⇧A)" icon={fi("24.autolayout-add-vertical")} onClick={() => ops.setAutoLayout(frame.id, "vertical")} />
            </>
          )
        ) : (
          <IconButton label="Add auto layout (⇧A)" icon={fi("24.autolayout-add-vertical")} onClick={ops.addAutoLayout} />
        )
      }
    >
      {frame && (
        <PropRow icons={<IconButton label="Wrap" icon={fi("24.layout.wrap")} active={Boolean(frame.layoutWrap) || frame.layoutMode === "grid"} disabled={frame.layoutMode !== "horizontal" && frame.layoutMode !== "grid"} onClick={() => frame.layoutMode === "horizontal" && ops.patch(frame.id, { layoutWrap: frame.layoutWrap ? undefined : true })} />}>
          {/* Figma's flow control: Freeform (no auto layout), Vertical, Horizontal, Grid — wrapping is the button at the right. */}
          <Segmented
            value={flow === "wrap" ? "horizontal" : flow}
            options={[
              { value: "" as const, label: "Freeform", icon: FLOW_GLYPH.freeform },
              { value: "vertical" as const, label: "Vertical", icon: FLOW_GLYPH.vertical },
              { value: "horizontal" as const, label: "Horizontal", icon: FLOW_GLYPH.horizontal },
              { value: "grid" as const, label: "Grid", icon: FLOW_GLYPH.grid },
            ]}
            onChange={(v) => {
              if (!v) return ops.setAutoLayout(frame.id, "none");
              if (frame.layoutMode === "none") ops.setAutoLayout(frame.id, v);
              ops.patch(frame.id, { layoutMode: v, layoutWrap: undefined, ...(v === "grid" && !frame.gridColumns ? { gridColumns: 2 } : {}) });
            }}
          />
        </PropRow>
      )}
      <PropRow icons={auto ? <IconButton label="Resize to fit" icon={fi("24.resize-to-fit.small")} onClick={hugAll} /> : <IconButton label={node.lockAspect ? "Unconstrain proportions" : "Constrain proportions"} icon={fi("constrain-proportions")} active={Boolean(node.lockAspect)} onClick={() => ops.lockProportions(node.id, !node.lockAspect)} />}>
        {node.widthVar ? (
          <BoundNumber label="Width" prefix="W" value={node.widthVar} variables={variables} byId={byId} mode={mode} onChange={(v) => ops.patch(node.id, "alias" in v ? { widthVar: v } : { widthVar: undefined, width: Number(v.value) || 0 })} suffix={sizingMenu("H")} />
        ) : (
          <NumericInput label="Width" prefix="W" value={Math.round(node.width)} min={0} onChange={(width) => ops.patch(node.id, { width, ...(node.lockAspect && node.width ? { height: Math.round((width * node.height) / node.width), sizingV: undefined } : {}), sizingH: undefined, ...(text ? { textAutoResize: text.textAutoResize === "widthHeight" ? "height" : text.textAutoResize } : {}) } as Partial<SceneNode>)} suffix={sizingMenu("H")} />
        )}
        {node.heightVar ? (
          <BoundNumber label="Height" prefix="H" value={node.heightVar} variables={variables} byId={byId} mode={mode} onChange={(v) => ops.patch(node.id, "alias" in v ? { heightVar: v } : { heightVar: undefined, height: Number(v.value) || 0 })} suffix={sizingMenu("V")} />
        ) : (
          <NumericInput label="Height" prefix="H" value={Math.round(node.height)} min={0} onChange={(height) => ops.patch(node.id, { height, ...(node.lockAspect && node.height ? { width: Math.round((height * node.width) / node.height), sizingH: undefined } : {}), sizingV: undefined, ...(text ? { textAutoResize: "none" } : {}) } as Partial<SceneNode>)} suffix={sizingMenu("V")} />
        )}
      </PropRow>
      {hasLimits && (
        <>
          <PropRow icons={<span className="w-6" />}>
            <NumericInput label="Min width" prefix={<Prefix>{fi("al.width-min")}</Prefix>} value={node.minWidth ?? null} placeholder="Min W" fallback={0} min={0} onChange={(minWidth) => ops.patch(node.id, { minWidth })} onClear={() => ops.patch(node.id, { minWidth: undefined })} suffix={limitMenu("minWidth")} />
            <NumericInput label="Min height" prefix={<Prefix>{fi("al.height-min")}</Prefix>} value={node.minHeight ?? null} placeholder="Min H" fallback={0} min={0} onChange={(minHeight) => ops.patch(node.id, { minHeight })} onClear={() => ops.patch(node.id, { minHeight: undefined })} suffix={limitMenu("minHeight")} />
          </PropRow>
          <PropRow icons={<span className="w-6" />}>
            <NumericInput label="Max width" prefix={<Prefix>{fi("al.width-max")}</Prefix>} value={node.maxWidth ?? null} placeholder="Max W" fallback={Math.round(node.width)} min={0} onChange={(maxWidth) => ops.patch(node.id, { maxWidth })} onClear={() => ops.patch(node.id, { maxWidth: undefined })} suffix={limitMenu("maxWidth")} />
            <NumericInput label="Max height" prefix={<Prefix>{fi("al.height-max")}</Prefix>} value={node.maxHeight ?? null} placeholder="Max H" fallback={Math.round(node.height)} min={0} onChange={(maxHeight) => ops.patch(node.id, { maxHeight })} onClear={() => ops.patch(node.id, { maxHeight: undefined })} suffix={limitMenu("maxHeight")} />
          </PropRow>
        </>
      )}
      {frame && auto && (
        <>
          <PropRow icons={<IconButton label="Advanced layout" icon={fi("24.adjust.small")} active={Boolean(frame.strokesInLayout || frame.firstOnTop || frame.baselineAlign)} onClick={(e) => advancedMenu(e.currentTarget)} />}>
            {/* Figma's two equal columns, whatever the panel's width: the alignment box — the grid's box, in a grid — filling the first, the gap field(s) filling the second, in line with the W and H fields. */}
            <div className="flex flex-1 min-w-0">
              {frame.layoutMode === "grid" ? (
                <GridBox frame={frame} ops={ops} onSettings={advancedMenu} />
              ) : (
                <AlignGrid frame={frame} onChange={(primaryAlign, counterAlign) => ops.patch(frame.id, { primaryAlign, counterAlign })} />
              )}
            </div>
            <div className="flex flex-1 min-w-0 flex-col gap-2 self-start">
              {frame.layoutMode === "grid" ? (
                <>
                  <BoundNumber label="Column gap" prefix={<Prefix>{fi("al.spacing-horizontal")}</Prefix>} value={frame.itemSpacing} variables={variables} byId={byId} mode={mode} onChange={(itemSpacing) => ops.patch(frame.id, { itemSpacing })} />
                  <BoundNumber label="Row gap" prefix={<Prefix>{fi("al.spacing-vertical")}</Prefix>} value={frame.counterSpacing ?? frame.itemSpacing} variables={variables} byId={byId} mode={mode} onChange={(counterSpacing) => ops.patch(frame.id, { counterSpacing })} />
                </>
              ) : (
                <>
                  {frame.primaryAlign === "spaceBetween" ? (
                    // Space between: the gap reads "Auto" (Figma's); a number typed turns it fixed again.
                    <NumericInput label={gapLabel} onFocusChange={focusGap} prefix={gapPrefix} value={null} placeholder="Auto" fallback={numberOf(frame.itemSpacing, byId)} min={0} onChange={(gap) => ops.patch(frame.id, { itemSpacing: own(gap), primaryAlign: "min" })} suffix={gapMode} />
                  ) : (
                    <BoundNumber label={gapLabel} onFocusChange={focusGap} prefix={gapPrefix} value={frame.itemSpacing} variables={variables} byId={byId} mode={mode} onChange={(itemSpacing) => ops.patch(frame.id, { itemSpacing })} suffix={gapMode} variableMenu />
                  )}
                  {frame.layoutWrap && frame.layoutMode === "horizontal" && (
                    <BoundNumber label="Vertical gap" onFocusChange={focusGap} prefix={<Prefix>{fi("al.spacing-vertical")}</Prefix>} value={frame.counterSpacing ?? frame.itemSpacing} variables={variables} byId={byId} mode={mode} onChange={(counterSpacing) => ops.patch(frame.id, { counterSpacing })} suffix={<ChevronMenu label="Vertical gap mode" items={[{ label: "Same as horizontal gap", checked: !frame.counterSpacing, onSelect: () => ops.patch(frame.id, { counterSpacing: undefined }) }, { label: "Separate", checked: Boolean(frame.counterSpacing), onSelect: () => ops.patch(frame.id, { counterSpacing: frame.itemSpacing }) }]} />} />
                  )}
                </>
              )}
            </div>
          </PropRow>
          <PropRow icons={<IconButton label="Individual padding" icon={fi("al.padding-sides")} active={sides} onClick={() => setSides((s) => !s)} />}>
            {sides ? (
              <BoundNumber label="Left padding" onFocusChange={focusPads(["left"])} prefix={<Prefix>{fi("al.padding-left")}</Prefix>} value={frame.paddingLeft} variables={variables} byId={byId} mode={mode} onChange={(paddingLeft) => ops.patch(frame.id, { paddingLeft })} />
            ) : (
              // Two sides apart: Figma writes both ("4, 10"); a number typed sets them alike.
              numberOf(frame.paddingLeft, byId) !== numberOf(frame.paddingRight, byId) ? (
                <NumericInput label="Horizontal padding" onFocusChange={focusPads(["left", "right"])} prefix={<Prefix>{fi("al.padding-horizontal")}</Prefix>} value={null} placeholder={`${numberOf(frame.paddingLeft, byId)}, ${numberOf(frame.paddingRight, byId)}`} fallback={numberOf(frame.paddingLeft, byId)} min={0} onChange={(v) => ops.patch(frame.id, { paddingLeft: own(v), paddingRight: own(v) })} />
              ) : (
                <BoundNumber label="Horizontal padding" onFocusChange={focusPads(["left", "right"])} prefix={<Prefix>{fi("al.padding-horizontal")}</Prefix>} value={frame.paddingLeft} variables={variables} byId={byId} mode={mode} onChange={(v) => ops.patch(frame.id, { paddingLeft: v, paddingRight: v })} />
              )
            )}
            {sides ? (
              <BoundNumber label="Top padding" onFocusChange={focusPads(["top"])} prefix={<Prefix>{fi("al.padding-top")}</Prefix>} value={frame.paddingTop} variables={variables} byId={byId} mode={mode} onChange={(paddingTop) => ops.patch(frame.id, { paddingTop })} />
            ) : (
              numberOf(frame.paddingTop, byId) !== numberOf(frame.paddingBottom, byId) ? (
                <NumericInput label="Vertical padding" onFocusChange={focusPads(["top", "bottom"])} prefix={<Prefix>{fi("al.padding-vertical")}</Prefix>} value={null} placeholder={`${numberOf(frame.paddingTop, byId)}, ${numberOf(frame.paddingBottom, byId)}`} fallback={numberOf(frame.paddingTop, byId)} min={0} onChange={(v) => ops.patch(frame.id, { paddingTop: own(v), paddingBottom: own(v) })} />
              ) : (
                <BoundNumber label="Vertical padding" onFocusChange={focusPads(["top", "bottom"])} prefix={<Prefix>{fi("al.padding-vertical")}</Prefix>} value={frame.paddingTop} variables={variables} byId={byId} mode={mode} onChange={(v) => ops.patch(frame.id, { paddingTop: v, paddingBottom: v })} />
              )
            )}
          </PropRow>
          {sides && (
            <PropRow icons={<span className="w-6" />}>
              <BoundNumber label="Right padding" onFocusChange={focusPads(["right"])} prefix={<Prefix>{fi("al.padding-right")}</Prefix>} value={frame.paddingRight} variables={variables} byId={byId} mode={mode} onChange={(paddingRight) => ops.patch(frame.id, { paddingRight })} />
              <BoundNumber label="Bottom padding" onFocusChange={focusPads(["bottom"])} prefix={<Prefix>{fi("al.padding-bottom")}</Prefix>} value={frame.paddingBottom} variables={variables} byId={byId} mode={mode} onChange={(paddingBottom) => ops.patch(frame.id, { paddingBottom })} />
            </PropRow>
          )}
        </>
      )}
      {frame && (
        <div className="pl-4 pr-10 py-2">
          <Checkbox label="Clip content" checked={Boolean(frame.clipsContent)} onChange={(clipsContent) => ops.patch(frame.id, { clipsContent })} />
        </div>
      )}
      {/* On the site's narrower screens (see the Page Editor's Tablet / Phone): its layers as they are, stacked, or in two columns. */}
      {frame && frame.layoutMode !== "none" && frame.type !== "componentSet" && (
        <PropRow icons={<span className="w-6" />}>
          <Select
            label="On narrow screens"
            value={frame.narrow ?? ""}
            options={[
              { value: "", label: "Narrow screens: as it is" },
              { value: "stack", label: "Stack under 768px (tablet)" },
              { value: "stack-sm", label: "Stack under 640px (phone)" },
              { value: "two", label: "Two columns under 640px" },
            ]}
            onChange={(narrow) => ops.patch(frame.id, { narrow: (narrow || undefined) as FrameNode["narrow"] } as Partial<SceneNode>)}
          />
        </PropRow>
      )}
    </Section>
  );
}

/** The alignment grid's cells named as Figma's ("Top left", "Center", "Bottom right"). */
function alignCellLabel(row: FrameNode["counterAlign"], col: FrameNode["counterAlign"]) {
  const v = row === "min" ? "Top" : row === "max" ? "Bottom" : "";
  const h = col === "min" ? "left" : col === "max" ? "right" : "";
  if (!v && !h) return "Center";
  if (!v) return h === "left" ? "Left" : "Right";
  return h ? `${v} ${h}` : `${v} center`;
}

function AlignGrid({ frame, onChange }: { frame: FrameNode; onChange: (primary: FrameNode["primaryAlign"], counter: FrameNode["counterAlign"]) => void }) {
  const horizontal = frame.layoutMode === "horizontal";
  const cells: FrameNode["counterAlign"][] = ["min", "center", "max"];
  const glyph = (counter: FrameNode["counterAlign"]): FigmaIconName => {
    // A wrapping row's glyphs are named by their side (left / center / right), a row's by top / center / bottom, a column's by left / center / right.
    const wrap = Boolean(frame.layoutWrap) && horizontal;
    const where = counter === "min" ? (horizontal && !wrap ? "top" : "left") : counter === "center" ? "center" : horizontal && !wrap ? "bottom" : "right";
    return `16.alg.${wrap ? "wrap" : horizontal ? "horizontal" : "vertical"}.${where}` as FigmaIconName;
  };
  return (
    <div className="grid grid-cols-3 w-full min-w-0 h-[64px] px-1 py-2 rounded-[5px] bg-[var(--f-bg-secondary)] border border-transparent focus-within:border-[var(--f-border-selected)]">
      {cells.map((row) =>
        cells.map((col) => {
          const primary = horizontal ? col : row;
          const counter = horizontal ? row : col;
          // Space between ("Auto" gap): the three cells along the flow light up as bars, as Figma draws them.
          const spaced = frame.primaryAlign === "spaceBetween";
          const active = spaced ? frame.counterAlign === counter : frame.primaryAlign === primary && frame.counterAlign === counter;
          return (
            <button key={`${row}${col}`} type="button" aria-label={alignCellLabel(row, col)} aria-pressed={active} onClick={() => onChange(frame.primaryAlign === "spaceBetween" ? "spaceBetween" : primary, counter)} className={cn("flex items-center justify-center cursor-pointer", active ? "text-[var(--f-text-brand)]" : "text-[var(--f-icon-tertiary)] hover:text-[var(--f-icon)]")}>
              {active ? (spaced ? <span className={cn("rounded-full bg-current", horizontal ? "w-[2px]" : "h-[2px]")} style={horizontal ? { height: primary === "center" ? 6 : 12 } : { width: primary === "center" ? 6 : 12 }} /> : fi(glyph(counter))) : fi("16.autolayoutgrid.dot")}
            </button>
          );
        })
      )}
    </div>
  );
}

/**
 * A grid's box, as Figma's: "8 × 3" over a sketch of its cells; a click
 * opens the picker — columns × rows (rows "Auto" when unset), the 12 × 8
 * cells to sweep a size from, "Open grid settings".
 */
function GridBox({ frame, ops, onSettings }: { frame: FrameNode; ops: EditorOps; onSettings: (el: HTMLElement) => void }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  const cols = Math.max(1, frame.gridColumns ?? 2);
  const rows = frame.gridRows;
  const set = (c: number, r?: number) => ops.patch(frame.id, { gridColumns: Math.max(1, Math.round(c)), gridRows: r && r > 0 ? Math.round(r) : undefined });
  const litC = hover?.c ?? cols;
  const litR = hover?.r ?? rows ?? 1;
  const sketchC = Math.min(cols, 12);
  const sketchR = Math.min(rows ?? 1, 8);
  return (
    <div ref={box} className="relative flex-1 min-w-0">
      <button type="button" aria-label="Grid size" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn("relative flex w-full h-[64px] items-center justify-center overflow-hidden rounded-[5px] bg-[var(--f-bg-secondary)] border cursor-pointer", open ? "border-[var(--f-border-selected)]" : "border-transparent hover:border-[var(--f-border)]")}>
        <span aria-hidden className="absolute inset-1 grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${sketchC}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${sketchR}, minmax(0, 1fr))` }}>
          {Array.from({ length: sketchC * sketchR }).map((_, i) => <span key={i} className="rounded-[2px] border border-[var(--f-border)]" />)}
        </span>
        <span className="relative px-1 rounded-[3px] text-[11px] leading-4 text-[var(--f-text)] bg-[var(--f-bg-secondary)]">{cols} × {rows ?? "Auto"}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-[68px] z-40 flex w-[224px] flex-col gap-2 p-2 rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_10px_16px_rgba(0,0,0,0.2)]" onPointerDown={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            <NumericInput label="Columns" prefix={<Prefix>{fi("grid-column")}</Prefix>} value={cols} min={1} max={12} onChange={(c) => set(c, rows)} />
            <span className="shrink-0 px-0.5 text-[11px] text-[var(--f-text-secondary)]">×</span>
            <NumericInput label="Rows" prefix={<Prefix>{fi("grid-row")}</Prefix>} value={rows ?? null} placeholder="Auto" fallback={1} min={1} max={8} onChange={(r) => set(cols, r)} onClear={() => set(cols, undefined)} suffix={<ChevronMenu label="Rows mode" items={[{ label: "Auto", checked: !rows, onSelect: () => set(cols, undefined) }, { label: "Fixed", checked: Boolean(rows), onSelect: () => set(cols, rows ?? 1) }]} />} />
          </div>
          <div className="relative">
            <div className="grid grid-cols-12 gap-[3px]" onMouseLeave={() => setHover(null)}>
              {Array.from({ length: 96 }).map((_, i) => {
                const c = (i % 12) + 1;
                const r = Math.floor(i / 12) + 1;
                const lit = c <= litC && r <= litR;
                return <button key={i} type="button" aria-label={`${c} × ${r}`} onMouseEnter={() => setHover({ c, r })} onClick={() => { set(c, r); setOpen(false); }} className={cn("aspect-square rounded-[2px] cursor-pointer", lit ? "bg-[var(--f-bg-selected)] shadow-[inset_0_0_0_1px_var(--f-border-selected)]" : "bg-[var(--f-bg-secondary)] hover:bg-[var(--f-bg-hover)]")} />;
              })}
            </div>
            {hover && <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 -bottom-1 translate-y-full px-2 py-1 rounded-[5px] bg-[var(--f-bg-menu)] text-[11px] leading-4 text-white">{hover.c} × {hover.r}</span>}
          </div>
          <button type="button" onClick={(e) => { setOpen(false); onSettings(e.currentTarget); }} className="flex h-8 items-center justify-center rounded-[5px] border border-[var(--f-border)] text-[11px] text-[var(--f-text)] hover:bg-[var(--f-bg-hover)] cursor-pointer">Open grid settings</button>
        </div>
      )}
    </div>
  );
}

function AppearanceSection({ node, nodes, ops, variables, byId, mode }: { node: SceneNode; nodes: SceneNode[]; ops: EditorOps; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode }) {
  const geo = node.type !== "text" ? node : null;
  const [independent, setIndependent] = useState(Boolean(geo?.corners));
  const rounded = geo && node.type !== "ellipse" && node.type !== "line";
  // Inside a main component: its visibility can follow a boolean property (Figma's "Apply boolean property").
  const holder = node.type === "component" || node.type === "componentSet" ? null : componentAround(nodes, node.id)?.holder ?? null;
  const booleans = holder?.properties?.filter((p) => p.type === "boolean") ?? [];
  const bound = node.visibleProp ? booleans.find((p) => p.id === node.visibleProp) : undefined;
  const createBoolean = () => {
    if (!holder) return;
    const id = nid("p");
    ops.setComponentProperties(holder.id, [...(holder.properties ?? []), { id, name: freePropertyName(holder, node.name), type: "boolean", value: node.visible !== false }]);
    ops.bindProperty(node.id, "visible", id);
  };
  return (
    <Section
      title="Appearance"
      pb={12}
      icons={
        <>
          <IconButton label="Blend mode" icon={fi(node.blendMode && node.blendMode !== "pass-through" ? "blendmode.active.small" : "blendmode.small")} active={Boolean(node.blendMode && node.blendMode !== "pass-through")} onClick={(e) => ops.menu(e.currentTarget, BLEND_MODES.map((b) => ({ label: b.label, checked: (node.blendMode ?? "pass-through") === b.value, onSelect: () => ops.patch(node.id, { blendMode: b.value === "pass-through" ? undefined : b.value }) })))} />
          {holder && (
            <IconButton label="Apply boolean property" icon={fi("24.boolean.small")} active={Boolean(bound)} onClick={(e) => ops.menu(e.currentTarget, [
              ...booleans.map((p) => ({ label: p.name, icon: fi("24.boolean.small", 16), checked: p.id === node.visibleProp, onSelect: () => ops.bindProperty(node.id, "visible", p.id) })),
              ...(booleans.length ? ["-" as const] : []),
              { label: "Create property", onSelect: createBoolean },
              ...(bound ? [{ label: "Detach property", onSelect: () => ops.bindProperty(node.id, "visible", undefined) }] : []),
            ])} />
          )}
          <IconButton label={node.visible === false ? "Show" : "Hide"} icon={fi(node.visible === false ? "hidden.small" : "eye.small")} onClick={() => (bound && holder ? ops.setPropertyValue(holder.id, bound.id, node.visible === false) : ops.patch(node.id, { visible: node.visible === false ? undefined : false }))} />
        </>
      }
    >
      {bound && (
        <div className="flex items-center gap-2 pl-4 pr-3 pb-1">
          <span className="flex flex-1 items-center gap-1 h-6 px-1 rounded-[5px] bg-[var(--f-bg-secondary)] text-[11px] text-[var(--f-text-component)]">{fi("24.boolean.small", 16)}<span className="truncate">{bound.name}</span></span>
          <IconButton label="Detach property" icon={fi("detach.small")} onClick={() => ops.bindProperty(node.id, "visible", undefined)} />
        </div>
      )}
      <PropRow icons={rounded ? <IconButton label="Individual corners" icon={fi("corners.independent")} active={independent} onClick={() => setIndependent((v) => !v)} /> : <span className="w-6" />}>
        <NumericInput label="Opacity" prefix={<Prefix>{fi("opacity")}</Prefix>} value={node.opacity ?? 100} min={0} max={100} unit="%" onChange={(opacity) => ops.patch(node.id, { opacity: opacity >= 100 ? undefined : opacity })} />
        {rounded ? (
          <BoundNumber label="Corner radius" prefix={<Prefix>{fi("corners")}</Prefix>} value={geo!.cornerRadius} variables={variables} byId={byId} mode={mode} min={0} onChange={(cornerRadius) => ops.patch(node.id, { cornerRadius, corners: undefined } as Partial<SceneNode>)} />
        ) : (
          <span className="flex-1" />
        )}
      </PropRow>
      {rounded && independent && (
        <>
          <PropRow icons={<span className="w-6" />}>
            {([0, 1] as const).map((i) => <CornerField key={i} geo={geo!} index={i} node={node} ops={ops} variables={variables} byId={byId} mode={mode} />)}
          </PropRow>
          <PropRow icons={<span className="w-6" />}>
            {([3, 2] as const).map((i) => <CornerField key={i} geo={geo!} index={i} node={node} ops={ops} variables={variables} byId={byId} mode={mode} />)}
          </PropRow>
        </>
      )}
    </Section>
  );
}

function CornerField({ geo, index, node, ops, variables, byId, mode }: { geo: FrameNode | (SceneNode & { type: "rectangle" | "ellipse" | "line" }); index: 0 | 1 | 2 | 3; node: SceneNode; ops: EditorOps; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode }) {
  const base = geo.cornerRadius ?? own(0);
  const corners = geo.corners ?? [base, base, base, base];
  const icons = ["radius.top.left", "radius.top.right", "radius.bottom.right", "radius.bottom.left"] as const;
  const labels = ["Top left radius", "Top right radius", "Bottom right radius", "Bottom left radius"] as const;
  return (
    <BoundNumber
      label={labels[index]}
      prefix={<Prefix>{fi(icons[index])}</Prefix>}
      value={corners[index]}
      variables={variables}
      byId={byId}
      mode={mode}
      min={0}
      onChange={(v) => {
        const next = [...corners] as [VariableValue, VariableValue, VariableValue, VariableValue];
        next[index] = v;
        ops.patch(node.id, { corners: next } as Partial<SceneNode>);
      }}
    />
  );
}

/**
 * A section's styles button (Figma's four squares): the colour variables —
 * the Libraries tab of the colour picker — picked onto its first paint (a
 * new one when there is none: `onPut` makes it).
 */
function LibrariesButton({ first, variables, byId, mode, ops, onPut }: { first?: Paint | StrokeStyle; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode; ops: EditorOps; onPut: (paint: { color: VariableValue; opacity?: number }) => void }) {
  const [libraries, setLibraries] = useState<{ top: number; right: number } | null>(null);
  const resolved = first ? String(boundValue(first.color, mode, byId) ?? "#000000") : "#d9d9d9";
  return (
    <span data-picker-anchor="" className="relative flex">
      <IconButton label="Styles and variables" icon={fi("styles")} active={Boolean(libraries)} onClick={(e) => setLibraries(libraries ? null : anchorOf(e.currentTarget))} />
      {libraries && (
        <ColorPicker
          initialTab="libraries"
          color={resolved}
          opacity={first?.opacity ?? 100}
          anchor={libraries}
          variables={variables}
          byId={byId}
          mode={mode}
          pageColors={ops.pageColors}
          selectedId={first && "alias" in first.color ? first.color.alias : undefined}
          onChange={(hex, opacity) => onPut({ color: own(hex), opacity: opacity >= 100 ? undefined : opacity })}
          onVariable={(color) => onPut({ color })}
          onClose={() => setLibraries(null)}
        />
      )}
    </span>
  );
}

/** Several layers selected whose list (fills, strokes, effects) differs: Figma's "Mixed" — "+" puts one new entry on all of them. */
function MixedRow({ what }: { what: string }) {
  return <p className="px-4 pb-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">Mixed {what} — click + to replace them on every selected layer.</p>;
}

function FillSection({ node, ops, variables, byId, mode, compositeId, mixed = false }: { node: SceneNode; ops: EditorOps; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode; compositeId?: string; mixed?: boolean }) {
  const fills = mixed ? [] : node.fills ?? [];
  const setFills = (next: Paint[]) => (compositeId ? ops.override(compositeId, { fills: next }) : ops.patch(node.id, { fills: next } as Partial<SceneNode>));
  const first = fills[0];
  const putFirst = (paint: { color: VariableValue; opacity?: number }) => setFills(first ? [{ ...first, ...paint }, ...fills.slice(1)] : [paint]);
  return (
    <Section title="Fill" muted={fills.length === 0 && !mixed} pb={fills.length || mixed ? 12 : 0} icons={<>
      {!mixed && <LibrariesButton first={first} variables={variables} byId={byId} mode={mode} ops={ops} onPut={putFirst} />}
      <IconButton label="Add fill" icon={fi("plus.small")} onClick={() => setFills([{ color: { alias: node.type === "text" ? "text-title" : "bg-5" } }, ...fills])} />
    </>}>
      {mixed && <MixedRow what="fills" />}
      {fills.map((paint, i) => (
        <PaintRow key={i} paint={paint} variables={variables} byId={byId} mode={mode} pageColors={ops.pageColors} ops={ops} onChange={(p) => setFills(fills.map((f, j) => (j === i ? p : f)))} onRemove={() => setFills(fills.filter((_, j) => j !== i))} />
      ))}
    </Section>
  );
}

function StrokeSection({ node, ops, variables, byId, mode, compositeId, mixed = false }: { node: FrameNode | (SceneNode & { type: "rectangle" | "ellipse" | "line" }); ops: EditorOps; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode; compositeId?: string; mixed?: boolean }) {
  const strokes = mixed ? [] : node.strokes ?? [];
  const setStrokes = (next: StrokeStyle[]) => (compositeId ? ops.override(compositeId, { strokes: next }) : ops.patch(node.id, { strokes: next } as Partial<SceneNode>));
  // The styles button, as the fill's: onto the first stroke — a new 1px inside one when there is none.
  const putFirst = (paint: { color: VariableValue; opacity?: number }) =>
    setStrokes(strokes[0] ? [{ ...strokes[0], ...paint }, ...strokes.slice(1)] : [{ weight: own(1), align: "inside", ...paint }]);
  return (
    <Section title="Stroke" muted={strokes.length === 0 && !mixed} pb={strokes.length || mixed ? 12 : 0} icons={<>
      {!mixed && <LibrariesButton first={strokes[0]} variables={variables} byId={byId} mode={mode} ops={ops} onPut={putFirst} />}
      <IconButton label="Add stroke" icon={fi("plus.small")} onClick={() => setStrokes([{ color: { alias: "border-hover" }, weight: own(1), align: "inside" }, ...strokes])} />
    </>}>
      {mixed && <MixedRow what="strokes" />}
      {strokes.map((stroke, i) => (
        <div key={i} className="flex flex-col">
          <PaintRow paint={stroke} variables={variables} byId={byId} mode={mode} pageColors={ops.pageColors} ops={ops} onChange={(s) => setStrokes(strokes.map((x, j) => (j === i ? s : x)))} onRemove={() => setStrokes(strokes.filter((_, j) => j !== i))} />
          <PropRow icons={<span className="w-6" />}>
            <Select label="Position" value={stroke.align} options={[{ value: "inside", label: "Inside" }, { value: "center", label: "Center" }, { value: "outside", label: "Outside" }]} onChange={(align) => setStrokes(strokes.map((x, j) => (j === i ? { ...x, align: align as StrokeStyle["align"] } : x)))} />
            <BoundNumber label="Stroke weight" prefix={<Prefix>{fi("stroke-weight")}</Prefix>} value={stroke.weight} variables={variables} byId={byId} mode={mode} min={0} onChange={(weight) => setStrokes(strokes.map((x, j) => (j === i ? { ...x, weight } : x)))} />
          </PropRow>
          {node.type !== "line" && (
            <PropRow icons={<span className="w-6" />}>
              <Select label="Stroke style" value={stroke.dashed ? "dashed" : "solid"} options={[{ value: "solid", label: "Solid" }, { value: "dashed", label: "Dashed" }]} onChange={(v) => setStrokes(strokes.map((x, j) => (j === i ? { ...x, dashed: v === "dashed" ? true : undefined } : x)))} />
              <div className="flex flex-1 items-center h-6 rounded-[5px] bg-[var(--f-bg-secondary)]">
                {(["top", "right", "bottom", "left"] as const).map((side) => {
                  const sides = stroke.sides ?? { top: true, right: true, bottom: true, left: true };
                  const toggle = () => { const next = { ...sides, [side]: !sides[side] }; const all = next.top && next.right && next.bottom && next.left; setStrokes(strokes.map((x, j) => (j === i ? { ...x, sides: all ? undefined : next } : x))); };
                  return <IconButton key={side} label={{ top: "Top", right: "Right", bottom: "Bottom", left: "Left" }[side]} icon={fi(`al.padding-${side}` as FigmaIconName)} active={sides[side]} onClick={toggle} className="flex-1" />;
                })}
              </div>
            </PropRow>
          )}
        </div>
      ))}
    </Section>
  );
}

function EffectsSection({ node, ops, pageColors, mixed = false }: { node: FrameNode | (SceneNode & { type: "rectangle" | "ellipse" | "line" }); ops: EditorOps; pageColors: string[]; mixed?: boolean }) {
  const effects = mixed ? [] : node.effects ?? [];
  const [editing, setEditing] = useState<{ index: number; anchor: { top: number; right: number } } | null>(null);
  const set = (next: Effect[]) => ops.patch(node.id, { effects: next } as Partial<SceneNode>);
  const add = (el: HTMLElement) =>
    ops.menu(el, (["innerShadow", "dropShadow", "layerBlur", "backgroundBlur"] as Effect["type"][]).map((type) => ({ label: EFFECT_LABEL[type], onSelect: () => set([...effects, newEffect(type)]) })));
  const current = editing ? effects[editing.index] : null;
  const style = node.effectStyle ? ops.effectStyles.find((st) => st.id === node.effectStyle) : null;
  const stylesMenu = (el: HTMLElement) =>
    ops.menu(el, [
      ...ops.effectStyles.map((st) => ({ label: st.name, checked: st.id === node.effectStyle, onSelect: () => ops.applyEffectStyle(node.id, st.id) })),
      ...(ops.effectStyles.length ? ["-" as const] : []),
      { label: "Create effect style", disabled: !effects.length, onSelect: () => ops.createEffectStyle(node.id) },
      ...(node.effectStyle ? [{ label: "Detach style", onSelect: () => ops.detachEffectStyle(node.id) }] : []),
    ]);
  return (
    <Section title="Effects" muted={effects.length === 0 && !style && !mixed} pb={effects.length || style || mixed ? 12 : 0} icons={<><IconButton label="Effect styles" icon={fi("styles")} active={Boolean(style)} onClick={(e) => stylesMenu(e.currentTarget)} /><IconButton label="Add effect" icon={fi("plus.small")} onClick={(e) => add(e.currentTarget)} /></>}>
      {mixed && <MixedRow what="effects" />}
      {style && (
        <PropRow icons={<IconButton label="Detach style" icon={fi("detach.small")} onClick={() => ops.detachEffectStyle(node.id)} />}>
          <button type="button" onClick={(e) => stylesMenu(e.currentTarget)} className="flex flex-1 min-w-0 items-center gap-1 h-6 px-1 rounded-[5px] bg-[var(--f-bg-secondary)] text-left cursor-pointer">
            <span className="flex w-4 h-4 shrink-0 items-center justify-center overflow-hidden">{fi("24.effects.small", 16, "-m-1")}</span>
            <span className="truncate text-[11px] text-[var(--f-text)]">{style.name}</span>
          </button>
        </PropRow>
      )}
      {!style && effects.map((e, i) => (
        <PropRow key={i} icons={<><IconButton label={e.visible === false ? "Show" : "Hide"} icon={fi(e.visible === false ? "hidden.small" : "eye.small")} onClick={() => set(effects.map((x, j) => (j === i ? { ...x, visible: x.visible === false ? undefined : false } : x)))} /><IconButton label="Remove" icon={fi("minus.small")} onClick={() => { setEditing(null); set(effects.filter((_, j) => j !== i)); }} /></>}>
          <button type="button" data-picker-anchor="" onClick={(ev) => setEditing(editing?.index === i ? null : { index: i, anchor: anchorOf(ev.currentTarget) })} className={cn("flex flex-1 min-w-0 items-center gap-1 h-6 px-1 rounded-[5px] text-left cursor-pointer", editing?.index === i ? "bg-[var(--f-bg-selected)] text-[var(--f-text-brand)]" : "bg-[var(--f-bg-secondary)] text-[var(--f-text)]")}>
            <span className="flex w-4 h-4 shrink-0 items-center justify-center overflow-hidden"><EffectGlyph type={e.type} /></span>
            <span className="truncate text-[11px]">{EFFECT_LABEL[e.type]}</span>
          </button>
        </PropRow>
      ))}
      {editing && current && (
        <EffectPopover effect={current} anchor={editing.anchor} pageColors={pageColors} onChange={(next) => set(effects.map((x, j) => (j === editing.index ? next : x)))} onClose={() => setEditing(null)} />
      )}
    </Section>
  );
}

function EffectGlyph({ type }: { type: Effect["type"] }) {
  return fi(type === "dropShadow" ? "24.drop.shadow.mid.small" : type === "innerShadow" ? "24.inner.shadow.top.left.small" : type === "layerBlur" ? "24.layer.blur.small" : "24.background.blur.small", 16, "-m-1");
}

/** Figma's effect window beside the panel: the effect's kind under a chevron, its values in labelled rows. */
function EffectPopover({ effect, anchor, pageColors, onChange, onClose }: { effect: Effect; anchor: { top: number; right: number }; pageColors: string[]; onChange: (effect: Effect) => void; onClose: () => void }) {
  const [picker, setPicker] = useState<{ top: number; right: number } | null>(null);
  const top = Math.max(8, Math.min(anchor.top - 12, window.innerHeight - 360));
  const left = Math.max(8, anchor.right - 320 - 8);
  const shadow = effect.type === "dropShadow" || effect.type === "innerShadow" ? effect : null;
  const blur = effect.type === "layerBlur" || effect.type === "backgroundBlur" ? effect : null;
  const row = (label: string, field: ReactNode) => (
    <div className="flex items-center gap-2 h-8 px-4">
      <span className="w-[100px] shrink-0 text-[11px] text-[var(--f-text-secondary)]">{label}</span>
      <div className="flex flex-1 min-w-0 items-center gap-2">{field}</div>
    </div>
  );
  return (
    <div role="dialog" aria-label={EFFECT_LABEL[effect.type]} className="fixed z-40 flex w-[320px] flex-col rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_10px_16px_rgba(0,0,0,0.2)] text-[11px] leading-4 text-[var(--f-text)]" style={{ top, left }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between h-12 pl-4 pr-2 border-b border-[var(--f-border)]">
        <ChevronMenu label="Effect type" width={200} items={(Object.keys(EFFECT_LABEL) as Effect["type"][]).map((t) => ({ label: EFFECT_LABEL[t], checked: t === effect.type, onSelect: () => onChange(t === effect.type ? effect : { ...newEffect(t), visible: effect.visible }) }))}>
          <span className="flex items-center gap-2"><span className="flex w-4 h-4 items-center justify-center overflow-hidden"><EffectGlyph type={effect.type} /></span><span className="text-[13px] font-[550] leading-[22px]">{EFFECT_LABEL[effect.type]}</span></span>
        </ChevronMenu>
        <div className="flex items-center gap-2">
          <IconButton label="Close" icon={fi("close.small")} onClick={onClose} />
        </div>
      </div>
      <div className="flex flex-col py-2">
        {shadow ? (
          <>
            {row("Position", <><NumericInput label="X" prefix="X" value={shadow.x} onChange={(x) => onChange({ ...shadow, x })} /><NumericInput label="Y" prefix="Y" value={shadow.y} onChange={(y) => onChange({ ...shadow, y })} /></>)}
            {row("Blur", <NumericInput label="Blur" prefix={<Prefix>{fi("opacity")}</Prefix>} value={shadow.blur} min={0} onChange={(blur) => onChange({ ...shadow, blur })} />)}
            {row("Spread", <NumericInput label="Spread" prefix={<Prefix>{fi("24.spread.small")}</Prefix>} value={shadow.spread} onChange={(spread) => onChange({ ...shadow, spread })} />)}
            {row("Color", (
              <div className="relative flex flex-1">
                <ColorInput label="Shadow color" color={shadow.color} opacity={shadow.opacity} onColor={(color) => onChange({ ...shadow, color })} onOpacity={(opacity) => onChange({ ...shadow, opacity })} chit={<button type="button" data-picker-anchor="" aria-label="Color picker" onClick={(e) => setPicker(picker ? null : anchorOf(e.currentTarget))} className="cursor-pointer"><Chit color={shadow.color} /></button>} />
                {picker && <ColorPicker color={shadow.color} opacity={shadow.opacity} anchor={{ top: picker.top, right: left - 4 }} variables={[]} byId={new Map()} mode="light" pageColors={pageColors} onChange={(color, opacity) => onChange({ ...shadow, color, opacity })} onClose={() => setPicker(null)} />}
              </div>
            ))}
          </>
        ) : blur ? (
          row("Blur", <NumericInput label="Blur" prefix={<Prefix>{fi("opacity")}</Prefix>} value={blur.radius} min={0} onChange={(radius) => onChange({ ...blur, radius })} />)
        ) : null}
      </div>
    </div>
  );
}

function TextSection({ node, nodes, ops, variables, byId, mode, textStyles, lang, compositeId, multi = false }: { node: TextNode; nodes: SceneNode[]; ops: EditorOps; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode; textStyles: TextStyle[]; lang: LangCode; compositeId?: string; /** Several texts selected: their words stay each one's own */ multi?: boolean }) {
  const weights = [300, 400, 500, 600, 700];
  const text = wordsIn(node, lang) ?? "";
  // In a text style its typography is the style's: shown as the style's, and — as Figma's — changing any of it detaches the text from the
  // style, the style's values its own first (so only what was changed changes). Detach style keeps the style's look the same way.
  const style = node.textStyle ? textStyles.find((st) => st.id === node.textStyle) : undefined;
  const typo = style
    ? { fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing }
    : { fontSize: node.fontSize, fontWeight: node.fontWeight, lineHeight: node.lineHeight, letterSpacing: node.letterSpacing };
  const setTypo = (p: Partial<TextNode>) => ops.patch(node.id, (style ? { textStyle: undefined, ...typo, ...p } : p) as Partial<SceneNode>);
  const detachStyle = () => ops.patch(node.id, { textStyle: undefined, ...typo } as Partial<SceneNode>);
  // Inside a main component: its words can come from a text property (Figma's "Apply text property") — typing then sets the property's default.
  const holder = compositeId ? null : componentAround(nodes, node.id)?.holder ?? null;
  const texts = holder?.properties?.filter((p) => p.type === "text") ?? [];
  const bound = node.charactersProp ? texts.find((p) => p.id === node.charactersProp) : undefined;
  const setText = (value: string) => {
    if (compositeId) return ops.typeInInstance(compositeId, value, lang);
    if (bound && holder && lang === BASE_LANGUAGE) return ops.setPropertyValue(holder.id, bound.id, value);
    ops.patch(node.id, wordsPatch(node, lang, value) as Partial<SceneNode>);
  };
  const createText = () => {
    if (!holder) return;
    const id = nid("p");
    ops.setComponentProperties(holder.id, [...(holder.properties ?? []), { id, name: freePropertyName(holder, node.name), type: "text", value: node.characters }]);
    ops.bindProperty(node.id, "text", id);
  };
  return (
    <Section title="Typography" pb={12} icons={!compositeId ? <>
      {holder && (
        <IconButton label="Apply text property" icon={fi("24.text")} active={Boolean(bound)} onClick={(e) => ops.menu(e.currentTarget, [
          ...texts.map((p) => ({ label: p.name, icon: fi("24.text", 16), checked: p.id === node.charactersProp, onSelect: () => ops.bindProperty(node.id, "text", p.id) })),
          ...(texts.length ? ["-" as const] : []),
          { label: "Create property", onSelect: createText },
          ...(bound ? [{ label: "Detach property", onSelect: () => ops.bindProperty(node.id, "text", undefined) }] : []),
        ])} />
      )}
      <IconButton label="Text styles" icon={fi("styles")} active={Boolean(node.textStyle)} onClick={(e) => ops.menu(e.currentTarget, [...textStyles.map((st) => ({ label: st.name, checked: st.id === node.textStyle, onSelect: () => ops.patch(node.id, { textStyle: st.id } as Partial<SceneNode>) })), ...(textStyles.length ? ["-" as const] : []), { label: "Create text style", onSelect: () => ops.createTextStyle(node.id) }, ...(node.textStyle ? [{ label: "Detach style", onSelect: detachStyle }] : [])])} />
      <IconButton label="Type settings" icon={fi("24.adjust.small")} active={Boolean(node.textCase || node.textDecoration || node.tag || (node.verticalAlign && node.verticalAlign !== "top"))} onClick={(e) => ops.menu(e.currentTarget, [
        // What it is on the site's page — for search engines and screen readers (its text style's when "Auto").
        { label: "On the site", items: ([["", `Auto${style?.tag ? ` (${TAG_LABEL[style.tag]})` : ""}`], ["h1", TAG_LABEL.h1], ["h2", TAG_LABEL.h2], ["h3", TAG_LABEL.h3], ["h4", TAG_LABEL.h4], ["p", TAG_LABEL.p], ["div", TAG_LABEL.div]] as [string, string][]).map(([tag, label]) => ({ label, checked: (node.tag ?? "") === tag, onSelect: () => ops.patch(node.id, { tag: (tag || undefined) as TextNode["tag"] } as Partial<SceneNode>) })) },
        "-",
        { label: "As typed", checked: !node.textCase, onSelect: () => ops.patch(node.id, { textCase: undefined } as Partial<SceneNode>) },
        { label: "Uppercase", checked: node.textCase === "upper", onSelect: () => ops.patch(node.id, { textCase: "upper" } as Partial<SceneNode>) },
        { label: "Lowercase", checked: node.textCase === "lower", onSelect: () => ops.patch(node.id, { textCase: "lower" } as Partial<SceneNode>) },
        { label: "Title case", checked: node.textCase === "title", onSelect: () => ops.patch(node.id, { textCase: "title" } as Partial<SceneNode>) },
        "-",
        { label: "None", checked: !node.textDecoration, onSelect: () => ops.patch(node.id, { textDecoration: undefined } as Partial<SceneNode>) },
        { label: "Underline", checked: node.textDecoration === "underline", onSelect: () => ops.patch(node.id, { textDecoration: "underline" } as Partial<SceneNode>) },
        { label: "Strikethrough", checked: node.textDecoration === "strikethrough", onSelect: () => ops.patch(node.id, { textDecoration: "strikethrough" } as Partial<SceneNode>) },
        "-",
        { label: "Align top", checked: !node.verticalAlign || node.verticalAlign === "top", disabled: node.textAutoResize !== "none", onSelect: () => ops.patch(node.id, { verticalAlign: undefined } as Partial<SceneNode>) },
        { label: "Align middle", checked: node.verticalAlign === "middle", disabled: node.textAutoResize !== "none", onSelect: () => ops.patch(node.id, { verticalAlign: "middle" } as Partial<SceneNode>) },
        { label: "Align bottom", checked: node.verticalAlign === "bottom", disabled: node.textAutoResize !== "none", onSelect: () => ops.patch(node.id, { verticalAlign: "bottom" } as Partial<SceneNode>) },
      ])} />
    </> : undefined}>
      {bound && (
        <div className="flex items-center gap-2 pl-4 pr-3 pt-1">
          <span className="flex flex-1 items-center gap-1 h-6 px-1 rounded-[5px] bg-[var(--f-bg-secondary)] text-[11px] text-[var(--f-text-component)]">{fi("24.text", 16)}<span className="truncate">{bound.name}</span></span>
          <IconButton label="Detach property" icon={fi("detach.small")} onClick={() => ops.bindProperty(node.id, "text", undefined)} />
        </div>
      )}
      {!multi && <div className="pl-4 pr-3 py-1">
        <textarea aria-label="Text" value={text} placeholder={lang !== BASE_LANGUAGE ? node.characters : "Text"} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} rows={2} className="w-full resize-none rounded-[5px] border border-transparent bg-[var(--f-bg-secondary)] px-2 py-1 text-[11px] leading-4 text-[var(--f-text)] placeholder:text-[var(--f-text-secondary)] [&:hover:not(:focus)]:border-[var(--f-border)] focus:outline-none focus:border-[var(--f-border-selected)]" />
      </div>}
      {!compositeId && (
        <>
          <PropRow icons={<span className="w-6" />}>
            <Select label="Text style" value={node.textStyle ?? ""} options={[{ value: "", label: "Inter" }, ...textStyles.map((s) => ({ value: s.id, label: s.name }))]} onChange={(textStyle) => ops.patch(node.id, { textStyle: textStyle || undefined } as Partial<SceneNode>)} />
          </PropRow>
          <PropRow icons={<span className="w-6" />}>
            <Select label="Font weight" value={String(numberOf(typo.fontWeight, byId, 400))} options={weights.map((w) => ({ value: String(w), label: weightLabel(w) }))} onChange={(w) => setTypo({ fontWeight: own(Number(w)) })} />
            <BoundNumber label="Font size" prefix={<Prefix><span className="text-[10px]">Aa</span></Prefix>} value={typo.fontSize} variables={variables} byId={byId} mode={mode} min={1} onChange={(fontSize) => setTypo({ fontSize })} />
          </PropRow>
          <PropRow icons={<span className="w-6" />}>
            <NumericInput label="Line height" prefix={<Prefix>{fi("al.height-min")}</Prefix>} value={typo.lineHeight ? numberOf(typo.lineHeight, byId) : null} placeholder="Auto" fallback={Math.round(numberOf(typo.fontSize, byId, 16) * 1.25)} min={0} onChange={(v) => setTypo({ lineHeight: own(v) })} onClear={() => setTypo({ lineHeight: undefined })} />
            <NumericInput label="Letter spacing" prefix={<Prefix>{fi("al.width-min")}</Prefix>} value={typo.letterSpacing ? numberOf(typo.letterSpacing, byId) : null} placeholder="0" fallback={0} min={-20} onChange={(v) => setTypo({ letterSpacing: own(v) })} onClear={() => setTypo({ letterSpacing: undefined })} />
          </PropRow>
          <PropRow icons={<span className="w-6" />}>
            <Segmented
              value={node.textAlign}
              options={[
                { value: "left" as const, label: "Align left", icon: fi("24.text.align-left") },
                { value: "center" as const, label: "Align center", icon: fi("24.text.align-center") },
                { value: "right" as const, label: "Align right", icon: fi("24.text.align-right") },
              ]}
              onChange={(textAlign) => ops.patch(node.id, { textAlign } as Partial<SceneNode>)}
            />
            <Segmented
              value={node.textAutoResize}
              options={[
                { value: "widthHeight" as const, label: "Auto width", icon: fi("24.text.resize-width") },
                { value: "height" as const, label: "Auto height", icon: fi("24.text.resize-height") },
                { value: "none" as const, label: "Fixed size", icon: fi("24.text.resize-fixed") },
              ]}
              onChange={(v) => ops.patch(node.id, { textAutoResize: v } as Partial<SceneNode>)}
            />
          </PropRow>
        </>
      )}
    </Section>
  );
}

/** A one-line field typed in place: its text selected; Enter or leaving keeps it, Esc leaves things as they were. */
function InlineInput({ label, value, placeholder, onDone, className }: { label: string; value: string; placeholder?: string; onDone: (value: string | null) => void; className?: string }) {
  return (
    <input
      autoFocus
      aria-label={label}
      defaultValue={value}
      placeholder={placeholder}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { e.currentTarget.dataset.cancel = "1"; e.currentTarget.blur(); }
      }}
      onBlur={(e) => onDone(e.currentTarget.dataset.cancel ? null : e.currentTarget.value)}
      className={cn("min-w-0 bg-transparent text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)] outline-none", className)}
    />
  );
}

/**
 * A variant's own values (Figma's "Current variant"): each of the set's
 * variant properties — its name (a click renames it) and this variant's value
 * of it: a click on the value types it in place (renaming it in every variant
 * that has it), the chevron picks another of the set's values or "Add new…".
 */
/** Figma's conflict warning: variants of a set with the same values for every property (which one an instance shows is then a guess). */
function ConflictWarning({ set }: { set: FrameNode }) {
  const seen = new Set<string>();
  const clash = variantsOf(set).some((v) => {
    const key = variantName(v);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  if (!clash) return null;
  return <p role="alert" className="mx-4 mb-2 px-2 py-1.5 rounded-[5px] bg-[#fff1e6] text-[11px] leading-4 text-[#b44d00]">Some variants have the same values for every property — give each a combination of its own.</p>;
}

function CurrentVariantSection({ node, set, ops }: { node: FrameNode; set: FrameNode; ops: EditorOps }) {
  const [editing, setEditing] = useState<{ prop: string; part: "name" | "value" | "new" } | null>(null);
  const done = () => setEditing(null);
  return (
    <section aria-label="Current variant" data-instant="" className="flex flex-col pb-2 border-b border-[var(--f-border)]">
      <div className="flex items-center h-10 pl-4 pr-3">
        <span className="text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)] select-none">Current variant</span>
      </div>
      <ConflictWarning set={set} />
      {variantProperties(set).map((p) => {
        const current = variantValue(node, p.name);
        const at = editing?.prop === p.name ? editing.part : null;
        return (
          <div key={p.name} className="flex items-center gap-2 h-8 pl-4 pr-3">
            <div className="w-[88px] shrink-0">
              {at === "name" ? (
                <div className="flex h-6 items-center px-2 rounded-[5px] bg-[var(--f-bg)] border border-[var(--f-border-selected)]">
                  <InlineInput label="Property name" value={p.name} className="w-full h-full" onDone={(v) => { const to = v?.trim(); if (to && to !== p.name) ops.renameProperty(set.id, p.name, to); done(); }} />
                </div>
              ) : (
                <button type="button" title="Rename property" onClick={() => setEditing({ prop: p.name, part: "name" })} className="block max-w-full truncate text-left text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)] hover:text-[var(--f-text)] cursor-text">{p.name}</button>
              )}
            </div>
            <div className={cn("flex flex-1 min-w-0 items-center h-6 rounded-[5px] border transition-colors", at === "value" || at === "new" ? "border-[var(--f-border-selected)] bg-[var(--f-bg)]" : "border-[var(--f-border)] hover:border-[var(--f-icon-tertiary)]")}>
              {at === "value" || at === "new" ? (
                <InlineInput
                  label={`${p.name} value`}
                  value={at === "new" ? "" : current}
                  placeholder={at === "new" ? "New value" : undefined}
                  className="flex-1 h-full px-2"
                  onDone={(v) => {
                    const to = v?.trim();
                    if (to && to !== current) {
                      if (at === "new") ops.setVariantValue(node.id, p.name, to);
                      else ops.renameValue(set.id, p.name, current, to);
                    }
                    done();
                  }}
                />
              ) : (
                <button type="button" aria-label={`${p.name} value`} title="Rename value" onClick={() => setEditing({ prop: p.name, part: "value" })} className="min-w-0 flex-1 h-full px-2 truncate text-left text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)] cursor-text">{current || "—"}</button>
              )}
              <button
                type="button"
                aria-haspopup="menu"
                aria-label={`${p.name} values`}
                onClick={(e) => ops.menu(e.currentTarget, [
                  ...p.values.map((v) => ({ label: v, checked: v === current, onSelect: () => v !== current && ops.setVariantValue(node.id, p.name, v) })),
                  "-",
                  { label: "Add new…", onSelect: () => setEditing({ prop: p.name, part: "new" }) },
                ])}
                className="flex h-full w-6 shrink-0 items-center justify-center text-[var(--f-icon-secondary)] cursor-pointer"
              >
                {fi("16.chevron.down")}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** A property's row on an instance, as Figma's: its name (in the secondary colour) in the left column, its control — a toggle too — starting the right one. */
function PropertyRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 h-8 pl-4 pr-3">
      <span className="w-[88px] shrink-0 truncate text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)]" title={name}>{name}</span>
      <div className="min-w-0 flex-1 flex items-center justify-start">{children}</div>
    </div>
  );
}

const propertyIcon = (type: PropertyType, size?: number) => fi(type === "boolean" ? "24.boolean.small" : type === "instanceSwap" ? "24.instance.swap.small" : "24.text", size);

/** The components an instance swap property can pick from: every component but the holder's own variants. */
function swapOptions(nodes: SceneNode[], holder: FrameNode | null) {
  const own = new Set(holder ? (holder.type === "componentSet" ? variantsOf(holder).map((v) => v.id) : [holder.id]) : []);
  return allComponents(nodes).filter(({ component }) => !own.has(component.id)).map(({ component, set }) => ({ value: component.id, label: set ? `${set.name} / ${variantName(component)}` : component.name }));
}

/** The menu's entries that add a property to a main component (a set): Variant, Boolean, Instance swap, Text. */
function addPropertyEntries(holder: FrameNode, nodes: SceneNode[], ops: EditorOps, added?: (id: string) => void): MenuEntry[] {
  const isSet = holder.type === "componentSet";
  const props = holder.properties ?? [];
  const add = (type: PropertyType) => {
    const id = nid("p");
    const base = type === "boolean" ? "Property" : type === "text" ? "Text" : "Instance";
    const value = type === "boolean" ? true : type === "text" ? "" : swapOptions(nodes, holder)[0]?.value ?? "";
    ops.setComponentProperties(holder.id, [...props, { id, name: freePropertyName(holder, base), type, value }]);
    added?.(id);
  };
  return [
    { label: "Variant", icon: fi("24.create.variant.small", 16), onSelect: () => (isSet ? ops.addProperty(holder.id) : ops.addVariant(holder.id)) },
    { label: "Boolean", icon: fi("24.boolean.small", 16), onSelect: () => add("boolean") },
    { label: "Instance swap", icon: fi("24.instance.swap.small", 16), onSelect: () => add("instanceSwap") },
    { label: "Text", icon: fi("24.text", 16), onSelect: () => add("text") },
  ];
}

/** A property's window beside the panel (Figma's "Edit boolean property"…): its title, close, its rows. */
function PropertyWindow({ title, anchor, onClose, children }: { title: string; anchor: { top: number; right: number }; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (!ref.current?.contains(t) && !t.closest("[data-picker-anchor]") && !t.closest("[role=menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [onClose]);
  const top = Math.max(8, Math.min(anchor.top - 12, window.innerHeight - 240));
  const left = Math.max(8, anchor.right - 304 - 8);
  return (
    <div ref={ref} role="dialog" aria-label={title} data-instant="" className="fixed z-40 flex w-[304px] flex-col rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_10px_16px_rgba(0,0,0,0.2)] text-[11px] leading-4 text-[var(--f-text)]" style={{ top, left }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between h-12 pl-4 pr-2 border-b border-[var(--f-border)]">
        <span className="text-[13px] font-[550] leading-[22px] tracking-[-0.0325px]">{title}</span>
        <IconButton label="Close" icon={fi("close.small")} onClick={onClose} />
      </div>
      <div className="flex flex-col py-2">{children}</div>
    </div>
  );
}

/** A row of a property's window: its label at the left, its field. */
const WindowRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center gap-2 min-h-8 px-4 py-0.5">
    <span className="w-[96px] shrink-0 text-[11px] text-[var(--f-text-secondary)]">{label}</span>
    <div className="flex flex-1 min-w-0 items-center gap-2">{children}</div>
  </div>
);

const PROPERTY_TITLE: Record<PropertyType, string> = { boolean: "Edit boolean property", text: "Edit text property", instanceSwap: "Edit instance swap property" };

/**
 * A main component's (a set's) properties, as Figma's: each a row — its
 * icon, its name, its values or default — that shows, hovered, its edit
 * button (the property's window: its name and default; a variant
 * property's values) and its remove button; "+" adds one.
 */
function PropertiesSection({ holder, nodes, ops }: { holder: FrameNode; nodes: SceneNode[]; ops: EditorOps }) {
  const [editing, setEditing] = useState<{ key: string; anchor: { top: number; right: number } } | null>(null);
  // The row whose name is being typed in place (a click on it, as Figma's).
  const [naming, setNaming] = useState<string | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const isSet = holder.type === "componentSet";
  const variantProps = isSet ? variantProperties(holder) : [];
  const props = holder.properties ?? [];
  const options = swapOptions(nodes, holder);
  const rename = (id: string, name: string) => name.trim() && ops.setComponentProperties(holder.id, props.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)));
  const preview = (p: ComponentProperty) => (p.type === "boolean" ? (p.value ? "True" : "False") : p.type === "instanceSwap" ? options.find((o) => o.value === p.value)?.label ?? "—" : String(p.value) || "—");
  const open = (key: string, el: HTMLElement) => setEditing(editing?.key === key ? null : { key, anchor: anchorOf(el) });
  const row = (key: string, icon: ReactNode, name: string, value: string, onRemove: () => void, onRename: (name: string) => void) => {
    const active = editing?.key === key;
    if (naming === key) {
      // Its name, selected, in a field of its own — Enter or leaving it keeps it, Esc leaves it as it was.
      return (
        <div key={key} className="flex items-center h-8 pl-4 pr-3">
          <div className="flex flex-1 min-w-0 items-center gap-1.5 h-6 pl-1 pr-2 rounded-[5px] bg-[var(--f-bg)] border border-[var(--f-border-selected)]">
            <span className="flex w-4 h-4 shrink-0 items-center justify-center text-[var(--f-icon)]">{icon}</span>
            <input
              autoFocus
              aria-label="Property name"
              defaultValue={name}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") { e.currentTarget.dataset.cancel = "1"; e.currentTarget.blur(); }
              }}
              onBlur={(e) => {
                if (!e.currentTarget.dataset.cancel) onRename(e.currentTarget.value);
                setNaming(null);
              }}
              className="min-w-0 flex-1 h-full bg-transparent text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)] outline-none"
            />
          </div>
        </div>
      );
    }
    return (
      <div key={key} className="group/prop flex items-center gap-1 h-8 pl-4 pr-3">
        <div role="button" tabIndex={0} data-picker-anchor="" onClick={() => { setEditing(null); setNaming(key); }} onKeyDown={(e) => { if (e.key === "Enter") { setEditing(null); setNaming(key); } }} onDoubleClick={(e) => open(key, e.currentTarget)} className={cn("flex flex-1 min-w-0 items-center gap-1.5 h-6 pl-1 pr-2 rounded-[5px] select-none transition-colors cursor-text", active ? "bg-[var(--f-bg-tertiary)]" : "bg-[var(--f-bg-secondary)] hover:bg-[var(--f-bg-tertiary)]")}>
          <span className="flex w-4 h-4 shrink-0 items-center justify-center text-[var(--f-icon)]">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)]">{name}<span className="text-[var(--f-text-secondary)]"> · {value}</span></span>
        </div>
        <span data-picker-anchor="" className={cn("f-icons items-center gap-1", active ? "flex" : "hidden group-hover/prop:flex group-focus-within/prop:flex")}>
          <IconButton label="Edit property" icon={fi("24.adjust.small")} active={active} onClick={(e) => open(key, e.currentTarget)} />
          <IconButton label="Remove property" icon={fi("minus.small")} onClick={() => { setEditing(null); onRemove(); }} />
        </span>
      </div>
    );
  };
  const editedVariant = editing?.key.startsWith("v:") ? variantProps.find((p) => `v:${p.name}` === editing.key) : undefined;
  const editedProp = editing && !editing.key.startsWith("v:") ? props.find((p) => p.id === editing.key) : undefined;
  return (
    <section aria-label="Properties" data-instant="" className="flex flex-col pb-2 border-b border-[var(--f-border)]">
      <div className="flex items-center gap-1 h-10 pl-4 pr-3">
        <span className="flex-1 text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)] select-none">Properties</span>
        <span className="f-icons flex items-center gap-1">
          <IconButton label="Add property" icon={fi("plus.small")} onClick={(e) => ops.menu(e.currentTarget, addPropertyEntries(holder, nodes, ops, (id) => setEditing({ key: id, anchor: anchorOf(e.currentTarget) })))} />
        </span>
      </div>
      {isSet && <ConflictWarning set={holder} />}
      {variantProps.map((p) => row(`v:${p.name}`, fi("16.instance"), p.name, p.values.join(", "), () => ops.removeProperty(holder.id, p.name), (to) => { const name = to.trim(); if (name && name !== p.name) ops.renameProperty(holder.id, p.name, name); }))}
      {props.map((p) => row(p.id, propertyIcon(p.type, 16), p.name, preview(p), () => ops.setComponentProperties(holder.id, props.filter((x) => x.id !== p.id)), (to) => rename(p.id, to)))}
      {editing && editedVariant && (
        <PropertyWindow title="Edit variant property" anchor={editing.anchor} onClose={close}>
          <WindowRow label="Name">
            <TextInput autoFocus label="Property name" value={editedVariant.name} onCommit={(to) => { const name = to.trim(); if (name && name !== editedVariant.name) { ops.renameProperty(holder.id, editedVariant.name, name); setEditing({ ...editing, key: `v:${name}` }); } }} />
          </WindowRow>
          {/* As Figma's: under a line, the values — each a field of its own, the window's width. */}
          <div className="flex flex-col gap-2 mt-2 px-4 pt-3 pb-1 border-t border-[var(--f-border)]">
            <span className="h-6 flex items-center text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)]">Values</span>
            {editedVariant.values.map((v) => (
              <TextInput key={v} label={`${editedVariant.name} value`} value={v} className="flex-none h-8" onCommit={(to) => { const value = to.trim(); if (value && value !== v) ops.renameValue(holder.id, editedVariant.name, v, value); }} />
            ))}
          </div>
        </PropertyWindow>
      )}
      {editing && editedProp && (
        <PropertyWindow title={PROPERTY_TITLE[editedProp.type]} anchor={editing.anchor} onClose={close}>
          <WindowRow label="Name">
            <TextInput autoFocus label="Property name" value={editedProp.name} onCommit={(name) => rename(editedProp.id, name)} />
          </WindowRow>
          <WindowRow label="Value">
            {editedProp.type === "boolean" && (
              <>
                <Switch label="Default value" checked={Boolean(editedProp.value)} onChange={(v) => ops.setPropertyValue(holder.id, editedProp.id, v)} />
                <span className="text-[11px] text-[var(--f-text)]">{editedProp.value ? "True" : "False"}</span>
              </>
            )}
            {editedProp.type === "text" && <TextInput label="Default value" value={String(editedProp.value)} onCommit={(v) => ops.setPropertyValue(holder.id, editedProp.id, v)} />}
            {editedProp.type === "instanceSwap" && <Select outlined label="Default component" prefix={<span className="flex shrink-0 pl-1 text-[var(--f-icon)]">{fi("16.instance")}</span>} value={String(editedProp.value)} options={options} onChange={(v) => ops.setPropertyValue(holder.id, editedProp.id, v)} />}
          </WindowRow>
        </PropertyWindow>
      )}
    </section>
  );
}

function InstanceSection({ node, nodes, ops, lang }: { node: FrameNode; nodes: SceneNode[]; ops: EditorOps; lang: LangCode }) {
  const main = node.mainId ? findComponent(nodes, node.mainId) : null;
  const set = main ? setOf(nodes, main.id) : null;
  const variantProps = set ? variantProperties(set) : [];
  const props = main ? propertiesOf(nodes, main.id) : [];
  const values = main ? propertyValues(nodes, main, node) : {};
  const overridden = Boolean(node.overrides && Object.keys(node.overrides).length) || Boolean(node.props && Object.keys(node.props).length) || Boolean(node.propsEn && Object.keys(node.propsEn).length) || Boolean(node.propsI18n && Object.keys(node.propsI18n).length);
  // Inside a main component: which component it shows can follow an instance swap property.
  const around = componentAround(nodes, node.id);
  const holder = around?.holder ?? null;
  const swaps = holder?.properties?.filter((p) => p.type === "instanceSwap") ?? [];
  const boundSwap = node.mainProp ? swaps.find((p) => p.id === node.mainProp) : undefined;
  const createSwap = () => {
    if (!holder || !node.mainId) return;
    const id = nid("p");
    ops.setComponentProperties(holder.id, [...(holder.properties ?? []), { id, name: freePropertyName(holder, node.name), type: "instanceSwap", value: node.mainId }]);
    ops.bindProperty(node.id, "instance", id);
  };
  const swapItems = (p: ComponentProperty) => {
    const preferred = (p.preferred ?? []).map((id) => swapOptions(nodes, null).find((o) => o.value === id)).filter((o): o is { value: string; label: string } => Boolean(o));
    const all = swapOptions(nodes, null).filter((o) => !preferred.some((x) => x.value === o.value));
    return [...preferred, ...all];
  };
  // As Figma's instance panel: under the header (the component's name), where it is from and its main component's button, then its properties — no section title.
  return (
    <section aria-label="Instance" data-instant="" className="flex flex-col pb-2 border-b border-[var(--f-border)]">
      <div className="flex items-center gap-1 h-8 pl-4 pr-3">
        <span className="text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)] select-none">{main ? "From this file" : "No main component"}</span>
        <IconButton label="Go to main component" icon={fi("16.instance")} disabled={!main} onClick={ops.goToMain} />
        <span className="f-icons ml-auto flex items-center gap-1">
          {overridden && <IconButton label="Reset all changes" icon={fi("reset.instance.small")} onClick={ops.resetOverrides} />}
          <IconButton label="More actions" icon={fi("24.more")} onClick={(e) => ops.menu(e.currentTarget, ops.instanceActions(node.id))} />
          {holder && (
            <IconButton label="Apply instance swap property" icon={fi("24.instance.swap.small")} active={Boolean(boundSwap)} onClick={(e) => ops.menu(e.currentTarget, [
              ...swaps.map((p) => ({ label: p.name, icon: fi("24.instance.swap.small", 16), checked: p.id === node.mainProp, onSelect: () => ops.bindProperty(node.id, "instance", p.id) })),
              ...(swaps.length ? ["-" as const] : []),
              { label: "Create property", onSelect: createSwap },
              ...(boundSwap ? [{ label: "Detach property", onSelect: () => ops.bindProperty(node.id, "instance", undefined) }] : []),
            ])} />
          )}
          <IconButton label="Detach instance (⌥⌘B)" icon={fi("detach.small")} onClick={ops.detach} />
        </span>
      </div>
      {boundSwap && (
        <div className="flex items-center gap-2 pl-4 pr-3 pb-1">
          <span className="flex flex-1 items-center gap-1 h-6 px-1 rounded-[5px] bg-[var(--f-bg-secondary)] text-[11px] text-[var(--f-text-component)]">{fi("24.instance.swap.small", 16)}<span className="truncate">{boundSwap.name}</span></span>
          <IconButton label="Detach property" icon={fi("detach.small")} onClick={() => ops.bindProperty(node.id, "instance", undefined)} />
        </div>
      )}
      {variantProps.map((p) => (
        <PropertyRow key={p.name} name={p.name}>
          <Select outlined label={p.name} value={main ? variantValue(main, p.name) : ""} options={p.values.map((v) => ({ value: v, label: v }))} onChange={(v) => ops.swapVariant(node.id, p.name, v)} />
        </PropertyRow>
      ))}
      {props.map((p) => (
        <PropertyRow key={p.id} name={p.name}>
          {p.type === "boolean" && <Switch label={p.name} checked={Boolean(values[p.id])} onChange={(v) => ops.setInstanceProp(node.id, p.id, v)} />}
          {p.type === "text" && (
            <TextInput label={p.name} value={lang !== BASE_LANGUAGE ? propsIn(node, lang)?.[p.id] ?? "" : String(values[p.id] ?? "")} placeholder={lang !== BASE_LANGUAGE ? String(values[p.id] ?? "") : undefined} onCommit={(v) => ops.setInstanceProp(node.id, p.id, v, lang)} />
          )}
          {p.type === "instanceSwap" && <Select outlined label={p.name} prefix={<span className="flex shrink-0 pl-1 text-[var(--f-icon)]">{fi("16.instance")}</span>} value={String(values[p.id] ?? "")} options={swapItems(p)} onChange={(v) => ops.setInstanceProp(node.id, p.id, v)} />}
        </PropertyRow>
      ))}
    </section>
  );
}

// ── Prototype ─────────────────────────────────────────────────────────────────

/** A field showing its value that opens Figma's menu of choices (its groups divided, the current one checked). */
function MenuField({ label, value, entries, ops, prefix }: { label: string; value: string; entries: MenuEntry[]; ops: EditorOps; prefix?: ReactNode }) {
  return (
    <button type="button" aria-label={label} aria-haspopup="menu" data-picker-anchor="" onClick={(e) => ops.menu(e.currentTarget, entries)} className={cn(FIELD_OUTLINED, "relative flex flex-1 min-w-0 items-center gap-1.5 pl-2 pr-6 text-left cursor-pointer")}>
      {prefix}
      <span className="min-w-0 flex-1 truncate text-[11px] font-[450] leading-4 tracking-[0.055px] text-[var(--f-text)]">{value}</span>
      {fi("16.chevron.down", undefined, "pointer-events-none absolute right-1 text-[var(--f-icon-secondary)]")}
    </button>
  );
}

const ARROW: Record<InteractionDirection, string> = { left: "←", right: "→", down: "↓", up: "↑" };

/**
 * Figma's Prototype panel: a top-level frame's flow starting point; the
 * layer's interactions — each a row (its trigger, what it goes to), opening
 * the Interaction window: the trigger (a delay's time, a key), the action
 * (Navigate to a frame, Change to a variant, Back, Scroll to a layer, Open
 * link) and where it goes, the animation (a move's direction, matching
 * layers), its easing (a custom curve, a custom spring) and duration. With
 * nothing selected, the page's flows, each played from its start.
 */
function PrototypeSection({ node, nodes, pageNodes, ops }: { node: SceneNode | null; nodes: SceneNode[]; pageNodes: SceneNode[]; ops: EditorOps }) {
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const openId = ops.reactionOpen;
  const flows = pageNodes.filter((n): n is FrameNode => isFrameLike(n) && Boolean(n.flowStart));
  // Opened from the canvas (a noodle clicked): the window by its row.
  useLayoutEffect(() => {
    if (!openId || anchor) return;
    const row = list.current?.querySelector(`[data-reaction="${CSS.escape(openId)}"]`);
    if (row) setAnchor(anchorOf(row));
  }, [openId, anchor]);
  const flowsGroup = (
    <Section title="Flows" muted={flows.length === 0}>
      {flows.length === 0 && <p className="px-4 pt-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">Connect a frame to another to start a flow — or add a flow starting point to a top-level frame.</p>}
      {flows.map((f) => (
        <div key={f.id} className="px-2 py-0.5">
          <button type="button" onClick={() => ops.preview(f.id)} className="flex items-center gap-2 w-full h-6 px-2 rounded-[5px] text-left hover:bg-[var(--f-bg-hover)] cursor-pointer">
            <span className="flex w-4 shrink-0 justify-center text-[var(--f-icon)]">{fi("24.play.small", 16)}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--f-text)]">{f.flowStart}</span>
            <span className="truncate text-[11px] text-[var(--f-text-secondary)]">{f.name}</span>
          </button>
        </div>
      ))}
    </Section>
  );
  if (!node || node.id.includes("/")) {
    return (
      <>
        {node && (
          <Section title="Interactions" muted>
            <p className="px-4 pt-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">A layer of an instance: its interactions are its main component&apos;s — set them up there.</p>
          </Section>
        )}
        {flowsGroup}
      </>
    );
  }
  const found = findNode(pageNodes, node.id) ?? findNode(nodes, node.id);
  const topId = found?.path[0];
  const top = topId ? getNode(pageNodes, topId) ?? getNode(nodes, topId) : null;
  const topLevel = found?.path.length === 1 && isFrameLike(node) && node.type !== "componentSet";
  const set = node.type === "component" ? setOf(nodes, node.id) : null;
  const reactions = node.reactions ?? [];
  const setReactions = (next: Reaction[]) => ops.setReactions(node.id, next);
  const patch = (id: string, p: Partial<Reaction>) => setReactions(reactions.map((x) => (x.id === id ? { ...x, ...p } : x)));
  // Where each action can go: the page's frames (not its own), the variants of its set, the layers of its frame.
  const frames = pageNodes.filter((n) => isFrameLike(n) && n.type !== "componentSet" && n.id !== topId);
  const variants = set ? variantsOf(set).filter((v) => v.id !== node.id) : [];
  const layers: SceneNode[] = [];
  if (top && isFrameLike(top)) walk(top.children, (n) => { if (isFrameLike(n) && n.type !== "instance") layers.push(n); });
  const nameOf = (r: Reaction) => {
    const a = actionOf(r);
    if (a === "back") return "Back";
    if (a === "url") return r.url || "No link";
    const t = r.target ? getNode(nodes, r.target) ?? getNode(pageNodes, r.target) : null;
    if (!t) return "None";
    return t.type === "component" && t.variant?.length ? variantLabel(t) : t.name;
  };
  const defaults = (action: InteractionAction): Partial<Reaction> => {
    switch (action) {
      case "change": return { action, target: variants[0]?.id ?? "", animation: "smart" };
      case "navigate": return { action, target: frames[0]?.id ?? "", animation: "instant", direction: "left" };
      case "scroll": return { action, target: layers[0]?.id ?? "", animation: "smart" };
      default: return { action, target: "", animation: "instant" };
    }
  };
  const add = (e: React.MouseEvent<HTMLElement>) => {
    const r: Reaction = { id: nid("r"), trigger: "click", easing: "ease-out", duration: 300, ...(set ? defaults("change") : defaults("navigate")) } as Reaction;
    setReactions([...reactions, r]);
    ops.openReaction(r.id);
    setAnchor(anchorOf(e.currentTarget));
  };
  const editing = openId ? reactions.find((r) => r.id === openId) : undefined;
  const windowRow = (label: string, field: ReactNode) => (
    <div className="flex items-center gap-2 min-h-8 px-4 py-0.5">
      <span className="w-[88px] shrink-0 text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)]">{label}</span>
      <div className="flex flex-1 min-w-0 items-center gap-2">{field}</div>
    </div>
  );
  const divided = (children: ReactNode) => <div className="flex flex-col mt-1 pt-1 border-t border-[var(--f-border)]">{children}</div>;

  const interactionWindow = editing && anchor && (() => {
    const r = editing;
    const action = actionOf(r);
    const actions: InteractionAction[] = set ? ["navigate", "change", "back", "scroll", "url"] : ["navigate", "back", "scroll", "url"];
    const animations: InteractionAnimation[] = action === "change" || action === "scroll" ? (action === "scroll" ? ["instant", "smart"] : CHANGE_ANIMATIONS) : (Object.keys(ANIMATIONS) as InteractionAnimation[]);
    const destinations = action === "change" ? variants : action === "scroll" ? layers : frames;
    const spring = EASINGS[r.easing]?.spring;
    const triggerEntries: MenuEntry[] = TRIGGER_GROUPS.flatMap((group, i) => [...(i ? ["-" as const] : []), ...group.map((t) => ({ label: TRIGGERS[t], checked: r.trigger === t, onSelect: () => patch(r.id, { trigger: t, ...(t === "delay" && r.delay === undefined ? { delay: 800 } : {}) }) }))]);
    const easingEntries: MenuEntry[] = (Object.keys(EASINGS) as InteractionEasing[]).flatMap((e, i, all) => [...(i && EASINGS[e].spring && !EASINGS[all[i - 1]].spring ? ["-" as const] : []), { label: EASINGS[e].label, checked: r.easing === e, onSelect: () => patch(r.id, { easing: e, ...(e === "custom-bezier" && !r.bezier ? { bezier: [0.42, 0, 0.58, 1] as [number, number, number, number] } : {}), ...(e === "custom-spring" && !r.spring ? { spring: { mass: 1, stiffness: 100, damping: 15 } } : {}) }) }]);
    return (
      <PropertyWindow title="Interaction" anchor={anchor} onClose={() => { ops.openReaction(null); setAnchor(null); }}>
        {windowRow("Trigger", <MenuField label="Trigger" value={TRIGGERS[r.trigger]} entries={triggerEntries} ops={ops} />)}
        {r.trigger === "delay" && windowRow("Delay", <NumericInput label="Delay" prefix={<Prefix>ms</Prefix>} value={r.delay ?? 800} min={0} onChange={(delay) => patch(r.id, { delay })} />)}
        {r.trigger === "key" && windowRow("Key", (
          <input
            aria-label="Key"
            readOnly
            value={r.key ? (r.key === " " ? "Space" : r.key) : ""}
            placeholder="Press a key"
            onKeyDown={(e) => { e.preventDefault(); e.stopPropagation(); if (!["Shift", "Meta", "Control", "Alt"].includes(e.key)) patch(r.id, { key: e.key }); }}
            className={cn(FIELD_OUTLINED, "flex-1 min-w-0 px-2 text-[11px] text-[var(--f-text)] outline-none focus:border-[var(--f-border-selected)]")}
          />
        ))}
        {divided(
          <>
            {windowRow("Action", <MenuField label="Action" value={ACTIONS[action]} ops={ops} entries={actions.map((a) => ({ label: ACTIONS[a], checked: action === a, onSelect: () => a !== action && patch(r.id, defaults(a)) }))} />)}
            {(action === "navigate" || action === "change" || action === "scroll") && windowRow(action === "change" ? "Change to" : "Destination", (
              <Select outlined label="Destination" value={r.target} options={[...(destinations.some((d) => d.id === r.target) ? [] : [{ value: r.target, label: "None" }]), ...destinations.map((d) => ({ value: d.id, label: d.type === "component" && d.variant?.length ? variantLabel(d) : d.name }))]} onChange={(target) => patch(r.id, { target })} />
            ))}
            {action === "url" && windowRow("Link", <TextInput label="Link" value={r.url ?? ""} placeholder="https://…" onCommit={(url) => patch(r.id, { url: url.trim() || undefined })} />)}
          </>
        )}
        {action !== "url" && action !== "back" && divided(
          <>
            {windowRow("Animation", <MenuField label="Animation" value={ANIMATIONS[r.animation]} ops={ops} entries={(Object.keys(ANIMATIONS) as InteractionAnimation[]).flatMap((a, i) => [...(i === 3 ? ["-" as const] : []), { label: ANIMATIONS[a], checked: r.animation === a, disabled: !animations.includes(a), onSelect: () => patch(r.id, { animation: a, ...(DIRECTED.has(a) && !r.direction ? { direction: "left" as InteractionDirection } : {}) }) }])} />)}
            {DIRECTED.has(r.animation) && (
              <div className="px-4 py-1"><Checkbox label="Animate matching layers" checked={Boolean(r.matchLayers)} onChange={(v) => patch(r.id, { matchLayers: v || undefined })} /></div>
            )}
            {DIRECTED.has(r.animation) && windowRow("Direction", <Segmented value={r.direction ?? "left"} options={DIRECTIONS.map((d) => ({ value: d, label: d, icon: <span className="text-[13px] leading-none">{ARROW[d]}</span> }))} onChange={(direction) => patch(r.id, { direction })} />)}
            {r.animation !== "instant" && windowRow("Easing", <MenuField label="Easing" value={EASINGS[r.easing]?.label ?? r.easing} entries={easingEntries} ops={ops} />)}
            {r.animation !== "instant" && r.easing === "custom-bezier" && windowRow("Curve", (
              <>
                {[0, 1, 2, 3].map((i) => (
                  <NumericInput key={i} label={["x1", "y1", "x2", "y2"][i]} prefix={<Prefix>{["x1", "y1", "x2", "y2"][i]}</Prefix>} value={(r.bezier ?? [0.42, 0, 0.58, 1])[i]} min={i % 2 === 0 ? 0 : -2} max={i % 2 === 0 ? 1 : 3} onChange={(v) => { const b = [...(r.bezier ?? [0.42, 0, 0.58, 1])] as [number, number, number, number]; b[i] = v; patch(r.id, { bezier: b }); }} />
                ))}
              </>
            ))}
            {r.animation !== "instant" && r.easing === "custom-spring" && windowRow("Spring", (
              <>
                {(["mass", "stiffness", "damping"] as const).map((k) => (
                  <NumericInput key={k} label={k[0].toUpperCase() + k.slice(1)} prefix={<Prefix>{k[0].toUpperCase()}</Prefix>} value={(r.spring ?? { mass: 1, stiffness: 100, damping: 15 })[k]} min={k === "mass" ? 0.1 : 0} onChange={(v) => patch(r.id, { spring: { ...(r.spring ?? { mass: 1, stiffness: 100, damping: 15 }), [k]: v } })} />
                ))}
              </>
            ))}
            {r.animation !== "instant" && (spring
              ? windowRow("Duration", <span className="text-[11px] leading-4 text-[var(--f-text-secondary)]">{durationOf(r)}ms — the spring&apos;s own</span>)
              : windowRow("Duration", <NumericInput label="Duration" prefix={<Prefix>ms</Prefix>} value={r.duration} min={0} onChange={(duration) => patch(r.id, { duration })} />))}
          </>
        )}
      </PropertyWindow>
    );
  })();

  return (
    <>
      {topLevel && isFrameLike(node) && (
        <Section title="Flow starting point" muted={!node.flowStart} icons={!node.flowStart ? <IconButton label="Add flow starting point" icon={fi("plus.small")} onClick={() => { let n = flows.length + 1; while (flows.some((f) => f.flowStart === `Flow ${n}`)) n++; ops.patch(node.id, { flowStart: `Flow ${n}` } as Partial<SceneNode>); }} /> : undefined}>
          {node.flowStart && (
            <PropRow icons={<><IconButton label="Present this flow" icon={fi("24.play.small")} onClick={() => ops.preview(node.id)} /><IconButton label="Remove flow starting point" icon={fi("minus.small")} onClick={() => ops.patch(node.id, { flowStart: undefined } as Partial<SceneNode>)} /></>}>
              <TextInput label="Flow name" value={node.flowStart} onCommit={(name) => name.trim() && ops.patch(node.id, { flowStart: name.trim() } as Partial<SceneNode>)} />
            </PropRow>
          )}
        </Section>
      )}
      <Section title="Interactions" muted={reactions.length === 0} icons={<IconButton label="Add interaction" icon={fi("plus.small")} onClick={add} />}>
        <div ref={list} data-instant="">
          {reactions.length === 0 && <p className="px-4 pt-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">Click + — or drag the + on the layer&apos;s edge onto a frame{set ? " or another variant" : ""}.</p>}
          {reactions.map((r) => {
            const open = openId === r.id;
            const a = actionOf(r);
            return (
              <div key={r.id} data-reaction={r.id} className="group/reaction flex items-center gap-1 h-8 pl-4 pr-3">
                <div role="button" tabIndex={0} data-picker-anchor="" onClick={(e) => { if (open) { ops.openReaction(null); setAnchor(null); } else { ops.openReaction(r.id); setAnchor(anchorOf(e.currentTarget)); } }} className={cn("flex flex-1 min-w-0 items-center gap-2 h-6 px-2 rounded-[5px] cursor-pointer select-none", open ? "bg-[var(--f-bg-tertiary)]" : "bg-[var(--f-bg-secondary)] hover:bg-[var(--f-bg-tertiary)]")}>
                  <span className="shrink-0 truncate text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)]">{TRIGGER_SHORT[r.trigger]}</span>
                  <span className="flex shrink-0 text-[var(--f-icon)]">{a === "change" ? fi("24.instance.swap.small", 16) : <span className="w-4 text-center text-[11px]">→</span>}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)]">{nameOf(r)}</span>
                </div>
                <span className="f-icons hidden group-hover/reaction:flex group-focus-within/reaction:flex" onClick={(e) => e.stopPropagation()}>
                  <IconButton label="Remove" icon={fi("minus.small")} onClick={() => { if (open) ops.openReaction(null); setReactions(reactions.filter((x) => x.id !== r.id)); }} />
                </span>
              </div>
            );
          })}
        </div>
        {interactionWindow}
      </Section>
      {flowsGroup}
    </>
  );
}

/** Figma's Layout guide: a frame's layout grids — columns, rows or a square grid, each with its counts, gutter, margin and colour. */
function LayoutGuideSection({ frame, ops }: { frame: FrameNode; ops: EditorOps }) {
  const grids = frame.layoutGrids ?? [];
  const set = (next: LayoutGrid[]) => ops.patch(frame.id, { layoutGrids: next.length ? next : undefined });
  const at = (i: number, patch: Partial<LayoutGrid>) => set(grids.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  return (
    <Section title="Layout grid" muted={!grids.length} pb={grids.length ? 12 : 0} icons={<IconButton label="Add layout grid" icon={fi("plus.small")} onClick={(e) => ops.menu(e.currentTarget, (["columns", "rows", "grid"] as LayoutGrid["type"][]).map((t) => ({ label: LAYOUT_GRID_LABEL[t], onSelect: () => set([...grids, newLayoutGrid(t)]) })))} />}>
      {grids.map((g, i) => (
        <div key={i} className="flex flex-col">
          <PropRow icons={<><IconButton label={g.visible === false ? "Show" : "Hide"} icon={fi(g.visible === false ? "hidden.small" : "eye.small")} onClick={() => at(i, { visible: g.visible === false ? undefined : false })} /><IconButton label="Remove" icon={fi("minus.small")} onClick={() => set(grids.filter((_, j) => j !== i))} /></>}>
            <Select label="Layout grid type" value={g.type} options={(["columns", "rows", "grid"] as LayoutGrid["type"][]).map((t) => ({ value: t, label: LAYOUT_GRID_LABEL[t] }))} onChange={(type) => at(i, { type: type as LayoutGrid["type"] })} />
            {g.type === "grid" ? (
              <NumericInput label="Size" prefix={<Prefix>{fi("24.grid", 16)}</Prefix>} value={g.size} min={1} unit="px" onChange={(size) => at(i, { size })} />
            ) : (
              <NumericInput label="Count" prefix={<Prefix>{fi(g.type === "columns" ? "grid-column" : "grid-row")}</Prefix>} value={g.count} min={1} max={100} onChange={(count) => at(i, { count })} />
            )}
          </PropRow>
          {g.type !== "grid" && (
            <PropRow icons={<span className="w-6" />}>
              <NumericInput label="Gutter" prefix={<Prefix>{fi(g.type === "columns" ? "al.spacing-horizontal" : "al.spacing-vertical")}</Prefix>} value={g.gutter} min={0} onChange={(gutter) => at(i, { gutter })} />
              <NumericInput label="Margin" prefix={<Prefix>{fi("al.padding-horizontal")}</Prefix>} value={g.margin} min={0} onChange={(margin) => at(i, { margin })} />
            </PropRow>
          )}
          <PropRow icons={<span className="w-6" />}>
            <ColorInput label="Color" color={g.color} opacity={g.opacity} onColor={(color) => at(i, { color })} onOpacity={(opacity) => at(i, { opacity })} />
          </PropRow>
        </div>
      ))}
    </Section>
  );
}

/** Figma's Export: the layer's export settings (scale, format) and the button that saves them. */
/** A row of the Embed and Link sections: what the field is, then the field. */
function FieldRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 min-h-8 pl-4 pr-3 py-1">
      <span className="w-[64px] shrink-0 truncate text-[11px] leading-4 text-[var(--f-text-secondary)]" title={name}>{name}</span>
      <div className="min-w-0 flex-1 flex items-center">{children}</div>
    </div>
  );
}

/** Several lines typed in the kit's box (a code sample, a caption): written as the field is left. */
function TextArea({ label, value, placeholder, rows = 3, mono = false, onCommit }: { label: string; value: string; placeholder?: string; rows?: number; mono?: boolean; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape: what was typed is dropped (the blur that follows writes nothing).
  const cancelled = useRef(false);
  return (
    <textarea
      aria-label={label}
      rows={rows}
      value={draft ?? value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) { cancelled.current = false; setDraft(null); return; }
        if (draft !== null) { onCommit(draft); setDraft(null); }
      }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { cancelled.current = true; setDraft(null); e.currentTarget.blur(); } }}
      className={cn("min-w-0 flex-1 px-2 py-1 rounded-[5px] bg-[var(--f-bg-secondary)] border border-transparent [&:hover:not(:focus)]:border-[var(--f-border)] focus:border-[var(--f-border-selected)] text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text)] placeholder:text-[var(--f-text-secondary)] outline-none resize-y", mono ? "font-mono" : "font-[450]")}
    />
  );
}

const ASPECTS = ["16/9", "4/3", "1/1", "3/4", "9/16"].map((r) => ({ value: r, label: r.replace("/", ":") }));

/**
 * What the site's code draws in the frame's place (see Embed): its kind and
 * what it draws from — an address, a code sample, the pictures of a before /
 * after or of the devices — and its caption, in the language being edited.
 */
function EmbedSection({ node, ops, lang }: { node: FrameNode; ops: EditorOps; lang: LangCode }) {
  const embed = node.embed!;
  const set = (p: Partial<Embed>) => {
    const next = { ...embed, ...p } as Record<string, unknown>;
    // (What is emptied goes: the stored file takes nothing unset.)
    Object.keys(next).forEach((k) => (next[k] === undefined || next[k] === "") && delete next[k]);
    ops.patch(node.id, { embed: next as unknown as Embed } as Partial<SceneNode>);
  };
  const field = (name: string, key: "src" | "language" | "figmaWorkspace" | "figmaCover" | "figmaWorkspaceCover" | "iframeCover" | "iframeTabletUrl" | "iframeMobileUrl", placeholder = "https://…") => (
    <FieldRow name={name}>
      <TextInput label={name} value={embed[key] ?? ""} placeholder={placeholder} onCommit={(value) => set({ [key]: value.trim() })} />
    </FieldRow>
  );
  const entries = embed.entries ?? [];
  const setEntry = (i: number, p: Partial<NonNullable<Embed["entries"]>[number]>) => {
    const list = [...entries];
    list[i] = { ...(list[i] ?? { id: nid("e") }), ...p };
    set({ entries: list });
  };
  const views = embed.iframeViews?.length ? embed.iframeViews : (["desktop", "tablet", "mobile"] as const);
  return (
    <Section title={`Embed · ${EMBED_LABEL[embed.kind]}`} pb={12}>
      {embed.kind === "image" && field("Image", "src")}
      {embed.kind === "video" && (
        <>
          {field("Video", "src", "YouTube, Vimeo, .mp4")}
          <div className="pl-4 pr-3 py-1"><Checkbox label="Loop, muted, without controls" checked={Boolean(embed.videoLoop)} onChange={(v) => set({ videoLoop: v || undefined })} /></div>
        </>
      )}
      {embed.kind === "code" && (
        <>
          {field("Language", "language", "javascript")}
          <FieldRow name="Code"><TextArea label="Code" value={embed.content ?? ""} rows={6} mono onCommit={(value) => set({ content: value })} /></FieldRow>
          <FieldRow name="Preview"><TextArea label="Preview (HTML)" value={embed.codePreview ?? ""} placeholder="HTML (optional)" rows={2} mono onCommit={(value) => set({ codePreview: value })} /></FieldRow>
        </>
      )}
      {embed.kind === "figma" && (
        <>
          {field("Prototype", "src", "figma.com/proto/…")}
          {field("Cover", "figmaCover")}
          {field("Pages", "figmaWorkspace", "figma.com/design/… (optional)")}
          {field("Pages cover", "figmaWorkspaceCover")}
        </>
      )}
      {embed.kind === "iframe" && (
        <>
          {field("Address", "src")}
          {field("Cover", "iframeCover")}
          <FieldRow name="Views">
            <div className="flex flex-wrap items-center gap-x-3">
              {(["desktop", "tablet", "mobile"] as const).map((view) => (
                <Checkbox key={view} label={view[0].toUpperCase() + view.slice(1)} checked={views.includes(view)} onChange={(on) => {
                  const next = (["desktop", "tablet", "mobile"] as const).filter((x) => (x === view ? on : views.includes(x)));
                  if (next.length) set({ iframeViews: [...next] });
                }} />
              ))}
            </div>
          </FieldRow>
          {views.includes("tablet") && field("Tablet", "iframeTabletUrl", "its own address (optional)")}
          {views.includes("mobile") && field("Mobile", "iframeMobileUrl", "its own address (optional)")}
        </>
      )}
      {embed.kind === "compare" && (["Before", "After"] as const).map((side, i) => (
        <div key={side}>
          <FieldRow name={side}><TextInput label={`${side} image`} value={entries[i]?.src ?? ""} placeholder="https://…" onCommit={(value) => setEntry(i, { src: value.trim() })} /></FieldRow>
          <FieldRow name="Label"><TextInput label={`${side} label`} value={entries[i]?.label ?? ""} placeholder={i === 0 ? "Önce" : "Sonra"} onCommit={(value) => setEntry(i, { label: value })} /></FieldRow>
        </div>
      ))}
      {embed.kind === "devices" && (
        <>
          <FieldRow name="Device">
            <Select label="Device" value={embed.variant === "browser" || embed.variant === "tablet" ? embed.variant : "phone"} options={[{ value: "phone", label: "Phone" }, { value: "tablet", label: "Tablet" }, { value: "browser", label: "Browser" }]} onChange={(value) => set({ variant: value as Embed["variant"] })} />
          </FieldRow>
          {entries.map((entry, i) => (
            <div key={entry.id} className="flex items-center">
              <div className="min-w-0 flex-1"><FieldRow name={`Screen ${i + 1}`}><TextInput label={`Screen ${i + 1}`} value={entry.src ?? ""} placeholder="https://…" onCommit={(value) => setEntry(i, { src: value.trim() })} /></FieldRow></div>
              <span className="pr-2"><IconButton label="Remove screen" icon={fi("minus.small")} onClick={() => set({ entries: entries.filter((_, j) => j !== i) })} /></span>
            </div>
          ))}
          <div className="px-4 pt-1">
            <button type="button" onClick={() => set({ entries: [...entries, { id: nid("e") }] })} className="flex w-full h-8 items-center justify-center rounded-[5px] border border-[var(--f-border)] text-[11px] font-[450] text-[var(--f-text)] hover:bg-[var(--f-bg-hover)] cursor-pointer">Add screen</button>
          </div>
        </>
      )}
      {(embed.kind === "image" || embed.kind === "compare") && (
        <FieldRow name="Ratio">
          <Select label="Aspect ratio" value={embed.aspectRatio ?? "16/9"} options={embed.kind === "image" ? ASPECTS.slice(0, 3) : ASPECTS} onChange={(value) => set({ aspectRatio: value as Embed["aspectRatio"] })} />
        </FieldRow>
      )}
      <FieldRow name={lang === BASE_LANGUAGE ? "Caption" : `Caption (${lang.toUpperCase()})`}>
        <TextArea label="Caption" value={(lang === BASE_LANGUAGE ? embed.caption : lang === "en" ? embed.captionEn : embed.captionI18n?.[lang]) ?? ""} placeholder="Optional" rows={2} onCommit={(value) => set(captionPatch(embed, lang, value))} />
      </FieldRow>
    </Section>
  );
}

/** Where a click on the layer goes, on the site: its link (none unless set). */
function LinkSection({ node, ops }: { node: SceneNode; ops: EditorOps }) {
  return (
    // Added empty (its field shows the address to type): an empty link links nowhere.
    <Section title="Link" muted={node.href === undefined} pb={node.href !== undefined ? 12 : 0} icons={node.href !== undefined ? <IconButton label="Remove link" icon={fi("minus.small")} onClick={() => ops.patch(node.id, { href: undefined })} /> : <IconButton label="Add link" icon={fi("plus.small")} onClick={() => ops.patch(node.id, { href: "" })} />}>
      {node.href !== undefined && (
        <FieldRow name="Address">
          <TextInput label="Link address" value={node.href} placeholder="https://…" onCommit={(value) => ops.patch(node.id, { href: value.trim() })} />
        </FieldRow>
      )}
    </Section>
  );
}

function ExportSection({ node, ops }: { node: SceneNode; ops: EditorOps }) {
  const settings = node.exports ?? [];
  const set = (next: ExportSetting[]) => ops.patch(node.id, { exports: next.length ? next : undefined });
  return (
    <Section title="Export" muted={!settings.length} pb={settings.length ? 12 : 0} icons={<IconButton label="Add export setting" icon={fi("plus.small")} onClick={() => set([...settings, { scale: (settings.length ? Math.min(4, settings.length + 1) : 1) as ExportSetting["scale"], format: "png" }])} />}>
      {settings.map((st, i) => (
        <PropRow key={i} icons={<IconButton label="Remove" icon={fi("minus.small")} onClick={() => set(settings.filter((_, j) => j !== i))} />}>
          <Select label="Scale" value={String(st.scale)} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n}x` }))} onChange={(v) => set(settings.map((x, j) => (j === i ? { ...x, scale: Number(v) as ExportSetting["scale"] } : x)))} />
          <Select label="Format" value={st.format} options={[{ value: "png", label: "PNG" }, { value: "jpg", label: "JPG" }, { value: "svg", label: "SVG" }]} onChange={(v) => set(settings.map((x, j) => (j === i ? { ...x, format: v as ExportSetting["format"] } : x)))} />
        </PropRow>
      ))}
      {settings.length > 0 && (
        <div className="px-4 pt-1">
          <button type="button" onClick={() => settings.forEach((st) => ops.exportNode(node.id, st))} className="flex w-full h-8 items-center justify-center rounded-[5px] border border-[var(--f-border)] text-[11px] font-[450] text-[var(--f-text)] hover:bg-[var(--f-bg-hover)] cursor-pointer">
            Export {node.name}
          </button>
        </div>
      )}
    </Section>
  );
}

/** Figma's Selection colors: every colour of its own in the selection, each once — changed here, it changes everywhere in it. */
function SelectionColors({ nodes, selection, ops, byId, mode }: { nodes: SceneNode[]; selection: readonly string[]; ops: EditorOps; byId: Map<string, DesignVariable>; mode: ThemeMode }) {
  const found = selection.filter((id) => !id.includes("/")).map((id) => getNode(nodes, id)).filter((n): n is SceneNode => Boolean(n));
  const colors = new Map<string, { opacity: number; variable?: DesignVariable }>();
  walk(found, (n) => {
    for (const p of [...(n.fills ?? []), ...(n.type !== "text" ? n.strokes ?? [] : [])]) {
      if (p.visible === false) continue;
      const key = "alias" in p.color ? `var:${p.color.alias}` : String(p.color.value).toLowerCase();
      if (!colors.has(key)) colors.set(key, { opacity: p.opacity ?? 100, variable: "alias" in p.color ? byId.get(p.color.alias) : undefined });
    }
  });
  if (colors.size < 2) return null;
  return (
    <Section title="Selection colors" pb={12}>
      {[...colors].map(([key, c]) => (
        <PropRow key={key} icons={<span className="w-6" />}>
          {c.variable ? (
            <div className="flex flex-1 min-w-0 items-center h-6 rounded-[5px] bg-[var(--f-bg-secondary)]">
              <Chit color={String(boundValue(c.variable.light, mode, byId) ?? "#000")} />
              <span className="truncate text-[11px] text-[var(--f-text)]">{splitName(c.variable.name)[1] || c.variable.name}</span>
            </div>
          ) : (
            <ColorInput label="Selection color" color={key} opacity={c.opacity} onColor={(hex) => ops.replaceColor(key, hex)} onOpacity={(opacity) => ops.replaceColor(key, key, opacity)} />
          )}
        </PropRow>
      ))}
    </Section>
  );
}

// ── The panel ─────────────────────────────────────────────────────────────────

/** Languages offered when one is added (a code and its name as its speakers write it). */
const LANGUAGE_SUGGESTIONS: Language[] = [
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "nl", name: "Nederlands" },
  { code: "ru", name: "Русский" },
  { code: "ar", name: "العربية" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "zh", name: "中文" },
  { code: "az", name: "Azərbaycanca" },
];

/** A language code: two or three letters, and a region after a dash ("pt-br"). */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/;

/**
 * The language the file is edited in, as Figma's variable mode row: the
 * collection's name at the left, the mode in an outlined field with its menu
 * (the languages, ticked; "Add language…" under a line), and "−" at the end
 * — which takes the language off with its words (not the base one).
 */
function LanguageRow({ languages, lang, ops }: { languages: Language[]; lang: LangCode; ops: EditorOps }) {
  const [adding, setAdding] = useState<{ top: number; right: number } | null>(null);
  const current = languages.find((l) => l.code === lang) ?? languages[0];
  const close = useCallback(() => setAdding(null), []);
  return (
    <>
      <PropRow icons={<IconButton label="Remove language" icon={fi("minus.small")} disabled={current.code === BASE_LANGUAGE} onClick={() => ops.removeLanguage(current.code)} />}>
        <span className="flex-1 min-w-0 truncate text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)] select-none">Language</span>
        <button
          type="button"
          aria-haspopup="menu"
          aria-label="Language"
          data-picker-anchor=""
          onClick={(e) => {
            const el = e.currentTarget;
            ops.menu(el, [
              ...languages.map((l) => ({ label: l.name, checked: l.code === current.code, onSelect: () => ops.setLanguage(l.code) })),
              "-",
              { label: "Add language…", onSelect: () => setAdding(anchorOf(el)) },
            ]);
          }}
          className={cn(FIELD_OUTLINED, "flex-1 pl-2 pr-1 cursor-pointer text-left")}
        >
          <span className="flex-1 min-w-0 truncate text-[11px] font-[450] leading-4 tracking-[0.055px] text-[var(--f-text)]">{current.name}</span>
          <span className="shrink-0 text-[var(--f-icon-secondary)]">{fi("16.chevron.down")}</span>
        </button>
      </PropRow>
      {adding && <AddLanguageWindow languages={languages} anchor={adding} onAdd={(language) => { ops.addLanguage(language); close(); }} onClose={close} />}
    </>
  );
}

/** The window that adds a language: its name and code (a suggestion fills both), then "Add". */
function AddLanguageWindow({ languages, anchor, onAdd, onClose }: { languages: Language[]; anchor: { top: number; right: number }; onAdd: (language: Language) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const taken = new Set(languages.map((l) => l.code));
  const clean = code.trim().toLowerCase();
  const problem = !name.trim() ? "" : !LANGUAGE_CODE.test(clean) ? "A code is two or three letters, like de or pt-br." : taken.has(clean) ? "That language is already in the file." : "";
  const ready = Boolean(name.trim()) && LANGUAGE_CODE.test(clean) && !taken.has(clean);
  const submit = () => ready && onAdd({ code: clean, name: name.trim() });
  return (
    <PropertyWindow title="Add language" anchor={anchor} onClose={onClose}>
      <WindowRow label="Name">
        <TextInput autoFocus label="Language name" value={name} placeholder="Deutsch" onChange={setName} />
      </WindowRow>
      <WindowRow label="Code">
        <TextInput label="Language code" value={code} placeholder="de" onChange={setCode} />
      </WindowRow>
      <div className="flex flex-col gap-2 mt-2 px-4 pt-3 pb-1 border-t border-[var(--f-border)]">
        <span className="h-4 flex items-center text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)]">Suggestions</span>
        <div className="flex flex-wrap gap-1">
          {LANGUAGE_SUGGESTIONS.filter((l) => !taken.has(l.code)).map((l) => (
            <button key={l.code} type="button" onClick={() => { setName(l.name); setCode(l.code); }} className="h-6 px-2 rounded-[5px] bg-[var(--f-bg-secondary)] text-[11px] leading-4 text-[var(--f-text)] cursor-pointer hover:bg-[var(--f-bg-hover)]">{l.name}</button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
        <span className="min-w-0 text-[11px] leading-4 text-[var(--f-text-secondary)]">{problem}</span>
        <BrandButton disabled={!ready} onClick={submit}>Add</BrandButton>
      </div>
    </PropertyWindow>
  );
}

function PageColor({ background, ops, variables, byId, mode }: { background: string; ops: EditorOps; variables: DesignVariable[]; byId: Map<string, DesignVariable>; mode: ThemeMode }) {
  const [picker, setPicker] = useState<{ top: number; right: number } | null>(null);
  // The page colour with its opacity, as Figma's row: kept as #RRGGBBAA when under 100.
  const hex = background.slice(0, 7);
  const opacity = background.length === 9 ? Math.round((parseInt(background.slice(7, 9), 16) / 255) * 100) : 100;
  const withOpacity = (h: string, o: number) => (o >= 100 ? h : `${h}${Math.round((o / 100) * 255).toString(16).padStart(2, "0")}`);
  return (
    <div className="relative flex flex-1 min-w-0">
      <ColorInput label="Canvas color" color={hex} opacity={opacity} onColor={(h) => ops.setBackground(withOpacity(h, opacity))} onOpacity={(o) => ops.setBackground(withOpacity(hex, o))} chit={<button type="button" data-picker-anchor="" aria-label="Color picker" onClick={(e) => setPicker(picker ? null : anchorOf(e.currentTarget))} className="cursor-pointer"><Chit color={background} /></button>} />
      {picker && <ColorPicker color={hex} opacity={opacity} anchor={picker} variables={variables} byId={byId} mode={mode} pageColors={ops.pageColors} onChange={(h, o) => ops.setBackground(withOpacity(h, o))} onClose={() => setPicker(null)} />}
    </div>
  );
}

/** A text's element on the site, as the panel names it. */
const TAG_LABEL: Record<NonNullable<TextNode["tag"]>, string> = { h1: "Heading 1 (the page's title)", h2: "Heading 2", h3: "Heading 3", h4: "Heading 4", p: "Paragraph", div: "Plain text" };

const KIND: Record<SceneNode["type"], string> = { frame: "Frame", rectangle: "Rectangle", ellipse: "Ellipse", line: "Line", text: "Text", component: "Component", componentSet: "Component set", instance: "Instance" };

export function Inspector({ nodes, pageNodes = nodes, selection, tab, ops: baseOps, variables, byId, mode, textStyles, lang, background, header }: {
  /** Every page's nodes (where main components are found) */
  nodes: SceneNode[];
  /** The open page's own — its flows */
  pageNodes?: SceneNode[];
  selection: readonly string[];
  tab: "design" | "prototype";
  ops: EditorOps;
  variables: DesignVariable[];
  byId: Map<string, DesignVariable>;
  mode: ThemeMode;
  textStyles: TextStyle[];
  lang: LangCode;
  background: string;
  header: (node: SceneNode) => MenuItem[];
}) {
  const first = selection[0];
  const composite = first?.includes("/") ? first : null;
  // Several layers selected: the panel shows the first, but what is changed in it goes to all of them (as Figma's).
  const ownIds = selection.filter((id) => !id.includes("/"));
  const ops: EditorOps = selection.length > 1 ? { ...baseOps, patch: (_id, p) => baseOps.patchMany(ownIds, p) } : baseOps;
  let node: SceneNode | null = null;
  let parent: FrameNode | null = null;
  if (composite) {
    // A layer inside an instance (a nested one's too), as drawn: its overrides on it.
    node = layerAt(nodes, composite)?.node ?? null;
  } else if (first) {
    const found = findNode(nodes, first);
    node = found?.node ?? null;
    parent = found?.parent ?? null;
  }

  if (!node) {
    if (tab === "prototype") return <PrototypeSection node={null} nodes={nodes} pageNodes={pageNodes} ops={ops} />;
    const pageFrame = getNode(nodes, ops.pageId);
    return (
      <div className="flex flex-col">
        <Section title="Page" icons={<IconButton label="Open variables" icon={fi("variable.small")} onClick={ops.openVariables} />}>
          <PropRow icons={<span className="w-6" />}>
            <PageColor background={background} ops={ops} variables={variables} byId={byId} mode={mode} />
          </PropRow>
          <LanguageRow languages={ops.languages} lang={lang} ops={ops} />
        </Section>
        <Section title="Styles" icons={<IconButton label="Create style" icon={fi("plus.small")} onClick={(e) => ops.menu(e.currentTarget, [{ label: "Create text style", onSelect: () => ops.createTextStyle(null) }, { label: "Create color style", onSelect: () => ops.createColorStyle("#000000") }, { label: "Create effect style", hint: "select a layer", disabled: true }])} />} pb={12}>
          <Labels a="Text styles" />
          <TextStyleTree styles={textStyles} byId={byId} variables={variables} mode={mode} ops={ops} />
          <Labels a="Color styles" className="pt-2" />
          <ColorStyleTree variables={variables.filter((v) => v.kind === "color")} byId={byId} mode={mode} onOpen={ops.openVariables} />
          <StyleRow depth={0} onClick={ops.openVariables}><span className="text-[var(--f-text-secondary)]">All variables ({variables.length})…</span></StyleRow>
          {ops.effectStyles.length > 0 && <Labels a="Effect styles" className="pt-2" />}
          {ops.effectStyles.map((st) => (
            <StyleRow key={st.id} depth={0} icon={<span className="text-[var(--f-icon-secondary)]">{fi("24.effects.small", 16)}</span>} trailing={<IconButton label="Delete style" icon={fi("minus.small")} onClick={() => ops.removeEffectStyle(st.id)} className="opacity-0 group-hover/srow:opacity-100" />}>
              {st.name}
            </StyleRow>
          ))}
        </Section>
        {pageFrame && <ExportSection node={pageFrame} ops={ops} />}
      </div>
    );
  }

  const multi = selection.length > 1;
  const inAuto = Boolean(parent && parent.layoutMode !== "none");
  // An instance: its look and layout as drawn (its component's, its own changes over them) — and what is changed of them its
  // override of its own frame (the key ""), as Figma's; its place, size and sizing stay the instance's own.
  const resolvedInstance = !composite && !multi && node.type === "instance" ? resolveInstance(nodes, node) : null;
  const shown: SceneNode = resolvedInstance ? { ...resolvedInstance, id: node.id } : node;
  const lookOps: EditorOps = resolvedInstance
    ? {
        ...ops,
        patch: (id, p) => {
          if (id !== node.id) return ops.patch(id, p);
          const look: Record<string, unknown> = {};
          const rest: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(p)) ((OVERRIDABLE as readonly string[]).includes(k) ? look : rest)[k] = v;
          if (Object.keys(look).length) ops.override(`${id}/`, look as NodeOverride);
          if (Object.keys(rest).length) ops.patch(id, rest as Partial<SceneNode>);
        },
      }
    : ops;
  // As Figma's: the header reads in the text's colour — a layer inside an instance in the component's purple.
  const purple = Boolean(composite);
  // As Figma's: a component, a set or an instance is headed by its (main) component's name; any other layer by its kind.
  const instanceMain = node.type === "instance" && node.mainId ? findComponent(nodes, node.mainId) : null;
  const instanceSet = instanceMain ? setOf(nodes, instanceMain.id) : null;
  const title = multi
    ? `${selection.length} selected`
    : node.type === "instance"
      ? instanceSet?.name ?? instanceMain?.name ?? node.name
      : node.type === "component" || node.type === "componentSet"
        ? node.name
        : KIND[node.type];
  // The selected layers themselves (several: their shared values, or "Mixed"), and whether they share a parent (the spacing between them).
  const selectedNodes = ownIds.map((id) => findNode(nodes, id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
  // Several layers whose lists differ: "Mixed" (what one of them has would otherwise be written over the others').
  const differs = (pick: (n: SceneNode) => unknown) => selectedNodes.length > 1 && selectedNodes.some((f) => JSON.stringify(pick(f.node) ?? []) !== JSON.stringify(pick(selectedNodes[0].node) ?? []));
  const mixedFills = differs((n) => n.fills);
  const mixedStrokes = differs((n) => (n.type === "text" ? undefined : n.strokes));
  const mixedEffects = differs((n) => (n.type === "text" ? undefined : n.effects));
  const sameParent = selectedNodes.length > 1 && selectedNodes.every((f) => (f.parent?.id ?? null) === (selectedNodes[0].parent?.id ?? null));
  const headerMenu = multi || composite ? [] : header(node);
  // A variant's set (a component in one).
  const componentSet = node.type === "component" ? setOf(nodes, node.id) : null;

  return (
    <div className="flex flex-col">
      {/* The layer header, as Figma's: the kind with its menu (the layers holding it); at the right, create component and "…". */}
      <div className="flex items-center justify-between h-12 pl-4 pr-3 py-1 border-b border-[var(--f-border)]">
        <ChevronMenu label="Layer" items={headerMenu.map((m) => ({ label: m.label, hint: m.hint, onSelect: m.onSelect }))} width={200} className={cn(headerMenu.length === 0 && "pointer-events-none")}>
          <span className={cn("truncate text-[13px] font-[550] leading-[22px] tracking-[-0.0325px]", purple ? "text-[var(--f-text-component)]" : "text-[var(--f-text)]")}>{title}</span>
        </ChevronMenu>
        <div className="flex items-center gap-2">
          {!composite && !multi && node.type === "frame" && <IconButton label="Create component (⌥⌘K)" icon={fi("component.small")} onClick={ops.createComponent} />}
          {/* A main component's, as Figma's: its variants selected (a set's, a variant's set's), its set, a variant added; its properties' menu. */}
          {!composite && !multi && (node.type === "componentSet" || componentSet) && (
            <IconButton label="Select all variants" icon={fi("select-matching.small")} onClick={() => { const set = node.type === "componentSet" ? node : componentSet!; ops.select(variantsOf(set).map((v) => v.id)); }} />
          )}
          {!composite && !multi && componentSet && <IconButton label="Select component set" icon={fi("16.component.set")} onClick={() => ops.select([componentSet.id])} />}
          {!composite && !multi && (node.type === "componentSet" || (node.type === "component" && !componentSet)) && (
            <IconButton label="Add variant" icon={fi("add-variant.small")} onClick={() => ops.addVariant(node.id)} />
          )}
          {!composite && !multi && (node.type === "componentSet" || node.type === "component") && (
            <IconButton label="Add property" icon={fi("24.adjust.small")} onClick={(e) => ops.menu(e.currentTarget, addPropertyEntries(node.type === "componentSet" ? node : componentSet ?? node, nodes, ops))} />
          )}
          {multi && <IconButton label={`Use as mask (${"^" + keys("mod", "m")})`} icon={fi("24.mask")} onClick={() => ops.maskWith(ownIds[0])} />}
          <IconButton label="More" icon={<span className="text-[var(--f-icon)]">{fi("24.more")}</span>} onClick={(e) => ops.more(e.currentTarget)} />
        </div>
      </div>
      {tab === "prototype" ? (
        <PrototypeSection node={node} nodes={nodes} pageNodes={pageNodes} ops={ops} />
      ) : composite ? (
        <>
          <Section title="Instance layer" icons={<IconButton label="More actions" icon={fi("24.more")} onClick={(e) => ops.menu(e.currentTarget, ops.instanceActions(composite))} />}>
            <p className="px-4 pt-1 text-[11px] leading-4 text-[var(--f-text-secondary)]">Layer of the main component: changes apply to this instance only.</p>
            <div className="pl-4 pr-3 py-2"><Checkbox label="Visible" checked={node.visible !== false} onChange={(v) => ops.override(composite, { visible: v })} /></div>
          </Section>
          {node.type === "text" && <TextSection node={node} nodes={nodes} ops={ops} variables={variables} byId={byId} mode={mode} textStyles={textStyles} lang={lang} compositeId={composite} />}
          <FillSection node={node} ops={ops} variables={variables} byId={byId} mode={mode} compositeId={composite} />
          {node.type !== "text" && <StrokeSection node={node} ops={ops} variables={variables} byId={byId} mode={mode} compositeId={composite} />}
        </>
      ) : (
        <>
          {!multi && isFrameLike(node) && node.embed && <EmbedSection key={node.id} node={node} ops={ops} lang={lang} />}
          {!multi && node.type === "instance" && <InstanceSection node={node} nodes={nodes} ops={ops} lang={lang} />}
          {!multi && node.type === "component" && componentSet && <CurrentVariantSection node={node} set={componentSet} ops={ops} />}
          {!multi && node.type === "component" && !componentSet && <PropertiesSection holder={node} nodes={nodes} ops={ops} />}
          {!multi && node.type === "componentSet" && <PropertiesSection holder={node} nodes={nodes} ops={ops} />}
          <PositionSection node={node} inAuto={inAuto} ops={ops} multi={selection} selected={selectedNodes.map((f) => f.node)} />
          {multi && selectedNodes.length > 1 ? (
            <MultiLayoutSection selected={selectedNodes.map((f) => f.node)} sameParent={sameParent} ops={ops} />
          ) : (
            <LayoutSection node={shown} parent={parent} ops={lookOps} variables={variables} byId={byId} mode={mode} />
          )}
          <AppearanceSection key={`a-${node.id}`} node={shown} nodes={nodes} ops={lookOps} variables={variables} byId={byId} mode={mode} />
          {node.type === "text" && <TextSection node={node} nodes={nodes} ops={ops} variables={variables} byId={byId} mode={mode} textStyles={textStyles} lang={lang} multi={multi} />}
          {shown.type !== "line" && <FillSection node={shown} ops={lookOps} variables={variables} byId={byId} mode={mode} mixed={mixedFills} />}
          {shown.type !== "text" && <StrokeSection node={shown} ops={lookOps} variables={variables} byId={byId} mode={mode} mixed={mixedStrokes} />}
          {shown.type !== "text" && <EffectsSection key={`e-${node.id}`} node={shown} ops={lookOps} pageColors={ops.pageColors} mixed={mixedEffects} />}
          <SelectionColors nodes={nodes} selection={selection} ops={ops} byId={byId} mode={mode} />
          {isFrameLike(node) && node.type !== "instance" && <LayoutGuideSection frame={node} ops={ops} />}
          {!multi && isFrameLike(node) && node.type !== "componentSet" && !node.embed && <LinkSection key={node.id} node={node} ops={ops} />}
          <ExportSection node={node} ops={ops} />
        </>
      )}
    </div>
  );
}

export { hexDigits };
