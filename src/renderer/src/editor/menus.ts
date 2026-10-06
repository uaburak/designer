/**
 * The editor's menus as DS MenuEntry lists, built from the command registry
 * when a menu opens (so enablement and checks are current): the main menu
 * (the rail's Figma button) with Figma's File / Edit / View / Object / Text /
 * Arrange submenus, and the canvas context menu.
 */
import type { MenuEntry, MenuItem } from "@/ds";
import type { Guid } from "@/engine/codec";
import type { EditorController } from "./controller";
import { COMMAND_BY_ID, isEnabled, shortcutOf } from "./commands";

/** A command as a menu item: its label and first shortcut, disabled when it can't run now, checked when it toggles. */
export function commandItem(ed: EditorController, id: string, label?: string): MenuItem {
  const c = COMMAND_BY_ID.get(id);
  if (!c) return { id, label: label ?? id, disabled: true };
  return { id, label: label ?? c.label, shortcut: shortcutOf(c), disabled: !isEnabled(ed, c), checked: c.checked ? c.checked(ed) : undefined };
}

type Spec = string | "-" | { label: string; items: Spec[] };

function build(ed: EditorController, specs: Spec[], prefix: string): MenuEntry[] {
  return specs.map((s, i) => {
    if (s === "-") return "-";
    if (typeof s === "string") return commandItem(ed, s);
    const items = build(ed, s.items, `${prefix}${i}.`);
    return { id: `submenu:${prefix}${i}`, label: s.label, items, disabled: !items.some((e) => typeof e === "object" && "id" in e && !e.disabled) };
  });
}

/** Figma's menus, in Figma's order (R7-editor.md, the UI3 main menu). */
export const MAIN_MENU: Spec[] = [
  "file.back-to-files",
  "tool.actions",
  "-",
  {
    label: "File",
    items: ["file.new", "-", "file.place-image", "-", "file.rename", "file.duplicate", "file.move", "-", "file.save-version", "file.version-history", "-", "file.export", "file.export-frames-to-pdf"],
  },
  {
    label: "Edit",
    items: [
      "edit.undo",
      "edit.redo",
      "-",
      "edit.copy",
      "edit.cut",
      "edit.paste",
      "edit.paste-over-selection",
      "edit.paste-to-replace",
      "edit.duplicate",
      "edit.delete",
      "-",
      "edit.copy-properties",
      "edit.paste-properties",
      "-",
      "edit.find",
      "-",
      "edit.select-all",
      "edit.select-matching",
      "edit.select-inverse",
      "edit.select-none",
    ],
  },
  {
    label: "View",
    items: [
      "view.pixel-grid",
      "view.snap-pixel-grid",
      "view.layout-guides",
      "view.rulers",
      "view.outlines",
      "-",
      "view.toggle-ui",
      "view.minimize-ui",
      "view.property-labels",
      "-",
      "view.zoom-in",
      "view.zoom-out",
      "view.zoom-100",
      "view.zoom-fit",
      "view.zoom-selection",
      "-",
      "view.previous-page",
      "view.next-page",
    ],
  },
  {
    label: "Object",
    items: [
      "object.group",
      "object.ungroup",
      "object.frame-selection",
      "-",
      "object.add-auto-layout",
      "object.remove-auto-layout",
      "-",
      "object.create-component",
      "object.use-as-mask",
      "-",
      "object.bring-to-front",
      "object.bring-forward",
      "object.send-backward",
      "object.send-to-back",
      "-",
      "object.flip-horizontal",
      "object.flip-vertical",
      "object.rotate-180",
      "object.rotate-90-left",
      "object.rotate-90-right",
      "-",
      "object.toggle-visible",
      "object.toggle-lock",
      "object.rename",
    ],
  },
  {
    label: "Text",
    items: ["text.bold", "text.italic", "text.underline", "text.strikethrough", "-", "text.align-left", "text.align-center", "text.align-right"],
  },
  {
    label: "Arrange",
    items: [
      "arrange.align-left",
      "arrange.align-horizontal-center",
      "arrange.align-right",
      "-",
      "arrange.align-top",
      "arrange.align-vertical-center",
      "arrange.align-bottom",
      "-",
      "arrange.distribute-horizontal",
      "arrange.distribute-vertical",
      "arrange.tidy-up",
    ],
  },
  {
    label: "Vector",
    items: ["vector.union", "vector.subtract", "vector.intersect", "vector.exclude", "-", "vector.flatten", "vector.outline-stroke"],
  },
  "-",
  { label: "Preferences", items: ["theme.light", "theme.dark", "theme.system"] },
  { label: "Help and account", items: ["help.shortcuts"] },
];

export function mainMenu(ed: EditorController): MenuEntry[] {
  return build(ed, MAIN_MENU, "main.");
}

/** The canvas's menu (Figma's): over a selection, or over empty canvas. */
export function canvasMenu(ed: EditorController, layers: { id: Guid; name: string }[]): MenuEntry[] {
  if (!ed.selection.length) {
    return build(ed, ["edit.paste-here", "-", "view.toggle-ui", "view.rulers", "-", "edit.select-all"], "canvas.");
  }
  const entries = build(
    ed,
    [
      "edit.copy",
      "edit.paste-here",
      "edit.paste-over-selection",
      { label: "Copy/Paste as", items: ["edit.copy-as-png", "edit.copy-as-svg", "edit.copy-as-code", "edit.copy-as-text", "-", "edit.copy-properties", "edit.paste-properties"] },
      "-",
      "object.bring-to-front",
      "object.bring-forward",
      "object.send-backward",
      "object.send-to-back",
      "-",
      "object.group",
      "object.frame-selection",
      "object.ungroup",
      "-",
      "vector.flatten",
      "vector.outline-stroke",
      "object.use-as-mask",
      "-",
      "object.toggle-visible",
      "object.toggle-lock",
      "-",
      "object.flip-horizontal",
      "object.flip-vertical",
      "-",
      "object.add-auto-layout",
      "object.create-component",
      "-",
      "edit.duplicate",
      "edit.delete",
    ],
    "canvas."
  );
  if (layers.length > 1) {
    entries.push("-", { id: "submenu:select-layer", label: "Select layer", items: layers.map((l) => ({ id: `select-layer:${l.id}`, label: l.name || l.id, checked: ed.selection.includes(l.id) })) });
  }
  return entries;
}
