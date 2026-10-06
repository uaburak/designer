/**
 * The Design panel's geometry sections for a selection (UI3): Position
 * (alignment, X/Y, rotation with rotate / flip), Layout (auto layout,
 * W/H with Constrain proportions, Clip content) and Appearance (opacity,
 * corner radius, visibility, blend mode). Every edit is one undo step; a
 * scrub is one open transaction committed on release (ed.edit); a Mixed
 * field steps each layer by the delta (onStep).
 */
import { useState } from "react";
import { AlignmentMatrix, BLEND_LABEL, BLEND_MODES, Checkbox, Icon, IconButton, MenuButton, MIXED, NumericInput, PanelSection, PropertyGrid, PropertyRow, SegmentedControl, ToggleIconButton, type Alignment, type ChangeInfo, type Mixed } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { command, isEnabled, runEditorCommand, shortcutOf } from "../../commands";
import { groupChain } from "../../actions";
import { useLayerTree, useUI } from "../../hooks";
import { hasConstraints } from "../../model/constraints";
import { ancestorsOf } from "../../model/layerTree";
import { isAutoLayout } from "../../model/sizing";
import { ConstraintsRow } from "./Constraints";
import { AutoLayoutSettingsButton, LimitRow, SizeField, useLimitAxes } from "./Sizing";
import { fieldValue, mixed, mixedNumber } from "../../model/mixed";
import { IDENTITY, panelPosition, roundPanel, rotateTo, rotationOf, withPanelPosition } from "../../model/geometry";
import { fields, hasCorners, isFrameNode, isGroupNode, typeOf, useKeeps, useParents, useSupports, type BlendModeName, type PanelNode } from "./shared";
import styles from "./Design.module.css";

/** Writes `fn(fresh node)` to every node as one undo step (a scrub: one open transaction). */
function editEach(ed: EditorController, label: string, info: ChangeInfo, refs: readonly Guid[], fn: (n: PanelNode) => Parameters<EditorController["engine"]["setProps"]>[1] | null) {
  ed.edit(label, info, () => {
    for (const n of ed.engine.readNodes(refs) as PanelNode[]) {
      const f = fn(n);
      if (f) ed.engine.setProps([n.guid], f);
    }
  });
}

const stepInfo: ChangeInfo = { final: true, source: "step" };

function CommandButton({ id, icon }: { id: string; icon: Parameters<typeof IconButton>[0]["icon"] }) {
  const ed = useEditor();
  const c = command(id);
  return <IconButton icon={icon} label={c.label} shortcut={shortcutOf(c)} disabled={!isEnabled(ed, c)} onClick={() => runEditorCommand(ed, id)} />;
}

// ---- Position ------------------------------------------------------------------------------

