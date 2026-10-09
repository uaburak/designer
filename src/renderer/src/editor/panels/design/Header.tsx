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
import { bindVariable } from "../../variables";
import { OpenVariablesButton, VariablePicker } from "../variables/VariablePicker";
import { BIND_TYPE } from "../../model/variables";
import { sharedBinding } from "./Variables";
import { convertFrameKind, frameKindOf, offeredKinds, type FrameKind } from "./frameKind";
import { PANEL_MENU_GAP, isFrameNode, typeLabel, typeOf, useParents, type PanelNode } from "./shared";
import styles from "./Design.module.css";
import hstyles from "./Header.module.css";

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
      ["iPad Pro 11", 834, 1194],
      ["iPad Pro 12.9", 1024, 1366],
      ["Android Expanded", 1280, 800],
    ],
  },
  {
    header: "Desktop Presets",
    items: [
      ["MacBook Air", 1280, 832],
      ["MacBook Pro 14", 1512, 982],
      ["MacBook Pro 16", 1728, 1117],
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
    { header: "Frame Layout Options" },
    ...(["Section", "Frame", "Group"] as const).map((k) => ({ id: `kind:${k}`, label: k, checked: kind === k, disabled: kind !== k && !offered[k] })),
    ...FRAME_PRESETS.flatMap((g): MenuEntry[] => ["-", { header: g.header }, ...g.items.map(([name, w, h]) => ({ id: `${w}x${h}:${name}`, label: name, hint: `${w}×${h}` }))]),
  ];
}

/** Figma's boolean group menu: the four operations, then Flatten — each with its glyph (live: labels at 44). */
const BOOLEAN_ITEMS: { id: string; op: "UNION" | "SUBTRACT" | "INTERSECT" | "XOR"; icon: IconName }[] = [
  { id: "vector.union", op: "UNION", icon: "16.boolean.union" },
  { id: "vector.subtract", op: "SUBTRACT", icon: "16.boolean.subtract" },
  { id: "vector.intersect", op: "INTERSECT", icon: "16.boolean.intersect" },
  { id: "vector.exclude", op: "XOR", icon: "16.boolean.exclude" },
];

/** The glyph each action carries in the header's menus (every item has one: the label column stays at 44). */
export const ACTION_ICON: Record<string, IconName> = {
  "edit-object": "24.pen",
  "ready-for-dev": "24.dev-brackets",
  "object.create-component": "24.component.small",
  "object.create-multiple-components": "24.component.small",
  "object.detach-instance": "24.detach.small",
  "object.reset-all-changes": "24.reset.instance.small",
  "reset-name": "24.reset.instance.small",
  "object.push-changes": "24.go.to.main.component.small",
  "object.use-as-mask": "24.mask",
  "object.hide-when-publishing": "24.hidden.small",
  "vector.union": "16.boolean.union",
  "vector.subtract": "16.boolean.subtract",
  "vector.intersect": "16.boolean.intersect",
  "vector.exclude": "16.boolean.exclude",
  "vector.flatten": "16.vector",
};

/** A command as a header-menu item: its glyph, never a check column (live labels at 44). */
export function actionItem(ed: EditorController, id: string, label?: string): MenuItem {
  const item = commandItem(ed, id, label);
  return { id: item.id, label: item.label, shortcut: item.shortcut, disabled: item.disabled, icon: ACTION_ICON[id.startsWith("reset-changes:") ? "reset-name" : id] ?? "24.component.small" };
}

/** The boolean group's items in More actions (Union … Exclude, then Flatten), live's labels. */
export function booleanActions(ed: EditorController): MenuItem[] {
  return [actionItem(ed, "vector.union", "Union"), actionItem(ed, "vector.subtract", "Subtract"), actionItem(ed, "vector.intersect", "Intersect"), actionItem(ed, "vector.exclude", "Exclude"), actionItem(ed, "vector.flatten")];
}

/** Layers vector edit mode opens (the engine turns shapes into a vector at their first edit). */
const EDITABLE = new Set(["VECTOR", "LINE", "STAR", "REGULAR_POLYGON", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "BOOLEAN_OPERATION"]);
const SHAPES = new Set(["VECTOR", "LINE", "STAR", "REGULAR_POLYGON", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "BOOLEAN_OPERATION"]);

export type HeaderKind = "frame" | "group" | "section" | "rect" | "shape" | "nested" | "boolean" | "text" | "multi";
export type HeaderAction = "slot" | "ready" | "create" | "mask" | "boolean" | "edit" | "matching" | "link" | "variable" | "more";

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
  multi: ["matching", "mask", "boolean", "more"],
};

