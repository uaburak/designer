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

/** A frame-like layer: a frame, component, set, instance or section (not a group). */
const isFrameLike = (n: { type?: string; resizeToFit?: boolean }) => ["FRAME", "SYMBOL", "INSTANCE", "SECTION"].includes(String(n.type)) && !n.resizeToFit;

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

/** Dynamic items' ids: "Reset ▸ <group>" carries the group's fields; "Move to page ▸ <page>" the page. */
export const RESET_PREFIX = "reset-changes:";
const MOVE_TO_PAGE = "move-to-page:";

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
  if (id.startsWith(MOVE_TO_PAGE)) {
    // "Move to page ▸": the selection to the end of that page, where it is; this page stays in view.
    const page = id.slice(MOVE_TO_PAGE.length);
    const children = (ed.engine.readNode(page, { childIds: true }) as { childIds?: Guid[] } | null)?.childIds ?? [];
    const count = ed.engine.moveNodes(ed.selection, page, children.length);
    if (count > 0) ed.engine.setSelection([]);
    return count > 0;
  }
  return runEditorCommand(ed, id);
}

/** The component items a selection gets in the canvas menu (Figma's): instance actions, or create / combine / add variant. */
function componentEntries(ed: EditorController): Spec[] {
  const nodes = selectionNodes(ed);
  // An instance (live Figma): Create component, Reset instance, Detach instance, Go to main component.
  if (nodes.some(isInstance))
    return ["object.create-component", (e) => { const r = resetSubmenu(e); return r ? { ...r, label: "Reset instance" } : null; }, "object.detach-instance", "object.go-to-main-component"];
  const out: Spec[] = [];
  const mains = nodes.length > 0 && nodes.every((n) => isComponent(n) || isComponentSet(n));
  if (!mains) out.push("object.create-component", ...(nodes.length > 1 ? ["object.create-multiple-components"] : []));
  // A main component (live Figma): its actions under "Main component ▸".
  else
    out.push({
      label: "Main component",
      items: [
        ...(nodes.length > 1 && nodes.every(isComponent) ? ["object.combine-as-variants"] : []),
        ...(nodes.length === 1 ? ["object.add-variant"] : []),
        "object.restore-component",
      ],
    });
  if (!mains && nodes.some((n) => n.isSoftDeleted)) out.push("object.restore-component");
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
      "edit.set-default-properties",
      "edit.copy-properties",
      "edit.paste-properties",
      "-",
      "edit.pick-color",
      "-",
      "edit.select-all",
      "edit.select-matching",
      "edit.select-none",
      "edit.select-inverse",
      {
        label: "Select all with",
        items: ["edit.select-same-fill", "edit.select-same-stroke", "edit.select-same-effect", "edit.select-same-text", "edit.select-same-font", "edit.select-same-instance"],
      },
    ],
  },
  {
    label: "View",
    items: [
      "view.pixel-grid",
      "view.layout-guides",
      "view.rulers",
      "view.show-slices",
      "view.comments",
      "view.annotations",
      { label: "Outlines", items: ["view.outlines"] },
      "view.pixel-preview",
      "view.mask-outlines",
      "view.frame-outlines",
      "view.memory-usage",
      "view.property-labels",
      "-",
      "view.additional-labels",
      "view.minimize-left-nav",
      "view.minimize-ui",
      "view.toggle-ui",
      "view.multiplayer-cursors",
      "view.switch-to-draw",
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
      "view.zoom-previous-frame",
      "view.zoom-next-frame",
      "view.find-previous-frame",
      "view.find-next-frame",
    ],
  },
  {
    label: "Object",
    items: [
      "object.frame-selection",
      "object.group",
      "object.ungroup",
      "-",
      "object.wrap-in-section",
      "object.convert-to-section",
      "object.convert-to-frame",
      "-",
      "object.restore-default-thumbnail",
      "-",
      "object.use-as-mask",
      "-",
      "object.add-auto-layout",
      "object.more-layout-options",
      "-",
      "object.create-component",
      { label: "Slots", items: ["object.convert-to-slot", "object.wrap-in-new-slot", "object.delete-slot-contents"] },
      resetSubmenu,
      "object.detach-instance",
      { label: "Main component", items: ["object.go-to-main-component", "object.push-changes", "object.restore-component", "-", "object.create-multiple-components", "object.combine-as-variants", "object.add-variant"] },
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
      "vector.flatten",
      "vector.outline-stroke",
      { label: "Boolean groups", items: ["vector.union", "vector.subtract", "vector.intersect", "vector.exclude"] },
      "-",
      "object.toggle-visible",
      "object.toggle-lock",
      "object.hide-other-layers",
      "view.collapse-layers",
      "object.rename",
      "-",
      "object.remove-fill",
      "object.remove-stroke",
      "object.swap-fill-stroke",
      "object.remove-interactions",
    ],
  },
  {
    label: "Text",
    items: ["text.bold", "text.italic", "text.underline", "text.strikethrough", "text.create-link", "-", "text.bulleted-list", "text.numbered-list", "-", "text.align-left", "text.align-center", "text.align-right"],
  },
  {
    label: "Arrange",
    items: [
      "arrange.round-to-pixel",
      "-",
      "arrange.align-left",
      "arrange.align-horizontal-center",
      "arrange.align-right",
      "arrange.align-top",
      "arrange.align-vertical-center",
      "arrange.align-bottom",
      "-",
      "arrange.tidy-up",
      "-",
      "arrange.pack-horizontal",
      "arrange.pack-vertical",
      "-",
      "arrange.distribute-horizontal",
      "arrange.distribute-vertical",
      "-",
      "arrange.distribute-left",
      "arrange.distribute-horizontal-centers",
      "arrange.distribute-right",
      "arrange.distribute-top",
      "arrange.distribute-vertical-centers",
      "arrange.distribute-bottom",
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

/** The page items of "Move to page ▸": every other page. */
function moveToPage(ed: EditorController): MenuEntry | null {
  const pages = ed.store.pages.filter((p) => p.guid !== ed.store.page);
  const items: MenuEntry[] = pages.map((p) => ({ id: `${MOVE_TO_PAGE}${p.guid}`, label: p.name }));
  return { id: "submenu:move-to-page", label: "Move to page", items, disabled: !items.length };
}

/** Plugins ▸ / Widgets ▸ (none yet). */
const emptySubmenu = (label: string) => (): MenuEntry => ({ id: `submenu:${label.toLowerCase()}`, label, items: [], disabled: true });

/**
 * The canvas's menu, item for item as live Figma's (docs/research/figma/live/menus/context-*.txt): over a selection
 * — Copy, Paste here, Paste to replace, Copy/Paste as, Send to Figma Make, Find similar designs, Add motion │ Select
 * layer, Move to page, Bring to front, Send to back │ Convert to section, Group, Frame, Wrap in new section,
 * Ungroup, Flatten, Outline stroke, Set as thumbnail, Use as mask │ auto layout, More layout options, the component
 * items, Plugins, Widgets │ Show/Hide, Lock/Unlock │ Flip horizontal, Flip vertical; over empty canvas — Paste here
 * │ Show/Hide UI, Show/Hide comments │ Cursor chat, Actions…, Plugins, Widgets.
 */
export function canvasMenu(ed: EditorController, layers: { id: Guid; name: string; locked?: boolean }[]): MenuEntry[] {
  if (!ed.selection.length) {
    return [
      ...build(ed, ["edit.paste-here", "-"], "canvas."),
      commandItem(ed, "view.toggle-ui"),
      commandItem(ed, "view.comments", "Show/Hide comments"),
      "-",
      ...build(ed, ["canvas.cursor-chat", "tool.actions", emptySubmenu("Plugins"), emptySubmenu("Widgets")], "canvas."),
    ];
  }
  const nodes = selectionNodes(ed);
  const single = nodes.length === 1 ? nodes[0] : null;
  const multi = nodes.length > 1;
  const page = ed.store.page;
  const topFrame = !!single && isFrameLike(single) && single.parentIndex?.guid === page;
  const allComponents = nodes.length > 0 && nodes.every((n) => isComponent(n) || isComponentSet(n));
  const autoLayout = nodes.some((n) => (n as { stackMode?: string }).stackMode && (n as { stackMode?: string }).stackMode !== "NONE");
  const instance = nodes.some(isInstance);
  const specs: Spec[] = [
    "edit.copy",
    "edit.paste-here",
    "edit.paste-to-replace",
    { label: "Copy/Paste as", items: ["edit.copy-as-text", "edit.copy-as-code", "edit.copy-as-svg", "edit.copy-as-png", "-", "edit.copy-properties", "edit.paste-properties"] },
    "canvas.send-to-make",
    ...(multi ? [] : ["canvas.find-similar"]),
    ...(allComponents ? [] : ["canvas.add-motion"]),
    "-",
    ...(layers.length > 1 ? [() => selectLayerSubmenu(ed, layers)] : []),
    moveToPage,
    (e) => commandItem(e, "object.bring-to-front"),
    (e) => commandItem(e, "object.send-to-back"),
    "-",
    ...(topFrame ? ["object.convert-to-section"] : []),
    "object.group",
    "object.frame-selection",
    ...(multi && isEnabled(ed, command("object.wrap-in-section")) ? ["object.wrap-in-section"] : []),
    ...(isEnabled(ed, command("object.ungroup")) ? [(e: EditorController) => commandItem(e, "object.ungroup", "Ungroup")] : []),
    "vector.flatten",
    "vector.outline-stroke",
    ...(topFrame ? ["object.set-as-thumbnail"] : []),
    "object.use-as-mask",
    "-",
    autoLayout ? "object.remove-auto-layout" : "object.add-auto-layout",
    ...((topFrame || multi || (single && isFrameLike(single))) && !instance ? ["object.more-layout-options"] : []),
    ...componentEntries(ed),
    emptySubmenu("Plugins"),
    emptySubmenu("Widgets"),
    "-",
    (e) => commandItem(e, "object.toggle-visible", "Show/Hide"),
    (e) => commandItem(e, "object.toggle-lock", "Lock/Unlock"),
    "-",
    "object.flip-horizontal",
    "object.flip-vertical",
  ];
  return build(ed, specs, "canvas.");
}

/** "Select layer ▸": every layer under the pointer (locked ones too, with their padlock). */
function selectLayerSubmenu(ed: EditorController, layers: { id: Guid; name: string; locked?: boolean }[]): MenuEntry {
  return {
    id: "submenu:select-layer",
    label: "Select layer",
    items: layers.map((l) => ({ id: `select-layer:${l.id}`, label: l.locked ? `${l.name || l.id} 🔒` : l.name || l.id, checked: ed.selection.includes(l.id) })),
  };
}
