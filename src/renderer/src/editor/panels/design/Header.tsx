/**
 * The selection's header row (Figma UI3, live panel docs/research/figma/live/design): 48 high, the type at 16 in
 * 13px/550 — "Frame ▾" / "Group ▾" / "Section ▾" open the frame presets (and convert between the three) —, "N
 * selected" for several layers, then the actions Figma shows for that kind, right-aligned 4 apart (HEADER_ACTIONS):
 *
 *   frame       Toggle ready for dev status · Create component · More actions
 *   group       Toggle ready for dev status · Use as mask · Boolean operations · Create component
 *   section     Toggle ready for dev status
 *   rectangle, ellipse, image          Create component · Use as mask · Boolean operations · Edit object
 *   line, polygon, star, vector        Create component · Use as mask · Boolean operations · More actions
 *   one of those in a frame            Select matching layers · Create component · Use as mask · More actions
 *                                      (live autolayout-child, frame-child-constraints, grid-child)
 *   boolean     Use as mask · Boolean operations · Create component
 *   text        Create link · Apply variable · Create component · More actions
 *   text edited Create link · Apply variable · Create component (no More actions)
 *   several     (Select matching layers) · Use as mask · Boolean operations · More actions
 *
 * "More actions" holds what the row leaves out (Edit object, Use as mask, the boolean operations, Flatten…), in
 * live's menu look (popovers/instance-more-actions-menu.txt): a glyph column, the label at 44, the keys at the right,
 * right-aligned with the button, groups 15 apart.
 */
import { useState } from "react";
import { Icon, IconButton, MenuButton, ToggleIconButton, keys, type IconName, type MenuEntry, type MenuItem } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { command, isEnabled, runEditorCommand, shortcutOf } from "../../commands";
import { commandItem, runMenuItem } from "../../menus";
import { useTopics } from "../../hooks";
import { statusOfTargets, statusTargets } from "../../devStatus";
import { FrameStatusButton } from "./FrameStatusButton";
import { frameStatusTargets } from "../../frameStatus";
import { bindVariable } from "../../variables";
import { OpenVariablesButton, VariablePicker } from "../variables/VariablePicker";
import { BIND_TYPE } from "../../model/variables";
import { sharedBinding } from "./Variables";
import { convertFrameKind, frameKindOf, offeredKinds, type FrameKind } from "./frameKind";
import { PATHFINDER_OPTIONS_ID, PATHFINDERS, pathfinderSubmenu } from "../../pathfinder";
import { PANEL_MENU_GAP, isFrameNode, typeLabel, typeOf, useParents, useTextEditRef, type PanelNode } from "./shared";
import { readC, setOf } from "../../components";
import { isComponent, type CNode } from "../../model/components";
import { setMultiEdit, useMultiEdit } from "./multiEdit";
import styles from "./Design.module.css";
import hstyles from "./Header.module.css";
import { t, useT } from "@/i18n";

/**
 * Figma's frame presets (the "Frame ▾" menu and the Frame tool's list), by category in its order — the live menu
 * (docs/research/figma/live/popovers/frame-presets-menu.txt).
 */