/**
 * Which header Figma shows for a selection. `inFrame`: the one layer sits in a frame, an auto layout or a grid (not
 * on the page, in a section or a group) — a shape there gets the "nested" row (live autolayout-child,
 * frame-child-constraints, grid-child; a nested text, group or boolean keeps its own row: unverified).
 */
export function headerKind(nodes: readonly PanelNode[], inFrame = false): HeaderKind {
  if (nodes.length > 1) return "multi";
  const n = nodes[0];
  const kind = frameKindOf(n);
  if (kind === "Group") return "group";
  if (kind === "Section") return "section";
  if (kind === "Frame") return "frame";
  const t = typeOf(n);
  if (t === "TEXT") return "text";
  if (t === "BOOLEAN_OPERATION") return "boolean";
  if (inFrame && SHAPES.has(t)) return "nested";
  if (t === "RECTANGLE" || t === "ROUNDED_RECTANGLE" || t === "ELLIPSE") return "rect";
  return "shape";
}

/** The header's title: the type ("Image" for a rectangle filled with an image), or "N selected". */
export function headerTitle(nodes: readonly PanelNode[]): string {
  if (nodes.length > 1) return `${nodes.length} selected`;
  const n = nodes[0];
  const t = typeOf(n);
  if ((t === "RECTANGLE" || t === "ROUNDED_RECTANGLE") && (n.fillPaints ?? []).some((p) => p.visible !== false && (p.type === "IMAGE" || (p.type as string) === "VIDEO"))) return "Image";
  return typeLabel(nodes);
}

