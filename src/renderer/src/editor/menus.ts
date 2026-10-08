/**
 * The editor's menus as DS MenuEntry lists, built from the command registry
 * when a menu opens (so enablement and checks are current): the main menu
 * (the rail's Figma button) with Figma's File / Edit / View / Object / Text /
 * Arrange submenus, and the canvas context menu.
 */
import type { MenuEntry, MenuItem } from "@/ds";
import type { Guid } from "@/engine/codec";
import type { EditorController } from "./controller";
import { COMMAND_BY_ID, command, isEnabled, runEditorCommand, shortcutOf } from "./commands";
import { instanceChanges, resetChanges, selectedInstance, selectionNodes } from "./components";
import { isComponent, isComponentSet, isInstance } from "./model/components";
import { statusOfTargets, statusTargets } from "./devStatus";

/** A command as a menu item: its label and first shortcut, disabled when it can't run now, checked when it toggles. */
export function commandItem(ed: EditorController, id: string, label?: string): MenuItem {
  const c = COMMAND_BY_ID.get(id);
  if (!c) return { id, label: label ?? id, disabled: true };
  return { id, label: label ?? c.label, shortcut: shortcutOf(c), disabled: !isEnabled(ed, c), checked: c.checked ? c.checked(ed) : undefined };
}

/** A command, a line, a submenu, a command under another label (`{ id, label }`), or an item built when the menu opens. */
type Spec = string | "-" | { label: string; items: Spec[] } | { id: string; label: string } | ((ed: EditorController) => MenuEntry | null);

function build(ed: EditorController, specs: Spec[], prefix: string): MenuEntry[] {
  return specs.flatMap((s, i): MenuEntry[] => {
    if (s === "-") return ["-"];
    if (typeof s === "string") return [commandItem(ed, s)];
    if (typeof s === "function") {
      const e = s(ed);
      return e ? [e] : [];
    }
    if ("id" in s) return [commandItem(ed, s.id, s.label)];
    const items = build(ed, s.items, `${prefix}${i}.`);
    return [{ id: `submenu:${prefix}${i}`, label: s.label, items, disabled: !items.some((e) => typeof e === "object" && "id" in e && !e.disabled) }];
  });
}

/** Dynamic items' ids: "Reset ▸ <group>" carries the group's fields. */
export const RESET_PREFIX = "reset-changes:";

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
  // Inside a main: a nested frame converts to a slot, other layers are wrapped in a new one (help "Create and use slots").
  if (isEnabled(ed, command("object.convert-to-slot"))) out.push("object.convert-to-slot");
  else if (isEnabled(ed, command("object.wrap-in-new-slot"))) out.push("object.wrap-in-new-slot");
  return out;
}

/**
 * Figma's menus, in Figma's order: the Figma menu as the live app shows it (docs/research/figma/live/menus:
 * main-menu, main-file, main-edit, main-view, main-view-panels, main-preferences, main-help) — items not built yet
 * are listed disabled.
 */
export const MAIN_MENU: Spec[] = [
  "file.back-to-files",
  "-",
  "tool.actions",
  "-",
  {
    label: "File",
    items: [
      { id: "file.new", label: "New Design" },
      "-",
      { id: "file.place-image", label: "Place image/video…" },
      "-",
      "file.duplicate",
      "file.save-local-copy",
      "file.save-version",
      "file.version-history",
      "-",
      "file.export",
      "file.export-frames-to-pdf",
      "-",
      "file.create-branch",
      "-",
      "file.share-preview",
    ],
  },
  {
    label: "Edit",
    items: [
      "edit.undo",
      "edit.redo",
      "-",
      { label: "Copy as", items: ["edit.copy-as-png", "edit.copy-as-svg", "edit.copy-as-code", "edit.copy-as-text"] },
      "edit.paste-over-selection",
      "edit.paste-to-replace",
      "edit.duplicate",
      "edit.delete",
      "-",
      "edit.find",
      "edit.find-next",
      "edit.find-previous",
      "edit.find-replace",
      "-",
      "edit.copy-properties",
      "edit.paste-properties",
      "-",
      "edit.select-all",
      "edit.select-matching",
      "edit.select-none",
      "edit.select-inverse",
    ],
  },
  {
    label: "View",
    items: [
      "view.pixel-grid",
      "view.layout-guides",
      "view.rulers",
      "view.annotations",
      "view.outlines",
      "view.property-labels",
      "-",
      "view.additional-labels",
      "view.minimize-left-nav",
      "view.minimize-ui",
      "view.toggle-ui",
      "view.dev-mode",
      {
        label: "Panels",
        items: [
          { id: "view.layers", label: "Open layers panel" },
          { id: "view.assets", label: "Libraries" },
          "view.design-panel",
          "view.prototype-panel",
          { id: "view.local-variables", label: "Toggle variables" },
        ],
      },
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
      "object.convert-to-slot",
      "object.wrap-in-new-slot",
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
      "view.collapse-layers",
      "object.rename",
    ],
  },
  {
    label: "Text",
    items: ["text.bold", "text.italic", "text.underline", "text.strikethrough", "text.create-link", "-", "text.bulleted-list", "text.numbered-list", "-", "text.align-left", "text.align-center", "text.align-right"],
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
  { label: "Plugins", items: ["plugins.run-last", "plugins.manage"] },
  { label: "Widgets", items: ["widgets.manage"] },
  {
    label: "Preferences",
    items: [
      "view.snap-pixel-grid",
      "prefs.highlight-on-hover",
      "-",
      { label: "Theme", items: ["theme.light", "theme.dark", "theme.system"] },
      "prefs.color-profile",
      "prefs.nudge-amount",
    ],
  },
  { id: "file.libraries", label: "Libraries" },
  "-",
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
  // Dev Mode statuses on designs (frames, sections, components): "Mark as ready for dev", then the status menu's items.
  const targets = statusTargets(ed);
  if (targets.length) {
    const status = statusOfTargets(ed, targets);
    entries.push("-", ...build(ed, status === "BUILD" ? ["object.mark-completed", "object.remove-dev-status"] : status ? ["object.mark-ready-for-dev", "object.remove-dev-status"] : ["object.mark-ready-for-dev"], "canvas."));
  }
  if (layers.length > 1) {
    entries.push("-", { id: "submenu:select-layer", label: "Select layer", items: layers.map((l) => ({ id: `select-layer:${l.id}`, label: l.name || l.id, checked: ed.selection.includes(l.id) })) });
  }
  return entries;
}
