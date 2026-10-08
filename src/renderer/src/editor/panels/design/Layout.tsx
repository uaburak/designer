/**
 * The Layout / Auto layout section (Figma UI3, its live panel: docs/research/figma/live/design):
 *
 * - header: "Auto layout" with "Remove auto layout" (on) for an auto-layout frame; "Layout" with "Resize to fit"
 *   (frames, sections) and "Use auto layout" (frames, groups, several layers) otherwise;
 * - Flow: Freeform / Vertical / Horizontal / Grid, with "Wrap" (or, for a grid, "Toggle automatic positioning");
 * - a text's Resizing: Auto width / Auto height / Fixed size;
 * - Dimensions — or "Resizing" when an axis hugs or fills — W / H with their sizing menu and "Lock aspect ratio";
 *   min / max rows; a group's W / H scale what is in it;
 * - Spacing for several layers or a group's children;
 * - Alignment and Gap (the matrix; Gap takes "Auto"; a wrap adds the gap between rows) or the grid's dimensions and
 *   gaps, "Auto layout settings" (Auto spacing Between / Evenly / Around, strokes, canvas stacking, text baseline);
 * - Padding (horizontal / vertical, "Individual padding" for the four sides, CSS shorthand in any of them);
 * - Clip content.
 */
import { useState } from "react";
import { AlignmentMatrix, Checkbox, IconButton, MIXED, NumericInput, PanelSection, Popover, PropertyGrid, PropertyRow, SegmentedControl, Select, ToggleIconButton, type Alignment } from "@/ds";
import { useEditor } from "../../controller";
import { command, runEditorCommand, shortcutOf } from "../../commands";
import { useUI } from "../../hooks";
import { isAutoLayout, isSpaceBetween, SPACE_BETWEEN } from "../../model/sizing";
import { fieldValue, mixed, mixedNumber } from "../../model/mixed";
import { gridDefaults, isGrid, type GridNode } from "../../model/grid";
import { paddingFields, paddingFromText, paddingOf, type Padding } from "../../model/padding";
import { spacingAxes, spacingOf } from "../../model/spacing";
import { GridDimensionsRow, GridSpanRow } from "./Grid";
import { VariableField } from "./Variables";
import { LimitRow, SizeField, sizeLabels, useLimitAxes } from "./Sizing";
import { canResizeToFit, resizeToFit, spacingItems, writeSpacing } from "./layoutActions";
import { editEach, exitToCanvas, perLayer, stepInfo } from "./Sections";
import { fields, isFrameNode, isGroupNode, isTextNode, typeOf, useParents, useSupports, type PanelNode } from "./shared";
import styles from "./Design.module.css";

type Flow = "NONE" | "VERTICAL" | "HORIZONTAL" | "GRID";

const flowOf = (n: PanelNode): Flow => (n.stackMode === "VERTICAL" || n.stackMode === "HORIZONTAL" || n.stackMode === "GRID" ? n.stackMode : "NONE");
const sessionOf = (guid: string) => Number(String(guid).replace(/^I/, "").split(":")[0]) || 1;