export function PositionSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const tree = useLayerTree();
  const parents = useParents(nodes);
  const positioningKept = useSupports("stackPositioning");
  const constraintsKept = useSupports("horizontalConstraint");
  // "Ignore auto layout": every layer sits in an auto-layout frame.
  const inAutoLayout = positioningKept && nodes.every((_, i) => isAutoLayout(parents[i]));
  const absolute = mixed(nodes.map((n) => n.stackPositioning === "ABSOLUTE"));
  const constraints =
    constraintsKept &&
    nodes.every((n) => {
      const chain = ancestorsOf(tree, n.guid)
        .map((id) => tree.nodes.get(id)!)
        .concat(tree.nodes.get(tree.page) ?? [])
        .map((t) => ({ type: t.type, group: t.group, stackMode: t.stackMode }));
      if (!chain.length) chain.push({ type: "CANVAS", group: false, stackMode: undefined });
      return hasConstraints(chain, n.stackPositioning === "ABSOLUTE");
    });
  const refs = nodes.map((n) => n.guid);
  const pos = nodes.map((n) => panelPosition(n.transform ?? IDENTITY, groupChain(ed, n)));
  const x = mixedNumber(pos.map((p) => roundPanel(p.x)));
  const y = mixedNumber(pos.map((p) => roundPanel(p.y)));
  const rotation = mixedNumber(nodes.map((n) => roundPanel(rotationOf(n.transform ?? IDENTITY))));
  const setAxis = (axis: "x" | "y", v: number, info: ChangeInfo) =>
    editEach(ed, "Position", info, refs, (n) => ({ transform: withPanelPosition(n.transform ?? IDENTITY, groupChain(ed, n), axis === "x" ? v : null, axis === "y" ? v : null) }));
  const stepAxis = (axis: "x" | "y", d: number) =>
    editEach(ed, "Position", stepInfo, refs, (n) => {
      const p = panelPosition(n.transform ?? IDENTITY, groupChain(ed, n));
      return { transform: withPanelPosition(n.transform ?? IDENTITY, groupChain(ed, n), axis === "x" ? p.x + d : null, axis === "y" ? p.y + d : null) };
    });
  const setRotation = (deg: number, info: ChangeInfo) => editEach(ed, "Rotate", info, refs, (n) => (n.size ? { transform: rotateTo(n.transform ?? IDENTITY, n.size, deg) } : null));
  const stepRotation = (d: number) => editEach(ed, "Rotate", stepInfo, refs, (n) => (n.size ? { transform: rotateTo(n.transform ?? IDENTITY, n.size, rotationOf(n.transform ?? IDENTITY) + d) } : null));
  return (
    <PanelSection title="Position">
      <PropertyGrid labels={labels}>
        <PropertyRow label="Alignment">
          <div className={styles.buttons}>
            <CommandButton id="arrange.align-left" icon="24.layout-align-left" />
            <CommandButton id="arrange.align-horizontal-center" icon="24.layout-align-horizontal-center" />
            <CommandButton id="arrange.align-right" icon="24.layout-align-right" />
          </div>
          <div className={styles.buttons}>
            <CommandButton id="arrange.align-top" icon="24.layout-align-top" />
            <CommandButton id="arrange.align-vertical-center" icon="24.layout-align-vertical-center" />
            <CommandButton id="arrange.align-bottom" icon="24.layout-align-bottom" />
          </div>
        </PropertyRow>
        <PropertyRow
          label="Position"
          action={
            inAutoLayout ? (
              <ToggleIconButton
                icon="24.al.absolute-position"
                label="Ignore auto layout"
                pressed={absolute ?? false}
                onPressedChange={(on) => ed.setProps(refs, fields({ stackPositioning: on ? "ABSOLUTE" : "AUTO" }), on ? "Ignore auto layout" : "Use auto layout")}
              />
            ) : undefined
          }
        >
          <NumericInput label="X" prefix="X" value={fieldValue(x)} onChange={(v, info) => setAxis("x", v, info)} onCancel={() => ed.cancelEdit()} onStep={(d) => stepAxis("x", d)} onExit={exitToCanvas(ed)} />
          <NumericInput label="Y" prefix="Y" value={fieldValue(y)} onChange={(v, info) => setAxis("y", v, info)} onCancel={() => ed.cancelEdit()} onStep={(d) => stepAxis("y", d)} onExit={exitToCanvas(ed)} />
        </PropertyRow>
        {constraints && <ConstraintsRow nodes={nodes} />}
        <PropertyRow label="Rotation">
          <NumericInput label="Rotation" prefix="24.rotation" unit="°" value={fieldValue(rotation)} min={-360} max={360} onChange={(v, info) => setRotation(v, info)} onCancel={() => ed.cancelEdit()} onStep={stepRotation} onExit={exitToCanvas(ed)} />
          <div className={styles.buttons}>
            <CommandButton id="object.rotate-90-right" icon="24.rotate" />
            <CommandButton id="object.flip-horizontal" icon="24.flip.horizontal.small" />
            <CommandButton id="object.flip-vertical" icon="24.flip.vertical" />
          </div>
        </PropertyRow>
      </PropertyGrid>
    </PanelSection>
  );
}

