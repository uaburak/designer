/**
 * The Layout section's sizing (Figma UI3): W / H fields whose menu holds Fixed
 * width / Hug contents / Fill container, then Add min width… / Add max width…
 * (or Remove min and max); "Hug" / "Fill" read in the field until it's focused,
 * and typing a number makes the axis Fixed. min / max rows under the fields.
 * The auto-layout settings popover: spacing mode, strokes in layout, canvas
 * stacking, text baseline. All on the schema's fields (model/sizing.ts).
 */
import { useRef, useState } from "react";
import { Checkbox, Icon, IconButton, MenuButton, NumericInput, Popover, PropertyRow, Select, isMixed, type ChangeInfo, type MenuEntry } from "@/ds";
import { useEditor, type EditorController } from "../../controller";
import { supportsField } from "../../engineCompat";
import { fieldValue, mixed, mixedNumber } from "../../model/mixed";
import { roundPanel } from "../../model/geometry";
import { canFill, canHug, canLimit, hasLimits, isAutoLayout, limitOf, newLimit, sizingChanges, sizingOf, withLimit, withoutLimits, type Axis, type Limit, type Sizing } from "../../model/sizing";
import { exitToCanvas } from "./Sections";
import { VariableField } from "./Variables";
import { fields, isGroupNode, type PanelNode } from "./shared";
import styles from "./Design.module.css";

const AXIS_WORD: Record<Axis, string> = { x: "width", y: "height" };
const stepInfo: ChangeInfo = { final: true, source: "step" };

/** Sizing writes for every node (and the parents that change with them), as one undo step. */
function applySizing(ed: EditorController, nodes: readonly PanelNode[], parents: readonly (PanelNode | null)[], axis: Axis, mode: Sizing) {
  ed.batch(mode === "FILL" ? "Fill container" : mode === "HUG" ? "Hug contents" : `Fixed ${AXIS_WORD[axis]}`, () => {
    nodes.forEach((n, i) => {
      const { node, parent } = sizingChanges(n, parents[i], axis, mode);
      if (parent && parents[i]) ed.engine.setProps([parents[i]!.guid], parent);
      if (Object.keys(node).length) ed.engine.setProps([n.guid], node);
    });
  });
}

