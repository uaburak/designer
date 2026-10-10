/**
 * The Design panel's Position and Appearance sections (Figma UI3, as its live panel lays them out —
 * docs/research/figma/live/design): Position — "Ignore auto layout" in the header for a layer in auto layout,
 * Alignment (two button groups; "More actions" for several layers or a container), Position (X / Y; the
 * "Constraints" popover for a layer in a frame), Rotation (with Rotate 90˚ right / Flip). Appearance — Hide and
 * "Apply blend mode" in the header, the blend mode row while one is set, Opacity and Corner radius ("Individual
 * corners", or "Corner smoothing" for polygons, stars and vectors), Count / Ratio. Layout is Layout.tsx.
 *
 * Every edit is one undo step; a scrub is one open transaction committed on release (ed.edit); a Mixed field
 * steps each layer by the delta (onStep) and takes "Mixed+10" per layer (onExpression).
 */
import { useState } from "react";
import { BLEND_LABEL, BLEND_MODES, Icon, IconButton, MenuButton, MIXED, NumericInput, PanelSection, Popover, PropertyGrid, PropertyRow, Select, SegmentedControl, ToggleIconButton, cx, scrubFrom, type ChangeInfo, type Mixed, type NumericInputProps } from "@/ds";
import type { Guid } from "@/engine/codec";
import { BindButton } from "./Component";
import type { CommandName } from "@/engine/abi";
import { useEditor, type EditorController } from "../../controller";
import { command, isEnabled, runEditorCommand, shortcutOf } from "../../commands";
import { groupChain } from "../../actions";
import { ancestors } from "../../components";
import { useTopics, useUI } from "../../hooks";
import { hasConstraints, type ConstraintHost } from "../../model/constraints";
import { isAutoLayout } from "../../model/sizing";
import { ConstraintsRow, ConstraintsToggle } from "./Constraints";
import { isGrid } from "../../model/grid";
import { ApplyModeButton, ModeRows, VariableField } from "./Variables";
import { fieldValue, mixed, mixedNumber } from "../../model/mixed";
import { IDENTITY, panelPosition, roundPanel, rotateTo, rotationOf, withPanelPosition } from "../../model/geometry";
import { PANEL_MENU_GAP, fields, hasCorners, isFrameNode, isGroupNode, isInstanceSublayer, typeOf, useKeeps, useParents, useSupports, useTextEditRef, type BlendModeName, type PanelNode } from "./shared";
import styles from "./Design.module.css";

type Fields = Parameters<EditorController["engine"]["setProps"]>[1];

/** Writes `fn(fresh node)` to every node as one undo step (a scrub: one open transaction). */
export function editEach(ed: EditorController, label: string, info: ChangeInfo, refs: readonly Guid[], fn: (n: PanelNode) => Fields | null) {
  ed.edit(label, info, () => {
    for (const n of ed.engine.readNodes(refs) as PanelNode[]) {
      const f = fn(ed.withRealType(n as never) as PanelNode);
      if (f) ed.engine.setProps([n.guid], f);
    }
  });
}

export const stepInfo: ChangeInfo = { final: true, source: "step" };

/**
 * A Mixed field's scrub (round 16): each layer's value(s) as the scrub found them, so every step writes start + delta
 * (the open transaction already holds the last step's values). One scrub at a time; dropped on release or Esc.
 */
let scrubStart: Map<string, unknown> | null = null;
export function scrubEach<T>(ed: EditorController, label: string, info: ChangeInfo, refs: readonly Guid[], read: (n: PanelNode) => T, write: (n: PanelNode, start: T) => Fields | null) {
  if (!scrubStart) scrubStart = new Map((ed.engine.readNodes(refs) as PanelNode[]).map((n) => [n.guid, read(ed.withRealType(n as never) as PanelNode)]));
  const start = scrubStart;
  if (info.final) scrubStart = null;
  editEach(ed, label, info, refs, (n) => write(n, start.has(n.guid) ? (start.get(n.guid) as T) : read(n)));
}
export const cancelScrub = (ed: EditorController) => {
  scrubStart = null;
  ed.cancelEdit();
};