/** Enter / Esc in a panel field give the keyboard back to the canvas (Figma). */
export const exitToCanvas = (ed: EditorController) => (reason: string) => {
  if (reason === "enter" || reason === "escape") ed.focusCanvas();
};

// ---- Layout ----------------------------------------------------------------------------------

type Direction = "v" | "h" | "w";

const directionOf = (n: PanelNode): Direction | null => (n.stackMode === "VERTICAL" ? "v" : n.stackMode === "HORIZONTAL" ? (n.stackWrap === "WRAP" ? "w" : "h") : null);

export function LayoutSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const autoLayoutKept = useSupports("stackMode");
  const constrainKept = useSupports("proportionsConstrained");
  const parents = useParents(nodes);
  const limits = useLimitAxes(nodes);
  const refs = nodes.map((n) => n.guid);
  const frames = nodes.every(isFrameNode);
  const directions = nodes.map(directionOf);
  const auto = autoLayoutKept && frames && directions.every((d) => d !== null);
  const constrained = mixed(nodes.map((n) => n.proportionsConstrained === true));

  const addAutoLayout = () => {
    if (runEditorCommand(ed, "object.add-auto-layout")) return;
    if (autoLayoutKept && frames) ed.setProps(refs, fields({ stackMode: "VERTICAL", stackSpacing: 10, stackHorizontalPadding: 10, stackVerticalPadding: 10, stackPaddingRight: 10, stackPaddingBottom: 10 }), "Add auto layout");
  };
  const removeAutoLayout = () => {
    if (runEditorCommand(ed, "object.remove-auto-layout")) return;
    ed.setProps(refs, fields({ stackMode: "NONE" }), "Remove auto layout");
  };
  const addCommand = command("object.add-auto-layout");
  const actions = frames ? (
    auto ? (
      <IconButton icon="24.minus.small" label="Remove auto layout" shortcut={shortcutOf(command("object.remove-auto-layout"))} tone="secondary" onClick={removeAutoLayout} />
    ) : (
      <IconButton icon="24.autolayout-add-vertical" label="Add auto layout" shortcut={shortcutOf(addCommand)} tone="secondary" disabled={!autoLayoutKept && !isEnabled(ed, addCommand)} onClick={addAutoLayout} />
    )
  ) : undefined;

  return (
    <PanelSection title={auto ? "Auto layout" : "Layout"} actions={actions}>
      <PropertyGrid labels={labels}>
        {auto && <DirectionRow nodes={nodes} />}
        <PropertyRow
          label="Dimensions"
          action={constrainKept ? <ToggleIconButton icon="24.constrain-proportions" label="Constrain proportions" pressed={constrained ?? false} onPressedChange={(on) => ed.setProps(refs, fields({ proportionsConstrained: on }), "Constrain proportions")} /> : undefined}
        >
          <SizeField axis="x" nodes={nodes} parents={parents} onAddLimit={limits.open} />
          <SizeField axis="y" nodes={nodes} parents={parents} onAddLimit={limits.open} />
        </PropertyRow>
        {limits.axes.map((axis) => (
          <LimitRow key={axis} axis={axis} nodes={nodes} />
        ))}
        {auto && <AutoLayoutRows nodes={nodes} />}
      </PropertyGrid>
      {frames && (
        <div className={styles.checkRow}>
          <Checkbox label="Clip content" checked={mixed(nodes.map((n) => n.frameMaskDisabled !== true)) ?? true} onChange={(on) => ed.setProps(refs, { frameMaskDisabled: !on }, "Clip content")} />
        </div>
      )}
    </PanelSection>
  );
}