export const FRAME_PRESETS: { header: string; items: [string, number, number][] }[] = [
  {
    header: "Phone Presets",
    items: [
      ["iPhone 17", 402, 874],
      ["iPhone 16 & 17 Pro", 402, 874],
      ["iPhone 16", 393, 852],
      ["iPhone 16 & 17 Pro Max", 440, 956],
      ["iPhone 16 Plus", 430, 932],
      ["iPhone Air", 420, 912],
      ["iPhone 14 & 15 Pro Max", 430, 932],
      ["iPhone 14 & 15 Pro", 393, 852],
      ["iPhone 13 & 14", 390, 844],
      ["iPhone 14 Plus", 428, 926],
      ["Android Compact", 412, 917],
      ["Android Medium", 700, 840],
    ],
  },
  {
    header: "Tablet Presets",
    items: [
      ["iPad mini 8.3", 744, 1133],
      ["Surface Pro 8", 1440, 960],
      ['iPad Pro 11"', 834, 1194],
      ['iPad Pro 12.9"', 1024, 1366],
      ["Android Expanded", 1280, 800],
    ],
  },
  {
    header: "Desktop Presets",
    items: [
      ["MacBook Air", 1280, 832],
      ['MacBook Pro 14"', 1512, 982],
      ['MacBook Pro 16"', 1728, 1117],
      ["Desktop", 1440, 1024],
      ["Wireframes", 1440, 1024],
      ["TV", 1280, 720],
    ],
  },
  {
    header: "Presentation Presets",
    items: [
      ["Slide 16:9", 1920, 1080],
      ["Slide 4:3", 1024, 768],
    ],
  },
  {
    header: "Watch Presets",
    items: [
      ["Apple Watch Series 10 42mm", 187, 223],
      ["Apple Watch Series 10 46mm", 208, 248],
      ["Apple Watch 41mm", 176, 215],
      ["Apple Watch 45mm", 198, 242],
      ["Apple Watch 44mm", 184, 224],
      ["Apple Watch 40mm", 162, 197],
    ],
  },
  {
    header: "Paper Presets",
    items: [
      ["A4", 595, 842],
      ["A5", 420, 595],
      ["A6", 297, 420],
      ["Letter", 612, 792],
      ["Tabloid", 792, 1224],
    ],
  },
  {
    header: "Social Media Presets",
    items: [
      ["Twitter post", 1200, 675],
      ["Twitter header", 1500, 500],
      ["Facebook post", 1200, 630],
      ["Facebook cover", 820, 312],
      ["Instagram post", 1080, 1350],
      ["Instagram story", 1080, 1920],
      ["Dribbble shot", 400, 300],
      ["Dribbble shot HD", 800, 600],
      ["LinkedIn cover", 1584, 396],
    ],
  },
  {
    header: "Figma Presets",
    items: [
      ["Plugin icon", 128, 128],
      ["Profile banner", 1680, 240],
      ["Plugin / file cover", 1920, 1080],
    ],
  },
  {
    header: "Archived Presets",
    items: [
      ["iPhone 13 mini", 375, 812],
      ["iPhone SE", 320, 568],
      ["iPhone 13 Pro Max", 428, 926],
      ["iPhone 13 / 13 Pro", 390, 844],
      ["iPhone 11 Pro Max", 414, 896],
      ["iPhone 11 Pro / X", 375, 812],
      ["iPhone 8 Plus", 414, 736],
      ["iPhone 8", 375, 667],
      ["Android Small", 360, 640],
      ["Android Large", 360, 800],
      ["Google Pixel 2", 411, 731],
      ["Google Pixel 2 XL", 411, 823],
      ["iPad mini 5", 768, 1024],
      ["Surface Pro 4", 1368, 912],
      ["MacBook", 1152, 700],
      ["MacBook Pro", 1440, 900],
      ["Surface Book", 1500, 1000],
      ["Apple Watch 42mm", 156, 195],
      ["Apple Watch 38mm", 136, 170],
      ["iMac", 1280, 720],
      ["Macintosh 128k", 512, 342],
    ],
  },
];

/**
 * The "Frame ▾" menu as live draws it (popovers/frame-presets-menu.txt): one flat list — Section, Frame, Group (what
 * the layer is, checked) —, then each preset block after a line, the size after the name ("402", "×", "874"). The
 * block titles ("Frame Layout Options", "Phone Presets"…) are there for assistive tech only (hidden, as live).
 */
export function frameMenu(kind: FrameKind, offered: Record<FrameKind, boolean> = { Section: true, Frame: true, Group: true }): MenuEntry[] {
  return [
    { header: t("Frame Layout Options") },
    ...(["Section", "Frame", "Group"] as const).map((k) => ({ id: `kind:${k}`, label: t(k), checked: kind === k, disabled: kind !== k && !offered[k] })),
    ...FRAME_PRESETS.flatMap((g): MenuEntry[] => ["-", { header: t(g.header) }, ...g.items.map(([name, w, h]) => ({ id: `${w}x${h}:${name}`, label: t(name), hint: `${w}×${h}` }))]),
  ];
}

/** Figma's boolean group menu: the four operations, then Flatten — each with its glyph (live: labels at 44). */
const BOOLEAN_ITEMS: { id: string; op: "UNION" | "SUBTRACT" | "INTERSECT" | "XOR"; icon: IconName }[] = [
  { id: "vector.union", op: "UNION", icon: "24.boolean.union.small" },
  { id: "vector.subtract", op: "SUBTRACT", icon: "24.boolean.subtract.small" },
  { id: "vector.intersect", op: "INTERSECT", icon: "24.boolean.intersect.small" },
  { id: "vector.exclude", op: "XOR", icon: "24.boolean.exclude.small" },
];

