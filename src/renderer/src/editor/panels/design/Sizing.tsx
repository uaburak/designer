/**
 * The Layout section's sizing (Figma UI3, its live panel): W / H fields. In or around auto layout each has its
 * sizing menu — "Fixed width (92)" / Hug contents / Fill container, then Add min width… / Add max width… (or Remove
 * min and max) and Apply variable… —: a Fixed field shows its number and the menu's chevron (always); a hugging or
 * filling one its number grey and the mode's word at the right in the chevron's place ("92 … Hug"), and the row reads "Resizing" (fields "Horizontal resizing" / "Vertical resizing") while an axis
 * hugs or fills, "Dimensions" (fields "Width" / "Height") otherwise. Typing a number makes the axis Fixed. A group's
 * W / H scale what is in it. min / max rows under the fields. All on the schema's fields (model/sizing.ts).
 */
import { useRef, useState } from "react";
import { Icon, IconButton, MenuButton, NumericInput, PropertyRow, isMixed, type ChangeInfo, type IconName, type MenuEntry } from "@/ds";
import { useEditor, type EditorController } from "../../controller";
import { supportsField } from "../../engineCompat";
import { fieldValue, mixed, mixedNumber } from "../../model/mixed";
import { roundPanel } from "../../model/geometry";
import { canFill, canHug, canLimit, hasLimits, isAutoLayout, inFlow, limitOf, newLimit, sizingChanges, sizingOf, withLimit, withoutLimits, type Axis, type Limit, type Sizing } from "../../model/sizing";
import { exitToCanvas } from "./Sections";
import { VariableField } from "./Variables";
import { scaleGroupTo } from "./layoutActions";
import { isGroupNode, type PanelNode } from "./shared";
import styles from "./Design.module.css";

const AXIS_WORD: Record<Axis, string> = { x: "width", y: "height" };
const stepInfo: ChangeInfo = { final: true, source: "step" };

/**
 * The W / H and gap lists open over their field, right-aligned with it, the checked row 4 above the field's top (live
 * popovers/width-sizing-menu.txt 166 × 129 at 1138,399 over W at 1216,435 (the panel's body starts at 81);
 * height-sizing-menu at 1234,399; gap-menu 156 × 64 at 1244,473 over the gap at 1312,485).
 */
export const SIZING_LIST_DY = -4;
/**
 * A plain layer in auto layout (a Width menu of Fixed / Fill container / min / max, no Hug contents): live's
 * autolayout-child-width-menu is 162 × 129 at 1142,379 over W at 1216,387, so its checked row lines up with the
 * field's top. (One capture: the rule for a child that can hug is unverified.)
 */
export const SIZING_LIST_DY_CHILD = 0;

/** Do these layers get W / H sizing menus (auto layout frames, layers in auto layout)? */
export const hasSizingMenu = (nodes: readonly PanelNode[], parents: readonly (PanelNode | null)[]) => nodes.length > 0 && nodes.every((n, i) => isAutoLayout(n) || inFlow(n, parents[i]));

/** The row's label and the fields' names (Figma: "Resizing" with "Horizontal resizing" while an axis hugs or fills). */
export function sizeLabels(nodes: readonly PanelNode[], parents: readonly (PanelNode | null)[]): { row: string; x: string; y: string } {
  const resizing = hasSizingMenu(nodes, parents) && nodes.some((n, i) => sizingOf(n, parents[i], "x") !== "FIXED" || sizingOf(n, parents[i], "y") !== "FIXED");
  return resizing ? { row: "Resizing", x: "Horizontal resizing", y: "Vertical resizing" } : { row: "Dimensions", x: "Width", y: "Height" };
}

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