export function LayoutSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const autoLayoutKept = useSupports("stackMode");
  const constrainKept = useSupports("proportionsConstrained");
  const parents = useParents(nodes);
  const limits = useLimitAxes(nodes);
  const refs = nodes.map((n) => n.guid);
  const sections = nodes.some((n) => typeOf(n) === "SECTION");
  const frames = nodes.every(isFrameNode) && !sections;
  const groups = nodes.every((n) => isGroupNode(n));
  const flowable = autoLayoutKept && !sections && nodes.every((n) => isFrameNode(n) || isGroupNode(n));
  const auto = autoLayoutKept && frames && nodes.every(isAutoLayout);
  const instances = nodes.some((n) => typeOf(n) === "INSTANCE");
  const constrained = mixed(nodes.map((n) => n.proportionsConstrained === true));
  const lines = nodes.every((n) => typeOf(n) === "LINE");
  const texts = nodes.filter(isTextNode);
  const spacing = (nodes.length > 1 || (nodes.length === 1 && (isGroupNode(nodes[0]) || typeOf(nodes[0]) === "BOOLEAN_OPERATION"))) && !auto;
  const sizes = sizeLabels(nodes, parents);

  const addAutoLayout = () => {
    if (runEditorCommand(ed, "object.add-auto-layout")) return;
    if (frames) ed.setProps(refs, fields({ stackMode: "VERTICAL", stackSpacing: 10, stackHorizontalPadding: 10, stackVerticalPadding: 10, stackPaddingRight: 10, stackPaddingBottom: 10 }), "Add auto layout");
  };
  const removeAutoLayout = () => {
    if (runEditorCommand(ed, "object.remove-auto-layout")) return;
    ed.setProps(refs, fields({ stackMode: "NONE" }), "Remove auto layout");
  };
  const addCommand = command("object.add-auto-layout");
  const removeCommand = command("object.remove-auto-layout");
  const actions = auto ? (
    instances ? undefined : (
      <ToggleIconButton icon="24.autolayout-add-vertical" label="Remove auto layout" tooltip="Toggle auto layout" shortcut={shortcutOf(removeCommand)} tone="secondary" pressed onPressedChange={removeAutoLayout} />
    )
  ) : (
    <>
      {canResizeToFit(nodes) && <IconButton icon="24.resize-to-fit.small" label="Resize to fit" shortcut="⌥⇧⌘R" tone="secondary" onClick={() => resizeToFit(ed, refs)} />}
      {(flowable || nodes.length > 1) && !sections && (
        <ToggleIconButton icon="24.autolayout-add-vertical" label="Use auto layout" tooltip="Toggle auto layout" shortcut={shortcutOf(addCommand)} tone="secondary" pressed={false} onPressedChange={addAutoLayout} />
      )}
    </>
  );

  return (
    <PanelSection title={auto ? "Auto layout" : "Layout"} actions={actions}>
      <PropertyGrid labels={labels}>
        {flowable && <FlowRow nodes={nodes} onAdd={addAutoLayout} onRemove={removeAutoLayout} />}
        {texts.length > 0 && <TextResizingRow nodes={texts} />}
        <PropertyRow
          label={sizes.row}
          action={
            constrainKept && !lines ? (
              <ToggleIconButton icon="24.constrain-proportions" label="Lock aspect ratio" tone="secondary" pressed={constrained ?? false} onPressedChange={(on) => ed.setProps(refs, fields({ proportionsConstrained: on }), "Lock aspect ratio")} />
            ) : undefined
          }
        >
          <SizeField axis="x" nodes={nodes} parents={parents} onAddLimit={limits.open} />
          <SizeField axis="y" nodes={nodes} parents={parents} onAddLimit={limits.open} />
        </PropertyRow>
        {limits.axes.map((axis) => (
          <LimitRow key={axis} axis={axis} nodes={nodes} />
        ))}
        {spacing && <SpacingRow nodes={nodes} />}
        {auto && <AutoLayoutRows nodes={nodes} />}
        {parents.length > 0 && parents.every((p) => isGrid(p)) && nodes.every((n) => n.stackPositioning !== "ABSOLUTE") && <GridSpanRow nodes={nodes} />}
      </PropertyGrid>
      {frames && !groups && (
        <div className={styles.checkRow}>
          <Checkbox tone="panel" label="Clip content" checked={mixed(nodes.map((n) => n.frameMaskDisabled !== true)) ?? true} onChange={(on) => ed.setProps(refs, { frameMaskDisabled: !on }, "Clip content")} />
        </div>
      )}
    </PanelSection>
  );
}