/** The glyph each action carries in the header's menus (every item has one: the label column stays at 44). */
export const ACTION_ICON: Record<string, IconName> = {
  "edit-object": "24.edit.object.small",
  "ready-for-dev": "24.dev-brackets",
  "object.create-component": "24.component.small",
  "object.create-multiple-components": "24.component.small",
  "object.detach-instance": "24.detach.small",
  "object.reset-all-changes": "24.reset.instance.small",
  "reset-name": "24.reset.instance.small",
  "object.push-changes": "24.go.to.main.component.small",
  "object.use-as-mask": "24.mask",
  "object.hide-when-publishing": "24.hidden.small",
  "vector.union": "24.boolean.union.small",
  "vector.subtract": "24.boolean.subtract.small",
  "vector.intersect": "24.boolean.intersect.small",
  "vector.exclude": "24.boolean.exclude.small",
  "vector.flatten": "24.flatten.small",
  // Round 19b [ours]: Illustrator's Pathfinders, drawn in Figma's boolean-icon style.
  ...Object.fromEntries(PATHFINDERS.map((p) => [p.id, p.icon])),
  [PATHFINDER_OPTIONS_ID]: "24.adjust.small",
};

/** A command as a header-menu item: its glyph, never a check column (live labels at 44). */
export function actionItem(ed: EditorController, id: string, label?: string): MenuItem {
  const item = commandItem(ed, id, label);
  return { id: item.id, label: t(item.label), shortcut: item.shortcut, disabled: item.disabled, icon: ACTION_ICON[id.startsWith("reset-changes:") ? "reset-name" : id] ?? "24.component.small" };
}

/** The boolean group's items in More actions (Union … Exclude, then Flatten), live's labels. */
export function booleanActions(ed: EditorController): MenuItem[] {
  return [actionItem(ed, "vector.union", "Union"), actionItem(ed, "vector.subtract", "Subtract"), actionItem(ed, "vector.intersect", "Intersect"), actionItem(ed, "vector.exclude", "Exclude"), actionItem(ed, "vector.flatten")];
}

/** Layers vector edit mode opens (the engine turns shapes into a vector at their first edit). */
const EDITABLE = new Set(["VECTOR", "LINE", "STAR", "REGULAR_POLYGON", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "BOOLEAN_OPERATION"]);
const SHAPES = new Set(["VECTOR", "LINE", "STAR", "REGULAR_POLYGON", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "BOOLEAN_OPERATION"]);

export type HeaderKind = "frame" | "group" | "section" | "rect" | "shape" | "nested" | "boolean" | "text" | "textEdit" | "multi";
export type HeaderAction = "slot" | "ready" | "create" | "mask" | "boolean" | "edit" | "matching" | "link" | "variable" | "multiedit" | "more";

/** The header's actions per kind, left to right (live design/*.txt; Convert to slot only inside a main). */
export const HEADER_ACTIONS: Record<HeaderKind, readonly HeaderAction[]> = {
  frame: ["slot", "ready", "create", "more"],
  group: ["ready", "mask", "boolean", "create"],
  section: ["ready"],
  rect: ["create", "mask", "boolean", "edit"],
  shape: ["create", "mask", "boolean", "more"],
  nested: ["matching", "create", "mask", "more"],
  boolean: ["mask", "boolean", "create"],
  text: ["link", "variable", "create", "more"],
  // While the text is edited on the canvas (live design/text-editing-caret.txt, text-editing-partial.txt): Create link at
  // 152, Apply variable 180, Create component 208 — no More actions.
  textEdit: ["link", "variable", "create"],
  multi: ["matching", "mask", "boolean", "more"],
};

/**
 * Which header Figma shows for a selection. `inFrame`: the one layer sits in a frame, an auto layout or a grid (not
 * on the page, in a section or a group) — a shape there gets the "nested" row (live autolayout-child,
 * frame-child-constraints, grid-child; a nested text, group or boolean keeps its own row: unverified).
 */
