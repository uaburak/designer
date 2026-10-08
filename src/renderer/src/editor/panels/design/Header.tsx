/**
 * The selection's header row (Figma UI3, live panel docs/research/figma/live/design): 48 high, the type at 16 in
 * 13px/550 — "Frame ▾" / "Group ▾" / "Section ▾" open the frame presets (and convert between the three) —, "N
 * selected" for several layers, then the actions Figma shows for that kind, right-aligned 4 apart:
 *
 *   frame       Toggle ready for dev status · Create component · More actions
 *   group       Toggle ready for dev status · Use as mask · Boolean operations · Create component
 *   section     Toggle ready for dev status
 *   rectangle, ellipse, image          Create component · Use as mask · Boolean operations · Edit object
 *   line, polygon, star, vector        Create component · Use as mask · Boolean operations · More actions
 *   boolean     Use as mask · Boolean operations · Create component
 *   text        Create link · Apply variable · Create component · More actions
 *   several     (Select matching layers) · Use as mask · Boolean operations · More actions
 *
 * "More actions" holds what the row leaves out (Edit object, Use as mask, Flatten, Outline stroke…).
 */
import { useState } from "react";
import { Icon, IconButton, MenuButton, ToggleIconButton, keys, type IconName, type MenuEntry } from "@/ds";
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
import { fields, isGroupNode, typeLabel, typeOf, type PanelNode } from "./shared";
import styles from "./Design.module.css";

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
 * The "Frame ▾" menu, one flat list as Figma draws it: "Frame Layout Options" — Section, Frame, Group (what the layer
 * is, checked) —, then each preset category under its header, the size after the name.
 */
export function frameMenu(kind: "Frame" | "Group" | "Section"): MenuEntry[] {
  return [
    { header: "Frame Layout Options" },
    // A section is its own node type: converting to and from it isn't done in place here.
    { id: "kind:Section", label: "Section", checked: kind === "Section", disabled: kind !== "Section" },
    { id: "kind:Frame", label: "Frame", checked: kind === "Frame", disabled: kind === "Section" },
    { id: "kind:Group", label: "Group", checked: kind === "Group", disabled: kind === "Section" },
    ...FRAME_PRESETS.flatMap((g): MenuEntry[] => [{ header: g.header }, ...g.items.map(([name, w, h]) => ({ id: `${w}x${h}:${name}`, label: name, hint: `${w}×${h}` }))]),
  ];
}

/** Figma's boolean group menu: the four operations, then Flatten. */
const BOOLEAN_ITEMS: { id: string; op: "UNION" | "SUBTRACT" | "INTERSECT" | "XOR"; icon: IconName }[] = [
  { id: "vector.union", op: "UNION", icon: "16.boolean.union" },
  { id: "vector.subtract", op: "SUBTRACT", icon: "16.boolean.subtract" },
  { id: "vector.intersect", op: "INTERSECT", icon: "16.boolean.intersect" },
  { id: "vector.exclude", op: "XOR", icon: "16.boolean.exclude" },
];

/** Layers vector edit mode opens (the engine turns shapes into a vector at their first edit). */
const EDITABLE = new Set(["VECTOR", "LINE", "STAR", "REGULAR_POLYGON", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "BOOLEAN_OPERATION"]);
const SHAPES = new Set(["VECTOR", "LINE", "STAR", "REGULAR_POLYGON", "ELLIPSE", "RECTANGLE", "ROUNDED_RECTANGLE", "BOOLEAN_OPERATION"]);

type Kind = "frame" | "group" | "section" | "rect" | "shape" | "boolean" | "text" | "multi";

