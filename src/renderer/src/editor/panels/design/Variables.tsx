/**
 * Variables in the Design panel (UI3, R3-24…27): every bindable field shows
 * the "Apply variable" button at its right end on hover — the picker lists
 * the variables of the field's type and scope —; a bound field becomes the
 * variable's pill (a click re-opens the picker; the button on hover detaches,
 * keeping the value). Paint rows bound to a colour variable show it the same
 * way. "Apply variable mode" (Appearance with a selection, Page with
 * nothing selected) sets a collection's mode on the layers or the page, and
 * each mode set there shows as a row with its collection and the mode.
 */
import { useMemo, useState, type ReactNode } from "react";
import { FieldPrefix, Icon, IconButton, MenuButton, PropertyGrid, PropertyRow, Select, Swatch, cx, tooltipProps, type IconName, type MenuEntry } from "@/ds";
import type { Color, Guid, Paint } from "@/engine/codec";
import { useEditor } from "../../controller";
import { GEOMETRY_GROUPS, useDocumentVersion, useLocalAssets } from "../../hooks";
import { colorToHex, toPercent } from "../../model/color";
import { BIND_TYPE, VAR_TYPE_ICON_24, bindingWarning, effectMemberVariable, formatLiteral, modeCollections, paintVariable, splitName, variableBindings, type BindField, type Variable } from "../../model/variables";
import { bindEffect, bindPaint, bindVariable, modesAt, resolveAt, setExplicitMode, type EffectMember } from "../../variables";
import { OpenVariablesButton, VariablePicker } from "../variables/VariablePicker";
import vstyles from "../variables/Variables.module.css";
import type { PanelNode } from "./shared";
import { t, useT } from "@/i18n";
import styles from "./Design.module.css";

const isCornerField = (f: string) => f.startsWith("RECTANGLE_") && f.endsWith("_CORNER_RADIUS");
const CORNER_FIELDS = ["RECTANGLE_TOP_LEFT_CORNER_RADIUS", "RECTANGLE_TOP_RIGHT_CORNER_RADIUS", "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS"] as const;

/**
 * The variable every node binds every one of `fields` to; null when none is bound, "mixed" when they differ. A corner
 * without its own binding takes the layer's CORNER_RADIUS one (Figma's files and polygons / stars bind the radius as
 * one field; the engine resolves it first, a corner's own binding over it).
 */
export function sharedBinding(nodes: readonly PanelNode[], fields: readonly string[]): Guid | null | "mixed" {
  let out: Guid | null | undefined;
  for (const n of nodes) {
    const b = variableBindings(n as never);
    for (const f of fields) {
      const id = b.get(f) ?? (isCornerField(f) ? b.get("CORNER_RADIUS") : undefined) ?? null;
      if (out === undefined) out = id;
      else if (out !== id) return "mixed";
    }
  }
  return out ?? null;
}

/** The variable's name as a pill shows it (its leaf), or the deleted variable's own name. */
function useVariableName(id: Guid | null): { variable: Variable | null; name: string; missing: boolean } {
  const ed = useEditor();
  const a = useLocalAssets();
  if (!id) return { variable: null, name: "", missing: false };
  const v = a.lookup.variable(id) ?? null;
  if (v) return { variable: v, name: splitName(v.name).leaf, missing: false };
  const n = ed.engine.readNode(id) as { name?: string } | null;
  return { variable: null, name: n?.name ? splitName(n.name).leaf : t("Missing variable"), missing: true };
}

/**
 * The pill of a bound field / paint: its glyph or swatch, the variable's name (a click opens the picker), Detach on
 * hover. `warning`: the bound value isn't used as it is (atlas 11 §6) — the pill in Figma's "warning" style, the
 * reason in its tooltip; otherwise the tooltip is the name, the description and the value, a blank line between.
 * `showValue` (the owner's choice over Figma, 2026-10-22): the pill reads the value it resolves to, the name stays in
 * the tooltip.
 */
