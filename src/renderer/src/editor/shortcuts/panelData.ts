/**
 * The Keyboard shortcuts panel's tabs and rows, as live Figma's panel has them (the owner's screenshots of Figma
 * desktop, 2026-10-10: docs/research/shortcuts-panel/): its tabs in order, three columns per tab, each row's wording,
 * icon and keys. A row of an editor command shows that command's keys in force (its default is Figma's — checked by
 * shortcutsPanel.test.ts — or the user's own); a row the engine or a gesture does (Enter, Tab, Space-drag, ⌘ click,
 * the cursor's modifiers) shows Figma's keys and can't be changed.
 */
import type { IconName } from "@/ds";

/** A command's keys in a row; `labels`: what a key's cap says there (live: Adjust font size "⇧ ⌘ < and >") */
export interface RowPart {
  command: string;
  labels?: Record<string, string>;
}

/**
 * A fixed key cap: "mod" "shift" "alt" "ctrl" (⌘ ⇧ ⌥ ⌃, or Ctrl Shift Alt elsewhere), "enter" "tab" "esc" "backspace"
 * "globe" (their glyph caps), or the cap's text ("Space", "click", "drag", "B").
 */
export type FixedCap = string;

export type ShortcutRow =
  | { kind: "heading"; text: string; /** strong: the Cursor tab's "While pointing…"; hint: "While editing a shape…" */ tone: "strong" | "hint" }
  | { kind: "keys"; id: string; label: string; icon?: IconName; parts: RowPart[] }
  | { kind: "fixed"; id: string; label: string; icon?: IconName; caps: FixedCap[] };

export interface EssentialItem {
  command: string;
  title: string;
  description: string;
}

export interface ShortcutTab {
  id: string;
  label: string;
  columns?: ShortcutRow[][];
}

const keys = (label: string, command: string, icon?: IconName, labels?: Record<string, string>): ShortcutRow => ({ kind: "keys", id: command, label, icon, parts: [{ command, labels }] });
const pair = (label: string, a: string, b: string, labels?: Record<string, string>): ShortcutRow => ({ kind: "keys", id: a, label, parts: [{ command: a, labels }, { command: b, labels }] });
const fixed = (id: string, label: string, caps: FixedCap[], icon?: IconName): ShortcutRow => ({ kind: "fixed", id, label, caps, icon });
const strong = (text: string): ShortcutRow => ({ kind: "heading", text, tone: "strong" });
const hint = (text: string): ShortcutRow => ({ kind: "heading", text, tone: "hint" });

/** Live: Adjust font size "⇧ ⌘ < and >" — the comma and period keys read < and > there. */
const ANGLES = { Comma: "<", Period: ">" };

/** The Essential tab: "Essential keyboard shortcuts", three numbered ones. */
export const ESSENTIALS: EssentialItem[] = [
  { command: "view.toggle-ui", title: "Show/Hide UI", description: "Press it now to quickly hide the panes and focus on your work" },
  { command: "view.component-search", title: "Component search", description: "Search for and insert components without losing your flow." },
  { command: "tool.actions", title: "Actions…", description: "Search through menus, commands, and plugins" },
];

