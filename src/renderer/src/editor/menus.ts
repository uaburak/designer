/**
 * The editor's menus as DS MenuEntry lists, built from the command registry
 * when a menu opens (so enablement and checks are current): the main menu
 * (the rail's Figma button) with Figma's File / Edit / View / Object / Text /
 * Arrange submenus, and the canvas context menu.
 */
import type { IconName, MenuEntry, MenuItem } from "@/ds";
import { CMD_ENABLED, Status } from "@/engine/abi";
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

/** A command under another label, with a glyph before its label, or with keys shown that the registry doesn't bind. */
type ItemSpec = { id: string; label?: string; icon?: IconName; shortcut?: string };
/**
 * A submenu: live Figma's submenus open even when every item in them is disabled (Text, Arrange, Vector with nothing
 * selected). `checks`: a check column (View, Text, Preferences: live labels at 32; elsewhere at 16, the commands'
 * own checked states not drawn). `minWidth`: live's measured width where its rows alone don't make it.
 */
type SubSpec = { label: string; items: Spec[]; checks?: boolean; minWidth?: number };
/** A command, a line, a submenu, a command spelled out, or an item built when the menu opens. */
type Spec = string | "-" | SubSpec | ItemSpec | ((ed: EditorController) => MenuEntry | null);

const withoutCheck = (item: MenuItem): MenuItem => {
  if (item.checked === undefined) return item;
  const { checked: _checked, ...rest } = item;
  return rest;
};

function build(ed: EditorController, specs: Spec[], prefix: string, checks = false): MenuEntry[] {
  return specs.flatMap((s, i): MenuEntry[] => {
    if (s === "-") return ["-"];
    if (typeof s === "string") return [checks ? commandItem(ed, s) : withoutCheck(commandItem(ed, s))];
    if (typeof s === "function") {
      const e = s(ed);
      return e ? [e] : [];
    }
    if ("id" in s) {
      const item = commandItem(ed, s.id, s.label);
      return [{ ...(checks ? item : withoutCheck(item)), ...(s.icon ? { icon: s.icon, inlineIcon: true } : {}), ...(s.shortcut ? { shortcut: s.shortcut } : {}) }];
    }
    const items = build(ed, s.items, `${prefix}${i}.`, s.checks ?? false);
    return [{ id: `submenu:${prefix}${i}`, label: s.label, items, ...(s.minWidth ? { minWidth: s.minWidth } : {}) }];
  });
}

/** More layout options ▸ (live context-frame / context-multi / main-object list it; its items are unverified). */
const MORE_LAYOUT: SubSpec = { label: "More layout options", items: ["object.add-layout-horizontal", "object.add-layout-vertical", "object.add-layout-grid"] };

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
  const items: MenuEntry[] = [withoutCheck(commandItem(ed, "object.reset-all-changes"))];
  if (groups.length) items.push("-", ...groups.map((g) => ({ id: `${RESET_PREFIX}${g.fields.join(",")}`, label: `Reset ${g.label.toLowerCase()}` })));
  return { id: "submenu:reset", label: "Reset", items, disabled: !groups.length };
}

/** Object › Reset instance (live: listed, disabled, when no instance is selected). */
const resetInstance = (ed: EditorController): MenuEntry => {
  const r = resetSubmenu(ed);
  return r ? { ...r, label: "Reset instance" } : { id: "submenu:reset", label: "Reset instance", disabled: true };
};

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
  // Live (context-multi.txt): a multi-selection gets Create component only (no "Create multiple components").
  if (!mains) out.push("object.create-component");
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
 * main-menu, main-file, main-edit, main-view, main-view-panels, main-object, main-text, main-arrange, main-vector,
 * main-plugins, main-widgets, main-preferences, main-help) — items not built yet are listed disabled.
 */