export function BoundPill({ id, prefix, swatch, label, warning, value, showValue, onOpen, onDetach }: { id: Guid; prefix?: IconName | string; swatch?: ReactNode; label: string; warning?: string | null; value?: string; showValue?: boolean; onOpen: (anchor: HTMLElement) => void; onDetach: () => void }) {
  useT();
  const { variable, name, missing } = useVariableName(id);
  const tip = warning ? t(warning) : [variable?.name ?? name, variable?.description, value].filter(Boolean).join("\n\n");
  return (
    <div className={vstyles.bound} data-bound-variable={variable?.name ?? name} data-warning={warning ? "" : undefined}>
      {prefix && <FieldPrefix prefix={prefix} className={vstyles.boundPrefix} />}
      {swatch}
      <button type="button" className={cx(vstyles.pill, warning && vstyles.pillWarning)} aria-label={`${t(label)}: ${variable?.name ?? name}`} {...tooltipProps(tip)} onClick={(e) => onOpen(e.currentTarget)}>
        <span className={cx(vstyles.pillText, missing && vstyles.pillMissing)}>{showValue && value !== undefined && !missing ? value : name}</span>
      </button>
      <button type="button" className={vstyles.detach} aria-label={t("Detach variable")} {...tooltipProps(t("Detach variable"))} onClick={onDetach}>
        <Icon name="24.detach.small" />
      </button>
    </div>
  );
}

/**
 * A field that can take a variable (`fields`: the VariableFields it writes — a horizontal padding writes left and
 * right): the field itself with "Apply variable" on hover, or the bound variable's pill. "Apply variable" is no tab
 * stop (Tab goes field to field, round 17): ⌥↓ in the field opens it (`data-field-menu`, NumericInput).
 */
export function VariableField({ nodes, fields, prefix, children, disabled, button = true, open: openFrom, onOpenChange, className }: { nodes: readonly PanelNode[]; fields: readonly BindField[]; prefix?: IconName | string; children: ReactNode; disabled?: boolean; /** the wrapper's class (a popover's fixed field width) */ className?: string; /** the hover button (W / H open the picker from their menu instead) */ button?: boolean; open?: HTMLElement | null; onOpenChange?: (anchor: HTMLElement | null) => void }) {
  useT();
  const ed = useEditor();
  const [ownOpen, setOwnOpen] = useState<HTMLElement | null>(null);
  const open = openFrom !== undefined ? openFrom : ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const bound = sharedBinding(nodes, fields);
  // Instance sublayers too: they show the binding they inherit and take one as an override, as in Figma
  const refs = nodes.map((n) => n.guid);
  // The four corners together are one "Corner radius"
  const spec = fields.length === 4 && fields.every((f) => f.startsWith("RECTANGLE_") && f.endsWith("_CORNER_RADIUS")) ? BIND_TYPE.CORNER_RADIUS : BIND_TYPE[fields[0]];
  if (!refs.length || disabled) return <>{children}</>;
  const bind = (id: Guid | null) => {
    // A corner's change on a layer whose radius is bound as one (CORNER_RADIUS): the binding moves onto the corners that
    // had none of their own first, then this field changes — one step.
    const whole = fields.some(isCornerField) ? (ed.engine.readNodes(refs) as PanelNode[]).filter((n) => variableBindings(n as never).has("CORNER_RADIUS")) : [];
    if (!whole.length) return bindVariable(ed, refs, fields, id);
    ed.batch(id ? "Apply variable" : "Detach variable", () => {
      for (const n of whole) {
        const b = variableBindings(n as never);
        const own = CORNER_FIELDS.filter((f) => !b.has(f) && !fields.includes(f));
        const r = b.get("CORNER_RADIUS")!;
        bindVariable(ed, [n.guid], ["CORNER_RADIUS"], null);
        if (own.length) bindVariable(ed, [n.guid], own, r);
      }
      bindVariable(ed, refs, fields, id);
    });
  };
  const picker = open && (
    <VariablePicker
      anchor={open}
      types={[spec.type, ...(spec.also ?? [])]}
      scope={spec.scope}
      current={typeof bound === "string" && bound !== "mixed" ? bound : null}
      consumer={refs[0]}
      onPick={(v) => bind(v.id)}
      footer={<OpenVariablesButton onDone={() => setOpen(null)} />}
      onClose={() => setOpen(null)}
    />
  );
  if (bound && bound !== "mixed") {
    // The value as the first layer sees it (its modes): a warning when the field can't use it as it is.
    const value = resolveAt(ed, bound, refs[0]);
    const warning = bindingWarning(fields[0], value, nodes[0] as never);
    return (
      <div className={cx(vstyles.bindWrap, className)} data-bind-field={fields.join(",")}>
        <BoundPill id={bound} prefix={prefix} label={spec.label} warning={warning} value={typeof value === "number" ? formatLiteral("FLOAT", value) : typeof value === "string" ? value : undefined} showValue onOpen={setOpen} onDetach={() => bind(null)} />
        {picker}
      </div>
    );
  }
  return (
    <div className={cx(vstyles.bindWrap, className)} data-bind-field={fields.join(",")}>
      {children}
      {button && (
        <button type="button" className={vstyles.applyButton} aria-label={t("Apply variable")} aria-expanded={!!open} tabIndex={-1} data-field-menu="" {...tooltipProps(t("Apply variable"))} onClick={(e) => setOpen(e.currentTarget)}>
          <Icon name="24.variable.small" />
        </button>
      )}
      {picker}
    </div>
  );
}