/** Flow: Freeform (no auto layout) / Vertical / Horizontal / Grid; the action column holds Wrap or automatic positioning. */
function FlowRow({ nodes, onAdd, onRemove }: { nodes: PanelNode[]; onAdd: () => void; onRemove: () => void }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const flow = mixed(nodes.map(flowOf));
  const auto = nodes.every(isAutoLayout);
  const wrap = mixed(nodes.map((n) => n.stackWrap === "WRAP"));
  const reflow = mixed(nodes.map((n) => (n as { gridReflowEnabled?: boolean }).gridReflowEnabled === true));
  const pick = (v: string) => {
    const to = v as Flow;
    if (to === "NONE") return onRemove();
    if (to === "GRID") {
      // Not auto layout yet (a group, a plain frame): make it auto layout first.
      if (!auto) onAdd();
      // Grid: 2 × 2 Hug tracks with automatic positioning (Figma Design), unless the frame had tracks already.
      editEach(ed, "Auto layout direction", { final: true, source: "pick" }, ed.selection, (n) => fields({ ...(gridDefaults(n as unknown as GridNode, sessionOf(n.guid)) as object), stackWrap: "NO_WRAP" } as never));
      return;
    }
    if (!auto) onAdd();
    // The frame that holds auto layout now (a group became one): the selection.
    ed.setProps(ed.selection, fields({ stackMode: to, ...(to === "VERTICAL" ? { stackWrap: "NO_WRAP" } : {}) }), "Auto layout direction");
  };
  const action =
    auto && flow === "GRID" ? (
      <ToggleIconButton
        icon="24.layout-tidy-up-grid"
        label="Toggle automatic positioning"
        tone="secondary"
        pressed={reflow ?? false}
        // Turning it back on sets Number of rows to Auto (help "Use the grid auto layout flow").
        onPressedChange={(on) => ed.setProps(refs, fields((on ? { gridReflowEnabled: true, gridAutoTracks: "ROWS" } : { gridReflowEnabled: false }) as never), "Automatic positioning")}
      />
    ) : auto ? (
      <ToggleIconButton
        icon="24.al.layout-wrap"
        label="Wrap"
        tone="secondary"
        pressed={wrap ?? false}
        // Wrap lays out horizontally (a vertical flow turns horizontal to wrap).
        onPressedChange={(on) => ed.setProps(refs, fields(on ? { stackMode: "HORIZONTAL", stackWrap: "WRAP" } : { stackWrap: "NO_WRAP" }), "Wrap")}
      />
    ) : undefined;
  return (
    <PropertyRow label="Flow" span={2} action={action}>
      <SegmentedControl
        label="Layout"
        fullWidth
        value={flow ?? MIXED}
        options={[
          { value: "NONE", icon: "24.layout.freeform", tooltip: "Freeform" },
          { value: "VERTICAL", icon: "24.layout.vertical", tooltip: "Vertical" },
          { value: "HORIZONTAL", icon: "24.layout.horizontal", tooltip: "Horizontal" },
          { value: "GRID", icon: "24.layout.grid", tooltip: "Grid" },
        ]}
        onChange={pick}
      />
    </PropertyRow>
  );
}