export function headerKind(nodes: readonly PanelNode[], inFrame = false, editing: string | null = null): HeaderKind {
  if (nodes.length > 1) return "multi";
  const n = nodes[0];
  if (editing && n.guid === editing && typeOf(n) === "TEXT") return "textEdit";
  const kind = frameKindOf(n);
  if (kind === "Group") return "group";
  if (kind === "Section") return "section";
  if (kind === "Frame") return "frame";
  const ty = typeOf(n);
  if (ty === "TEXT") return "text";
  if (ty === "BOOLEAN_OPERATION") return "boolean";
  if (inFrame && SHAPES.has(ty)) return "nested";
  if (ty === "RECTANGLE" || ty === "ROUNDED_RECTANGLE" || ty === "ELLIPSE") return "rect";
  return "shape";
}

/** Where the selection sits among components: the set of the variant every layer is in, and whether all are in a main. */
export function componentContext(ed: EditorController, nodes: readonly PanelNode[]): { set: Guid | null; inMain: boolean } {
  let set: Guid | null | undefined;
  let inMain = nodes.length > 0;
  for (const n of nodes) {
    let main: CNode | null = null;
    for (let id = readC(ed, n.guid)?.parentIndex?.guid; id; ) {
      const p = readC(ed, id);
      if (!p) break;
      if (isComponent(p)) {
        main = p;
        break;
      }
      id = p.parentIndex?.guid;
    }
    inMain &&= !!main;
    const s = main ? (setOf(ed, main)?.guid ?? null) : null;
    set = set === undefined || set === s ? s : null;
  }
  return { set: set ?? null, inMain };
}

/**
 * The row Figma shows inside components (live 2026-10-23, the owner's "Wecra Design System-2"): in a variant, Multi-edit
 * variants takes Create component's place — a frame: Convert to slot · Multi-edit variants · Select matching layers ·
 * More; a text: Multi-edit · Select matching · Create link · More; two frames: Multi-edit · Select matching · Use as
 * mask · Boolean operations. In a plain main a vector has Select matching · Use as mask · Boolean operations · More; in
 * a frame a frame has Select matching · Create component · Use as mask · Boolean operations and a text Select matching
 * · Create link · Apply variable · More. (A frame in a plain main: Convert to slot · Select matching · Use as mask ·
 * More, and other layers in a variant, are inferred from those.)
 */
export function headerRow(kind: HeaderKind, inFrame: boolean, ctx: { set: Guid | null; inMain: boolean }): readonly HeaderAction[] {
  if (kind === "textEdit" || kind === "section") return HEADER_ACTIONS[kind];
  if (ctx.set) {
    if (kind === "frame") return ["slot", "multiedit", "matching", "more"];
    if (kind === "text") return ["multiedit", "matching", "link", "more"];
    if (kind === "multi") return ["multiedit", "matching", "mask", "boolean"];
    return ["multiedit", "matching", "mask", "more"];
  }
  if (kind === "frame") return ctx.inMain ? ["slot", "matching", "mask", "more"] : inFrame ? ["matching", "create", "mask", "boolean"] : HEADER_ACTIONS.frame;
  if (kind === "text") return ctx.inMain || inFrame ? ["matching", "link", "variable", "more"] : HEADER_ACTIONS.text;
  if (ctx.inMain && kind !== "multi") return ["matching", "mask", "boolean", "more"];
  return HEADER_ACTIONS[kind];
}

/** "Multi-edit variants" (Q): on for the set, one layer picked in a variant takes the same layer in the others. */
export function MultiEditToggle({ set }: { set: Guid }) {
  useT();
  const on = useMultiEdit(set);
  const c = command("object.multi-edit-variants");
  return <ToggleIconButton icon="24.multi-edit.small" label={t(c.label)} shortcut={shortcutOf(c)} tone="secondary" pressed={on} onPressedChange={(v) => setMultiEdit(set, v)} />;
}

/** The header's title: the type ("Image" for a rectangle filled with an image), or "N selected". */
export function headerTitle(nodes: readonly PanelNode[]): string {
  if (nodes.length > 1) return `${nodes.length} selected`;
  const n = nodes[0];
  const ty = typeOf(n);
  if ((ty === "RECTANGLE" || ty === "ROUNDED_RECTANGLE") && (n.fillPaints ?? []).some((p) => p.visible !== false && (p.type === "IMAGE" || (p.type as string) === "VIDEO"))) return "Image";
  return typeLabel(nodes);
}