export const MAIN_MENU: Spec[] = [
  "file.back-to-files",
  "-",
  // Live: "Actions…" with its glyph (the label at 40) and ⌘K.
  { id: "tool.actions", icon: "24.actions" },
  "-",
  {
    label: "File",
    items: [
      { id: "file.new", label: "New Design" },
      // Live: "New ▸" under New Design (its items not captured: help.figma.com's file kinds, unverified).
      { label: "New", items: [{ id: "file.new", label: "Design file" }] },
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
    checks: true,
    items: [
      "view.pixel-grid",
      "view.layout-guides",
      "view.rulers",
      "view.show-slices",
      "view.comments",
      "view.annotations",
      { label: "Outlines", checks: true, items: ["view.outlines"] },
      "view.pixel-preview",
      "view.mask-outlines",
      "view.frame-outlines",
      "view.memory-usage",
      "-",
      "view.additional-labels",
      "view.minimize-left-nav",
      "view.minimize-ui",
      "view.toggle-ui",
      "view.multiplayer-cursors",
      "view.switch-to-draw",
      // Live: "Switch to Dev Mode ⇧D", no check.
      (ed) => ({ ...withoutCheck(commandItem(ed, "view.dev-mode")), label: "Switch to Dev Mode" }),
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
      MORE_LAYOUT,
      "-",
      "object.create-component",
      { label: "Slots", items: ["object.convert-to-slot", "object.wrap-in-new-slot"] },
      resetInstance,
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
      "-",
      "object.remove-fill",
      "object.remove-stroke",
      "object.swap-fill-stroke",
      "object.remove-interactions",
      "object.delete-slot-contents",
    ],
  },
  {
    label: "Text",
    checks: true,
    minWidth: 199,
    items: [
      "text.bold",
      "text.italic",
      "text.underline",
      "text.strikethrough",
      "text.create-link",
      "-",
      "text.bulleted-list",
      "text.numbered-list",
      "-",
      { label: "Alignment", items: ["text.align-left", "text.align-center", "text.align-right"] },
      // Live: Text › Adjust ▸ (its items from help.figma.com's shortcuts; not captured).
      {
        label: "Adjust",
        items: [
          "text.font-size-up",
          "text.font-size-down",
          "-",
          "text.font-weight-up",
          "text.font-weight-down",
          "-",
          "text.line-height-up",
          "text.line-height-down",
          "-",
          "text.letter-spacing-up",
          "text.letter-spacing-down",
        ],
      },
      // Live: Case ▸ and Text direction ▸ (their items not captured: Type settings' Case options, unverified).
      { label: "Case", checks: true, items: ["text.case-original", "text.case-upper", "text.case-lower", "text.case-title", "text.case-small-caps", "text.case-forced-small-caps"] },
      { label: "Text direction", checks: true, items: ["text.direction-auto", "text.direction-ltr", "text.direction-rtl"] },
      "-",
      { label: "Spell check", checks: true, items: ["text.spell-check"] },
      "prefs.show-text-suggestions",
    ],
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
    items: ["vector.join", "vector.smooth-join", "vector.delete-heal", "vector.split", "vector.simplify", "vector.offset"],
  },
  "-",
  // Plugins and widgets aren't part of this app: their items listed, disabled (live main-plugins / main-widgets).
  { label: "Plugins", minWidth: 181, items: ["plugins.run-last", "-", { label: "Saved plugins", items: ["plugins.none"] }, "-", "plugins.manage"] },
  { label: "Widgets", minWidth: 152, items: ["widgets.manage", "widgets.select-all"] },
  {
    label: "Preferences",
    checks: true,
    minWidth: 235,
    items: [
      "prefs.snap-to-geometry",
      "prefs.snap-to-objects",
      "view.snap-pixel-grid",
      "-",
      "prefs.keep-tool-selected",
      "prefs.highlight-on-hover",
      "prefs.rename-duplicated-layers",
      "prefs.show-dimensions",
      "prefs.hide-canvas-ui",
      "prefs.smart-quotes",
      "prefs.flip-while-resizing",
      "prefs.keyboard-zooms-into-selection",
      "prefs.invert-zoom",
      "prefs.ctrl-click-menus",
      "prefs.number-keys-opacity",
      "prefs.old-outline-shortcuts",
      "prefs.rotate-with-arrows",
      "prefs.ai-chat-audio",
      "prefs.open-links-in-desktop",
      "prefs.show-text-suggestions",
      "prefs.show-tool-suggestions",
      "prefs.show-agents",
      "-",
      "prefs.scroll-wheel-zoom",
      "prefs.right-drag-pan",
      "-",
      { label: "Theme", checks: true, items: ["theme.light", "theme.dark", "theme.system"] },
      "prefs.color-profile",
      "prefs.keyboard-layout",
      "prefs.accessibility",
      "prefs.permissions",
      "prefs.nudge-amount",
    ],
  },
  { id: "file.libraries", label: "Libraries" },
  "-",
  "file.open-in-desktop",
  {
    label: "Help and account",
    minWidth: 178,
    items: ["help.page", "help.shortcuts", "help.forum", "help.videos", "help.release-notes", "help.font-settings", "-", "help.legal", "help.account", "help.log-out"],
  },
];

/** Live main menu: 194 wide (main-menu.txt); its rows alone make 131. */
export const MAIN_MENU_WIDTH = 194;

export function mainMenu(ed: EditorController): MenuEntry[] {
  return build(ed, MAIN_MENU, "main.");
}

/** The page items of "Move to page ▸": every other page. */
function moveToPage(ed: EditorController): MenuEntry | null {
  const pages = ed.store.pages.filter((p) => p.guid !== ed.store.page);
  const items: MenuEntry[] = pages.map((p) => ({ id: `${MOVE_TO_PAGE}${p.guid}`, label: p.name }));
  return { id: "submenu:move-to-page", label: "Move to page", items, disabled: !items.length };
}

/** Plugins ▸ / Widgets ▸ in the canvas menu: open, their items disabled (plugins aren't part of this app). */
const PLUGINS: SubSpec = { label: "Plugins", items: ["plugins.run-last", "-", { label: "Saved plugins", items: ["plugins.none"] }, "-", "plugins.manage"] };
const WIDGETS: SubSpec = { label: "Widgets", items: ["widgets.manage", "widgets.select-all"] };

/**
 * The canvas's menu, item for item as live Figma's (docs/research/figma/live/menus/context-*.txt): over a selection
 * — Copy, Paste here, Paste to replace, Copy/Paste as, Send to Figma Make, Find similar designs, Add motion │ Select
 * layer, Move to page, Bring to front, Send to back │ Convert to section, Group, Frame, Wrap in new section,
 * Ungroup, Flatten, Outline stroke, Set as thumbnail, Use as mask │ auto layout, More layout options, the component
 * items, Plugins, Widgets │ Show/Hide, Lock/Unlock │ Flip horizontal, Flip vertical; over empty canvas — Paste here
 * │ Show/Hide UI, Show/Hide comments │ Cursor chat, Actions…, Plugins, Widgets.
 */
export function canvasMenu(ed: EditorController, layers: { id: Guid; name: string; locked?: boolean; icon?: IconName }[], options: { row?: boolean } = {}): MenuEntry[] {
  if (!ed.selection.length) {
    return [
      ...build(ed, ["edit.paste-here", "-"], "canvas."),
      withoutCheck(commandItem(ed, "view.toggle-ui")),
      withoutCheck(commandItem(ed, "view.comments", "Show/Hide comments")),
      "-",
      ...build(ed, ["canvas.cursor-chat", "tool.actions", PLUGINS, WIDGETS], "canvas."),
    ];
  }
  const nodes = selectionNodes(ed);
  const single = nodes.length === 1 ? nodes[0] : null;
  const multi = nodes.length > 1;
  const page = ed.store.page;
  const topFrame = !!single && isFrameLike(single) && single.parentIndex?.guid === page;
  const allComponents = nodes.length > 0 && nodes.every((n) => isComponent(n) || isComponentSet(n));
  const instance = nodes.some(isInstance);
  // Live (context-instance.txt): an instance's auto layout can't be removed, so ⇧A reads "Add auto layout" (it wraps).
  const autoLayout = nodes.some((n) => !isInstance(n) && (n as { stackMode?: string }).stackMode && (n as { stackMode?: string }).stackMode !== "NONE");
  // Live: Convert to section on a top-level frame only (context-frame); Set as thumbnail on a frame or a main
  // component (context-frame, context-component), never an instance.
  const plainFrame = topFrame && single?.type === "FRAME";
  const thumbnail = topFrame && !instance && (single?.type === "FRAME" || isComponent(single!));
  const row = options.row === true;
  const specs: Spec[] = [
    "edit.copy",
    // Live (context-layer-row.txt): a Layers row's menu has no Paste here.
    ...(row ? [] : ["edit.paste-here"]),
    "edit.paste-to-replace",
    { label: "Copy/Paste as", items: ["edit.copy-as-text", "edit.copy-as-code", "edit.copy-as-svg", "edit.copy-as-png", "-", "edit.copy-properties", "edit.paste-properties"] },
    "canvas.send-to-make",
    ...(multi ? [] : ["canvas.find-similar"]),
    ...(allComponents ? [] : ["canvas.add-motion"]),
    "-",
    ...(layers.length > 1 && !row ? [() => selectLayerSubmenu(ed, layers)] : []),
    moveToPage,
    "object.bring-to-front",
    "object.send-to-back",
    "-",
    ...(plainFrame && !row ? ["object.convert-to-section"] : []),
    "object.group",
    "object.frame-selection",
    ...(multi && isEnabled(ed, command("object.wrap-in-section")) ? ["object.wrap-in-section"] : []),
    ...(isEnabled(ed, command("object.ungroup")) && !allComponents ? [{ id: "object.ungroup", label: "Ungroup" }] : []),
    // Live (context-layer-row.txt): Rename ⌘R after Frame selection on a Layers row, then "Rename layers" with its
    // "AI" tag (live's AI renaming: listed, not built).
    ...(row ? ["object.rename", (e: EditorController): MenuEntry => ({ ...commandItem(e, "canvas.rename-layers-ai"), badge: "AI" })] : []),
    "vector.flatten",
    "vector.outline-stroke",
    ...(thumbnail && !row ? ["object.set-as-thumbnail"] : []),
    "object.use-as-mask",
    "-",
    autoLayout ? "object.remove-auto-layout" : "object.add-auto-layout",
    ...((topFrame || multi || (single && isFrameLike(single))) && !instance ? [MORE_LAYOUT] : []),
    ...componentEntries(ed),
    PLUGINS,
    WIDGETS,
    "-",
    { id: "object.toggle-visible", label: "Show/Hide" },
    { id: "object.toggle-lock", label: "Lock/Unlock" },
    "-",
    "object.flip-horizontal",
    "object.flip-vertical",
  ];
  return build(ed, specs, "canvas.");
}

/**
 * "Select layer ▸": every layer under the pointer, each with its Layers glyph (help.figma.com: type icons), locked ones
 * too with their padlock after the name.
 */
function selectLayerSubmenu(ed: EditorController, layers: { id: Guid; name: string; locked?: boolean; icon?: IconName }[]): MenuEntry {
  return {
    id: "submenu:select-layer",
    label: "Select layer",
    items: layers.map((l) => ({
      id: `select-layer:${l.id}`,
      label: l.name || l.id,
      checked: ed.selection.includes(l.id),
      ...(l.icon ? { icon: l.icon } : {}),
      ...(l.locked ? { trailingIcon: "16.lock.locked" as IconName } : {}),
    })),
  };
}

/**
 * A page row's menu (live context-page-row.txt; behaviour/pages.md): Copy link to page │ Rename page, Duplicate page │
 * Move up / Move down (each where it applies; Move down unverified — the capture's page was the last) │ Delete page.
 * Copy link waits for deep links (docs/desktop-impl.md), as the file tabs' Copy link does.
 */
export function pageMenu(ed: EditorController, page: Guid): MenuEntry[] {
  const pages = ed.store.pages;
  const at = pages.findIndex((p) => p.guid === page);
  const can = (name: "DELETE_PAGE" | "DUPLICATE_PAGE") => (ed.engine.commandState(name) & CMD_ENABLED) !== 0;
  const moves: MenuEntry[] = [
    ...(at > 0 ? [{ id: "page:move-up", label: "Move up" }] : []),
    ...(at >= 0 && at < pages.length - 1 ? [{ id: "page:move-down", label: "Move down" }] : []),
  ];
  return [
    { id: "page:copy-link", label: "Copy link to page", disabled: true },
    "-",
    { id: "page:rename", label: "Rename page" },
    { id: "page:duplicate", label: "Duplicate page", disabled: !can("DUPLICATE_PAGE") },
    "-",
    ...moves,
    "-",
    { id: "page:delete", label: "Delete page", disabled: pages.length < 2 || !can("DELETE_PAGE") },
  ];
}

/** Runs a page menu pick; true when it ran. */
export function runPageMenuItem(ed: EditorController, page: Guid, id: string): boolean {
  const pages = ed.store.pages;
  const at = pages.findIndex((p) => p.guid === page);
  // moveNodes counts the other pages: index `to` in the list without this page.
  const move = (to: number) => to !== at && to >= 0 && to < pages.length && ed.engine.moveNodes([page], "0:0", to) > 0;
  switch (id) {
    case "page:rename":
      ed.ui.set({ renaming: { kind: "page", id: page } });
      return true;
    case "page:duplicate":
      return ed.engine.command("DUPLICATE_PAGE", { page }) === Status.OK;
    case "page:delete":
      return ed.engine.command("DELETE_PAGE", { page }) === Status.OK;
    case "page:move-up":
      return move(at - 1);
    case "page:move-down":
      return move(at + 1);
  }
  return false;
}

/** A command as the Actions palette lists it: its label, the menu it lives in, its keys. */
export interface ActionItem {
  id: string;
  label: string;
  /** The Figma menu's submenu it is in ("Edit", "View"…), "Tools" for the toolbar's tools */
  section: string;
  shortcut?: string;
  disabled: boolean;
}

/** The toolbar's tools, as the palette lists them (the bottom toolbar's order). */
const TOOL_ACTIONS = ["tool.move", "tool.hand", "tool.scale", "tool.frame", "tool.section", "tool.slice", "tool.rectangle", "tool.line", "tool.arrow", "tool.ellipse", "tool.polygon", "tool.star", "tool.image", "tool.pen", "tool.pencil", "tool.text", "tool.comment", "tool.annotation", "tool.measurement"];

/**
 * The Actions palette's commands (⌘K; panels/ActionsPanel.tsx): every command of the Figma menu (live main-*.txt) in
 * its order, under its submenu's name, then the tools — each once, the palette itself left out.
 */
export function actionItems(ed: EditorController): ActionItem[] {
  const out: ActionItem[] = [];
  const seen = new Set<string>(["tool.actions"]);
  const add = (id: string, section: string, label?: string) => {
    if (seen.has(id) || !COMMAND_BY_ID.has(id)) return;
    seen.add(id);
    const item = commandItem(ed, id, label);
    out.push({ id, label: item.label, section, shortcut: item.shortcut, disabled: !!item.disabled });
  };
  const walk = (specs: Spec[], section: string) => {
    for (const s of specs) {
      if (s === "-" || typeof s === "function") continue;
      if (typeof s === "string") add(s, section);
      else if ("id" in s) add(s.id, section, s.label);
      else walk(s.items, section);
    }
  };
  for (const s of MAIN_MENU) {
    if (s === "-" || typeof s === "function") continue;
    if (typeof s === "string") add(s, "File");
    else if ("id" in s) add(s.id, "File", s.label);
    else walk(s.items, s.label);
  }
  add("view.dev-mode", "View", "Switch to Dev Mode");
  for (const id of TOOL_ACTIONS) add(id, "Tools");
  return out;
}