/**
 * A number field's handlers over several layers: a value for all, ↑ ↓ on Mixed adding the delta to each, "Mixed+10"
 * applied to each, a scrub cancelled with Esc, Esc giving the keyboard back to the canvas.
 */
export function perLayer(
  ed: EditorController,
  label: string,
  refs: readonly Guid[],
  get: (n: PanelNode) => number,
  set: (n: PanelNode, v: number) => Fields | null,
  clamp: (v: number) => number = (v) => v
): Pick<NumericInputProps, "onChange" | "onStep" | "onExpression" | "onScrubBy" | "onCancel" | "onExit"> {
  return {
    onChange: (v, info) => editEach(ed, label, info, refs, (n) => set(n, v)),
    onStep: (d) => editEach(ed, label, stepInfo, refs, (n) => set(n, clamp(get(n) + d))),
    onExpression: (each, info) => editEach(ed, label, info, refs, (n) => set(n, clamp(each(get(n))))),
    // A Mixed field scrubbed: each layer from its own value, in whole steps.
    onScrubBy: (d, info) => scrubEach(ed, label, info, refs, get, (n, v0) => set(n, clamp(scrubFrom(v0, d)))),
    onCancel: () => cancelScrub(ed),
    onExit: exitToCanvas(ed),
  };
}

/** A command as a segment of a button group (Figma's 29 × 24 align / rotate buttons on #383838). */
/** The alignment buttons' engine commands: ⇧-click aligns each layer to its own parent (help "Align layers"; unverified live). */
const ALIGN_COMMANDS: Record<string, CommandName> = {
  "arrange.align-left": "ALIGN_LEFT",
  "arrange.align-horizontal-center": "ALIGN_HORIZONTAL_CENTER",
  "arrange.align-right": "ALIGN_RIGHT",
  "arrange.align-top": "ALIGN_TOP",
  "arrange.align-vertical-center": "ALIGN_VERTICAL_CENTER",
  "arrange.align-bottom": "ALIGN_BOTTOM",
};

function GroupButton({ id, icon, disabled, run }: { id: string; icon: Parameters<typeof IconButton>[0]["icon"]; disabled?: boolean; run?: () => void }) {
  const ed = useEditor();
  const c = command(id);
  const engineCommand = ALIGN_COMMANDS[id];
  return (
    <IconButton
      icon={icon}
      label={c.label}
      shortcut={shortcutOf(c)}
      className={styles.groupButton}
      disabled={disabled ?? !isEnabled(ed, c)}
      onClick={(e) => (run && !isEnabled(ed, c) ? run() : e.shiftKey && engineCommand ? ed.engine.command(engineCommand, { toParent: true }) : runEditorCommand(ed, id))}
    />
  );
}

/**
 * One frame, group or boolean on its own (live design/frame.txt, group.txt, boolean.txt: the six Align buttons
 * enabled): its children line up inside it — each to the container's box, as one undo step. Unverified beyond the
 * enabled state (help "Align layers": a frame's or group's children align to it).
 */
function alignChildren(ed: EditorController, container: Guid, how: CommandName) {
  const kids = (ed.engine.readNodes([container], { childIds: true })[0]?.childIds ?? []) as Guid[];
  if (!kids.length) return;
  const before = ed.selection;
  ed.engine.setSelection(kids);
  ed.engine.command(how, { toParent: true });
  ed.engine.setSelection(before);
}

/** Esc in a panel field gives the keyboard back to the canvas (Figma; Enter keeps the field). */
export const exitToCanvas = (ed: EditorController) => (reason: string) => {
  if (reason === "escape") ed.focusCanvas();
};

// ---- Position ------------------------------------------------------------------------------

/** A layer's ancestors up to the page as `hasConstraints` reads them (cached node reads, not the whole Layers tree). */
function constraintChain(ed: EditorController, n: PanelNode): ConstraintHost[] {
  const chain: ConstraintHost[] = ancestors(ed, n.guid).map((a) => ({ type: a.type ?? "NONE", group: a.type === "GROUP" || (a.type === "FRAME" && a.resizeToFit === true), stackMode: (a as { stackMode?: string }).stackMode }));
  chain.push({ type: "CANVAS", group: false, stackMode: undefined });
  return chain;
}