/** The flow: Vertical / Horizontal / Wrap, and the advanced settings. */
function DirectionRow({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const direction = mixed(nodes.map((n) => directionOf(n) ?? "v"));
  return (
    <PropertyRow span={2} label="Direction" action={<AutoLayoutSettingsButton nodes={nodes} />}>
      <SegmentedControl
        label="Direction"
        fullWidth
        value={direction ?? MIXED}
        options={[
          { value: "v", icon: "24.al.layout-vertical", tooltip: "Vertical layout" },
          { value: "h", icon: "24.al.layout-horizontal", tooltip: "Horizontal layout" },
          { value: "w", icon: "24.al.layout-wrap", tooltip: "Wrap" },
        ]}
        onChange={(v) => ed.setProps(refs, fields({ stackMode: v === "v" ? "VERTICAL" : "HORIZONTAL", stackWrap: v === "w" ? "WRAP" : "NO_WRAP" }), "Auto layout direction")}
      />
    </PropertyRow>
  );
}

function AutoLayoutRows({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const direction = mixed(nodes.map((n) => directionOf(n) ?? "v"));
  const first = nodes[0];
  const horizontal = direction !== "v";
  const alignment: Alignment = {
    primary: first.stackPrimaryAlignItems === "CENTER" || first.stackPrimaryAlignItems === "MAX" || first.stackPrimaryAlignItems === "SPACE_BETWEEN" ? first.stackPrimaryAlignItems : "MIN",
    counter: first.stackCounterAlignItems === "CENTER" || first.stackCounterAlignItems === "MAX" ? first.stackCounterAlignItems : "MIN",
  };
  const gap = mixedNumber(nodes.map((n) => n.stackSpacing ?? 0));
  const autoGap = nodes.every((n) => n.stackPrimaryAlignItems === "SPACE_BETWEEN");
  const padH = mixedNumber(nodes.map((n) => n.stackHorizontalPadding ?? 0));
  const padV = mixedNumber(nodes.map((n) => n.stackVerticalPadding ?? 0));
  const set = (label: string, info: ChangeInfo, f: (n: PanelNode) => ReturnType<typeof fields>) => editEach(ed, label, info, refs, f);
  return (
    <>
      <PropertyRow label="Alignment and gap">
        <div className={styles.matrix}>
          <AlignmentMatrix direction={horizontal ? "horizontal" : "vertical"} value={alignment} onChange={(a) => ed.setProps(refs, fields({ stackPrimaryAlignItems: a.primary, stackCounterAlignItems: a.counter }), "Alignment")} />
        </div>
        <NumericInput
          label="Gap between items"
          prefix={horizontal ? "24.al.spacing-horizontal" : "24.al.spacing-vertical"}
          value={fieldValue(gap)}
          min={0}
          valueLabel={autoGap ? "Auto" : undefined}
          onChange={(v, info) => set("Gap", info, (n) => fields({ stackSpacing: v, ...(n.stackPrimaryAlignItems === "SPACE_BETWEEN" ? { stackPrimaryAlignItems: "MIN" } : {}) }))}
          onCancel={() => ed.cancelEdit()}
          onStep={(d) => set("Gap", stepInfo, (n) => fields({ stackSpacing: Math.max(0, (n.stackSpacing ?? 0) + d) }))}
          onExit={exitToCanvas(ed)}
        />
      </PropertyRow>
      <PropertyRow label="Padding">
        <NumericInput
          label="Horizontal padding"
          prefix="24.al.padding-horizontal"
          value={fieldValue(padH)}
          min={0}
          onChange={(v, info) => set("Padding", info, () => fields({ stackHorizontalPadding: v, stackPaddingRight: v }))}
          onCancel={() => ed.cancelEdit()}
          onExit={exitToCanvas(ed)}
        />
        <NumericInput
          label="Vertical padding"
          prefix="24.al.padding-vertical"
          value={fieldValue(padV)}
          min={0}
          onChange={(v, info) => set("Padding", info, () => fields({ stackVerticalPadding: v, stackPaddingBottom: v }))}
          onCancel={() => ed.cancelEdit()}
          onExit={exitToCanvas(ed)}
        />
      </PropertyRow>
    </>
  );
}

// ---- Appearance ----------------------------------------------------------------------------

const CORNERS = [
  ["rectangleTopLeftCornerRadius", "24.radius.top.left", "Top left corner radius"],
  ["rectangleTopRightCornerRadius", "24.radius.top.right", "Top right corner radius"],
  ["rectangleBottomLeftCornerRadius", "24.radius.bottom.left", "Bottom left corner radius"],
  ["rectangleBottomRightCornerRadius", "24.radius.bottom.right", "Bottom right corner radius"],
] as const;

type CornerField = (typeof CORNERS)[number][0];

export function AppearanceSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const blendKept = useKeeps("blendMode");
  const refs = nodes.map((n) => n.guid);
  // Containers default to Pass through, leaves to Normal (docs/engine-build.md E4).
  const blend = mixed(nodes.map((n) => n.blendMode ?? (isFrameNode(n) || isGroupNode(n) ? "PASS_THROUGH" : "NORMAL")));
  const blendEntries = [
    { id: "PASS_THROUGH", label: "Pass through", checked: blend === "PASS_THROUGH" },
    ...BLEND_MODES.map((m) => (m === "-" ? ("-" as const) : { id: m, label: BLEND_LABEL[m], checked: blend === m })),
  ];
  const blendActive = blend !== "PASS_THROUGH" && blend !== "NORMAL";
  const polygons = nodes.every((n) => typeOf(n) === "REGULAR_POLYGON" || typeOf(n) === "STAR");
  const stars = nodes.every((n) => typeOf(n) === "STAR");
  const countKept = useKeeps("count");
  const opacity = mixedNumber(nodes.map((n) => Math.round((n.opacity ?? 1) * 100)));
  const visible = mixed(nodes.map((n) => n.visible !== false));
  const corners = nodes.every(hasCorners);
  const radius = mixedNumber(nodes.map((n) => n.cornerRadius ?? 0));
  const independentNow = nodes.some((n) => n.rectangleCornerRadiiIndependent === true);
  const [independentOpen, setIndependentOpen] = useState(false);
  const independent = independentNow || independentOpen;
  const corner = (f: CornerField): Mixed<number> | undefined => mixedNumber(nodes.map((n) => n[f] ?? n.cornerRadius ?? 0));

  const setRadius = (v: number, info: ChangeInfo) =>
    editEach(ed, "Corner radius", info, refs, () => ({
      cornerRadius: v,
      rectangleCornerRadiiIndependent: false,
      rectangleTopLeftCornerRadius: v,
      rectangleTopRightCornerRadius: v,
      rectangleBottomRightCornerRadius: v,
      rectangleBottomLeftCornerRadius: v,
    }));
  const setCorner = (f: CornerField, v: number, info: ChangeInfo) =>
    editEach(ed, "Corner radius", info, refs, (n) => {
      const all = Object.fromEntries(CORNERS.map(([k]) => [k, n[k] ?? n.cornerRadius ?? 0])) as Record<CornerField, number>;
      all[f] = v;
      const same = CORNERS.every(([k]) => all[k] === all.rectangleTopLeftCornerRadius);
      return { ...all, rectangleCornerRadiiIndependent: !same, cornerRadius: same ? v : (n.cornerRadius ?? 0) };
    });

  return (
    <PanelSection
      title="Appearance"
      actions={
        <>
          <IconButton
            icon={visible === false ? "24.hidden.small" : "24.eye.small"}
            label={visible === false ? "Show" : "Hide"}
            shortcut={shortcutOf(command("object.toggle-visible"))}
            tone="secondary"
            onClick={() => ed.setProps(refs, { visible: visible === false }, visible === false ? "Show" : "Hide")}
          />
          {blendKept ? (
            <MenuButton label="Blend mode" entries={blendEntries} className={styles.iconMenu} onSelect={(id) => ed.setProps(refs, fields({ blendMode: id as BlendModeName }), "Blend mode")}>
              <Icon name={blendActive ? "24.blendmode.active.small" : "24.blendmode.small"} />
            </MenuButton>
          ) : (
            <IconButton icon="24.blendmode.small" label="Blend mode" tone="secondary" disabled />
          )}
        </>
      }
    >
      <PropertyGrid labels={labels}>
        <PropertyRow label={corners ? "Opacity and corner radius" : "Opacity"} action={corners ? <ToggleIconButton icon="24.corners.independent" label="Individual corners" pressed={independent} onPressedChange={setIndependentOpen} /> : undefined}>
          <NumericInput
            label="Opacity"
            prefix="24.opacity"
            unit="%"
            precision={0}
            min={0}
            max={100}
            value={fieldValue(opacity)}
            onChange={(v, info) => editEach(ed, "Opacity", info, refs, () => ({ opacity: v / 100 }))}
            onCancel={() => ed.cancelEdit()}
            onStep={(d) => editEach(ed, "Opacity", stepInfo, refs, (n) => ({ opacity: Math.min(1, Math.max(0, (n.opacity ?? 1) + d / 100)) }))}
            onExit={exitToCanvas(ed)}
          />
          {corners ? (
            <NumericInput
              label="Corner radius"
              prefix="24.corners"
              min={0}
              value={independentNow ? MIXED : fieldValue(radius)}
              onChange={setRadius}
              onCancel={() => ed.cancelEdit()}
              onStep={(d) => editEach(ed, "Corner radius", stepInfo, refs, (n) => ({ cornerRadius: Math.max(0, (n.cornerRadius ?? 0) + d) }))}
              onExit={exitToCanvas(ed)}
            />
          ) : (
            <span />
          )}
        </PropertyRow>
        {polygons && countKept && (
          <PropertyRow label={stars ? "Count and ratio" : "Count"}>
            <NumericInput
              label="Count"
              prefix="24.polygon"
              min={3}
              max={60}
              precision={0}
              value={fieldValue(mixedNumber(nodes.map((n) => n.count ?? (typeOf(n) === "STAR" ? 5 : 3))))}
              onChange={(v, info) => editEach(ed, "Count", info, refs, () => fields({ count: Math.round(v) }))}
              onCancel={() => ed.cancelEdit()}
              onStep={(d) => editEach(ed, "Count", stepInfo, refs, (n) => fields({ count: Math.max(3, Math.min(60, (n.count ?? 3) + d)) }))}
              onExit={exitToCanvas(ed)}
            />
            {stars ? (
              <NumericInput
                label="Ratio"
                prefix="24.star.outline"
                unit="%"
                min={0}
                max={100}
                precision={0}
                value={fieldValue(mixedNumber(nodes.map((n) => Math.round((n.starInnerScale ?? 0.382) * 100))))}
                onChange={(v, info) => editEach(ed, "Ratio", info, refs, () => fields({ starInnerScale: v / 100 }))}
                onCancel={() => ed.cancelEdit()}
                onExit={exitToCanvas(ed)}
              />
            ) : (
              <span />
            )}
          </PropertyRow>
        )}
        {corners && independent && (
          <>
            {[CORNERS.slice(0, 2), CORNERS.slice(2)].map((pair, i) => (
              <PropertyRow key={i} label={i === 0 ? "Top corners" : "Bottom corners"}>
                {pair.map(([f, icon, label]) => (
                  <NumericInput key={f} label={label} prefix={icon} min={0} value={fieldValue(corner(f))} onChange={(v, info) => setCorner(f, v, info)} onCancel={() => ed.cancelEdit()} onExit={exitToCanvas(ed)} />
                ))}
              </PropertyRow>
            ))}
          </>
        )}
      </PropertyGrid>
    </PanelSection>
  );
}