/** The picker of a layer's visibility: boolean variables, and True / False (the plain value back, the variable detached). */
function VisibilityPicker({ nodes, anchor, current, onClose }: { nodes: readonly PanelNode[]; anchor: HTMLElement; current: Guid | null; onClose: () => void }) {
  useT();
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const literal = (on: boolean) => () =>
    ed.batch(on ? "Show" : "Hide", () => {
      if (sharedBinding(ed.engine.readNodes(refs) as PanelNode[], ["VISIBLE"]) !== null) bindVariable(ed, refs, ["VISIBLE"], null);
      ed.engine.setProps(refs, { visible: on } as never);
    });
  const visible = current ? null : nodes.every((n) => n.visible !== false) ? true : nodes.every((n) => n.visible === false) ? false : null;
  return (
    <VariablePicker
      anchor={anchor}
      types={["BOOLEAN"]}
      scope={BIND_TYPE.VISIBLE.scope}
      current={current}
      consumer={refs[0]}
      literals={[
        { id: "true", label: t("True"), checked: visible === true, onPick: literal(true) },
        { id: "false", label: t("False"), checked: visible === false, onPick: literal(false) },
      ]}
      onPick={(v) => bindVariable(ed, refs, ["VISIBLE"], v.id)}
      footer={<OpenVariablesButton onDone={onClose} />}
      onClose={onClose}
    />
  );
}

/**
 * A layer's visibility bound to a boolean variable (Appearance, under Opacity / Corner radius — as Figma shows it): a
 * row of its own over both field columns, the toggle glyph and the variable's pill; a click opens the boolean variables
 * (and True / False), Detach variable on hover keeps the layer as it shows now. Layers bound to different variables, or
 * some bound and some not, show "Mixed". Nothing when no layer's visibility is bound.
 */
export function VisibilityVariableRow({ nodes }: { nodes: readonly PanelNode[] }) {
  useT();
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const bound = nodes.length ? sharedBinding(nodes, ["VISIBLE"]) : null;
  if (!bound) return null;
  const refs = nodes.map((n) => n.guid);
  const detach = () => bindVariable(ed, refs, ["VISIBLE"], null);
  const value = bound === "mixed" ? null : resolveAt(ed, bound, refs[0]);
  return (
    <PropertyRow span={2} data-visibility-variable={bound === "mixed" ? "mixed" : ""}>
      <div className={vstyles.bindWrap} data-bind-field="VISIBLE">
        {bound === "mixed" ? (
          <div className={vstyles.bound} data-bound-variable="mixed">
            <FieldPrefix prefix={VAR_TYPE_ICON_24.BOOLEAN} className={vstyles.boundPrefix} />
            <button type="button" className={vstyles.pill} aria-label={`${t("Visibility")}: ${t("Mixed")}`} onClick={(e) => setOpen(e.currentTarget)}>
              <span className={vstyles.pillText}>{t("Mixed")}</span>
            </button>
            <button type="button" className={vstyles.detach} aria-label={t("Detach variable")} {...tooltipProps(t("Detach variable"))} onClick={detach}>
              <Icon name="24.detach.small" />
            </button>
          </div>
        ) : (
          <BoundPill id={bound} prefix={VAR_TYPE_ICON_24.BOOLEAN} label={BIND_TYPE.VISIBLE.label} value={typeof value === "boolean" ? formatLiteral("BOOLEAN", value) : undefined} onOpen={setOpen} onDetach={detach} />
        )}
        {open && <VisibilityPicker nodes={nodes} anchor={open} current={bound === "mixed" ? null : bound} onClose={() => setOpen(null)} />}
      </div>
    </PropertyRow>
  );
}

/**
 * "Apply variable" for a layer's visibility (Appearance's header, after Hide): the boolean variables (and True / False).
 * Only while the file has boolean variables and no selected layer's visibility is bound (the row shows the binding then).
 */