/** A text's Resizing (Figma's live panel puts it in Layout): Auto width / Auto height / Fixed size. */
function TextResizingRow({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const value = mixed(nodes.map((n) => n.textAutoResize ?? "NONE"));
  return (
    <PropertyRow label="Resizing" span={2}>
      <SegmentedControl
        label="Resizing"
        fullWidth
        value={value ?? MIXED}
        options={[
          { value: "WIDTH_AND_HEIGHT", icon: "24.text.resize-width", tooltip: "Auto width" },
          { value: "HEIGHT", icon: "24.text.resize-height", tooltip: "Auto height" },
          { value: "NONE", icon: "24.text.resize-fixed", tooltip: "Fixed size" },
        ]}
        onChange={(v) => ed.setProps(refs, fields({ textAutoResize: v as "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" }), "Resizing")}
      />
    </PropertyRow>
  );
}

/** Several layers or a group's children: the gap between them along the axis (or axes) they line up on. */
function SpacingRow({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const items = spacingItems(ed, nodes);
  const axes = spacingAxes(items);
  if (!axes.length) return null;
  const field = (axis: "x" | "y") => {
    const v = spacingOf(items, axis);
    return (
      <NumericInput
        key={axis}
        label={axis === "x" ? "Horizontal spacing" : "Vertical spacing"}
        prefix={axis === "x" ? "24.al.spacing-horizontal" : "24.al.spacing-vertical"}
        value={v === "mixed" ? MIXED : v}
        onChange={(g, info) => writeSpacing(ed, nodes, axis, g, info)}
        onStep={(d) => {
          const now = spacingOf(spacingItems(ed, ed.engine.readNodes(nodes.map((n) => n.guid))), axis);
          if (now !== "mixed") writeSpacing(ed, nodes, axis, now + d, stepInfo);
        }}
        onCancel={() => ed.cancelEdit()}
        onExit={exitToCanvas(ed)}
      />
    );
  };
  return (
    <PropertyRow label="Spacing">
      {axes.includes("x") ? field("x") : <span />}
      {axes.includes("y") ? field("y") : <span />}
    </PropertyRow>
  );
}

/** "Auto spacing" (the gap's Auto): Between (Figma's files: SPACE_EVENLY), Evenly (CSS space-evenly), Around. */
const AUTO_SPACING = [
  { value: SPACE_BETWEEN, label: "Between" },
  { value: "SPACE_EVENLY_CSS", label: "Evenly" },
  { value: "SPACE_AROUND", label: "Around" },
] as const;
const isAutoGap = (v: string | undefined) => isSpaceBetween(v) || v === "SPACE_EVENLY_CSS" || v === "SPACE_AROUND";

function AutoLayoutRows({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const flow = mixed(nodes.map(flowOf));
  const first = nodes[0];
  const horizontal = flow === "HORIZONTAL";
  const wrap = horizontal && nodes.every((n) => n.stackWrap === "WRAP");
  const alignment: Alignment = {
    primary: isAutoGap(first.stackPrimaryAlignItems) ? "SPACE_BETWEEN" : first.stackPrimaryAlignItems === "CENTER" || first.stackPrimaryAlignItems === "MAX" ? first.stackPrimaryAlignItems : "MIN",
    counter: first.stackCounterAlignItems === "CENTER" || first.stackCounterAlignItems === "MAX" ? first.stackCounterAlignItems : "MIN",
  };
  const gap = mixedNumber(nodes.map((n) => n.stackSpacing ?? 0));
  const autoGap = nodes.every((n) => isAutoGap(n.stackPrimaryAlignItems));
  const rowGap = mixedNumber(nodes.map((n) => n.stackCounterSpacing ?? n.stackSpacing ?? 0));
  const autoRowGap = nodes.every((n) => n.stackCounterAlignContent === "SPACE_BETWEEN");
  const gapHandlers = perLayer(
    ed,
    "Gap",
    refs,
    (n) => n.stackSpacing ?? 0,
    // A typed gap ends Auto: the items pack from the start again.
    (n, v) => fields({ stackSpacing: v, ...(isAutoGap(n.stackPrimaryAlignItems) ? { stackPrimaryAlignItems: "MIN" } : {}) }),
    (v) => Math.max(0, v)
  );
  const rowGapHandlers = perLayer(ed, "Gap between rows", refs, (n) => n.stackCounterSpacing ?? n.stackSpacing ?? 0, (_, v) => fields({ stackCounterSpacing: v, stackCounterAlignContent: "AUTO" }), (v) => Math.max(0, v));
  const autoMode = (n: PanelNode) => (isAutoGap(n.stackPrimaryAlignItems) ? n.stackPrimaryAlignItems : SPACE_BETWEEN);
  if (flow === "GRID")
    return (
      <>
        <GridDimensionsRow nodes={nodes} action={<AutoLayoutSettingsButton nodes={nodes} />} />
        <PaddingRows nodes={nodes} />
      </>
    );
  const gapLabel = (what: string) => `${horizontal ? "Horizontal" : "Vertical"} gap between ${what}`;
  return (
    <>
      <PropertyRow labels={["Alignment", "Gap"]} action={<AutoLayoutSettingsButton nodes={nodes} />} className={styles.alignRow}>
        <div className={styles.matrix}>
          <AlignmentMatrix
            direction={horizontal ? "horizontal" : "vertical"}
            value={alignment}
            onChange={(a) => editEach(ed, "Alignment", { final: true, source: "pick" }, refs, (n) => fields({ stackPrimaryAlignItems: a.primary === "SPACE_BETWEEN" ? autoMode(n) : a.primary, stackCounterAlignItems: a.counter }))}
          />
        </div>
        <div className={styles.gapStack}>
          <VariableField nodes={nodes} fields={["STACK_SPACING"]} prefix={horizontal ? "24.al.spacing-horizontal" : "24.al.spacing-vertical"}>
            <NumericInput
              label={gapLabel("objects")}
              prefix={horizontal ? "24.al.spacing-horizontal" : "24.al.spacing-vertical"}
              value={fieldValue(gap)}
              min={0}
              valueLabel={autoGap ? "Auto" : undefined}
              keywords={["Auto"]}
              onKeyword={() => editEach(ed, "Gap", stepInfo, refs, (n) => fields({ stackPrimaryAlignItems: autoMode(n) }))}
              {...gapHandlers}
            />
          </VariableField>
          {wrap && (
            <VariableField nodes={nodes} fields={["STACK_COUNTER_SPACING"]} prefix="24.al.spacing-vertical">
              <NumericInput
                label="Vertical gap between rows"
                prefix="24.al.spacing-vertical"
                value={fieldValue(rowGap)}
                min={0}
                valueLabel={autoRowGap ? "Auto" : undefined}
                keywords={["Auto"]}
                onKeyword={() => ed.setProps(refs, fields({ stackCounterAlignContent: "SPACE_BETWEEN" }), "Gap between rows")}
                {...rowGapHandlers}
              />
            </VariableField>
          )}
        </div>
      </PropertyRow>
      <PaddingRows nodes={nodes} />
    </>
  );
}

const SIDES = [
  ["left", "24.al.padding-left", "Left padding", "STACK_PADDING_LEFT"],
  ["top", "24.al.padding-top", "Top padding", "STACK_PADDING_TOP"],
  ["right", "24.al.padding-right", "Right padding", "STACK_PADDING_RIGHT"],
  ["bottom", "24.al.padding-bottom", "Bottom padding", "STACK_PADDING_BOTTOM"],
] as const;

/**
 * Padding: horizontal and vertical (each Mixed when its two sides differ), or — "Individual padding" — the four
 * sides; ⌘-click on "Individual padding" for one field over all four (uniform). Several numbers typed: model/padding.ts.
 */
function PaddingRows({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const pads = nodes.map((n) => paddingOf(n));
  const [mode, setMode] = useState<"default" | "individual" | "uniform">("default");
  const differ = pads.some((p) => p.left !== p.right || p.top !== p.bottom);
  const shown = mode === "default" && differ ? "individual" : mode;
  const shorthand = (sides: (keyof Padding)[]) => (raw: string) => {
    const p = paddingFromText(raw, sides);
    if (!p) return false;
    ed.setProps(refs, fields(paddingFields(p)), "Padding");
    return true;
  };
  const sideValue = (side: keyof Padding) => fieldValue(mixedNumber(pads.map((p) => p[side])));
  const pairValue = (a: keyof Padding, b: keyof Padding) => fieldValue(mixedNumber(pads.flatMap((p) => [p[a], p[b]])));
  const handlers = (label: string, sides: (keyof Padding)[]) =>
    perLayer(
      ed,
      label,
      refs,
      (n) => paddingOf(n)[sides[0]],
      (_, v) => fields(paddingFields(Object.fromEntries(sides.map((s) => [s, Math.max(0, v)])))),
      (v) => Math.max(0, v)
    );
  const toggle = (
    <ToggleIconButton
      icon="24.al.padding-sides"
      label="Individual padding"
      tone="secondary"
      pressed={shown !== "default"}
      onPressedChange={() => undefined}
      onClick={(e) => {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) setMode(shown === "uniform" ? "default" : "uniform");
        else setMode(shown === "individual" ? "default" : "individual");
      }}
    />
  );
  const field = (label: string, prefix: (typeof SIDES)[number][1] | "24.al.padding-horizontal" | "24.al.padding-vertical", value: ReturnType<typeof sideValue>, sides: (keyof Padding)[], bind: Parameters<typeof VariableField>[0]["fields"]) => (
    <VariableField nodes={nodes} fields={bind} prefix={prefix}>
      <NumericInput label={label} prefix={prefix} value={value} min={0} onText={shorthand(sides)} {...handlers("Padding", sides)} />
    </VariableField>
  );
  if (shown === "uniform")
    return (
      <PropertyRow labels={["Padding", undefined]} action={toggle}>
        {field("Padding", "24.al.padding-sides" as never, fieldValue(mixedNumber(pads.flatMap((p) => [p.left, p.top, p.right, p.bottom]))), ["left", "top", "right", "bottom"], ["STACK_PADDING_LEFT", "STACK_PADDING_TOP", "STACK_PADDING_RIGHT", "STACK_PADDING_BOTTOM"])}
        <span />
      </PropertyRow>
    );
  if (shown === "individual")
    return (
      <>
        <PropertyRow labels={["Padding", undefined]} action={toggle}>
          {SIDES.slice(0, 2).map(([side, icon, label, bind]) => field(label, icon, sideValue(side), [side], [bind]))}
        </PropertyRow>
        <PropertyRow>{SIDES.slice(2).map(([side, icon, label, bind]) => field(label, icon, sideValue(side), [side], [bind]))}</PropertyRow>
      </>
    );
  return (
    <PropertyRow labels={["Padding", undefined]} action={toggle}>
      {field("Horizontal padding", "24.al.padding-horizontal", pairValue("left", "right"), ["left", "right"], ["STACK_PADDING_LEFT", "STACK_PADDING_RIGHT"])}
      {field("Vertical padding", "24.al.padding-vertical", pairValue("top", "bottom"), ["top", "bottom"], ["STACK_PADDING_TOP", "STACK_PADDING_BOTTOM"])}
    </PropertyRow>
  );
}

// ---- Auto layout settings ------------------------------------------------------------------

/** The settings popovers' width (auto layout, type settings): labels and 150 controls on one line. */
export const SETTINGS_WIDTH = 300;

/** The "Auto layout settings" button and its popover. */
export function AutoLayoutSettingsButton({ nodes }: { nodes: PanelNode[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <IconButton icon="24.adjust.small" label="Auto layout settings" tone="secondary" aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} />
      {anchor && <AutoLayoutSettings nodes={nodes} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

function AutoLayoutSettings({ nodes, anchor, onClose }: { nodes: PanelNode[]; anchor: HTMLElement; onClose: () => void }) {
  const ed = useEditor();
  const al = nodes.filter((n) => isAutoLayout(n));
  const refs = al.map((n) => n.guid);
  const spacing = mixed(al.map((n) => (n.stackPrimaryAlignItems === "SPACE_EVENLY_CSS" ? "SPACE_EVENLY_CSS" : n.stackPrimaryAlignItems === "SPACE_AROUND" ? "SPACE_AROUND" : SPACE_BETWEEN)));
  const strokes = mixed(al.map((n) => (n.bordersTakeSpace ? "INCLUDED" : "EXCLUDED")));
  const stacking = mixed(al.map((n) => (n.stackReverseZIndex ? "FIRST" : "LAST")));
  const horizontal = al.every((n) => n.stackMode === "HORIZONTAL");
  const grid = al.every((n) => n.stackMode === "GRID");
  const baseline = mixed(al.map((n) => n.stackCounterAlignItems === "BASELINE"));
  return (
    <Popover anchor={anchor} title="Auto layout settings" width={SETTINGS_WIDTH} onClose={onClose} label="Auto layout settings">
      <div className={styles.settings}>
        {!grid && (
          <>
            <span className={styles.settingsLabel}>Auto spacing</span>
            <Select
              label="Auto spacing"
              value={spacing ?? MIXED}
              options={AUTO_SPACING.map((o) => ({ ...o }))}
              // Picking one makes the gap Auto with that spacing (help 31289464393751).
              onChange={(v) => ed.setProps(refs, fields({ stackPrimaryAlignItems: v as never }), "Auto spacing")}
            />
          </>
        )}
        <span className={styles.settingsLabel}>Strokes</span>
        <Select
          label="Strokes"
          value={strokes ?? MIXED}
          options={[
            { value: "INCLUDED", label: "Included in layout" },
            { value: "EXCLUDED", label: "Excluded from layout" },
          ]}
          onChange={(v) => ed.setProps(refs, fields({ bordersTakeSpace: v === "INCLUDED" }), "Strokes in layout")}
        />
        <span className={styles.settingsLabel}>Canvas stacking</span>
        <Select
          label="Canvas stacking"
          value={stacking ?? MIXED}
          options={[
            { value: "FIRST", label: "First on top" },
            { value: "LAST", label: "Last on top" },
          ]}
          onChange={(v) => ed.setProps(refs, fields({ stackReverseZIndex: v === "FIRST" }), "Canvas stacking")}
        />
        {!grid && (
          <>
            <span className={styles.settingsLabel}>Text baseline alignment</span>
            <Checkbox
              label="Text baseline alignment"
              hideLabel
              checked={baseline ?? false}
              disabled={!horizontal}
              onChange={(on) => ed.setProps(refs, fields({ stackCounterAlignItems: on ? "BASELINE" : "MIN" }), "Text baseline alignment")}
            />
          </>
        )}
      </div>
    </Popover>
  );
}

