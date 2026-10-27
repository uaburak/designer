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
 * - Alignment and Gap (the matrix, with its W / A / S / D, X and B keys; Gap takes "Auto" or any start of it and
 *   negative numbers; a wrap adds the gap between rows) or the grid's dimensions and gaps, "Auto layout settings"
 *   (Auto spacing Between / Evenly / Around, strokes, canvas stacking, text baseline, the layout version Updated /
 *   Legacy);
 * - Padding (horizontal / vertical, "Individual padding" for the four sides, CSS shorthand in any of them);
 * - Clip content.
 */
import { useEffect, useRef, useState } from "react";
import { AlignmentMatrix, Checkbox, Icon, IconButton, MenuButton, MIXED, NumericInput, PanelSection, Popover, PropertyGrid, PropertyRow, SegmentedControl, Select, ToggleIconButton, cx, isMixed, scrubFrom, tooltipProps, type Alignment, type IconName, type NumericInputProps } from "@/ds";
import { SPACING_HIGHLIGHT } from "@/engine/abi";
import { useEditor } from "../../controller";
import { command, runEditorCommand, shortcutOf } from "../../commands";
import { useUI } from "../../hooks";
import { isAutoLayout, isSpaceBetween, SPACE_BETWEEN } from "../../model/sizing";
import { fieldValue, mixed, mixedNumber } from "../../model/mixed";
import { gridDefaults, isGrid, type GridNode } from "../../model/grid";
import { ALL_SIDES, paddingDisplay, paddingFields, paddingFromText, paddingHighlight, paddingOf, type Padding } from "../../model/padding";
import { spacingAxes, spacingOf } from "../../model/spacing";
import { GridDimensionsRow, GridSpanRow } from "./Grid";
import { VariableField } from "./Variables";
import { InstanceSizeField, LimitRow, SIZING_LIST_DY, SizeField, sizeLabels, sizeLocked, useLimitAxes } from "./Sizing";
import { canResizeToFit, resizeToFit, spacingItems, writeSpacing } from "./layoutActions";
import { cancelScrub, editEach, exitToCanvas, perLayer, scrubEach, stepInfo } from "./Sections";
import { fields, isFrameNode, isGroupNode, isInstanceSublayer, isTextNode, typeOf, useParents, useSupports, type PanelNode } from "./shared";
import { useDrawMode } from "../../draw/panels/DrawSliders";
import { t, tx, useT } from "@/i18n";
import styles from "./Design.module.css";

type Flow = "NONE" | "VERTICAL" | "HORIZONTAL" | "GRID";

const flowOf = (n: PanelNode): Flow => (n.stackMode === "VERTICAL" || n.stackMode === "HORIZONTAL" || n.stackMode === "GRID" ? n.stackMode : "NONE");
const sessionOf = (guid: string) => Number(String(guid).replace(/^I/, "").split(":")[0]) || 1;

/**
 * An instance's flow is its main component's: with no auto layout there it shows neither Flow nor "Use auto layout"
 * (live design/variant-instance.txt, the Chip instance: Layout > Dimensions at 350), with auto layout Flow and Wrap
 * are disabled (live design/instance.txt, nested-instance-parent.txt). null: no instance among the layers.
 */
export function instanceFlow(nodes: readonly PanelNode[]): "hidden" | "locked" | null {
  if (!nodes.some((n) => typeOf(n) === "INSTANCE")) return null;
  return nodes.every(isAutoLayout) ? "locked" : "hidden";
}

