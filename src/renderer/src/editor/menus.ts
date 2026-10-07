/**
 * The editor's menus as DS MenuEntry lists, built from the command registry
 * when a menu opens (so enablement and checks are current): the main menu
 * (the rail's Figma button) with Figma's File / Edit / View / Object / Text /
 * Arrange submenus, and the canvas context menu.
 */
import type { MenuEntry, MenuItem } from "@/ds";
import type { Guid } from "@/engine/codec";
import type { EditorController } from "./controller";
import { COMMAND_BY_ID, isEnabled, runEditorCommand, shortcutOf } from "./commands";
import { instanceChanges, resetChanges, selectedInstance, selectionNodes } from "./components";
import { isComponent, isComponentSet, isInstance } from "./model/components";

/** A command as a menu item: its label and first shortcut, disabled when it can't run now, checked when it toggles. */
export function commandItem(ed: EditorController, id: string, label?: string): MenuItem {
  const c = COMMAND_BY_ID.get(id);
  if (!c) return { id, label: label ?? id, disabled: true };
  return { id, label: label ?? c.label, shortcut: shortcutOf(c), disabled: !isEnabled(ed, c), checked: c.checked ? c.checked(ed) : undefined };
}

type Spec = string | "-" | { label: string; items: Spec[] } | ((ed: EditorController) => MenuEntry | null);

function build(ed: EditorController, specs: Spec[], prefix: string): MenuEntry[] {
  return specs.flatMap((s, i): MenuEntry[] => {
    if (s === "-") return ["-"];
    if (typeof s === "string") return [commandItem(ed, s)];
    if (typeof s === "function") {
      const e = s(ed);
      return e ? [e] : [];
    }
    const items = build(ed, s.items, `${prefix}${i}.`);
    return [{ id: `submenu:${prefix}${i}`, label: s.label, items, disabled: !items.some((e) => typeof e === "object" && "id" in e && !e.disabled) }];
  });
}

/** Dynamic items' ids: "Reset ▸ <group>" carries the group's fields. */
const RESET_PREFIX = "reset-changes:";

/**
 * "Reset ▸" for the selected instance (R4 §3): Reset all changes, then one item per changed property group (only
 * those it has). Null when nothing is an instance.
 */
export function resetSubmenu(ed: EditorController): MenuItem | null {
  const inst = selectedInstance(ed);
  if (!inst) return null;
  const groups = instanceChanges(ed, inst);
  const items: MenuEntry[] = [commandItem(ed, "object.reset-all-changes")];
  if (groups.length) items.push("-", ...groups.map((g) => ({ id: `${RESET_PREFIX}${g.fields.join(",")}`, label: `Reset ${g.label.toLowerCase()}` })));
  return { id: "submenu:reset", label: "Reset", items, disabled: !groups.length };
}

/** Runs a menu pick: a registry command, or a dynamic item (Reset ▸ group, Select layer ▸). True when it ran. */
export function runMenuItem(ed: EditorController, id: string): boolean {
  if (id.startsWith(RESET_PREFIX)) {
    const inst = selectedInstance(ed);
    if (!inst) return false;
    resetChanges(ed, inst, id.slice(RESET_PREFIX.length).split(","));
    return true;
  }
  if (id.startsWith("select-layer:")) {
    ed.engine.setSelection([id.slice("select-layer:".length)]);
    return true;
  }
  return runEditorCommand(ed, id);
}

/** The component items a selection gets in the canvas menu (Figma's): instance actions, or create / combine / add variant. */
function componentEntries(ed: EditorController): Spec[] {
  const nodes = selectionNodes(ed);
  if (nodes.some(isInstance)) return ["object.go-to-main-component", "object.push-changes", resetSubmenu, "object.detach-instance"];
  const out: Spec[] = [];
  if (nodes.length > 1 && nodes.every(isComponent)) out.push("object.combine-as-variants");
  else if (nodes.length === 1 && (isComponentSet(nodes[0]) || isComponent(nodes[0]))) out.push("object.add-variant");
  if (!nodes.every((n) => isComponent(n) || isComponentSet(n))) out.push("object.create-component", ...(nodes.length > 1 ? ["object.create-multiple-components"] : []));
  if (nodes.some((n) => n.isSoftDeleted)) out.push("object.restore-component");
  return out;
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
      "view.layers",
      "view.assets",
      "view.local-variables",
      "-",
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
      "object.create-multiple-components",
      "object.combine-as-variants",
      "object.add-variant",
      resetSubmenu,
      "object.detach-instance",
      { label: "Main component", items: ["object.go-to-main-component", "object.push-changes", "object.restore-component"] },
      "-",
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
      ...componentEntries(ed),
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