/** One layer to `v` along `axis` (the other axis too when its proportions are locked); a group scales its contents. */
function resizeOne(ed: EditorController, n: PanelNode, parent: PanelNode | null, axis: Axis, v: number) {
  const s = n.size ?? { x: 0, y: 0 };
  const keep = n.proportionsConstrained && s.x > 0 && s.y > 0;
  const size = axis === "x" ? { x: v, y: keep ? (v * s.y) / s.x : s.y } : { x: keep ? (v * s.x) / s.y : s.x, y: v };
  const next = { x: Math.max(0.01, size.x), y: Math.max(0.01, size.y) };
  if (isGroupNode(n)) return scaleGroupTo(ed, n, next);
  // A typed size makes the axis Fixed (Figma).
  const fixed = sizingOf(n, parent, axis) === "FIXED" ? {} : sizingChanges(n, parent, axis, "FIXED").node;
  ed.engine.setProps([n.guid], { ...fixed, size: next });
}

/** The W or H field with its sizing menu. */
export function SizeField({ axis, nodes, parents, onAddLimit, disabled }: { axis: Axis; nodes: PanelNode[]; parents: (PanelNode | null)[]; onAddLimit: (axis: Axis) => void; disabled?: boolean }) {
  const ed = useEditor();
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const word = AXIS_WORD[axis];
  const value = mixedNumber(nodes.map((n) => roundPanel(n.size?.[axis] ?? 0)));
  const sizing = mixed(nodes.map((n, i) => sizingOf(n, parents[i], axis)));
  const names = sizeLabels(nodes, parents);
  // Text hugs through textAutoResize, which the engine keeps with E3.
  const textKept = supportsField(ed.engine, "textAutoResize");
  const hugs = (n: PanelNode) => canHug(n) && (n.type !== "TEXT" || textKept);
  const hug = nodes.some(hugs);
  const fill = nodes.some((n, i) => canFill(n, parents[i]));
  const limits = nodes.every((n, i) => canLimit(n, parents[i]));
  const limited = nodes.some((n) => hasLimits(n, axis));
  const menu = hasSizingMenu(nodes, parents);
  const read = () => ed.engine.readNodes(nodes.map((n) => n.guid)).map((n) => ed.withRealType(n) as PanelNode);

  const setSize = (v: number, info: ChangeInfo) => ed.edit("Resize", info, () => read().forEach((n, i) => resizeOne(ed, n, parents[i], axis, v)));
  const stepSize = (d: number) => ed.edit("Resize", stepInfo, () => read().forEach((n, i) => resizeOne(ed, n, parents[i], axis, Math.max(0.01, (n.size?.[axis] ?? 0) + d))));
  const eachSize = (each: (x: number) => number, info: ChangeInfo) => ed.edit("Resize", info, () => read().forEach((n, i) => resizeOne(ed, n, parents[i], axis, Math.max(0.01, each(n.size?.[axis] ?? 0)))));

  const fixedLabel = `Fixed ${word}${isMixed(value) || value === undefined ? "" : ` (${value})`}`;
  // Live (popovers/width-sizing-menu.txt, height-sizing-menu.txt, autolayout-child-width-menu.txt): Fixed (n), Hug contents,
  // Fill container, then Add min / max — each with its glyph; no "Apply variable" (W / H take one from the hover button).
  const glyph = (k: "fixed" | "hug" | "fill" | "min" | "max"): IconName => `24.al.${axis === "x" ? "width" : "height"}-${k}` as IconName;
  const entries: MenuEntry[] = [
    { id: "FIXED", label: fixedLabel, checked: sizing === "FIXED", icon: glyph("fixed") },
    ...(hug ? [{ id: "HUG", label: "Hug contents", checked: sizing === "HUG", disabled: !nodes.every(hugs), icon: glyph("hug") }] : []),
    ...(fill ? [{ id: "FILL", label: "Fill container", checked: sizing === "FILL", disabled: !nodes.every((n, i) => canFill(n, parents[i])), icon: glyph("fill") }] : []),
    ...(limits
      ? [
          "-" as const,
          ...(limited
            ? [{ id: "remove-limits", label: "Remove min and max" }]
            : [
                { id: "add-min", label: `Add min ${word}…`, icon: glyph("min") },
                { id: "add-max", label: `Add max ${word}…`, icon: glyph("max") },
              ]),
        ]
      : []),
  ];
  const onMenu = (id: string) => {
    if (id === "apply-variable") return setPicker(field.current?.querySelector<HTMLElement>("[data-bind-field]") ?? field.current ?? null);
    if (id === "FIXED" || id === "HUG" || id === "FILL") applySizing(ed, nodes, parents, axis, id);
    else if (id === "remove-limits") ed.batch(`Remove min and max ${word}`, () => nodes.forEach((n) => ed.engine.setProps([n.guid], withoutLimits(n, axis))));
    else if (id === "add-min" || id === "add-max") {
      const which: Limit = id === "add-min" ? "min" : "max";
      ed.batch(`Add ${which} ${word}`, () => nodes.forEach((n) => ed.engine.setProps([n.guid], withLimit(n, which, axis, newLimit(n, axis)))));
      onAddLimit(axis);
    }
    ed.focusCanvas();
  };
  const mode = sizing === "HUG" ? "Hug" : sizing === "FILL" ? "Fill" : undefined;
  const label = axis === "x" ? names.x : names.y;
  return (
    <div ref={field} style={{ display: "contents" }}>
      <VariableField nodes={nodes} fields={[axis === "x" ? "WIDTH" : "HEIGHT"]} prefix={axis === "x" ? "W" : "H"} button={false} open={picker} onOpenChange={setPicker}>
        <NumericInput
          label={label}
          prefix={axis === "x" ? "W" : "H"}
          className={menu ? styles.sizeField : undefined}
          disabled={disabled}
          value={fieldValue(value)}
          // The number hugs its digits; what is right of it focuses the field (a Fixed field), or is the mode's word.
          modeLabel={menu ? " " : undefined}
          dimValue={!!mode}
          min={0.01}
          onChange={setSize}
          onStep={stepSize}
          onExpression={eachSize}
          onCancel={() => ed.cancelEdit()}
          onExit={exitToCanvas(ed)}
          suffix={
            menu ? (
              // The owner's live Figma (docs/research/panel17): Fixed → the chevron, hovered or not; Hug / Fill → the mode's
              // word in its place, the number grey, and the chevron instead of the word while the field is hovered (the
              // owner's correction). Either opens the sizing list.
              <MenuButton label={`${label} sizing`} entries={entries} onSelect={onMenu} className={mode ? styles.sizeMode : styles.sizeMenu} overField='[data-ds="NumericInput"]' overAlign="right" overOffset={hug ? SIZING_LIST_DY : SIZING_LIST_DY_CHILD}>
                {mode ? (
                  <>
                    <span className={styles.sizeModeWord}>{mode}</span>
                    <span className={styles.sizeModeChevron}>
                      <Icon name="24.chevron.down" />
                    </span>
                  </>
                ) : (
                  <Icon name="24.chevron.down" />
                )}
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

/**
 * Is this axis's field disabled? Live (design/line.txt, text.txt, text-editing-caret.txt): a line's Height; an auto-width
 * text's Width and Height. An auto-height text's Height follows the same rule (unverified: not captured).
 */
export function sizeLocked(nodes: readonly PanelNode[], axis: Axis): boolean {
  if (!nodes.length) return false;
  if (axis === "y" && nodes.every((n) => n.type === "LINE")) return true;
  // A text that sizes itself on this axis locks the field for the whole selection (live design/text.txt alone,
  // design/mixed-multi.txt with Rect + Ellipse + Text + F_frame: W and H disabled, "Mixed").
  return nodes.some((n) => n.type === "TEXT" && (n.textAutoResize === "WIDTH_AND_HEIGHT" || (axis === "y" && n.textAutoResize === "HEIGHT")));
}

/** Which axes show their min / max row. */
export function useLimitAxes(nodes: PanelNode[]): { axes: Axis[]; open: (axis: Axis) => void } {
  const [added, setAdded] = useState<{ key: string; axes: Axis[] }>({ key: "", axes: [] });
  const key = nodes.map((n) => n.guid).join(",");
  const justAdded = added.key === key ? added.axes : [];
  const axes = (["x", "y"] as const).filter((a) => justAdded.includes(a) || nodes.some((n) => hasLimits(n, a)));
  return { axes, open: (axis) => setAdded({ key, axes: [...justAdded, axis] }) };
}