export function LayoutSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  // Draw (docs/draw.md §5.3): "Dimensions" — W / H only, no auto layout, no min / max.
  const drawMode = useDrawMode();
  const autoLayoutKept = useSupports("stackMode") && !drawMode;
  const constrainKept = useSupports("proportionsConstrained");
  const parents = useParents(nodes);
  const limits = useLimitAxes(nodes);
  const refs = nodes.map((n) => n.guid);
  const sections = nodes.some((n) => typeOf(n) === "SECTION");
  // A section takes auto layout as a frame does ([ours]: docs/schema.md "Auto layout on sections"); written to Figma as a plain section
  const frames = nodes.every(isFrameNode);
  const groups = nodes.every((n) => isGroupNode(n));
  const clipFrames = nodes.filter((n) => isFrameNode(n) && typeOf(n) !== "SECTION");
  const auto = autoLayoutKept && frames && nodes.every(isAutoLayout);
  const instances = nodes.some((n) => typeOf(n) === "INSTANCE");
  const instanceFlowState = instanceFlow(nodes);
  const flowable = autoLayoutKept && nodes.every((n) => isFrameNode(n) || isGroupNode(n)) && instanceFlowState !== "hidden";
  const constrained = mixed(nodes.map((n) => n.proportionsConstrained === true));
  const lines = nodes.every((n) => typeOf(n) === "LINE");
  const texts = nodes.filter(isTextNode);
  const spacing = (nodes.length > 1 || (nodes.length === 1 && (isGroupNode(nodes[0]) || typeOf(nodes[0]) === "BOOLEAN_OPERATION"))) && !auto;
  const sizes = sizeLabels(nodes, parents);
  // Inside an instance: Flow, Wrap and Lock aspect ratio disabled, W / H a read-only list (live nested-instance.txt).
  const locked = nodes.some(isInstanceSublayer);
  const flowLocked = locked || instanceFlowState === "locked";

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
    // (Neither on an instance nor on a layer inside one — live Figma 2026-10-23)
    instances || locked ? undefined : (
      <ToggleIconButton icon="24.autolayout-on" label={t("Remove auto layout")} tooltip={t("Toggle auto layout")} shortcut={shortcutOf(removeCommand)} tone="secondary" pressed onPressedChange={removeAutoLayout} />
    )
  ) : (
    <>
      {canResizeToFit(nodes) && <IconButton icon="24.resize-to-fit.small" label={t("Resize to fit")} shortcut="⌥⇧⌘R" tone="secondary" onClick={() => resizeToFit(ed, refs)} />}
      {(flowable || nodes.length > 1) && !instanceFlowState && (
        <ToggleIconButton icon="24.autolayout-add-vertical" label={t("Use auto layout")} tooltip={t("Toggle auto layout")} shortcut={shortcutOf(addCommand)} tone="secondary" pressed={false} onPressedChange={addAutoLayout} />
      )}
    </>
  );

  return (
    <PanelSection title={drawMode ? t("Dimensions") : auto ? t("Auto layout") : t("Layout")} actions={drawMode ? undefined : actions}>
      <PropertyGrid labels={labels} className={cx(auto && !labels && styles.autoLayoutGrid)}>
        {/* (A frame inside an instance: no Flow at all — live Figma 2026-10-23, the owner's Button instance) */}
        {flowable && !locked && <FlowRow nodes={nodes} disabled={flowLocked} onAdd={addAutoLayout} onRemove={removeAutoLayout} />}
        {texts.length > 0 && <TextResizingRow nodes={texts} />}
        <PropertyRow
          label={t(sizes.row)}
          action={
            constrainKept && !lines ? (
              <ToggleIconButton icon="24.constrain-proportions" label={t("Lock aspect ratio")} tone="secondary" disabled={locked} pressed={constrained ?? false} onPressedChange={(on) => ed.setProps(refs, fields({ proportionsConstrained: on }), "Lock aspect ratio")} />
            ) : undefined
          }
        >
          {locked ? <InstanceSizeField axis="x" nodes={nodes} parents={parents} /> : <SizeField axis="x" nodes={nodes} parents={parents} onAddLimit={limits.open} disabled={sizeLocked(nodes, "x")} />}
          {locked ? <InstanceSizeField axis="y" nodes={nodes} parents={parents} /> : <SizeField axis="y" nodes={nodes} parents={parents} onAddLimit={limits.open} disabled={sizeLocked(nodes, "y")} />}
        </PropertyRow>
        {!drawMode && limits.axes.map((axis) => (
          <LimitRow key={axis} axis={axis} nodes={nodes} />
        ))}
        {spacing && <SpacingRow nodes={nodes} />}
        {auto && <AutoLayoutRows nodes={nodes} />}
        {!drawMode && parents.length > 0 && parents.every((p) => isGrid(p)) && nodes.every((n) => n.stackPositioning !== "ABSOLUTE") && <GridSpanRow nodes={nodes} />}
      </PropertyGrid>
      {/* Live (design/mixed-multi.txt): shown when a frame is among the layers (Rect + Ellipse + Text + F_frame), for the frames */}
      {clipFrames.length > 0 && !sections && !groups && (
        <div className={styles.checkRow}>
          <Checkbox tone="panel" label={t("Clip content")} checked={mixed(clipFrames.map((n) => n.frameMaskDisabled !== true)) ?? true} onChange={(on) => ed.setProps(clipFrames.map((n) => n.guid), { frameMaskDisabled: !on }, "Clip content")} />
        </div>
      )}
    </PanelSection>
  );
}