/** Which header Figma shows for a selection. */
export function headerKind(nodes: readonly PanelNode[]): Kind {
  if (nodes.length > 1) return "multi";
  const n = nodes[0];
  if (isGroupNode(n)) return "group";
  const t = typeOf(n);
  if (t === "SECTION") return "section";
  if (t === "FRAME") return "frame";
  if (t === "TEXT") return "text";
  if (t === "BOOLEAN_OPERATION") return "boolean";
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
  const kind = headerKind(nodes);
  const title = headerTitle(nodes);
  const presets = kind === "frame" || kind === "group" || kind === "section";
  return (
    <div className={styles.typeHeader} data-type-header={kind}>
      {presets ? (
        <MenuButton
          label={`${title}, Frame Dimension Presets`}
          entries={frameMenu(title as "Frame" | "Group" | "Section")}
          className={styles.typeButton}
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
  const refs = nodes.map((n) => n.guid);
  if (id.startsWith("kind:")) {
    const to = id.slice(5);
    const now = nodes[0] ? (isGroupNode(nodes[0]) ? "Group" : typeOf(nodes[0]) === "SECTION" ? "Section" : "Frame") : null;
    if (to === now) return;
    // A group is a FRAME that fits its children (resizeToFit, as Figma's files keep it): Group → Frame keeps its
    // bounds and doesn't clip; Frame → Group drops what a group can't have (fills, strokes, auto layout, clipping).
    if (to === "Frame" && now === "Group") ed.setProps(refs, fields({ resizeToFit: false, frameMaskDisabled: true } as never), "Convert to frame");
    else if (to === "Group" && now === "Frame")
      ed.setProps(refs, fields({ resizeToFit: true, fillPaints: [], strokePaints: [], effects: [], stackMode: "NONE", frameMaskDisabled: true } as never), "Convert to group");
    return;
  }
  const [w, h] = id.split(":")[0].split("x").map(Number);
  ed.setProps(refs, { size: { x: w, y: h } }, "Resize frame");
}

function HeaderActions({ nodes, kind }: { nodes: PanelNode[]; kind: Kind }) {
  const ed = useEditor();
  const create = command("object.create-component");
  const mask = command("object.use-as-mask");
  const createButton = (
    <IconButton
      icon="24.component.small"
      label={create.label}
      shortcut={shortcutOf(create)}
      tone="secondary"
      disabled={!isEnabled(ed, create)}
      onClick={() => runEditorCommand(ed, create.id)}
    />
  );
  const maskButton = (
    <ToggleIconButton
      icon="24.mask"
      label={mask.label}
      shortcut={shortcutOf(mask)}
      tone="secondary"
      disabled={!isEnabled(ed, mask)}
      pressed={nodes.length > 0 && nodes.every((n) => (n as { mask?: boolean }).mask === true)}
      onPressedChange={() => runEditorCommand(ed, mask.id)}
    />
  );
  const editable = nodes.length === 1 && EDITABLE.has(typeOf(nodes[0])) && ed.vector.available;
  const editButton = <IconButton icon="24.pen" label="Edit object" shortcut={keys(["enter"])} tone="secondary" disabled={!editable} onClick={() => ed.vector.start(nodes[0].guid)} />;
  const toSlot = command("object.convert-to-slot");
  const slot = isEnabled(ed, toSlot) ? <IconButton icon="24.slot" label={toSlot.label} shortcut={shortcutOf(toSlot)} tone="secondary" onClick={() => runEditorCommand(ed, toSlot.id)} /> : null;
  const more = (omit: string[]) => <MoreActions nodes={nodes} omit={omit} />;
  switch (kind) {
    case "frame":
      return (
        <>
          {slot}
          <ReadyForDevToggle />
          {createButton}
          {more(["object.create-component"])}
        </>
      );
    case "group":
      return (
        <>
          <ReadyForDevToggle />
          {maskButton}
          <BooleanGroup nodes={nodes} />
          {createButton}
        </>
      );
    case "section":
      return <ReadyForDevToggle />;
    case "rect":
      return (
        <>
          {createButton}
          {maskButton}
          <BooleanGroup nodes={nodes} />
          {editButton}
        </>
      );
    case "shape":
      return (
        <>
          {createButton}
          {maskButton}
          <BooleanGroup nodes={nodes} />
          {more(["object.create-component", "object.use-as-mask"])}
        </>
      );
    case "boolean":
      return (
        <>
          {maskButton}
          <BooleanGroup nodes={nodes} />
          {createButton}
        </>
      );
    case "text":
      return (
        <>
          <CreateLinkToggle nodes={nodes} />
          <TextVariableButton nodes={nodes} />
          {createButton}
          {more(["object.create-component"])}
        </>
      );
    case "multi": {
      const matching = command("edit.select-matching");
      const shapesOnly = nodes.every((n) => SHAPES.has(typeOf(n)));
      return (
        <>
          {!shapesOnly && <IconButton icon="24.select-matching.small" label={matching.label} shortcut={shortcutOf(matching)} tone="secondary" disabled={!isEnabled(ed, matching)} onClick={() => runEditorCommand(ed, matching.id)} />}
          {maskButton}
          <BooleanGroup nodes={nodes} />
          {more(["object.use-as-mask"])}
        </>
      );
    }
  }
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

/** "Boolean operations": the current (or Union) operation as a button, its menu on the chevron (41 wide, Figma's). */
function BooleanGroup({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const booleans = nodes.length > 0 && nodes.every((n) => typeOf(n) === "BOOLEAN_OPERATION");
  const current = booleans && nodes.every((n) => n.booleanOperation === nodes[0].booleanOperation) ? (nodes[0].booleanOperation ?? "UNION") : null;
  const entries: MenuEntry[] = [
    ...BOOLEAN_ITEMS.map((b) => {
      const c = command(b.id);
      // Figma's live menu: Union, Subtract, Intersect, Exclude, Flatten — no line, no "selection".
      // (No check column: live popovers/boolean-operations-menu.txt has the glyphs at 16, the labels at 44.)
      return { id: b.id, label: c.label.replace(" selection", ""), icon: b.icon, shortcut: shortcutOf(c), disabled: !(booleans || isEnabled(ed, c)) };
    }),
    commandItem(ed, "vector.flatten"),
  ];
  const first = BOOLEAN_ITEMS.find((b) => b.op === (current ?? "UNION")) ?? BOOLEAN_ITEMS[0];
  const firstCommand = command(first.id);
  const any = entries.some((e) => typeof e === "object" && "id" in e && !e.disabled);
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
      <MenuButton label="Boolean operations" entries={entries} className={styles.splitChevron} disabled={!any} onSelect={(id) => pickBoolean(ed, nodes, id, booleans)}>
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
      fields({ booleanOperation: op }),
      command(id).label.replace(" selection", "")
    );
    return;
  }
  runMenuItem(ed, id);
}

/**
 * "More actions": what the header row leaves out, in the order of Figma's live menu (popovers/instance-more-actions-
 * menu.txt): Create component · Use as mask · Union, Subtract, Intersect, Exclude, Flatten — each group apart by a
 * line, what the row already shows left out, what can't run hidden. Edit object first for a shape the row has no
 * button for (unverified: no capture of a shape's menu).
 */
function MoreActions({ nodes, omit }: { nodes: PanelNode[]; omit: string[] }) {
  const ed = useEditor();
  const editable = nodes.length === 1 && EDITABLE.has(typeOf(nodes[0])) && ed.vector.available;
  const groups: [string, string?][][] = [
    [["object.create-component"], ["object.create-multiple-components"]],
    [["object.use-as-mask"]],
    [["vector.union", "Union"], ["vector.subtract", "Subtract"], ["vector.intersect", "Intersect"], ["vector.exclude", "Exclude"], ["vector.flatten"]],
  ];
  const entries: MenuEntry[] = [
    ...(editable ? [{ id: "edit-object", label: "Edit object", shortcut: keys(["enter"]) }, "-" as const] : []),
    ...groups.flatMap((g): MenuEntry[] => [...g.filter(([id]) => !omit.includes(id)).map(([id, label]) => commandItem(ed, id, label)).filter((e) => !e.disabled), "-"]),
  ];
  const trimmed = entries.filter((e, i, all) => e !== "-" || (i > 0 && i < all.length - 1 && all[i - 1] !== "-"));
  return (
    <MenuButton
      label="More actions"
      entries={trimmed.length ? trimmed : [{ id: "none", label: "No actions", disabled: true }]}
      className={styles.iconMenu}
      onSelect={(id) => {
        if (id === "edit-object") ed.vector.start(nodes[0].guid);
        else runMenuItem(ed, id);
      }}
    >
      <Icon name="24.more" />
    </MenuButton>
  );
}