/** The W or H field with its sizing menu. */
export function SizeField({ axis, nodes, parents, onAddLimit }: { axis: Axis; nodes: PanelNode[]; parents: (PanelNode | null)[]; onAddLimit: (axis: Axis) => void }) {
  const ed = useEditor();
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const word = AXIS_WORD[axis];
  const value = mixedNumber(nodes.map((n) => roundPanel(n.size?.[axis] ?? 0)));
  const sizing = mixed(nodes.map((n, i) => sizingOf(n, parents[i], axis)));
  const groups = nodes.some(isGroupNode);
  // Text hugs through textAutoResize, which the engine keeps with E3.
  const textKept = supportsField(ed.engine, "textAutoResize");
  const hugs = (n: PanelNode) => canHug(n) && (n.type !== "TEXT" || textKept);
  const hug = nodes.some(hugs);
  const fill = nodes.some((n, i) => canFill(n, parents[i]));
  const limits = nodes.every((n, i) => canLimit(n, parents[i]));
  const limited = nodes.some((n) => hasLimits(n, axis));

  const setSize = (v: number, info: ChangeInfo) =>
    ed.edit("Resize", info, () => {
      ed.engine.readNodes(nodes.map((n) => n.guid)).forEach((fresh, i) => {
        const n = ed.withRealType(fresh) as PanelNode;
        const s = n.size ?? { x: 0, y: 0 };
        const keep = n.proportionsConstrained && s.x > 0 && s.y > 0;
        const size = axis === "x" ? { x: v, y: keep ? (v * s.y) / s.x : s.y } : { x: keep ? (v * s.x) / s.y : s.x, y: v };
        // A typed size makes the axis Fixed (Figma).
        const fixed = sizingOf(n, parents[i], axis) === "FIXED" ? {} : sizingChanges(n, parents[i], axis, "FIXED").node;
        ed.engine.setProps([n.guid], { ...fixed, size: { x: Math.max(0.01, size.x), y: Math.max(0.01, size.y) } });
      });
    });
  const stepSize = (d: number) =>
    ed.edit("Resize", stepInfo, () => {
      for (const n of ed.engine.readNodes(nodes.map((x) => x.guid))) if (n.size) ed.engine.setProps([n.guid], { size: axis === "x" ? { x: Math.max(0.01, n.size.x + d), y: n.size.y } : { x: n.size.x, y: Math.max(0.01, n.size.y + d) } });
    });

  const entries: MenuEntry[] = [
    { id: "FIXED", label: `Fixed ${word}`, checked: sizing === "FIXED", hint: isMixed(value) || value === undefined ? undefined : String(value) },
    ...(hug ? [{ id: "HUG", label: "Hug contents", checked: sizing === "HUG", disabled: !nodes.every(hugs) }] : []),
    ...(fill ? [{ id: "FILL", label: "Fill container", checked: sizing === "FILL", disabled: !nodes.every((n, i) => canFill(n, parents[i])) }] : []),
    ...(limits
      ? [
          "-" as const,
          ...(limited
            ? [{ id: "remove-limits", label: "Remove min and max" }]
            : [
                { id: "add-min", label: `Add min ${word}…` },
                { id: "add-max", label: `Add max ${word}…` },
              ]),
        ]
      : []),
    "-",
    { id: "apply-variable", label: "Apply variable…" },
  ];
  const menu = true;
  const onMenu = (id: string) => {
    if (id === "apply-variable") return setPicker(field.current?.querySelector<HTMLElement>("[data-bind-field]") ?? null);
    if (id === "FIXED" || id === "HUG" || id === "FILL") applySizing(ed, nodes, parents, axis, id);
    else if (id === "remove-limits") ed.batch(`Remove min and max ${word}`, () => nodes.forEach((n) => ed.engine.setProps([n.guid], withoutLimits(n, axis))));
    else if (id === "add-min" || id === "add-max") {
      const which: Limit = id === "add-min" ? "min" : "max";
      ed.batch(`Add ${which} ${word}`, () => nodes.forEach((n) => ed.engine.setProps([n.guid], withLimit(n, which, axis, newLimit(n, axis)))));
      onAddLimit(axis);
    }
    ed.focusCanvas();
  };
  const label = sizing === "HUG" ? "Hug" : sizing === "FILL" ? "Fill" : undefined;
  return (
    <div ref={field} style={{ display: "contents" }}>
    <VariableField nodes={nodes} fields={[axis === "x" ? "WIDTH" : "HEIGHT"]} prefix={axis === "x" ? "W" : "H"} button={false} open={picker} onOpenChange={setPicker} disabled={groups}>
    <NumericInput
      label={axis === "x" ? "Width" : "Height"}
      prefix={axis === "x" ? "W" : "H"}
      className={styles.sizeField}
      value={fieldValue(value)}
      valueLabel={label}
      min={0.01}
      disabled={groups}
      onChange={setSize}
      onCancel={() => ed.cancelEdit()}
      onStep={stepSize}
      onExit={exitToCanvas(ed)}
      suffix={
        menu && !groups ? (
          <MenuButton label={`${axis === "x" ? "Width" : "Height"} sizing`} entries={entries} onSelect={onMenu} className={styles.sizeMenu}>
            <Icon name="16.chevron.down" />
          </MenuButton>
        ) : undefined
      }
    />
    </VariableField>
    </div>
  );
}

/** The min / max fields of one axis (shown once a limit exists, or right after "Add min …"). */
export function LimitRow({ axis, nodes }: { axis: Axis; nodes: PanelNode[] }) {
  const ed = useEditor();
  const word = AXIS_WORD[axis];
  const value = (which: Limit) => {
    const vs = nodes.map((n) => limitOf(n, which, axis));
    if (vs.every((v) => v === null)) return null;
    return fieldValue(mixedNumber(vs.map((v) => v ?? 0)));
  };
  const set = (which: Limit, v: number | null, info: ChangeInfo) =>
    ed.edit(`${which === "min" ? "Min" : "Max"} ${word}`, info, () => {
      for (const n of ed.engine.readNodes(nodes.map((x) => x.guid)) as PanelNode[]) ed.engine.setProps([n.guid], withLimit(n, which, axis, v));
    });
  const field = (which: Limit) => (
    <VariableField nodes={nodes} fields={[`${which.toUpperCase()}_${axis === "x" ? "WIDTH" : "HEIGHT"}` as "MIN_WIDTH"]} prefix={`24.al.${word}-${which}` as "24.al.width-min"}>
    <NumericInput
      label={`${which === "min" ? "Min" : "Max"} ${word}`}
      prefix={`24.al.${word}-${which}` as "24.al.width-min"}
      placeholder={`${which === "min" ? "Min" : "Max"} ${axis === "x" ? "W" : "H"}`}
      value={value(which)}
      min={0}
      onChange={(v, info) => set(which, v, info)}
      onClear={() => set(which, null, { final: true, source: "type" })}
      onCancel={() => ed.cancelEdit()}
      onExit={exitToCanvas(ed)}
    />
    </VariableField>
  );
  return (
    <PropertyRow
      label={`Min and max ${word}`}
      action={<IconButton icon="24.minus.small" label={`Remove min and max ${word}`} tone="secondary" onClick={() => ed.batch(`Remove min and max ${word}`, () => nodes.forEach((n) => ed.engine.setProps([n.guid], withoutLimits(n, axis))))} />}
    >
      {field("min")}
      {field("max")}
    </PropertyRow>
  );
}