export function TypeHeader({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  // Command states change with the selection and the document.
  useTopics(ed.store, ["selection", "undo", "structure"]);
  const [parent] = useParents(nodes.length === 1 ? nodes : []);
  const inFrame = !!parent && isFrameNode(parent) && typeOf(parent) !== "SECTION";
  const editing = useTextEditRef();
  const kind = headerKind(nodes, inFrame, editing);
  const context = componentContext(ed, nodes);
  const title = headerTitle(nodes);
  // (`title` stays English: it names the frame kind the presets menu checks.)
  const shownTitle = nodes.length > 1 ? t("{n} selected", { n: nodes.length }) : t(title);
  const presets = kind === "frame" || kind === "group" || kind === "section";
  return (
    <div className={styles.typeHeader} data-type-header={kind}>
      {presets ? (
        <MenuButton
          label={t("{type}, Frame Dimension Presets", { type: shownTitle })}
          entries={frameMenu(title as FrameKind, offeredKinds(ed, nodes))}
          className={styles.typeButton}
          // Live (popovers/frame-presets-menu.txt: 222 × 1887 at 1208,125): 8 under the button, its rows at the button's
          // left from its top, the first lit, the whole list past the window's bottom (moved by the wheel), not cut and scrolled.
          gap={8}
          flush
          extend
          menuClassName={hstyles.presetsMenu}
          onSelect={(id) => pickPreset(ed, nodes, id)}
        >
          <span>{shownTitle}</span>
          <Icon name="16.chevron.down" />
        </MenuButton>
      ) : (
        <span className={styles.typeLabel}>{shownTitle}</span>
      )}
      <div className={styles.headerActions}>
        <HeaderActions nodes={nodes} kind={kind} row={headerRow(kind, inFrame, context)} set={context.set} />
      </div>
    </div>
  );
}

function pickPreset(ed: EditorController, nodes: readonly PanelNode[], id: string) {
  if (id.startsWith("kind:")) {
    convertFrameKind(ed, nodes, id.slice(5) as FrameKind);
    return;
  }
  const [w, h] = id.split(":")[0].split("x").map(Number);
  ed.setProps(
    nodes.map((n) => n.guid),
    { size: { x: w, y: h } },
    "Resize frame"
  );
}

/** The More actions items each header action leaves out of the menu when the row shows it. */
const IN_ROW: Partial<Record<HeaderAction, string[]>> = {
  create: ["object.create-component"],
  mask: ["object.use-as-mask"],
  edit: ["edit-object"],
};

function HeaderActions({ nodes, kind, row, set }: { nodes: PanelNode[]; kind: HeaderKind; row: readonly HeaderAction[]; set: Guid | null }) {
  useT();
  const ed = useEditor();
  const create = command("object.create-component");
  const mask = command("object.use-as-mask");
  const matching = command("edit.select-matching");
  const toSlot = command("object.convert-to-slot");
  const editable = nodes.length === 1 && EDITABLE.has(typeOf(nodes[0])) && ed.vector.available;
  const shapesOnly = nodes.every((n) => SHAPES.has(typeOf(n)));
  const omit = row.flatMap((a) => IN_ROW[a] ?? []);
  const render = (a: HeaderAction) => {
    switch (a) {
      case "slot":
        return isEnabled(ed, toSlot) ? <IconButton key={a} icon="24.convert-to-slot" label={t(toSlot.label)} shortcut={shortcutOf(toSlot)} tone="secondary" onClick={() => runEditorCommand(ed, toSlot.id)} /> : null;
      case "ready":
        // A frame or section that takes the owner's statuses: their button is Ready for dev's (no `</>` beside it).
        return frameStatusTargets(ed).length ? <FrameStatusButton key={a} /> : <ReadyForDevToggle key={a} />;
      case "create":
        return <IconButton key={a} icon="24.component.small" label={t(create.label)} shortcut={shortcutOf(create)} tone="secondary" disabled={!isEnabled(ed, create)} onClick={() => runEditorCommand(ed, create.id)} />;
      case "mask":
        return (
          <ToggleIconButton
            key={a}
            icon="24.mask"
            label={t(mask.label)}
            shortcut={shortcutOf(mask)}
            tone="secondary"
            disabled={!isEnabled(ed, mask)}
            pressed={nodes.length > 0 && nodes.every((n) => (n as { mask?: boolean }).mask === true)}
            onPressedChange={() => runEditorCommand(ed, mask.id)}
          />
        );
      case "boolean":
        return <BooleanGroup key={a} nodes={nodes} />;
      case "edit":
        return <IconButton key={a} icon="24.edit.object.small" label={t("Edit object")} shortcut={keys(["enter"])} tone="secondary" disabled={!editable} onClick={() => ed.vector.start(nodes[0].guid)} />;
      case "matching":
        // Several shapes alone have nothing to match (live multi-two-shapes): the row starts at Use as mask.
        return kind === "multi" && shapesOnly ? null : (
          <IconButton key={a} icon="24.select-matching.small" label={t(matching.label)} shortcut={shortcutOf(matching)} tone="secondary" disabled={!isEnabled(ed, matching)} onClick={() => runEditorCommand(ed, matching.id)} />
        );
      case "multiedit":
        return set ? <MultiEditToggle key={a} set={set} /> : null;
      case "link":
        return <CreateLinkToggle key={a} nodes={nodes} />;
      case "variable":
        return <TextVariableButton key={a} nodes={nodes} />;
      case "more":
        return <MoreActions key={a} nodes={nodes} omit={omit} />;
    }
  };
  return <>{row.map(render)}</>;
}

/** "Toggle ready for dev status": on while every target is Ready for dev (Dev Mode's statuses). */
function ReadyForDevToggle() {
  useT();
  const ed = useEditor();
  const targets = statusTargets(ed);
  const status = statusOfTargets(ed, targets);
  return (
    <ToggleIconButton
      icon="24.dev-brackets"
      label={t("Toggle ready for dev status")}
      tone="secondary"
      disabled={!targets.length}
      pressed={status === "BUILD"}
      onPressedChange={(on) => runEditorCommand(ed, on ? "object.mark-ready-for-dev" : "object.remove-dev-status")}
      data-ready-for-dev=""
    />
  );
}

/** A text's "Create link" (⇧⌘U): on while the text carries a link. */
function CreateLinkToggle({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const c = command("text.create-link");
  const linked = nodes.length > 0 && nodes.every((n) => !!n.hyperlink?.url || !!n.hyperlink?.guid);
  return <ToggleIconButton icon="24.link" label={t(c.label)} shortcut={shortcutOf(c)} tone="secondary" pressed={linked} disabled={!isEnabled(ed, c) && !linked} onPressedChange={() => runEditorCommand(ed, c.id)} />;
}

/** A text's "Apply variable": its content bound to a string variable (the picker; a bound text detaches from it). */
function TextVariableButton({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const refs = nodes.map((n) => n.guid);
  const bound = sharedBinding(nodes, ["TEXT_DATA"]);
  const spec = BIND_TYPE.TEXT_DATA;
  return (
    <>
      <ToggleIconButton
        icon="24.variable.small"
        label={t("Apply variable")}
        tone="secondary"
        disabled={!refs.length}
        pressed={!!bound && bound !== "mixed"}
        aria-expanded={!!open}
        onPressedChange={() => undefined}
        onClick={(e) => {
          e.preventDefault();
          setOpen(open ? null : e.currentTarget);
        }}
      />
      {open && (
        <VariablePicker
          anchor={open}
          types={[spec.type, ...(spec.also ?? [])]}
          scope={spec.scope}
          current={typeof bound === "string" && bound !== "mixed" ? (bound as Guid) : null}
          consumer={refs[0] ?? null}
          onPick={(v) => bindVariable(ed, refs, ["TEXT_DATA"], v.id)}
          footer={<OpenVariablesButton onDone={() => setOpen(null)} />}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/**
 * The boolean menu's entries (live popovers/boolean-operations-menu.txt: Union … Exclude, Flatten — no line, no
 * checks), then ours (round 19b): a line and Illustrator's "Pathfinder ›" — Divide … Minus Back, Pathfinder options….
 */
export function booleanMenu(ed: EditorController, booleans: boolean): MenuEntry[] {
  return [
    ...BOOLEAN_ITEMS.map((b) => {
      const c = command(b.id);
      return { id: b.id, label: t(c.label.replace(" selection", "")), icon: b.icon, shortcut: shortcutOf(c), disabled: !(booleans || isEnabled(ed, c)) };
    }),
    actionItem(ed, "vector.flatten"),
    "-",
    pathfinderSubmenu((id) => actionItem(ed, id)),
  ];
}

/**
 * "Boolean operations": the current (or Union) operation as a button, its menu on the chevron (41 wide, Figma's) —
 * the menu right-aligned with the chevron, 12 under it, its rows from its top (live 151 × 120 at 1253, 129).
 */
function BooleanGroup({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const booleans = nodes.length > 0 && nodes.every((n) => typeOf(n) === "BOOLEAN_OPERATION");
  const current = booleans && nodes.every((n) => n.booleanOperation === nodes[0].booleanOperation) ? (nodes[0].booleanOperation ?? "UNION") : null;
  const entries = booleanMenu(ed, booleans);
  const first = BOOLEAN_ITEMS.find((b) => b.op === (current ?? "UNION")) ?? BOOLEAN_ITEMS[0];
  const firstCommand = command(first.id);
  const any = entries.some((e) => typeof e === "object" && "id" in e && !e.disabled);
  return (
    <div className={styles.splitButton} role="group" aria-label={t("Boolean operations")}>
      <IconButton
        icon={first.icon}
        label={t(firstCommand.label.replace(" selection", ""))}
        shortcut={shortcutOf(firstCommand)}
        tone="secondary"
        className={styles.splitMain}
        disabled={!(booleans || isEnabled(ed, firstCommand))}
        onClick={() => pickBoolean(ed, nodes, first.id, booleans)}
      />
      <MenuButton label={t("Boolean operations")} entries={entries} className={styles.splitChevron} disabled={!any} align="end" gap={PANEL_MENU_GAP} flush menuClassName={hstyles.actionsMenu} onSelect={(id) => pickBoolean(ed, nodes, id, booleans)}>
        <Icon name="16.chevron.down" />
      </MenuButton>
    </div>
  );
}

/** A boolean group selected: the menu changes its operation; otherwise it runs the command on the selection. */
function pickBoolean(ed: EditorController, nodes: PanelNode[], id: string, booleans: boolean) {
  const op = BOOLEAN_ITEMS.find((b) => b.id === id)?.op;
  if (booleans && op) {
    ed.setProps(
      nodes.map((n) => n.guid),
      { booleanOperation: op } as never,
      command(id).label.replace(" selection", "")
    );
    return;
  }
  runMenuItem(ed, id);
}

/**
 * "More actions": what the header row leaves out, in the order of Figma's live menu (popovers/instance-more-actions-
 * menu.txt, owner-2026-10-18): Create component · Use as mask · Union, Subtract, Intersect, Exclude, Flatten · Edit object — each
 * group apart by a line, what the row already shows left out, what can't run hidden (a shape's own menu is not
 * captured: unverified beyond that order).
 */
export function moreActionsMenu(ed: EditorController, nodes: readonly PanelNode[], omit: readonly string[]): MenuEntry[] {
  const editable = nodes.length === 1 && EDITABLE.has(typeOf(nodes[0])) && ed.vector.available;
  // A shape's narrow header (the owner's capture figma-boolean-menu.png, 2026-10-18): the boolean group, then Edit
  // object under a line, last.
  const groups: MenuItem[][] = [
    [actionItem(ed, "object.create-component"), actionItem(ed, "object.create-multiple-components")],
    [actionItem(ed, "object.use-as-mask")],
    booleanActions(ed),
    editable ? [{ id: "edit-object", label: t("Edit object"), icon: ACTION_ICON["edit-object"] }] : [],
  ];
  return groups.flatMap((g): MenuEntry[] => {
    const shown = g.filter((e) => !omit.includes(e.id) && !e.disabled);
    return shown.length ? ["-", ...shown] : [];
  });
}

function MoreActions({ nodes, omit }: { nodes: PanelNode[]; omit: string[] }) {
  useT();
  const ed = useEditor();
  // Built when the menu opens: each item asks its command whether it can run (over the whole selection), which a
  // selection of hundreds of layers would otherwise pay on every panel render.
  const entries = (): MenuEntry[] => {
    const list = moreActionsMenu(ed, nodes, omit);
    return list.length ? list : [{ id: "none", label: t("No actions"), disabled: true }];
  };
  return (
    <MenuButton
      label={t("More actions")}
      entries={entries}
      className={styles.iconMenu}
      align="end"
      gap={PANEL_MENU_GAP}
      flush
      menuClassName={hstyles.actionsMenu}
      onSelect={(id) => {
        if (id === "edit-object") ed.vector.start(nodes[0].guid);
        else runMenuItem(ed, id);
      }}
    >
      <Icon name="24.more" />
    </MenuButton>
  );
}