export function VisibilityVariableButton({ nodes }: { nodes: readonly PanelNode[] }) {
  useT();
  const a = useLocalAssets();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  if (!nodes.length || !a.variables.some((v) => v.type === "BOOLEAN") || sharedBinding(nodes, ["VISIBLE"]) !== null) return null;
  return (
    <>
      <IconButton icon="24.variable.small" label={t("Apply variable")} tone="secondary" aria-expanded={!!open} data-apply-variable="VISIBLE" onClick={(e) => setOpen(open ? null : e.currentTarget)} />
      {open && <VisibilityPicker nodes={nodes} anchor={open} current={null} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Figma's tooltip hex: three digits when each pair repeats ("#000"), else six. */
function shortHex(hex: string): string {
  const h = hex.replace("#", "").toLowerCase();
  return h.length === 6 && h[0] === h[1] && h[2] === h[3] && h[4] === h[5] ? `#${h[0]}${h[2]}${h[4]}` : `#${h}`;
}

/**
 * A colour bound to a variable, as live shows it (2026-10-22, Fill and Selection colors): an outlined field — the
 * colour's swatch, the variable's name — whose tooltip is the name, a blank line and "#000 · 89.8%". `onDetach`:
 * hovering narrows it for Detach variable, 4 after it.
 */
export function ColorVariablePill({ id, color, opacity = 1, label, onOpen, onDetach, className }: { id: Guid; color: Color; opacity?: number; label: string; onOpen: (anchor: HTMLElement) => void; onDetach?: () => void; className?: string }) {
  useT();
  const { variable, name, missing } = useVariableName(id);
  const alpha = (color.a ?? 1) * opacity;
  const pct = Math.round(alpha * 1000) / 10;
  const tip = [variable?.name ?? name, `${shortHex(colorToHex(color))} · ${pct}%`].join("\n\n");
  return (
    <div className={cx(vstyles.colorBound, className)} data-bound-variable={variable?.name ?? name}>
      <button type="button" className={vstyles.colorPill} aria-label={`${t(label)}: ${variable?.name ?? name}`} {...tooltipProps(tip)} onClick={(e) => onOpen(e.currentTarget)}>
        <Swatch color={colorToHex(color)} opacity={toPercent(alpha)} size={14} />
        <span className={cx(vstyles.pillText, missing && vstyles.pillMissing)}>{variable?.name ?? name}</span>
      </button>
      {onDetach && <IconButton icon="24.detach.small" label={t("Detach variable")} tone="secondary" className={vstyles.colorDetach} onClick={onDetach} />}
    </div>
  );
}

/** The effect fields a variable binds, by their field labels (the effect settings popover). */
const EFFECT_FIELD_LABEL: Record<EffectMember, string> = { x: "Position X", y: "Position Y", radius: "Blur radius", spread: "Spread", color: "Color" };

/** The variable every layer binds effect `index`'s `member` to; null when none, "mixed" when they differ. */
function sharedEffectBinding(nodes: readonly PanelNode[], index: number, member: EffectMember): Guid | null | "mixed" {
  const ids = nodes.map((n) => effectMemberVariable(((n.effects ?? []) as object[])[index], member));
  return ids.every((x) => x === ids[0]) ? (ids[0] ?? null) : "mixed";
}

/**
 * An effect's number in its settings popover that takes a variable (Effect.radiusVar, spreadVar, xVar, yVar — number
 * variables scoped to Effects): the field with "Apply variable" on hover, or the bound variable's pill (a click picks
 * another, Detach on hover keeps the value) — as the panel's own fields (VariableField).
 */
export function EffectVariableField({ nodes, index, member, prefix, children, className }: { nodes: readonly PanelNode[]; index: number; member: Exclude<EffectMember, "color">; prefix?: IconName | string; children: ReactNode; className?: string }) {
  useT();
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const refs = nodes.map((n) => n.guid);
  if (!refs.length) return <>{children}</>;
  const bound = sharedEffectBinding(nodes, index, member);
  const bind = (id: Guid | null) => bindEffect(ed, refs, index, member, id);
  const picker = open && (
    <VariablePicker
      anchor={open}
      types={["FLOAT"]}
      scope="EFFECT_FLOAT"
      current={bound && bound !== "mixed" ? bound : null}
      consumer={refs[0]}
      onPick={(v) => bind(v.id)}
      footer={<OpenVariablesButton onDone={() => setOpen(null)} />}
      onClose={() => setOpen(null)}
    />
  );
  const attrs = { className: cx(vstyles.bindWrap, className), "data-bind-field": `effects[${index}].${member}` };
  if (bound && bound !== "mixed") {
    const value = resolveAt(ed, bound, refs[0]);
    return (
      <div {...attrs}>
        <BoundPill id={bound} prefix={prefix} label={EFFECT_FIELD_LABEL[member]} value={typeof value === "number" ? formatLiteral("FLOAT", value) : undefined} showValue onOpen={setOpen} onDetach={() => bind(null)} />
        {picker}
      </div>
    );
  }
  return (
    <div {...attrs}>
      {children}
      <button type="button" className={vstyles.applyButton} aria-label={t("Apply variable")} aria-expanded={!!open} tabIndex={-1} data-field-menu="" {...tooltipProps(t("Apply variable"))} onClick={(e) => setOpen(e.currentTarget)}>
        <Icon name="24.variable.small" />
      </button>
      {picker}
    </div>
  );
}

/**
 * An effect's colour bound to a colour variable (Effect.colorVar, the effect settings popover): the outlined variable
 * field as Fill's (a click picks another colour variable scoped to Effects, Detach keeps the colour). `children` (the
 * colour field) while it isn't bound.
 */
export function EffectColorField({ nodes, index, color, children }: { nodes: readonly PanelNode[]; index: number; color: Color; children: ReactNode }) {
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const refs = nodes.map((n) => n.guid);
  const bound = refs.length ? sharedEffectBinding(nodes, index, "color") : null;
  if (!bound || bound === "mixed") return <>{children}</>;
  return (
    <div className={vstyles.bindWrap} data-bind-field={`effects[${index}].color`}>
      <ColorVariablePill id={bound} color={color} label="Color" onOpen={setOpen} onDetach={() => bindEffect(ed, refs, index, "color", null)} />
      {open && <VariablePicker anchor={open} types={["COLOR"]} scope="EFFECT_COLOR" current={bound} consumer={refs[0]} onPick={(v) => bindEffect(ed, refs, index, "color", v.id)} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** A paint row bound to a colour variable (live 2026-10-22): the outlined variable field; Detach keeps the colour. */
/**
 * A paint bound to a colour variable: its pill opens the colour picker on its Libraries tab, the variable marked
 * (`onPick`: the section's picker; live Figma — not "Apply variable"); without `onPick`, the variable list.
 */
export function BoundPaintRow({ nodes, field, index, paint, onPick, className }: { nodes: readonly PanelNode[]; field: "fillPaints" | "strokePaints"; index: number; paint: Paint; onPick?: (anchor: DOMRect) => void; className?: string }) {
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const id = paintVariable(paint)!;
  const refs = nodes.map((n) => n.guid);
  const color = (paint.color ?? { r: 1, g: 1, b: 1, a: 1 }) as Color;
  return (
    <div className={cx(vstyles.bindWrap, className)} data-bind-field={`${field}[${index}].color`}>
      <ColorVariablePill id={id} color={color} opacity={paint.opacity ?? 1} label={field === "fillPaints" ? "Fill" : "Stroke"} onOpen={onPick ? (el) => onPick(el.getBoundingClientRect()) : setOpen} onDetach={() => bindPaint(ed, refs, field, index, null)} />
      {open && (
        <VariablePicker
          anchor={open}
          types={["COLOR"]}
          scope={paintScope(nodes, field)}
          current={id}
          consumer={refs[0]}
          onPick={(v) => bindPaint(ed, refs, field, index, v.id)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/** The scope a paint field asks for: Frame / Shape / Text fill, or Stroke. */
export function paintScope(nodes: readonly PanelNode[], field: "fillPaints" | "strokePaints"): string {
  if (field === "strokePaints") return "STROKE";
  if (nodes.every((n) => n.type === "TEXT")) return "TEXT_FILL";
  if (nodes.every((n) => ["FRAME", "SYMBOL", "INSTANCE", "SECTION"].includes(n.type ?? ""))) return "FRAME_FILL";
  return "SHAPE_FILL";
}

// ---- Apply variable mode ---------------------------------------------------------------------------------------------

/** "Apply variable mode": per collection with modes, Auto (the inherited mode) or one of its modes. */
export function ApplyModeButton({ refs }: { refs: readonly Guid[] }) {
  useT();
  const ed = useEditor();
  const a = useLocalAssets();
  const version = useDocumentVersion(~GEOMETRY_GROUPS); // modes never change with a move or a resize
  const collections = modeCollections(a.collections);
  const first = refs[0];
  // Two engine reads per layer: not per render (the panel re-renders every frame of a drag), only per change.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the document (version) or the layer changed
  const modes = useMemo(() => (first ? modesAt(ed, first) : new Map<Guid, { mode: Guid; explicit: boolean; inherited: Guid }>()), [ed, first, version, a]);
  if (!refs.length) return null;
  // No collection with modes: Figma's live panel shows no button at all.
  if (!collections.length) return null;
  const entries: MenuEntry[] = collections.map((c) => {
    const m = modes.get(c.id);
    const inherited = c.modes.find((x) => x.id === m?.inherited)?.name ?? c.modes[0]?.name;
    return {
      id: `submenu:${c.id}`,
      label: c.name,
      items: [
        { id: `${c.id}|auto`, label: t("Auto ({mode})", { mode: inherited ?? "" }), checked: !m?.explicit },
        "-",
        ...c.modes.map((x) => ({ id: `${c.id}|${x.id}`, label: x.name, checked: !!m?.explicit && m.mode === x.id })),
      ],
    };
  });
  return (
    <MenuButton
      label={t("Apply variable mode")}
      entries={entries}
      className={styles.iconMenu}
      onSelect={(id) => {
        const [c, mode] = id.split("|");
        if (c && mode) setExplicitMode(ed, refs, c, mode === "auto" ? null : mode);
      }}
    >
      <Icon name="24.variable.mode.small" />
    </MenuButton>
  );
}

/** The modes set on the layers (or the page): a row per collection with its mode (Auto clears it). */
export function ModeRows({ refs }: { refs: readonly Guid[] }) {
  useT();
  const ed = useEditor();
  const a = useLocalAssets();
  const version = useDocumentVersion(~GEOMETRY_GROUPS);
  const key = refs.join(",");
  // A row shows only for a collection every selected layer sets explicitly: none without collections, and the read
  // stops at the first layer that sets none (a large selection doesn't ask the engine about each of its layers).
  const per = useMemo(() => {
    if (!a.collections.length) return null;
    const out: ReturnType<typeof modesAt>[] = [];
    for (const r of refs) {
      const m = modesAt(ed, r);
      if (![...m.values()].some((x) => x.explicit)) return null;
      out.push(m);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the document (version) or the selection (key) changed
  }, [ed, key, version, a]);
  if (!refs.length || !per) return null;
  const rows = a.collections.filter((c) => per.every((m) => m.get(c.id)?.explicit));
  if (!rows.length) return null;
  // Live (2026-10-22, the Page section): the collection's name in the first field column, its mode in an outlined
  // menu in the second, and "—" at the row's end to put it back on Auto.
  return (
    <PropertyGrid>
      {rows.map((c) => {
        const modes = per.map((m) => m.get(c.id)!.mode);
        const same = modes.every((m) => m === modes[0]);
        const inherited = c.modes.find((x) => x.id === per[0].get(c.id)?.inherited)?.name ?? c.modes[0]?.name;
        return (
          <PropertyRow
            key={c.id}
            data-mode-row={c.name}
            action={<IconButton icon="24.minus.small" label={t("Remove variable mode")} tone="secondary" onClick={() => setExplicitMode(ed, refs, c.id, null)} />}
          >
            <span className={vstyles.modeName}>{c.name}</span>
            <Select
              label={t("{name} mode", { name: c.name })}
              variant="outlined"
              value={same ? modes[0] : "mixed"}
              options={[{ value: "auto", label: t("Auto ({mode})", { mode: inherited ?? "" }) }, "-", ...c.modes.map((m) => ({ value: m.id, label: m.name })), ...(same ? [] : [{ value: "mixed", label: t("Mixed"), disabled: true }])]}
              onChange={(v) => setExplicitMode(ed, refs, c.id, v === "auto" ? null : v)}
            />
          </PropertyRow>
        );
      })}
    </PropertyGrid>
  );
}

/** A colour variable's value at a layer (for previews). */
export function useResolvedColor(id: Guid | null, consumer: Guid | null): Color | null {
  const ed = useEditor();
  useLocalAssets();
  if (!id) return null;
  const v = resolveAt(ed, id, consumer);
  return v && typeof v === "object" ? (v as Color) : null;
}

export { styles as designStyles };