export function TypeHeader({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  // Command states change with the selection and the document.
  useTopics(ed.store, ["selection", "undo", "structure"]);
  const [parent] = useParents(nodes.length === 1 ? nodes : []);
  const inFrame = !!parent && isFrameNode(parent) && typeOf(parent) !== "SECTION";
  const kind = headerKind(nodes, inFrame);
  const title = headerTitle(nodes);
  const presets = kind === "frame" || kind === "group" || kind === "section";
  return (
    <div className={styles.typeHeader} data-type-header={kind}>
      {presets ? (
        <MenuButton
          label={`${title}, Frame Dimension Presets`}
          entries={frameMenu(title as FrameKind, offeredKinds(ed, nodes))}
          className={styles.typeButton}
          // Live: the list right under the button, its rows at the button's left.
          gap={0}
          menuClassName={hstyles.presetsMenu}
          onSelect={(id) => pickPreset(ed, nodes, id)}
        >
          <span>{title}</span>
          <Icon name="16.chevron.down" />
        </MenuButton>
      ) : (
        <span className={styles.typeLabel}>{title}</span>
      )}
      <div className={styles.headerActions}>
        <HeaderActions nodes={nodes} kind={kind} />
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

function HeaderActions({ nodes, kind }: { nodes: PanelNode[]; kind: HeaderKind }) {
  const ed = useEditor();
  const row = HEADER_ACTIONS[kind];
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
        return isEnabled(ed, toSlot) ? <IconButton key={a} icon="24.slot" label={toSlot.label} shortcut={shortcutOf(toSlot)} tone="secondary" onClick={() => runEditorCommand(ed, toSlot.id)} /> : null;
      case "ready":
        return <ReadyForDevToggle key={a} />;
      case "create":
        return <IconButton key={a} icon="24.component.small" label={create.label} shortcut={shortcutOf(create)} tone="secondary" disabled={!isEnabled(ed, create)} onClick={() => runEditorCommand(ed, create.id)} />;
      case "mask":
        return (
          <ToggleIconButton
            key={a}
            icon="24.mask"
            label={mask.label}
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
        return <IconButton key={a} icon="24.pen" label="Edit object" shortcut={keys(["enter"])} tone="secondary" disabled={!editable} onClick={() => ed.vector.start(nodes[0].guid)} />;
      case "matching":
        // Several shapes alone have nothing to match (live multi-two-shapes): the row starts at Use as mask.
        return kind === "multi" && shapesOnly ? null : (
          <IconButton key={a} icon="24.select-matching.small" label={matching.label} shortcut={shortcutOf(matching)} tone="secondary" disabled={!isEnabled(ed, matching)} onClick={() => runEditorCommand(ed, matching.id)} />
        );
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
  const ed = useEditor();
  const targets = statusTargets(ed);
  const status = statusOfTargets(ed, targets);
  return (
    <ToggleIconButton
      icon="24.dev-brackets"
      label="Toggle ready for dev status"
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
  const ed = useEditor();
  const c = command("text.create-link");
  const linked = nodes.length > 0 && nodes.every((n) => !!n.hyperlink?.url || !!n.hyperlink?.guid);
  return <ToggleIconButton icon="24.link" label={c.label} shortcut={shortcutOf(c)} tone="secondary" pressed={linked} disabled={!isEnabled(ed, c) && !linked} onPressedChange={() => runEditorCommand(ed, c.id)} />;
}

/** A text's "Apply variable": its content bound to a string variable (the picker; a bound text detaches from it). */
function TextVariableButton({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const refs = nodes.map((n) => n.guid).filter((id) => !id.startsWith("I"));
  const bound = sharedBinding(nodes, ["TEXT_DATA"]);
  const spec = BIND_TYPE.TEXT_DATA;
  return (
    <>
      <ToggleIconButton
        icon="24.variable.small"
        label="Apply variable"
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
          types={[spec.type]}
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

/** The boolean menu's entries (live popovers/boolean-operations-menu.txt: Union … Exclude, Flatten — no line, no checks). */
export function booleanMenu(ed: EditorController, booleans: boolean): MenuItem[] {
  return [
    ...BOOLEAN_ITEMS.map((b) => {
      const c = command(b.id);
      return { id: b.id, label: c.label.replace(" selection", ""), icon: b.icon, shortcut: shortcutOf(c), disabled: !(booleans || isEnabled(ed, c)) };
    }),
    actionItem(ed, "vector.flatten"),
  ];
}

/**
 * "Boolean operations": the current (or Union) operation as a button, its menu on the chevron (41 wide, Figma's) —
 * the menu right-aligned with the chevron, 4 under it (live 151 × 120 at 1253, 129).
 */
function BooleanGroup({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const booleans = nodes.length > 0 && nodes.every((n) => typeOf(n) === "BOOLEAN_OPERATION");
  const current = booleans && nodes.every((n) => n.booleanOperation === nodes[0].booleanOperation) ? (nodes[0].booleanOperation ?? "UNION") : null;
  const entries = booleanMenu(ed, booleans);
  const first = BOOLEAN_ITEMS.find((b) => b.op === (current ?? "UNION")) ?? BOOLEAN_ITEMS[0];
  const firstCommand = command(first.id);
  const any = entries.some((e) => !e.disabled);
  return (
    <div className={styles.splitButton} role="group" aria-label="Boolean operations">
      <IconButton
        icon={first.icon}
        label={firstCommand.label.replace(" selection", "")}
        shortcut={shortcutOf(firstCommand)}
        tone="secondary"
        className={styles.splitMain}
        disabled={!(booleans || isEnabled(ed, firstCommand))}
        onClick={() => pickBoolean(ed, nodes, first.id, booleans)}
      />
      <MenuButton label="Boolean operations" entries={entries} className={styles.splitChevron} disabled={!any} align="end" gap={PANEL_MENU_GAP} menuClassName={hstyles.actionsMenu} onSelect={(id) => pickBoolean(ed, nodes, id, booleans)}>
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
 * menu.txt): Edit object · Create component · Use as mask · Union, Subtract, Intersect, Exclude, Flatten — each
 * group apart by a line, what the row already shows left out, what can't run hidden (a shape's own menu is not
 * captured: unverified beyond that order).
 */
export function moreActionsMenu(ed: EditorController, nodes: readonly PanelNode[], omit: readonly string[]): MenuEntry[] {
  const editable = nodes.length === 1 && EDITABLE.has(typeOf(nodes[0])) && ed.vector.available;
  const groups: MenuItem[][] = [
    editable ? [{ id: "edit-object", label: "Edit object", shortcut: keys(["enter"]), icon: ACTION_ICON["edit-object"] }] : [],
    [actionItem(ed, "object.create-component"), actionItem(ed, "object.create-multiple-components")],
    [actionItem(ed, "object.use-as-mask")],
    booleanActions(ed),
  ];
  return groups.flatMap((g): MenuEntry[] => {
    const shown = g.filter((e) => !omit.includes(e.id) && !e.disabled);
    return shown.length ? ["-", ...shown] : [];
  });
}

function MoreActions({ nodes, omit }: { nodes: PanelNode[]; omit: string[] }) {
  const ed = useEditor();
  const entries = moreActionsMenu(ed, nodes, omit);
  return (
    <MenuButton
      label="More actions"
      entries={entries.length ? entries : [{ id: "none", label: "No actions", disabled: true }]}
      className={styles.iconMenu}
      align="end"
      gap={PANEL_MENU_GAP}
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
