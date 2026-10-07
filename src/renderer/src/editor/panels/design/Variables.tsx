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
import { FieldPrefix, Icon, IconButton, MenuButton, Select, Swatch, cx, tooltipProps, type IconName, type MenuEntry } from "@/ds";
import type { Color, Guid, Paint } from "@/engine/codec";
import { useEditor } from "../../controller";
import { GEOMETRY_GROUPS, useDocumentVersion, useLocalAssets } from "../../hooks";
import { colorToHex, toPercent } from "../../model/color";
import { BIND_TYPE, modeCollections, paintVariable, splitName, variableBindings, type BindField, type Variable } from "../../model/variables";
import { bindPaint, bindVariable, modesAt, resolveAt, setExplicitMode } from "../../variables";
import { OpenVariablesButton, VariablePicker } from "../variables/VariablePicker";
import vstyles from "../variables/Variables.module.css";
import type { PanelNode } from "./shared";
import styles from "./Design.module.css";

/** The variable every node binds every one of `fields` to; null when none is bound, "mixed" when they differ. */
export function sharedBinding(nodes: readonly PanelNode[], fields: readonly string[]): Guid | null | "mixed" {
  let out: Guid | null | undefined;
  for (const n of nodes) {
    const b = variableBindings(n as never);
    for (const f of fields) {
      const id = b.get(f) ?? null;
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
  return { variable: null, name: n?.name ? splitName(n.name).leaf : "Missing variable", missing: true };
}

/** The pill of a bound field / paint: its glyph or swatch, the variable's name (a click opens the picker), Detach on hover. */
export function BoundPill({ id, prefix, swatch, label, onOpen, onDetach }: { id: Guid; prefix?: IconName | string; swatch?: ReactNode; label: string; onOpen: (anchor: HTMLElement) => void; onDetach: () => void }) {
  const { variable, name, missing } = useVariableName(id);
  return (
    <div className={vstyles.bound} data-bound-variable={variable?.name ?? name}>
      {prefix && <FieldPrefix prefix={prefix} className={vstyles.boundPrefix} />}
      {swatch}
      <button type="button" className={vstyles.pill} aria-label={`${label}: ${variable?.name ?? name}`} {...tooltipProps(variable?.name ?? name)} onClick={(e) => onOpen(e.currentTarget)}>
        <span className={cx(vstyles.pillText, missing && vstyles.pillMissing)}>{name}</span>
      </button>
      <button type="button" className={vstyles.detach} aria-label="Detach variable" {...tooltipProps("Detach variable")} onClick={onDetach}>
        <Icon name="24.detach.small" />
      </button>
    </div>
  );
}

/**
 * A field that can take a variable (`fields`: the VariableFields it writes — a horizontal padding writes left and
 * right): the field itself with "Apply variable" on hover, or the bound variable's pill.
 */
export function VariableField({ nodes, fields, prefix, children, disabled, button = true, open: openFrom, onOpenChange }: { nodes: readonly PanelNode[]; fields: readonly BindField[]; prefix?: IconName | string; children: ReactNode; disabled?: boolean; /** the hover button (W / H open the picker from their menu instead) */ button?: boolean; open?: HTMLElement | null; onOpenChange?: (anchor: HTMLElement | null) => void }) {
  const ed = useEditor();
  const [ownOpen, setOwnOpen] = useState<HTMLElement | null>(null);
  const open = openFrom !== undefined ? openFrom : ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const bound = sharedBinding(nodes, fields);
  const refs = nodes.map((n) => n.guid).filter((id) => !id.startsWith("I"));
  const spec = BIND_TYPE[fields[0]];
  if (!refs.length || disabled) return <>{children}</>;
  const bind = (id: Guid | null) => bindVariable(ed, refs, fields, id);
  const picker = open && (
    <VariablePicker
      anchor={open}
      types={[spec.type]}
      scope={spec.scope}
      current={typeof bound === "string" && bound !== "mixed" ? bound : null}
      consumer={refs[0]}
      onPick={(v) => bind(v.id)}
      footer={<OpenVariablesButton onDone={() => setOpen(null)} />}
      onClose={() => setOpen(null)}
    />
  );
  if (bound && bound !== "mixed") {
    return (
      <div className={vstyles.bindWrap} data-bind-field={fields.join(",")}>
        <BoundPill id={bound} prefix={prefix} label={spec.label} onOpen={setOpen} onDetach={() => bind(null)} />
        {picker}
      </div>
    );
  }
  return (
    <div className={vstyles.bindWrap} data-bind-field={fields.join(",")}>
      {children}
      {button && (
        <button type="button" className={vstyles.applyButton} aria-label="Apply variable" aria-expanded={!!open} {...tooltipProps("Apply variable")} onClick={(e) => setOpen(e.currentTarget)}>
          <Icon name="24.variable.small" />
        </button>
      )}
      {picker}
    </div>
  );
}

/** A paint row bound to a colour variable: the swatch (its colour now) and the variable's pill; Detach keeps the colour. */
export function BoundPaintRow({ nodes, field, index, paint, className }: { nodes: readonly PanelNode[]; field: "fillPaints" | "strokePaints"; index: number; paint: Paint; className?: string }) {
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const id = paintVariable(paint)!;
  const refs = nodes.map((n) => n.guid);
  const color = (paint.color ?? { r: 1, g: 1, b: 1, a: 1 }) as Color;
  return (
    <div className={cx(vstyles.bindWrap, className)} data-bind-field={`${field}[${index}].color`}>
      <BoundPill
        id={id}
        label={field === "fillPaints" ? "Fill" : "Stroke"}
        swatch={
          <span className={vstyles.boundPrefix}>
            <Swatch color={colorToHex(color)} opacity={toPercent((color.a ?? 1) * (paint.opacity ?? 1))} size={14} />
          </span>
        }
        onOpen={setOpen}
        onDetach={() => bindPaint(ed, refs, field, index, null)}
      />
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
  const ed = useEditor();
  const a = useLocalAssets();
  const version = useDocumentVersion(~GEOMETRY_GROUPS); // modes never change with a move or a resize
  const collections = modeCollections(a.collections);
  const first = refs[0];
  // Two engine reads per layer: not per render (the panel re-renders every frame of a drag), only per change.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the document (version) or the layer changed
  const modes = useMemo(() => (first ? modesAt(ed, first) : new Map<Guid, { mode: Guid; explicit: boolean; inherited: Guid }>()), [ed, first, version, a]);
  if (!refs.length) return null;
  if (!collections.length) return <IconButton icon="24.variable.mode.small" label="Apply variable mode" tone="secondary" disabled />;
  const entries: MenuEntry[] = collections.map((c) => {
    const m = modes.get(c.id);
    const inherited = c.modes.find((x) => x.id === m?.inherited)?.name ?? c.modes[0]?.name;
    return {
      id: `submenu:${c.id}`,
      label: c.name,
      items: [
        { id: `${c.id}|auto`, label: `Auto (${inherited})`, checked: !m?.explicit },
        "-",
        ...c.modes.map((x) => ({ id: `${c.id}|${x.id}`, label: x.name, checked: !!m?.explicit && m.mode === x.id })),
      ],
    };
  });
  return (
    <MenuButton
      label="Apply variable mode"
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
  const ed = useEditor();
  const a = useLocalAssets();
  const version = useDocumentVersion(~GEOMETRY_GROUPS);
  const key = refs.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the document (version) or the selection (key) changed
  const per = useMemo(() => refs.map((r) => modesAt(ed, r)), [ed, key, version, a]);
  if (!refs.length) return null;
  const rows = a.collections.filter((c) => per.every((m) => m.get(c.id)?.explicit));
  if (!rows.length) return null;
  return (
    <>
      {rows.map((c) => {
        const modes = per.map((m) => m.get(c.id)!.mode);
        const same = modes.every((m) => m === modes[0]);
        const inherited = c.modes.find((x) => x.id === per[0].get(c.id)?.inherited)?.name ?? c.modes[0]?.name;
        return (
          <div key={c.id} className={vstyles.modeRow} data-mode-row={c.name}>
            <div className={vstyles.modePill}>
              <span className={vstyles.modeIcon}>
                <Icon name="24.variable.mode.small" />
              </span>
              <span className={vstyles.modeName}>{c.name}</span>
              <Select
                label={`${c.name} mode`}
                variant="ghost"
                value={same ? modes[0] : "mixed"}
                options={[{ value: "auto", label: `Auto (${inherited})` }, "-", ...c.modes.map((m) => ({ value: m.id, label: m.name })), ...(same ? [] : [{ value: "mixed", label: "Mixed", disabled: true }])]}
                onChange={(v) => setExplicitMode(ed, refs, c.id, v === "auto" ? null : v)}
              />
            </div>
          </div>
        );
      })}
    </>
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