/** Flow: Freeform (no auto layout) / Vertical / Horizontal / Grid; the action column holds Wrap or automatic positioning. */
function FlowRow({ nodes, disabled, onAdd, onRemove }: { nodes: PanelNode[]; disabled?: boolean; onAdd: () => void; onRemove: () => void }) {
  useT();
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
        label={t("Toggle automatic positioning")}
        tone="secondary"
        disabled={disabled}
        pressed={reflow ?? false}
        // Turning it back on sets Number of rows to Auto (help "Use the grid auto layout flow").
        onPressedChange={(on) => ed.setProps(refs, fields((on ? { gridReflowEnabled: true, gridAutoTracks: "ROWS" } : { gridReflowEnabled: false }) as never), "Automatic positioning")}
      />
    ) : auto ? (
      <ToggleIconButton
        icon="24.al.layout-wrap"
        label={t("Wrap")}
        tone="secondary"
        disabled={disabled}
        pressed={wrap ?? false}
        // Wrap lays out horizontally (a vertical flow turns horizontal to wrap).
        onPressedChange={(on) => ed.setProps(refs, fields(on ? { stackMode: "HORIZONTAL", stackWrap: "WRAP" } : { stackWrap: "NO_WRAP" }), "Wrap")}
      />
    ) : undefined;
  return (
    <PropertyRow label={t("Flow")} span={2} action={action}>
      <SegmentedControl
        label={t("Layout")}
        fullWidth
        disabled={disabled}
        value={flow ?? MIXED}
        options={[
          { value: "NONE", icon: "24.layout.freeform", tooltip: t("Freeform") },
          { value: "VERTICAL", icon: "24.layout.vertical", tooltip: t("Vertical") },
          { value: "HORIZONTAL", icon: "24.layout.horizontal", tooltip: t("Horizontal") },
          { value: "GRID", icon: "24.layout.grid", tooltip: t("Grid") },
        ]}
        onChange={pick}
      />
    </PropertyRow>
  );
}