/** Several layers, or one container whose children can be spread: the Alignment row's "More actions". */
function AlignmentMore({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const entries = ["arrange.distribute-horizontal", "arrange.distribute-vertical", "arrange.tidy-up"].map((id) => {
    const c = command(id);
    return { id, label: c.label, shortcut: shortcutOf(c), disabled: nodes.length > 1 ? !isEnabled(ed, c) : false };
  });
  return (
    <MenuButton
      label="More actions"
      tooltip
      entries={entries}
      className={styles.iconMenu}
      onSelect={(id) => {
        if (nodes.length > 1) return void runEditorCommand(ed, id);
        // One container: its children are what spreads; the selection comes back after.
        const kids = (ed.engine.readNodes([nodes[0].guid], { childIds: true })[0]?.childIds ?? []) as Guid[];
        if (kids.length < 2) return;
        const before = ed.selection;
        ed.engine.setSelection(kids);
        runEditorCommand(ed, id);
        ed.engine.setSelection(before);
      }}
    >
      <Icon name="24.more" />
    </MenuButton>
  );
}

const GRID_H = [
  { value: "MIN", icon: "24.layout-align-left", tooltip: "Align left" },
  { value: "CENTER", icon: "24.layout-align-horizontal-center", tooltip: "Align horizontal centers" },
  { value: "MAX", icon: "24.layout-align-right", tooltip: "Align right" },
] as const;
const GRID_V = [
  { value: "MIN", icon: "24.layout-align-top", tooltip: "Align top" },
  { value: "CENTER", icon: "24.layout-align-vertical-center", tooltip: "Align vertical centers" },
  { value: "MAX", icon: "24.layout-align-bottom", tooltip: "Align bottom" },
] as const;

export function PositionSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  // The ancestors can change (a reparent, auto layout added above): re-read on structure changes, not per frame.
  useTopics(ed.store, ["structure"]);
  const parents = useParents(nodes);
  const positioningKept = useSupports("stackPositioning");
  const constraintsKept = useSupports("horizontalConstraint");
  // "Ignore auto layout": every layer sits in an auto-layout frame.
  const inAutoLayout = positioningKept && nodes.every((_, i) => isAutoLayout(parents[i]));
  const inGrid = nodes.every((n, i) => isGrid(parents[i]) && n.stackPositioning !== "ABSOLUTE");
  const absolute = mixed(nodes.map((n) => n.stackPositioning === "ABSOLUTE"));
  const constraintsOpen = useUI((s) => !!s.constraintsOpen);
  const constraints = constraintsKept && nodes.every((n) => hasConstraints(constraintChain(ed, n), n.stackPositioning === "ABSOLUTE"));
  const section = nodes.every((n) => typeOf(n) === "SECTION");
  const refs = nodes.map((n) => n.guid);
  const pos = nodes.map((n) => panelPosition(n.transform ?? IDENTITY, groupChain(ed, n)));
  const x = mixedNumber(pos.map((p) => roundPanel(p.x)));
  const y = mixedNumber(pos.map((p) => roundPanel(p.y)));
  const rotation = mixedNumber(nodes.map((n) => roundPanel(rotationOf(n.transform ?? IDENTITY))));
  const axis = (a: "x" | "y") =>
    perLayer(
      ed,
      "Position",
      refs,
      (n) => panelPosition(n.transform ?? IDENTITY, groupChain(ed, n))[a],
      (n, v) => ({ transform: withPanelPosition(n.transform ?? IDENTITY, groupChain(ed, n), a === "x" ? v : null, a === "y" ? v : null) })
    );
  const rotate = perLayer(
    ed,
    "Rotate",
    refs,
    (n) => rotationOf(n.transform ?? IDENTITY),
    (n, deg) => (n.size ? { transform: rotateTo(n.transform ?? IDENTITY, n.size, deg) } : null)
  );
  const container = nodes.length === 1 && (isGroupNode(nodes[0]) || typeOf(nodes[0]) === "BOOLEAN_OPERATION" || (typeOf(nodes[0]) === "FRAME" && !isAutoLayout(nodes[0])));
  // A layer inside an instance keeps its place and turn (live design/nested-instance.txt); a layer in an auto-layout
  // flow keeps its place (autolayout-child, grid-child: X / Y disabled); a text being edited keeps its turn
  // (text-editing-caret: Rotate 90˚ / Flip disabled).
  const locked = nodes.some(isInstanceSublayer);
  const textEdit = useTextEditRef();
  const editingText = !!textEdit && nodes.some((n) => n.guid === textEdit);
  const placeLocked = locked || (inAutoLayout && nodes.every((n) => n.stackPositioning !== "ABSOLUTE"));
  const containerKids = container && !locked ? ((ed.engine.readNodes([nodes[0].guid], { childIds: true })[0]?.childIds ?? []) as Guid[]).length : 0;
  const alignRun = (id: string) => (containerKids > 0 ? () => alignChildren(ed, nodes[0].guid, ALIGN_COMMANDS[id]) : undefined);
  const alignDisabled = (id: string) => (locked ? true : containerKids > 0 ? false : !isEnabled(ed, command(id)));
  const gridH = mixed(nodes.map((n) => (n as { gridChildHorizontalAlign?: string }).gridChildHorizontalAlign ?? "MIN"));
  const gridV = mixed(nodes.map((n) => (n as { gridChildVerticalAlign?: string }).gridChildVerticalAlign ?? "MIN"));
  return (
    <PanelSection
      title="Position"
      actions={
        inAutoLayout ? (
          <ToggleIconButton
            icon="24.al.absolute-position"
            label="Ignore auto layout"
            tone="secondary"
            disabled={locked}
            pressed={absolute ?? false}
            onPressedChange={(on) => ed.setProps(refs, fields({ stackPositioning: on ? "ABSOLUTE" : "AUTO" }), on ? "Ignore auto layout" : "Use auto layout")}
          />
        ) : undefined
      }
    >
      <PropertyGrid labels={labels}>
        {inGrid ? (
          // A layer in a grid: where it sits in its cell (gridChildHorizontalAlign / gridChildVerticalAlign).
          <PropertyRow label="Alignment">
            <SegmentedControl label="Horizontal alignment in cell" fullWidth value={gridH ?? MIXED} options={GRID_H.map((o) => ({ ...o }))} onChange={(v) => ed.setProps(refs, fields({ gridChildHorizontalAlign: v } as never), "Alignment")} />
            <SegmentedControl label="Vertical alignment in cell" fullWidth value={gridV ?? MIXED} options={GRID_V.map((o) => ({ ...o }))} onChange={(v) => ed.setProps(refs, fields({ gridChildVerticalAlign: v } as never), "Alignment")} />
          </PropertyRow>
        ) : (
          <PropertyRow label="Alignment" action={nodes.length > 1 || container ? <AlignmentMore nodes={nodes} /> : undefined}>
            <div className={styles.buttonGroup}>
              <GroupButton id="arrange.align-left" disabled={alignDisabled("arrange.align-left")} run={alignRun("arrange.align-left")} icon="24.layout-align-left" />
              <GroupButton id="arrange.align-horizontal-center" disabled={alignDisabled("arrange.align-horizontal-center")} run={alignRun("arrange.align-horizontal-center")} icon="24.layout-align-horizontal-center" />
              <GroupButton id="arrange.align-right" disabled={alignDisabled("arrange.align-right")} run={alignRun("arrange.align-right")} icon="24.layout-align-right" />
            </div>
            <div className={styles.buttonGroup}>
              <GroupButton id="arrange.align-top" disabled={alignDisabled("arrange.align-top")} run={alignRun("arrange.align-top")} icon="24.layout-align-top" />
              <GroupButton id="arrange.align-vertical-center" disabled={alignDisabled("arrange.align-vertical-center")} run={alignRun("arrange.align-vertical-center")} icon="24.layout-align-vertical-center" />
              <GroupButton id="arrange.align-bottom" disabled={alignDisabled("arrange.align-bottom")} run={alignRun("arrange.align-bottom")} icon="24.layout-align-bottom" />
            </div>
          </PropertyRow>
        )}
        <PropertyRow label="Position" action={constraints && !section ? <ConstraintsToggle /> : undefined}>
          <NumericInput label="X-position" prefix="X" prefixTone="primary" disabled={placeLocked} className={styles.plainDisabled} value={fieldValue(x)} {...axis("x")} />
          <NumericInput label="Y-position" prefix="Y" prefixTone="primary" disabled={placeLocked} className={styles.plainDisabled} value={fieldValue(y)} {...axis("y")} />
        </PropertyRow>
        {constraints && !section && constraintsOpen && <ConstraintsRow nodes={nodes} />}
        {!section && (
          <PropertyRow label="Rotation">
            <NumericInput label="Rotation" prefix="24.rotation" unit="°" disabled={locked} className={styles.plainDisabled} value={fieldValue(rotation)} min={-360} max={360} {...rotate} />
            <div className={styles.buttonGroup}>
              <GroupButton id="object.rotate-90-right" icon="24.rotate" disabled={locked || editingText || undefined} />
              <GroupButton id="object.flip-horizontal" icon="24.flip.horizontal.small" disabled={locked || editingText || undefined} />
              <GroupButton id="object.flip-vertical" icon="24.flip.vertical" disabled={locked || editingText || undefined} />
            </div>
          </PropertyRow>
        )}
      </PropertyGrid>
    </PanelSection>
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

const CORNER_FIELD = {
  rectangleTopLeftCornerRadius: "RECTANGLE_TOP_LEFT_CORNER_RADIUS",
  rectangleTopRightCornerRadius: "RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
  rectangleBottomLeftCornerRadius: "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS",
  rectangleBottomRightCornerRadius: "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS",
} as const;

/**
 * Inverted (concave) corners — our own addition, not Figma's (docs/schema.md §3.6): a corner whose bit is set in
 * `invertedCornerMask` shows its radius as a negative number, and a negative number typed (or stepped below 0) makes
 * the corner inverted. The all-corners field reads negative when every corner is inverted.
 */
const CORNER_BIT: Record<CornerField, number> = {
  rectangleTopLeftCornerRadius: 1,
  rectangleTopRightCornerRadius: 2,
  rectangleBottomRightCornerRadius: 4,
  rectangleBottomLeftCornerRadius: 8,
};
const invertedMask = (n: PanelNode): number => (hasCorners(n) ? (n.invertedCornerMask ?? 0) & 15 : 0);
/** A corner's radius, negative when it is inverted. */
const signedCorner = (n: PanelNode, f: CornerField): number => {
  const r = n[f] ?? n.cornerRadius ?? 0;
  return invertedMask(n) & CORNER_BIT[f] && r > 0 ? -r : r;
};
/** The all-corners radius, negative when every corner is inverted. */
const signedRadius = (n: PanelNode): number => {
  const r = n.cornerRadius ?? 0;
  return invertedMask(n) === 15 && r > 0 ? -r : r;
};

/** Polygons, stars and vectors: one radius for every corner, and corner smoothing (Figma's live panel). */
const SMOOTHED = new Set(["REGULAR_POLYGON", "STAR", "VECTOR"]);
/** Texts, lines and ellipses: the radius field alone (no button), disabled (live ellipse.txt, line.txt, text.txt). */
const PLAIN_RADIUS = new Set(["TEXT", "LINE", "ELLIPSE"]);

/** Figma's iOS corner smoothing preset (help 360050986854). */
export const IOS_SMOOTHING = 60;

export function AppearanceSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const labels = useUI((s) => s.propertyLabels);
  const blendKept = useKeeps("blendMode");
  const refs = nodes.map((n) => n.guid);
  // Every layer starts on Pass through (Figma's live menu checks it for a rectangle); on a leaf Normal draws the
  // same, so neither shows the Blend mode row there (docs/engine-build.md E4).
  const isDefaultBlend = (n: PanelNode) => {
    const b = n.blendMode ?? "PASS_THROUGH";
    return b === "PASS_THROUGH" || (b === "NORMAL" && !isFrameNode(n) && !isGroupNode(n));
  };
  const blend = mixed(nodes.map((n) => n.blendMode ?? "PASS_THROUGH"));
  const blendSet = nodes.some((n) => !isDefaultBlend(n));
  const blendEntries = [
    { id: "PASS_THROUGH", label: "Pass through", checked: blend === "PASS_THROUGH" },
    ...BLEND_MODES.map((m) => (m === "-" ? ("-" as const) : { id: m, label: BLEND_LABEL[m], checked: blend === m })),
  ];
  const blendOptions = [{ value: "PASS_THROUGH", label: "Pass through" }, ...BLEND_MODES.filter((m): m is Exclude<(typeof BLEND_MODES)[number], "-"> => m !== "-").map((m) => ({ value: m, label: BLEND_LABEL[m] }))];
  const polygons = nodes.filter((n) => typeOf(n) === "REGULAR_POLYGON" || typeOf(n) === "STAR");
  const stars = polygons.length > 0 && polygons.every((n) => typeOf(n) === "STAR");
  const countKept = useKeeps("count");
  const opacity = mixedNumber(nodes.map((n) => Math.round((n.opacity ?? 1) * 100)));
  const visible = mixed(nodes.map((n) => n.visible !== false));
  const rectCorners = nodes.some(hasCorners) || nodes.some((n) => isGroupNode(n) || typeOf(n) === "BOOLEAN_OPERATION");
  const smoothOnly = nodes.every((n) => SMOOTHED.has(typeOf(n)));
  const plainOnly = nodes.every((n) => PLAIN_RADIUS.has(typeOf(n)));
  const radius = mixedNumber(nodes.map(signedRadius));
  // Negative radii (inverted corners) only where every layer has four corners.
  const signedOk = nodes.every(hasCorners);
  const independentNow = nodes.some((n) => n.rectangleCornerRadiiIndependent === true);
  const [independentOpen, setIndependentOpen] = useState(false);
  const independent = rectCorners && !smoothOnly && (independentNow || independentOpen);
  const corner = (f: CornerField): Mixed<number> | undefined => mixedNumber(nodes.map((n) => signedCorner(n, f)));

  // Rectangles and frames keep four corners; other layers one radius.
  const radiusFields = (n: PanelNode, v: number): Fields => {
    if (!hasCorners(n)) return { cornerRadius: Math.max(0, v) };
    const r = Math.abs(v);
    return {
      cornerRadius: r,
      rectangleCornerRadiiIndependent: false,
      rectangleTopLeftCornerRadius: r,
      rectangleTopRightCornerRadius: r,
      rectangleBottomRightCornerRadius: r,
      rectangleBottomLeftCornerRadius: r,
      invertedCornerMask: v < 0 ? 15 : 0,
    };
  };
  const radiusHandlers = perLayer(ed, "Corner radius", refs, signedRadius, radiusFields, (v) => (signedOk ? v : Math.max(0, v)));
  const opacityHandlers = perLayer(ed, "Opacity", refs, (n) => Math.round((n.opacity ?? 1) * 100), (_, v) => ({ opacity: Math.min(100, Math.max(0, v)) / 100 }), (v) => Math.min(100, Math.max(0, v)));
  const cornerFields = (n: PanelNode, f: CornerField, v: number): Fields => {
      const all = Object.fromEntries(CORNERS.map(([k]) => [k, n[k] ?? n.cornerRadius ?? 0])) as Record<CornerField, number>;
      const r = hasCorners(n) ? Math.abs(v) : Math.max(0, v);
      all[f] = r;
      const same = CORNERS.every(([k]) => all[k] === all.rectangleTopLeftCornerRadius);
      // A negative value: this corner inverted (our own addition); a positive one: rounded outward again.
      const mask = invertedMask(n);
      const inverted = hasCorners(n) ? (v < 0 ? mask | CORNER_BIT[f] : mask & ~CORNER_BIT[f]) : undefined;
      return {
        ...all,
        rectangleCornerRadiiIndependent: !same,
        cornerRadius: same ? r : (n.cornerRadius ?? 0),
        ...(inverted !== undefined && inverted !== mask ? { invertedCornerMask: inverted } : {}),
      };
    };
  const setCorner = (f: CornerField, v: number, info: ChangeInfo) => editEach(ed, "Corner radius", info, refs, (n) => cornerFields(n, f, v));
  const blendLabel = (b: Mixed<string> | undefined) => (b === undefined || b === MIXED ? "Mixed" : b === "PASS_THROUGH" ? "Pass through" : BLEND_LABEL[b as keyof typeof BLEND_LABEL] ?? b);

  return (
    <PanelSection
      title="Appearance"
      actions={
        <>
          <ApplyModeButton refs={refs} />
          {nodes.length === 1 && <BindButton layer={nodes[0]} field="VISIBLE" type="BOOL" />}
          <IconButton
            icon={visible === false ? "24.hidden.small" : "24.eye.small"}
            label={visible === false ? "Show" : "Hide"}
            shortcut={shortcutOf(command("object.toggle-visible"))}
            tone="secondary"
            onClick={() => ed.setProps(refs, { visible: visible === false }, visible === false ? "Show" : "Hide")}
          />
          <MenuButton label="Apply blend mode" tooltip disabled={!blendKept} entries={blendEntries} className={styles.iconMenu} gap={PANEL_MENU_GAP} flush extend align="end" alignOffset={1} menuWidth={118} onSelect={(id) => ed.setProps(refs, fields({ blendMode: id as BlendModeName }), "Blend mode")}>
            <Icon name={blendSet ? "24.blendmode.active.small" : "24.blendmode.small"} />
          </MenuButton>
        </>
      }
    >
      <PropertyGrid labels={labels}>
        {blendSet && (
          // A blend mode set: its row, its menu, and the minus that puts the default back.
          <PropertyRow
            label="Blend mode"
            span={2}
            action={<IconButton icon="24.minus.small" label="Remove blend mode" tone="secondary" onClick={() => ed.setProps(refs, fields({ blendMode: "PASS_THROUGH" }), "Blend mode")} />}
          >
            <Select label="Blend mode" value={blend ?? MIXED} placeholder={blendLabel(blend)} options={blendOptions} onChange={(v) => ed.setProps(refs, fields({ blendMode: v as BlendModeName }), "Blend mode")} />
          </PropertyRow>
        )}
        <PropertyRow
          labels={["Opacity", "Corner radius"]}
          action={
            plainOnly ? undefined : smoothOnly ? (
              <CornerSmoothingButton nodes={nodes} />
            ) : (
              <ToggleIconButton icon="24.corners.independent" label="Individual corners" tone="secondary" pressed={independent} onPressedChange={setIndependentOpen} />
            )
          }
        >
          <VariableField nodes={nodes} fields={["OPACITY"]} prefix="24.opacity">
            <NumericInput label="Opacity" prefix="24.opacity" unit="%" precision={0} min={0} max={100} value={fieldValue(opacity)} {...opacityHandlers} />
          </VariableField>
          <VariableField nodes={nodes} fields={["CORNER_RADIUS"]} prefix="24.corners" disabled={independentNow}>
            <NumericInput label="Corner radius" prefix="24.corners" min={signedOk ? undefined : 0} disabled={plainOnly} value={independentNow ? MIXED : fieldValue(radius)} {...radiusHandlers} />
          </VariableField>
        </PropertyRow>
        {independent && (
          <>
            {[CORNERS.slice(0, 2), CORNERS.slice(2)].map((pair, i) => (
              // Live: a 2 × 2 grid without captions, Corner smoothing at the end of the bottom row.
              <PropertyRow key={i} data-corner-row={i === 0 ? "top" : "bottom"} action={i === 1 ? <CornerSmoothingButton nodes={nodes} /> : undefined}>
                {pair.map(([f, icon, label]) => (
                  <VariableField key={f} nodes={nodes} fields={[CORNER_FIELD[f]]} prefix={icon}>
                    <NumericInput label={label} prefix={icon} min={signedOk ? undefined : 0} value={fieldValue(corner(f))} onChange={(v, info) => setCorner(f, v, info)} onStep={(d) => editEach(ed, "Corner radius", stepInfo, refs, (n) => cornerFields(n, f, hasCorners(n) ? signedCorner(n, f) + d : Math.max(0, (n[f] ?? n.cornerRadius ?? 0) + d)))} onCancel={() => ed.cancelEdit()} onExit={exitToCanvas(ed)} />
                  </VariableField>
                ))}
              </PropertyRow>
            ))}
          </>
        )}
        {polygons.length > 0 && countKept && <CountRow nodes={polygons} stars={stars} />}
      </PropertyGrid>
      <ModeRows refs={refs} />
    </PanelSection>
  );
}

/** Polygons: "Count"; stars: "Count" and "Ratio" (Figma's live panel; the ratio with one decimal: 38.2%). */
function CountRow({ nodes, stars }: { nodes: PanelNode[]; stars: boolean }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const count = perLayer(ed, "Count", refs, (n) => n.count ?? (typeOf(n) === "STAR" ? 5 : 3), (_, v) => fields({ count: Math.max(3, Math.min(60, Math.round(v))) }), (v) => Math.max(3, Math.min(60, v)));
  const ratio = perLayer(ed, "Ratio", refs, (n) => (n.starInnerScale ?? 0.382) * 100, (_, v) => fields({ starInnerScale: Math.max(0, Math.min(100, v)) / 100 }), (v) => Math.max(0, Math.min(100, v)));
  return (
    <PropertyRow labels={stars ? ["Count", "Ratio"] : undefined} label={stars ? undefined : "Count"}>
      <NumericInput label="Count" prefix="24.polygon" min={3} max={60} precision={0} value={fieldValue(mixedNumber(nodes.map((n) => n.count ?? (typeOf(n) === "STAR" ? 5 : 3))))} {...count} />
      {stars ? <NumericInput label="Ratio" prefix="24.star.outline" unit="%" min={0} max={100} precision={1} value={fieldValue(mixedNumber(nodes.map((n) => Math.round((n.starInnerScale ?? 0.382) * 1000) / 10)))} {...ratio} /> : <span />}
    </PropertyRow>
  );
}

/**
 * "Corner smoothing" (help 360050986854): 0–100%, Figma's iOS preset at 60%; a popover with the slider and the field.
 * The engine draws smoothed rectangles and frames (cornerSmoothing); other layers keep the value.
 */
export function CornerSmoothingButton({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const refs = nodes.map((n) => n.guid);
  const value = mixedNumber(nodes.map((n) => Math.round((n.cornerSmoothing ?? 0) * 100)));
  const on = nodes.some((n) => (n.cornerSmoothing ?? 0) > 0);
  const handlers = perLayer(ed, "Corner smoothing", refs, (n) => (n.cornerSmoothing ?? 0) * 100, (_, v) => ({ cornerSmoothing: Math.max(0, Math.min(100, v)) / 100 }), (v) => Math.max(0, Math.min(100, v)));
  const slider = typeof value === "number" ? value : 0;
  return (
    <>
      <ToggleIconButton icon="24.corner-smoothing" label="Corner smoothing" tone="secondary" pressed={on} aria-expanded={!!anchor} onPressedChange={() => undefined} onClick={(e) => (e.preventDefault(), setAnchor(anchor ? null : e.currentTarget))} />
      {anchor && (
        <Popover anchor={anchor} title="Corner smoothing" width={240} onClose={() => setAnchor(null)} label="Corner smoothing">
          <div className={styles.smoothing} data-corner-smoothing="">
            <div className={styles.smoothingTrack}>
              <input
                type="range"
                aria-label="Corner smoothing"
                className={styles.slider}
                min={0}
                max={100}
                step={1}
                value={slider}
                style={{ ["--fill" as string]: `${slider}%` }}
                onChange={(e) => handlers.onChange(Number(e.currentTarget.value), { final: false, source: "drag" })}
                onPointerUp={(e) => handlers.onChange(Number(e.currentTarget.value), { final: true, source: "drag" })}
                onKeyUp={(e) => handlers.onChange(Number(e.currentTarget.value), { final: true, source: "step" })}
              />
              <button type="button" className={cx(styles.iosMark, slider === IOS_SMOOTHING && styles.iosOn)} style={{ left: `${IOS_SMOOTHING}%` }} aria-label="iOS corner smoothing (60%)" onClick={() => handlers.onChange(IOS_SMOOTHING, { final: true, source: "pick" })}>
                iOS
              </button>
            </div>
            <NumericInput label="Corner smoothing value" unit="%" precision={0} min={0} max={100} value={fieldValue(value)} {...handlers} />
          </div>
        </Popover>
      )}
    </>
  );
}