/** Which axes show their min / max row. */
export function useLimitAxes(nodes: PanelNode[]): { axes: Axis[]; open: (axis: Axis) => void } {
  const [added, setAdded] = useState<{ key: string; axes: Axis[] }>({ key: "", axes: [] });
  const key = nodes.map((n) => n.guid).join(",");
  const justAdded = added.key === key ? added.axes : [];
  const axes = (["x", "y"] as const).filter((a) => justAdded.includes(a) || nodes.some((n) => hasLimits(n, a)));
  return { axes, open: (axis) => setAdded({ key, axes: [...justAdded, axis] }) };
}

// ---- Auto layout settings ------------------------------------------------------------------

/** The settings popovers' width (auto layout, type settings): labels and 150 controls on one line. */
export const SETTINGS_WIDTH = 300;

/** The "Advanced layout settings" button and its popover. */
export function AutoLayoutSettingsButton({ nodes }: { nodes: PanelNode[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <IconButton icon="24.adjust.small" label="Advanced layout settings" tone="secondary" aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} />
      {anchor && <AutoLayoutSettings nodes={nodes} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

function AutoLayoutSettings({ nodes, anchor, onClose }: { nodes: PanelNode[]; anchor: HTMLElement; onClose: () => void }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const al = nodes.filter((n) => isAutoLayout(n));
  const spacing = mixed(al.map((n) => (n.stackPrimaryAlignItems === "SPACE_BETWEEN" ? "SPACE_BETWEEN" : "PACKED")));
  const strokes = mixed(al.map((n) => (n.bordersTakeSpace ? "INCLUDED" : "EXCLUDED")));
  const stacking = mixed(al.map((n) => (n.stackReverseZIndex ? "FIRST" : "LAST")));
  const horizontal = al.every((n) => n.stackMode === "HORIZONTAL");
  const baseline = mixed(al.map((n) => n.stackCounterAlignItems === "BASELINE"));
  return (
    <Popover anchor={anchor} title="Auto layout settings" width={SETTINGS_WIDTH} onClose={onClose} label="Auto layout settings">
      <div className={styles.settings}>
        <span className={styles.settingsLabel}>Spacing mode</span>
        <Select
          label="Spacing mode"
          value={spacing ?? "PACKED"}
          options={[
            { value: "PACKED", label: "Packed" },
            { value: "SPACE_BETWEEN", label: "Space between" },
          ]}
          onChange={(v) => ed.batch("Spacing mode", () => al.forEach((n) => ed.engine.setProps([n.guid], fields({ stackPrimaryAlignItems: v === "SPACE_BETWEEN" ? "SPACE_BETWEEN" : n.stackPrimaryAlignItems === "SPACE_BETWEEN" ? "MIN" : n.stackPrimaryAlignItems }))))}
        />
        <span className={styles.settingsLabel}>Strokes</span>
        <Select
          label="Strokes"
          value={strokes ?? "EXCLUDED"}
          options={[
            { value: "INCLUDED", label: "Included in layout" },
            { value: "EXCLUDED", label: "Excluded from layout" },
          ]}
          onChange={(v) => ed.setProps(refs, fields({ bordersTakeSpace: v === "INCLUDED" }), "Strokes in layout")}
        />
        <span className={styles.settingsLabel}>Canvas stacking</span>
        <Select
          label="Canvas stacking"
          value={stacking ?? "LAST"}
          options={[
            { value: "FIRST", label: "First on top" },
            { value: "LAST", label: "Last on top" },
          ]}
          onChange={(v) => ed.setProps(refs, fields({ stackReverseZIndex: v === "FIRST" }), "Canvas stacking")}
        />
        <span className={styles.settingsLabel}>Align text baseline</span>
        <Checkbox
          label="Align text baseline"
          hideLabel
          checked={baseline ?? false}
          disabled={!horizontal}
          onChange={(on) => ed.setProps(refs, fields({ stackCounterAlignItems: on ? "BASELINE" : "MIN" }), "Align text baseline")}
        />
      </div>
    </Popover>
  );
}