/** A text's Resizing (Figma's live panel puts it in Layout): Auto width / Auto height / Fixed size. */
function TextResizingRow({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const value = mixed(nodes.map((n) => n.textAutoResize ?? "NONE"));
  return (
    <PropertyRow label={t("Resizing")} span={2}>
      <SegmentedControl
        label={t("Resizing")}
        fullWidth
        value={value ?? MIXED}
        options={[
          { value: "WIDTH_AND_HEIGHT", icon: "24.text.resize-width", tooltip: t("Auto width") },
          { value: "HEIGHT", icon: "24.text.resize-height", tooltip: t("Auto height") },
          { value: "NONE", icon: "24.text.resize-fixed", tooltip: t("Fixed size") },
        ]}
        onChange={(v) => ed.setProps(refs, fields({ textAutoResize: v as "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" }), "Resizing")}
      />
    </PropertyRow>
  );
}

/** Several layers or a group's children: the gap between them along the axis (or axes) they line up on. */
function SpacingRow({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const items = spacingItems(ed, nodes);
  const axes = spacingAxes(items);
  if (!axes.length) return null;
  const field = (axis: "x" | "y") => {
    const v = spacingOf(items, axis);
    return (
      <NumericInput
        key={axis}
        label={axis === "x" ? t("Horizontal spacing") : t("Vertical spacing")}
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
    <PropertyRow label={t("Spacing")}>
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
  useT();
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
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
  // A typed gap ends Auto: the items pack from the start again. No minimum: a negative gap overlaps them (Figma's gap
  // formatter has none, Atlas 09 §3.3).
  const gapHandlers = perLayer(ed, "Gap", refs, (n) => n.stackSpacing ?? 0, (n, v) => fields({ stackSpacing: v, ...(isAutoGap(n.stackPrimaryAlignItems) ? { stackPrimaryAlignItems: "MIN" } : {}) }));
  const rowGapHandlers = perLayer(ed, "Gap between rows", refs, (n) => n.stackCounterSpacing ?? n.stackSpacing ?? 0, (_, v) => fields({ stackCounterSpacing: v, stackCounterAlignContent: "AUTO" }), (v) => Math.max(0, v));
  const autoMode = (n: PanelNode) => (isAutoGap(n.stackPrimaryAlignItems) ? n.stackPrimaryAlignItems : SPACE_BETWEEN);
  // The alignment box's X / double-click (Atlas 09 §3.4): Auto on takes the remembered spacing mode; off goes back to
  // the packed alignment it had (Figma's ref cache, CENTER when there is none).
  const packed = useRef<string>("CENTER");
  const toggleAutoGap = () => {
    if (autoGap) return editEach(ed, "Alignment", { final: true, source: "pick" }, refs, () => fields({ stackPrimaryAlignItems: packed.current as never }));
    packed.current = first.stackPrimaryAlignItems ?? "MIN";
    editEach(ed, "Alignment", { final: true, source: "pick" }, refs, (n) => fields({ stackPrimaryAlignItems: autoMode(n) }));
  };
  // B: Align text baseline (a horizontal flow only).
  const baselineOn = nodes.every((n) => n.stackCounterAlignItems === "BASELINE");
  const toggleBaseline = () => horizontal && ed.setProps(refs, fields({ stackCounterAlignItems: baselineOn ? "MIN" : "BASELINE" }), "Align text baseline");
  const highlight = useSpacingHighlight();
  if (flow === "GRID")
    return (
      <>
        <GridDimensionsRow nodes={nodes} action={<AutoLayoutSettingsButton nodes={nodes} />} />
        <PaddingRows nodes={nodes} highlight={highlight} />
      </>
    );
  const gapLabel = () => (horizontal ? t("Horizontal gap between objects") : t("Vertical gap between objects"));
  return (
    <>
      <PropertyRow labels={[t("Alignment"), t("Gap")]} action={<AutoLayoutSettingsButton nodes={nodes} />} className={styles.alignRow}>
        <div className={styles.matrix}>
          <AlignmentMatrix
            direction={horizontal ? "horizontal" : "vertical"}
            value={alignment}
            onChange={(a) => editEach(ed, "Alignment", { final: true, source: "pick" }, refs, (n) => fields({ stackPrimaryAlignItems: a.primary === "SPACE_BETWEEN" ? autoMode(n) : a.primary, stackCounterAlignItems: a.counter }))}
            onToggleAutoGap={toggleAutoGap}
            onToggleBaseline={toggleBaseline}
          />
        </div>
        <div className={styles.gapStack}>
          {/*
            Live: the gap field's chevron at its right edge (its list) — the hover Apply variable left out there. Without
            the row labels (the owner's panel17/74–75) a split control at rest, "12 │ ⌄"; with them (72, 78, the live dump
            design/autolayout-*.txt: the input across the 88) only on hover.
          */}
          <VariableField nodes={nodes} fields={["STACK_SPACING"]} prefix={horizontal ? "24.al.spacing-horizontal" : "24.al.spacing-vertical"} button={false}>
            <NumericInput
              label={gapLabel()}
              prefix={horizontal ? "24.al.spacing-horizontal" : "24.al.spacing-vertical"}
              className={cx(styles.hoverMenuField, !labels && styles.splitMenuField)}
              value={fieldValue(gap)}
              valueLabel={autoGap ? t("Auto") : undefined}
              keywords={["Auto"]}
              onKeyword={() => editEach(ed, "Gap", stepInfo, refs, (n) => fields({ stackPrimaryAlignItems: autoMode(n) }))}
              suffix={
                // Live (popovers/gap-menu.txt): the hover chevron lists the gap's number and Auto, the current one checked.
                <MenuButton
                  label={t("Gap sizing")}
                  className={styles.hoverMenu}
                  overField='[data-ds="NumericInput"]'
                  overAlign="right"
                  overOffset={SIZING_LIST_DY}
                  entries={[
                    { id: "value", label: isMixed(gap) || gap === undefined ? t("Mixed") : String(gap), checked: !autoGap },
                    { id: "auto", label: t("Auto"), checked: !!autoGap },
                  ]}
                  onSelect={(id) =>
                    id === "auto"
                      ? editEach(ed, "Gap", stepInfo, refs, (n) => fields({ stackPrimaryAlignItems: autoMode(n) }))
                      : editEach(ed, "Gap", stepInfo, refs, (n) => fields(isAutoGap(n.stackPrimaryAlignItems) ? { stackPrimaryAlignItems: "MIN" } : {}))
                  }
                >
                  <Icon name="16.chevron.down" />
                </MenuButton>
              }
              {...gapHandlers}
              {...highlight(SPACING_HIGHLIGHT.GAPS)}
            />
          </VariableField>
          {wrap && (
            <VariableField nodes={nodes} fields={["STACK_COUNTER_SPACING"]} prefix="24.al.spacing-vertical">
              <NumericInput
                label={t("Vertical gap between rows")}
                prefix="24.al.spacing-vertical"
                value={fieldValue(rowGap)}
                min={0}
                valueLabel={autoRowGap ? t("Auto") : undefined}
                keywords={["Auto"]}
                onKeyword={() => ed.setProps(refs, fields({ stackCounterAlignContent: "SPACE_BETWEEN" }), "Gap between rows")}
                {...rowGapHandlers}
                {...highlight(SPACING_HIGHLIGHT.GAPS)}
              />
            </VariableField>
          )}
        </div>
      </PropertyRow>
      <PaddingRows nodes={nodes} highlight={highlight} />
    </>
  );
}

const SIDES = [
  ["left", "24.al.padding-left", "Left padding", "STACK_PADDING_LEFT"],
  ["top", "24.al.padding-top", "Top padding", "STACK_PADDING_TOP"],
  ["right", "24.al.padding-right", "Right padding", "STACK_PADDING_RIGHT"],
  ["bottom", "24.al.padding-bottom", "Bottom padding", "STACK_PADDING_BOTTOM"],
] as const;
const ALL_BINDS = ["STACK_PADDING_TOP", "STACK_PADDING_RIGHT", "STACK_PADDING_BOTTOM", "STACK_PADDING_LEFT"] as const;

/** A padding / gap field's hover props: what it edits hatched on the canvas (`useSpacingHighlight`). */
type Highlight = (mask: number) => { onPointerEnter: () => void; onPointerLeave: () => void; onFocusChange: (on: boolean) => void };

/**
 * Round 16 (the owner's request with live Figma): a padding or gap field under the pointer — or focused, or being
 * scrubbed — hatches on the canvas what it edits (the engine's `setSpacingHighlight`, drawn as the pointer's hover over
 * that padding or gap). One per section, so the gap field and the padding fields share it.
 */
function useSpacingHighlight(): Highlight {
  const ed = useEditor();
  const state = useRef({ hover: 0, focus: 0 });
  const sync = () => {
    if (!ed.engine.destroyed) ed.engine.setSpacingHighlight(state.current.hover || state.current.focus);
  };
  useEffect(
    () => () => {
      state.current = { hover: 0, focus: 0 };
      if (!ed.engine.destroyed) ed.engine.setSpacingHighlight(0);
    },
    [ed]
  );
  return (mask) => ({
    onPointerEnter: () => {
      state.current.hover = mask;
      sync();
    },
    onPointerLeave: () => {
      if (state.current.hover === mask) state.current.hover = 0;
      sync();
    },
    onFocusChange: (on) => {
      if (on) state.current.focus = mask;
      else if (state.current.focus === mask) state.current.focus = 0;
      sync();
    },
  });
}

/**
 * A padding field's handlers over `sides` of every layer: a number sets them all; ↑ ↓, "Mixed+10" and the like move
 * each side of each layer from its own value (a pair reading "19, 22" steps to "20, 23"); never below 0.
 */
function paddingHandlers(ed: ReturnType<typeof useEditor>, refs: readonly string[], sides: readonly (keyof Padding)[]): Pick<NumericInputProps, "onChange" | "onStep" | "onExpression" | "onScrubBy" | "onCancel" | "onExit"> {
  const write = (p: Padding, f: (v: number) => number) => fields(paddingFields(Object.fromEntries(sides.map((s) => [s, Math.max(0, f(p[s]))]))));
  const each = (f: (v: number) => number) => (n: PanelNode) => write(paddingOf(n), f);
  return {
    onChange: (v, info) => editEach(ed, "Padding", info, refs, each(() => v)),
    onStep: (d) => editEach(ed, "Padding", stepInfo, refs, each((v) => v + d)),
    onExpression: (f, info) => editEach(ed, "Padding", info, refs, each(f)),
    // "19, 22" scrubbed: each side from its own value (20, 23 …).
    onScrubBy: (d, info) => scrubEach(ed, "Padding", info, refs, paddingOf, (_, p0) => write(p0, (v) => scrubFrom(v, d))),
    onCancel: () => cancelScrub(ed),
    onExit: exitToCanvas(ed),
  };
}

/**
 * Padding (live Figma, the owner's 53–55.png): horizontal and vertical — a pair whose sides differ reads "19, 22"
 * (left, right) / "18, 17" (top, bottom) —, or with "Individual padding" the four sides. ⌘-click on any padding field
 * (or on "Individual padding") makes them one field over all four, "18, 22, 17, 19" (top, right, bottom, left) when
 * they differ, focused with its text selected; it goes back when the keys leave it. Typed: one number sets every side
 * the field covers; "12, 18" in a pair sets its two sides (left, right / top, bottom), in the one field CSS's shorthand
 * (vertical, horizontal; three: top, horizontal, bottom; four: top, right, bottom, left) — model/padding.ts.
 */
function PaddingRows({ nodes, highlight }: { nodes: PanelNode[]; highlight: Highlight }) {
  useT();
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const pads = nodes.map((n) => paddingOf(n));
  const [individual, setIndividual] = useState(false);
  const [merged, setMerged] = useState(false);
  const [mergedPicker, setMergedPicker] = useState<HTMLElement | null>(null);
  const focusMerged = useRef(false);
  const mergedWrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!merged || !focusMerged.current) return;
    focusMerged.current = false;
    mergedWrap.current?.querySelector("input")?.focus();
  }, [merged]);
  const merge = () => {
    focusMerged.current = true;
    setMerged(true);
  };
  const shorthand = (sides: readonly (keyof Padding)[]) => (raw: string) => {
    const p = paddingFromText(raw, sides);
    if (!p) return false;
    ed.setProps(refs, fields(paddingFields(p)), "Padding");
    return true;
  };
  // Figma's glyph at full white (the owner's panel17/74, live panel-grid-autolayout-highres; 78's dashed one is older)
  const toggle = (
    <ToggleIconButton
      icon="24.al.padding-individual"
      label={t("Individual padding")}
      pressed={individual && !merged}
      onPressedChange={() => undefined}
      onClick={(e) => {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) return merged ? setMerged(false) : merge();
        setMerged(false);
        setIndividual(!individual);
      }}
    />
  );
  const field = (label: string, prefix: IconName, sides: readonly (keyof Padding)[], bind: Parameters<typeof VariableField>[0]["fields"], one = false) => {
    const shown = paddingDisplay(pads, sides);
    const hover = highlight(paddingHighlight(sides));
    return (
      <span
        key={label}
        ref={one ? mergedWrap : undefined}
        className={styles.contents}
        data-padding-field={sides.join(",")}
        onPointerEnter={hover.onPointerEnter}
        onPointerLeave={hover.onPointerLeave}
        // ⌘-click (Ctrl-click on Windows) on any padding field: the one field over all four.
        onPointerDownCapture={(e) => {
          if (one || !(e.metaKey || e.ctrlKey) || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          highlight(paddingHighlight(ALL_SIDES)).onPointerEnter();
          merge();
        }}
        // The one field goes back to the fields it came from when the keys leave it (not for its variable picker).
        onBlur={one ? (e) => !mergedPicker && !e.currentTarget.contains(e.relatedTarget as Node | null) && setMerged(false) : undefined}
      >
        <VariableField
          nodes={nodes}
          fields={bind}
          prefix={prefix}
          {...(one
            ? {
                open: mergedPicker,
                onOpenChange: (a: HTMLElement | null) => {
                  setMergedPicker(a);
                  if (!a && !mergedWrap.current?.contains(document.activeElement)) setMerged(false);
                },
              }
            : {})}
        >
          <NumericInput
            label={t(label)}
            prefix={prefix}
            value={"value" in shown ? shown.value : MIXED}
            displayText={"text" in shown ? shown.text : undefined}
            min={0}
            onText={shorthand(sides)}
            onFocusChange={hover.onFocusChange}
            {...paddingHandlers(ed, refs, sides)}
          />
        </VariableField>
      </span>
    );
  };
  if (merged)
    return (
      <PropertyRow labels={[t("Padding"), undefined]} span={2} action={toggle}>
        {field("Padding", "24.al.padding-sides", ALL_SIDES, ALL_BINDS, true)}
      </PropertyRow>
    );
  if (individual)
    return (
      <>
        <PropertyRow labels={[t("Padding"), undefined]} action={toggle}>
          {SIDES.slice(0, 2).map(([side, icon, label, bind]) => field(label, icon, [side], [bind]))}
        </PropertyRow>
        <PropertyRow>{SIDES.slice(2).map(([side, icon, label, bind]) => field(label, icon, [side], [bind]))}</PropertyRow>
      </>
    );
  return (
    <PropertyRow labels={[t("Padding"), undefined]} action={toggle}>
      {field("Horizontal padding", "24.al.padding-horizontal", ["left", "right"], ["STACK_PADDING_LEFT", "STACK_PADDING_RIGHT"])}
      {field("Vertical padding", "24.al.padding-vertical", ["top", "bottom"], ["STACK_PADDING_TOP", "STACK_PADDING_BOTTOM"])}
    </PropertyRow>
  );
}

// ---- Auto layout settings ------------------------------------------------------------------

/** The settings popovers' width (auto layout, type settings): labels and 150 controls on one line. */
export const SETTINGS_WIDTH = 300;

/** The "Auto layout settings" button and its popover. */
export function AutoLayoutSettingsButton({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <IconButton icon="24.adjust.small" label={t("Auto layout settings")} tone="secondary" aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} />
      {anchor && <AutoLayoutSettings nodes={nodes} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

function AutoLayoutSettings({ nodes, anchor, onClose }: { nodes: PanelNode[]; anchor: HTMLElement; onClose: () => void }) {
  useT();
  const ed = useEditor();
  const al = nodes.filter((n) => isAutoLayout(n));
  const refs = al.map((n) => n.guid);
  const spacing = mixed(al.map((n) => (n.stackPrimaryAlignItems === "SPACE_EVENLY_CSS" ? "SPACE_EVENLY_CSS" : n.stackPrimaryAlignItems === "SPACE_AROUND" ? "SPACE_AROUND" : SPACE_BETWEEN)));
  const strokes = mixed(al.map((n) => (n.bordersTakeSpace ? "INCLUDED" : "EXCLUDED")));
  const stacking = mixed(al.map((n) => (n.stackReverseZIndex ? "FIRST" : "LAST")));
  const horizontal = al.every((n) => n.stackMode === "HORIZONTAL");
  const grid = al.every((n) => n.stackMode === "GRID");
  const baseline = mixed(al.map((n) => n.stackCounterAlignItems === "BASELINE"));
  const autoGap = al.every((n) => isAutoGap(n.stackPrimaryAlignItems));
  // The layout version (stackLayoutVersion, Atlas 09 §3.2): Updated (1) or Legacy (0 / absent); picking one is the
  // engine's SET_STACK_LAYOUT_VERSION on the selected stacks (they lay out again by its rules at once, one undo step).
  const version = mixed(al.map((n) => (Number((n as { stackLayoutVersion?: number }).stackLayoutVersion ?? 0) >= 1 ? "UPDATED" : "LEGACY")));
  const strokesLabel = version === "LEGACY" ? t("Strokes") : t("Inside stroke");
  // Live (popovers/autolayout-advanced-settings.txt, grid/grid-autolayout-settings.txt; 240 wide): a 120-high preview,
  // then rows 32 apart from 173 — labels at 16, 112-wide dropdowns at 112: Inside stroke, Canvas stacking, Align text
  // baseline (Disabled / Enabled), Auto spacing (only for an Auto gap), Layout ("Updated"); a grid has Inside stroke and
  // Layout only.
  return (
    // Live: the auto layout one opens 4 above its button (960,481 for the button at 404 + 81), the grid's level with it (960,485)
    <Popover anchor={anchor} title={t("Auto layout settings")} width={240} offsetY={grid ? 0 : -4} onClose={onClose} label={t("Auto layout settings")}>
      <div className={styles.alPreview} aria-hidden="true">{t("Preview")}</div>
      <div className={cx(styles.settings, styles.alSettings)}>
        {/* Atlas 09 §3.9: "Inside stroke" under the Updated layout, "Strokes" under the Legacy one (its key borders_take_space) */}
        <span className={styles.settingsLabel}>{strokesLabel}</span>
        <Select
          label={strokesLabel}
          variant="ghost"
          value={strokes ?? MIXED}
          options={[
            { value: "INCLUDED", label: t("Included") },
            { value: "EXCLUDED", label: t("Excluded") },
          ]}
          onChange={(v) => ed.setProps(refs, fields({ bordersTakeSpace: v === "INCLUDED" }), "Inside stroke")}
        />
        {!grid && (
          <>
            <span className={styles.settingsLabel}>{t("Canvas stacking")}</span>
            <Select
              label={t("Canvas stacking")}
              variant="ghost"
              value={stacking ?? MIXED}
              options={[
                { value: "LAST", label: t("Last on top") },
                { value: "FIRST", label: t("First on top") },
              ]}
              onChange={(v) => ed.setProps(refs, fields({ stackReverseZIndex: v === "FIRST" }), "Canvas stacking")}
            />
            <span className={styles.settingsLabel}>{t("Align text baseline")}</span>
            <span className={cx(styles.alEnd, styles.alLegended)}>
              {/* (Live: the control's "Align text baseline" legend 7 above it at −1, clipped from view) */}
              <span className={styles.alLegend}>{t("Align text baseline")}</span>
              <SegmentedControl
                className={styles.typeSeg}
                label={t("Align text baseline")}
                disabled={!horizontal}
                value={baseline === undefined ? "OFF" : isMixed(baseline) ? MIXED : baseline ? "ON" : "OFF"}
                options={[
                  { value: "OFF", icon: "24.minus.small", tooltip: t("Disabled") },
                  { value: "ON", icon: "24.check", tooltip: t("Enabled") },
                ]}
                onChange={(v) => ed.setProps(refs, fields({ stackCounterAlignItems: v === "ON" ? "BASELINE" : "MIN" }), "Align text baseline")}
              />
            </span>
            <span className={cx(styles.settingsLabel, !autoGap && styles.settingsLabelDisabled)} {...(!autoGap ? tooltipProps(t("Only applicable for Auto gap")) : {})}>{t("Auto spacing")}</span>
            <Select
              label={t("Auto spacing")}
              variant="ghost"
              disabled={!autoGap}
              value={spacing ?? MIXED}
              options={AUTO_SPACING.map((o) => ({ ...o, label: t(o.label) }))}
              // Picking one makes the gap Auto with that spacing (help 31289464393751).
              onChange={(v) => ed.setProps(refs, fields({ stackPrimaryAlignItems: v as never }), "Auto spacing")}
            />
          </>
        )}
        <span className={cx(styles.settingsLabel, styles.alLayoutLabel)}>
          {t("Layout")}
          <button type="button" aria-label={t("More info")} className={styles.alInfo} {...tooltipProps(t("Updated: Figma's current auto layout rules"))}>
            <Icon name="24.info" style={{ margin: -4 }} />
          </button>
        </span>
        <Select
          label={t("Layout")}
          variant="ghost"
          value={version ?? MIXED}
          options={[
            { value: "UPDATED", label: tx("layout version", "Updated") },
            { value: "LEGACY", label: t("Legacy") },
          ]}
          onChange={(v) => void ed.engine.runCommand("SET_STACK_LAYOUT_VERSION", { version: v === "UPDATED" ? 1 : 0 })}
        />
      </div>
    </Popover>
  );
}