export const SHORTCUT_TABS: ShortcutTab[] = [
  { id: "essential", label: "Essential" },
  {
    id: "tools",
    label: "Tools",
    columns: [
      [keys("Move tool", "tool.move", "24.move"), keys("Frame tool", "tool.frame", "24.frame"), keys("Pen tool", "tool.pen", "24.pen"), keys("Pencil tool", "tool.pencil", "24.pencil")],
      [keys("Text tool", "tool.text", "24.text"), keys("Rectangle tool", "tool.rectangle", "24.rectangle"), keys("Ellipse tool", "tool.ellipse", "24.ellipse"), keys("Line tool", "tool.line", "24.line"), keys("Arrow tool", "tool.arrow", "24.arrow")],
      [keys("View comments", "tool.comment", "24.comment"), keys("Annotation tool", "tool.annotation", "24.annotation"), keys("Pick color", "edit.pick-color", "24.eyedropper.small"), keys("Slice tool", "tool.slice", "24.slice")],
    ],
  },
  {
    id: "view",
    label: "View",
    columns: [
      [keys("Show/Hide UI", "view.toggle-ui"), keys("Multiplayer cursors", "view.multiplayer-cursors")],
      [keys("Rulers", "view.rulers"), keys("Show outlines", "view.outlines"), keys("Pixel preview", "view.pixel-preview"), keys("Layout guides", "view.layout-guides"), keys("Pixel grid", "view.pixel-grid")],
      [keys("Open layers panel", "view.layers"), keys("Show assets", "view.assets"), keys("Team library", "view.team-library"), keys("Open design panel", "view.design-panel"), keys("Open prototype panel", "view.prototype-panel")],
    ],
  },
  {
    id: "zoom",
    label: "Zoom",
    columns: [
      [fixed("pan", "Pan", ["Space", "drag"]), keys("Zoom in", "view.zoom-in"), keys("Zoom out", "view.zoom-out"), keys("Zoom to 100%", "view.zoom-100")],
      [keys("Zoom to fit", "view.zoom-fit"), keys("Zoom to selection", "view.zoom-selection"), keys("Zoom to next frame", "view.zoom-next-frame"), keys("Zoom to previous frame", "view.zoom-previous-frame")],
      [keys("Previous page", "view.previous-page"), keys("Next page", "view.next-page"), keys("Find previous frame", "view.find-previous-frame"), keys("Find next frame", "view.find-next-frame")],
    ],
  },
  {
    id: "text",
    label: "Text",
    columns: [
      [pair("Bold/Italic", "text.bold", "text.italic"), keys("Underline", "text.underline"), keys("Create link", "text.create-link"), keys("Strikethrough", "text.strikethrough"), pair("Turn into a list", "text.numbered-list", "text.bulleted-list")],
      [keys("Text align left", "text.align-left"), keys("Text align center", "text.align-center"), keys("Text align right", "text.align-right"), keys("Text align justified", "text.align-justified")],
      [
        pair("Adjust font size", "text.font-size-down", "text.font-size-up", ANGLES),
        pair("Adjust font weight", "text.font-weight-down", "text.font-weight-up", ANGLES),
        pair("Adjust letter spacing", "text.letter-spacing-down", "text.letter-spacing-up", ANGLES),
        pair("Adjust line height", "text.line-height-down", "text.line-height-up", ANGLES),
      ],
    ],
  },
  {
    id: "shape",
    label: "Shape",
    columns: [
      [keys("Pen", "tool.pen", "24.pen"), keys("Pencil", "tool.pencil", "24.pencil"), hint("While editing a shape…"), fixed("paint", "Paint", ["shift", "B"], "24.paint-bucket"), fixed("bend", "Bend tool", ["mod"], "24.bend")],
      [keys("Remove fill", "object.remove-fill"), keys("Remove stroke", "object.remove-stroke"), keys("Swap fill and stroke", "object.swap-fill-stroke"), keys("Outline stroke", "vector.outline-stroke"), keys("Flatten", "vector.flatten")],
      [hint("After selecting points…"), keys("Join selection", "vector.join"), keys("Smooth join selection", "vector.smooth-join"), keys("Delete and heal selection", "vector.delete-heal")],
    ],
  },
  {
    id: "selection",
    label: "Selection",
    columns: [
      [keys("Select all", "edit.select-all"), keys("Select inverse", "edit.select-inverse"), fixed("select-none", "Select none", ["esc"]), fixed("deep-select", "Deep select", ["mod", "click"])],
      [
        fixed("select-children", "Select children", ["enter"]),
        fixed("select-parent", "Select parent", ["\\"]),
        fixed("select-next-sibling", "Select next sibling", ["tab"]),
        fixed("select-previous-sibling", "Select previous sibling", ["shift", "tab"]),
        keys("Select matching layers", "edit.select-matching"),
      ],
      [keys("Group selection", "object.group"), keys("Ungroup selection", "object.ungroup"), keys("Frame selection", "object.frame-selection"), keys("Show/Hide selection", "object.toggle-visible"), keys("Lock/Unlock selection", "object.toggle-lock")],
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    columns: [
      [strong("While pointing…"), fixed("measure", "Measure to selection", ["alt"]), strong("While moving…"), fixed("duplicate-drag", "Duplicate selection", ["alt"])],
      [strong("While clicking…"), fixed("deep-select", "Deep select", ["mod", "click"]), strong("While dragging to select…"), fixed("deep-select-rect", "Deep select within rectangle", ["mod", "drag"])],
      [strong("While resizing…"), fixed("resize-center", "Resize from center", ["alt"]), fixed("resize-proportional", "Resize proportionally", ["shift"]), fixed("resize-crop", "Crop (images)/Ignore constraints (frames)", ["mod"])],
    ],
  },
  {
    id: "edit",
    label: "Edit",
    columns: [
      [keys("Copy", "edit.copy"), keys("Cut", "edit.cut"), keys("Paste", "edit.paste"), keys("Paste to replace", "edit.paste-to-replace"), keys("Paste over selection", "edit.paste-over-selection")],
      [keys("Duplicate", "edit.duplicate"), keys("Rename selection", "object.rename"), keys("Export", "file.export"), keys("Find", "edit.find")],
      [keys("Copy as PNG", "edit.copy-as-png"), keys("Copy properties", "edit.copy-properties"), keys("Paste properties", "edit.paste-properties")],
    ],
  },
  {
    id: "transform",
    label: "Transform",
    columns: [
      [keys("Flip horizontal", "object.flip-horizontal"), keys("Flip vertical", "object.flip-vertical"), keys("Use as mask", "object.use-as-mask")],
      [fixed("edit-shape", "Edit shape or image", ["enter"]), keys("Place image/video…", "tool.image")],
      [fixed("opacity-0", "Set opacity to 0%", ["0", "0"]), fixed("opacity-10", "Set opacity to 10%", ["1"]), fixed("opacity-50", "Set opacity to 50%", ["5"]), fixed("opacity-100", "Set opacity to 100%", ["0"])],
    ],
  },
  {
    id: "arrange",
    label: "Arrange",
    columns: [
      [keys("Bring forward", "object.bring-forward"), keys("Send backward", "object.send-backward"), keys("Bring to front", "object.bring-to-front"), keys("Send to back", "object.send-to-back")],
      [
        pair("Align left/right", "arrange.align-left", "arrange.align-right"),
        pair("Align top/bottom", "arrange.align-top", "arrange.align-bottom"),
        pair("Align centers", "arrange.align-horizontal-center", "arrange.align-vertical-center"),
        pair("Distribute spacing", "arrange.distribute-horizontal", "arrange.distribute-vertical"),
        keys("Tidy up", "arrange.tidy-up"),
      ],
      [keys("Add auto layout", "object.add-auto-layout"), keys("Remove auto layout", "object.remove-auto-layout"), keys("Suggest auto layout", "object.suggest-auto-layout")],
    ],
  },
  {
    id: "components",
    label: "Components",
    columns: [
      [keys("Show assets", "view.assets"), keys("Team library", "view.team-library"), keys("Create component", "object.create-component"), keys("Detach instance", "object.detach-instance"), keys("Convert to slot", "object.convert-to-slot")],
      [keys("Component search", "view.component-search"), hint("While inserting a component…"), fixed("swap-instance", "Swap component instance", ["alt"])],
      [],
    ],
  },
  { id: "layout", label: "Layout" },
];

/** Every row with keys (not headings), of every tab. */
export const allRows = (): Exclude<ShortcutRow, { kind: "heading" }>[] =>
  SHORTCUT_TABS.flatMap((t) => (t.columns ?? []).flat()).filter((r): r is Exclude<ShortcutRow, { kind: "heading" }> => r.kind !== "heading");

/** The usage ids a row is lit by: its commands, or its own id. */
export const usageIds = (row: Exclude<ShortcutRow, { kind: "heading" }>): string[] => (row.kind === "keys" ? row.parts.map((p) => p.command) : [row.id]);

/** The usage ids of a tab (the Essential tab's are its three commands; Layout has none). */
export function tabUsageIds(tab: ShortcutTab): string[] {
  if (tab.id === "essential") return ESSENTIALS.map((e) => e.command);
  return (tab.columns ?? []).flat().flatMap((r) => (r.kind === "heading" ? [] : usageIds(r)));
}

/** The panel's wording for a command (its row's label), else null. */
export function rowLabelOf(command: string): string | null {
  for (const r of allRows()) if (r.kind === "keys" && r.parts.some((p) => p.command === command)) return r.label;
  const e = ESSENTIALS.find((x) => x.command === command);
  return e ? e.title : null;
}
