/**
 * The editor's menus as DS MenuEntry lists, built from the command registry
 * when a menu opens (so enablement and checks are current): the main menu
 * (the rail's Figma button) with Figma's File / Edit / View / Object / Text /
 * Arrange submenus, and the canvas context menu.
 */
import { addButton, type ButtonStyle } from "./model/canvasButtons";
import type { IconName, MenuEntry, MenuItem } from "@/ds";
import { intlLocale, t } from "@/i18n";
import { CMD_ENABLED, Status } from "@/engine/abi";
import type { Guid } from "@/engine/codec";
import { ANIMATION_STYLES } from "@shared/motion/types";
import type { EditorController } from "./controller";
import { COMMAND_BY_ID, command, inDesktopApp, isEnabled, runEditorCommand, shortcutOf, viewOnly } from "./commands";
import { modeOf } from "./devmode/devMode";
import { exportAllowed } from "./exporting";
import { changedProperties, instanceChanges, resetChanges, resetPropertyValue, selectedInstance, selectionNodes } from "./components";
import { PROPERTY_ICON, RESET_MENU_KINDS, isComponent, isComponentSet, isInstance, type ResetKind } from "./model/components";
import { branchMenuIds } from "./branching/commands";
import { canvasPluginsMenu, pluginsMenu, runPluginMenuItem } from "./plugins/menus";
import { isBrushSource } from "./draw/drawTools";
import { POST_ROW, postCanvasRows, runPostMenu } from "./social/PostsList";
import { selectedPosts } from "./social/SocialMode";
import { PATHFINDER_MENU_IDS } from "./pathfinder";

/** A frame-like layer: a frame, component, set, instance or section (not a group). */
const isFrameLike = (n: { type?: string; resizeToFit?: boolean }) => ["FRAME", "SYMBOL", "INSTANCE", "SECTION"].includes(String(n.type)) && !n.resizeToFit;

/** A command as a menu item: its label and first shortcut, disabled when it can't run now, checked when it toggles. */
export function commandItem(ed: EditorController, id: string, label?: string): MenuItem {
  const c = COMMAND_BY_ID.get(id);
  if (!c) return { id, label: t(label ?? id), disabled: true };
  return { id, label: t(label ?? c.label), shortcut: shortcutOf(c), disabled: !isEnabled(ed, c), checked: c.checked ? c.checked(ed) : undefined };
}

/** A command under another label, with a glyph before its label, or with keys shown that the registry doesn't bind. */
type ItemSpec = { id: string; label?: string; icon?: IconName; shortcut?: string };
/**
 * A submenu: live Figma's submenus open even when every item in them is disabled (Text, Arrange, Vector with nothing
 * selected). `checks`: a check column (View, Text, Preferences: live labels at 32; elsewhere at 16, the commands'
 * own checked states not drawn). `minWidth`: live's measured width where its rows alone don't make it; `width`: the
 * width live measured, held where our text comes out a fraction wider (Menu `width`); `edgeBottom`: its margin to the
 * window's bottom where live's isn't 8 (Preferences: 5).
 */
type SubSpec = { label: string; items: Spec[]; checks?: boolean; minWidth?: number; width?: number; edgeBottom?: number };
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
    return [{ id: `submenu:${prefix}${i}`, label: t(s.label), items, ...(s.minWidth ? { minWidth: s.minWidth } : {}), ...(s.width ? { width: s.width } : {}), ...(s.edgeBottom !== undefined ? { edgeBottom: s.edgeBottom } : {}) }];
  });
}

/** More layout options ▸ (live context-frame / context-multi / main-object list it; its items are unverified). */
/** Live View menu: 201 wide (main-view.txt); see MAIN_MENU_WIDTH for its .4. */
const VIEW_WIDTH = 201.4;

const ADD_BUTTON = "add-button:";

/**
 * Buttons ▸ picked: the button where the menu opened (its top-left at the pointer; the view's middle from a Layers
 * row), in the innermost section there, else on the page.
 */
function addButtonHere(ed: EditorController, style: ButtonStyle): void {
  const at = ed.ui.get().contextMenu?.canvas ?? null;
  const view = ed.canvas?.getBoundingClientRect();
  const p = at ?? { x: (view?.width ?? 0) / 2, y: (view?.height ?? 0) / 2 };
  const world = ed.engine.screenToWorld(p.x, p.y);
  const section = ed.engine.hitTest(p.x, p.y).find((id) => ed.engine.readNode(id, { fields: ["type"] })?.type === "SECTION") ?? null;
  let x = world.x, y = world.y;
  for (let cur: Guid | undefined = section ?? undefined, guard = 0; cur && guard < 256; guard++) {
    const n = ed.engine.readNode(cur, { fields: ["transform", "parentIndex", "type"] });
    if (!n || n.type === "CANVAS") break;
    x -= n.transform?.m02 ?? 0;
    y -= n.transform?.m12 ?? 0;
    cur = n.parentIndex?.guid;
  }
  addButton(ed, { x, y }, style, section ?? undefined);
}

/** Copy as code ▸ (atlas 03 "Copy/Paste as": `copy-as-code` {CSS, CSS (all layers), iOS, Android}). */
const COPY_AS_CODE: Spec[] = ["edit.copy-as-css", "edit.copy-as-css-recursive", "edit.copy-as-ios", "edit.copy-as-android"];

// Atlas 09 §4: Figma's Object menu code has a submenu (multi-stack-selection-submenu) with Suggest auto layout and
// destroy-all-auto-layout that the live menus don't show (gated); they sit here after a line until a probe names it.
const MORE_LAYOUT: SubSpec = {
  label: "More layout options",
  items: ["object.add-layout-horizontal", "object.add-layout-vertical", "object.add-layout-grid", "-", "object.suggest-auto-layout", "object.remove-all-auto-layout"],
};

/** Dynamic items' ids: "Reset ▸ <kind>", "Reset ▸ <property>" (its id), "Move to page ▸ <page>" the page. */
export const RESET_PREFIX = "reset-changes:";
export const RESET_PROPERTY_PREFIX = "reset-property:";
const MOVE_TO_PAGE = "move-to-page:";

/**
 * "Reset ▸" for the selected instance (atlas 10 §6.2): Reset all changes, then Figma's "Reset specific changes" —
 * its twelve kinds in its order, each only when the instance has it, then one "Reset {property}" per changed property
 * value with the property type's glyph. Null when nothing is an instance.
 */
export function resetSubmenu(ed: EditorController): MenuItem | null {
  const inst = selectedInstance(ed);
  if (!inst) return null;
  const groups = instanceChanges(ed, inst);
  const kinds: MenuEntry[] = groups.filter((g) => RESET_MENU_KINDS.has(g.kind)).map((g) => ({ id: `${RESET_PREFIX}${g.kind}`, label: t("Reset {group}", { group: t(g.label).toLocaleLowerCase(intlLocale()) }) }));
  const props: MenuEntry[] = changedProperties(ed, inst).map((p) => ({ id: `${RESET_PROPERTY_PREFIX}${p.id}`, label: t("Reset {property}", { property: p.name }), icon: PROPERTY_ICON[p.type] }));
  const items: MenuEntry[] = [withoutCheck(commandItem(ed, "object.reset-all-changes"))];
  if (kinds.length || props.length) items.push("-", ...kinds, ...props);
  return { id: "submenu:reset", label: t("Reset"), items, disabled: !groups.length };
}

/** Object › Reset instance (live: listed, disabled, when no instance is selected). */
const resetInstance = (ed: EditorController): MenuEntry => {
  const r = resetSubmenu(ed);
  return r ? { ...r, label: t("Reset instance") } : { id: "submenu:reset", label: t("Reset instance"), disabled: true };
};

/** Runs a menu pick: a registry command, or a dynamic item (Reset ▸ group, Select layer ▸). True when it ran. */
export function runMenuItem(ed: EditorController, id: string): boolean {
  if (runPluginMenuItem(ed, id)) return true;
  if (id.startsWith(RESET_PREFIX)) {
    const inst = selectedInstance(ed);
    if (!inst) return false;
    resetChanges(ed, inst, id.slice(RESET_PREFIX.length) as ResetKind);
    return true;
  }
  if (id.startsWith(RESET_PROPERTY_PREFIX)) {
    const inst = selectedInstance(ed);
    if (!inst) return false;
    resetPropertyValue(ed, inst, id.slice(RESET_PROPERTY_PREFIX.length));
    return true;
  }
  if (id.startsWith(POST_ROW)) {
    runPostMenu(ed, id.slice(POST_ROW.length), selectedPosts(ed), ed.store.page);
    return true;
  }
  if (id.startsWith(ADD_BUTTON)) {
    addButtonHere(ed, id.slice(ADD_BUTTON.length) as ButtonStyle);
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

/**
 * Figma's main component actions (Atlas 03 §4.2 `getMainComponentActionsMenu`): Go to main component, Push changes to
 * main, Restore main component, Add variant, Publish — counted by those that can run: none, no row; one, that row
 * alone; two or more, "Main component ▸" with all five. Publish is the selected main components' (the library's
 * publish dialog).
 */
const MAIN_ACTIONS = ["object.go-to-main-component", "object.push-changes", "object.restore-component", "object.add-variant", "file.publish-library"];

function mainComponentActions(ed: EditorController): Spec[] {
  const nodes = selectionNodes(ed);
  // Main components (live context-component.txt): "Main component ▸" with its five rows, those that can't run here greyed.
  if (nodes.length > 0 && nodes.every((n) => isComponent(n) || isComponentSet(n))) return [(e) => kept({ id: "submenu:main-component", label: t("Main component"), items: build(e, MAIN_ACTIONS, "main-component.") })];
  const can = (id: string) => isEnabled(ed, command(id)) && (id !== "file.publish-library" || (nodes.length > 0 && nodes.every((n) => isComponent(n) || isComponentSet(n))));
  const on = MAIN_ACTIONS.filter(can);
  if (on.length < 2) return on;
  return [{ label: "Main component", items: MAIN_ACTIONS }];
}

/** The component items a selection gets in the canvas menu (Figma's): instance actions, or create / combine / add variant. */
function componentEntries(ed: EditorController): Spec[] {
  const nodes = selectionNodes(ed);
  // An instance (live Figma): Create component, Reset instance, Detach instance, Go to main component.
  if (nodes.some(isInstance))
    return ["object.create-component", (e) => { const r = resetSubmenu(e); return r ? { ...r, label: t("Reset instance") } : null; }, "object.detach-instance", ...mainComponentActions(ed)];
  const out: Spec[] = [];
  const mains = nodes.length > 0 && nodes.every((n) => isComponent(n) || isComponentSet(n));
  // Live (context-multi.txt): a multi-selection gets Create component only (no "Create multiple components").
  if (!mains) out.push("object.create-component");
  else if (nodes.length > 1 && nodes.every(isComponent)) out.push("object.combine-as-variants");
  out.push(...mainComponentActions(ed));
  // Inside a main: a nested frame converts to a slot, other layers are wrapped in a new one (help "Create and use slots").
  if (isEnabled(ed, command("object.convert-to-slot"))) out.push("object.convert-to-slot");
  else if (isEnabled(ed, command("object.wrap-in-new-slot"))) out.push("object.wrap-in-new-slot");
  return out;
}

/** Edit › Select all with ▸ (SELECT_MATCHING's modes). */
const SELECT_ALL_WITH: SubSpec = {
  label: "Select all with",
  items: ["edit.select-same-fill", "edit.select-same-stroke", "edit.select-same-effect", "edit.select-same-text", "edit.select-same-font", "edit.select-same-instance"],
};

/**
 * Figma's menus, in Figma's order: the Figma menu as the live app shows it (docs/research/figma/live/menus:
 * main-menu, main-file, main-edit, main-view, main-view-panels, main-object, main-text, main-arrange, main-vector,
 * main-plugins, main-widgets, main-preferences, main-help) — items not built yet are listed disabled.
 */
export const MAIN_MENU: Spec[] = [
  "file.back-to-files",
  "-",
  // Live: "Actions…" with its glyph (2026-10-18: the magnifier; the label at 40) and ⌘K.
  { id: "tool.actions", icon: "24.search.small" },
  "-",
  {
    label: "File",
    width: 198,
    items: [
      { id: "file.new", label: "New Design" },
      // Live: "New ▸" under New Design (its items not captured: help.figma.com's file kinds, unverified).
      { label: "New", items: [{ id: "file.new", label: "Design file" }] },
      "-",
      // Live 2026-10-18 (menus.txt): "Place image…" (2026-10-08: "Place image/video…")
      "file.place-image",
      "-",
      "file.duplicate",
      "file.convert-to-social",
      "file.save-local-copy",
      "file.save-version",
      "file.version-history",
      "-",
      "file.export",
      "file.export-frames-to-pdf",
      "-",
      // Branching (branching/commands.ts): Create branch… on main; Update from main… / Review and merge changes… on a
      // branch; See all branches once the store has branches.
      ...["file.create-branch", "file.update-from-main", "file.review-and-merge", "file.see-all-branches"].map(
        (id) => (ed: EditorController) => (branchMenuIds(ed).includes(id) ? commandItem(ed, id) : null)
      ),
    ],
  },
  {
    label: "Edit",
    width: 190,
    items: [
      "edit.undo",
      "edit.redo",
      "-",
      { label: "Copy as", items: ["edit.copy-as-png", "edit.copy-as-svg", { label: "Copy as code", items: COPY_AS_CODE }, "edit.copy-as-text"] },
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
      SELECT_ALL_WITH,
    ],
  },
  {
    label: "View",
    checks: true,
    width: VIEW_WIDTH,
    items: [
      "view.pixel-grid",
      "view.layout-guides",
      "view.rulers",
      "view.show-slices",
      "view.comments",
      "view.annotations",
      { label: "Outlines", checks: true, items: ["view.outlines", "-", "view.outline-hidden-layers", "view.outline-object-bounds"] },
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
      "view.switch-to-motion",
      // Social (ours, docs/social.md §6.6): its safe areas while in it (a Social file's mode, §18)
      (ed) => (modeOf(ed) === "social" ? commandItem(ed, "social.toggle-safe-areas") : null),
      // Live: "Switch to Dev Mode ⇧D", no check.
      (ed) => ({ ...withoutCheck(commandItem(ed, "view.dev-mode")), label: t("Switch to Dev Mode") }),
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
    width: 185,
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
      // Round 19b [ours]: Illustrator's Pathfinders under Figma's four (pathfinder.ts).
      { label: "Boolean groups", items: ["vector.union", "vector.subtract", "vector.intersect", "vector.exclude", "-", { label: "Pathfinder", items: [...PATHFINDER_MENU_IDS] }] },
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
    width: 199,
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
    width: 220,
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
    width: 198,
    items: ["vector.join", "vector.smooth-join", "vector.delete-heal", "vector.split", "vector.simplify", "vector.offset"],
  },
  "-",
  // Plugins (docs/plugins.md §6, plugins/menus.ts); widgets aren't built (§11): their items listed, disabled.
  (ed: EditorController) => pluginsMenu(ed, (id, label) => withoutCheck(commandItem(ed, id, label))),
  { label: "Widgets", width: 152, items: ["widgets.manage", "widgets.select-all"] },
  {
    label: "Preferences",
    checks: true,
    width: 235,
    edgeBottom: 5,
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
  // In the desktop app it is the app itself: no row (live's capture is the browser's).
  (ed) => (inDesktopApp() ? null : commandItem(ed, "file.open-in-desktop")),
  // docs/ai.md §7: "AI balance" (credits used, remaining, the reset date); live 2026-10-18 (menus.txt): between Open in
  // desktop app and Help and account.
  "file.ai-balance",
  {
    label: "Help and account",
    width: 178,
    items: ["help.page", "help.shortcuts", "help.forum", "help.videos", "help.release-notes", "help.font-settings", "-", "help.legal", "help.account", "help.log-out"],
  },
];

/**
 * Live main menu: 194 wide (main-menu.txt); its rows alone make 131. The .4 is inferred (unverified): live's View
 * submenu is 201 wide at 210 and its Panels submenu opens at 416 (main-view-panels.txt), 4 past the edge, so the edge
 * is at 411.5 or more: a main menu 194.4 wide at 12 (submenus at 210.4) and a View menu 201.4 wide (`VIEW_WIDTH`).
 */
export const MAIN_MENU_WIDTH = 194.4;

/**
 * Edit ▸ for someone who can't edit (Atlas 03 §3.2, Figma's `!edit !dev_handoff`): Find, Find next / previous, Pick
 * color, Copy properties, Select all / matching / none / inverse, Select all with ▸ (the lines between are ours).
 */
const EDIT_VIEW_ONLY: Spec[] = ["edit.find", "edit.find-next", "edit.find-previous", "-", "edit.copy-properties", "-", "edit.pick-color", "-", "edit.select-all", "edit.select-matching", "edit.select-none", "edit.select-inverse", SELECT_ALL_WITH];

/** Edit ▸ in Dev Mode (§3.2 `!edit dev_handoff`): Copy as ▸, Find ×3, Select all, Select none. */
const EDIT_DEV_MODE: Spec[] = [{ label: "Copy as", items: ["edit.copy-as-text", "edit.copy-as-svg", "edit.copy-as-png"] }, "-", "edit.find", "edit.find-next", "edit.find-previous", "-", "edit.select-all", "edit.select-none"];

/** Submenus Figma shows only to someone who can edit (Text, Arrange, Vector: `edit`), and Object not in Dev Mode. */
const EDITING_ONLY = new Set(["Text", "Arrange", "Vector"]);

/**
 * The Figma menu as this person sees it (§3): an editor's; for a viewer, Edit ▸ is the view-only one and Text, Arrange
 * and Vector are gone; in Dev Mode Edit ▸ is Dev Mode's and Object is gone too.
 */
export function mainMenu(ed: EditorController): MenuEntry[] {
  const dev = modeOf(ed) === "dev";
  if (!dev && !viewOnly(ed)) return build(ed, MAIN_MENU, "main.");
  const specs = MAIN_MENU.flatMap((s): Spec[] => {
    if (typeof s !== "object" || "id" in s) return [s];
    if (s.label === "Edit") return [{ ...s, items: dev ? EDIT_DEV_MODE : EDIT_VIEW_ONLY }];
    return EDITING_ONLY.has(s.label) || (dev && s.label === "Object") ? [] : [s];
  });
  return build(ed, specs, "main.");
}

/** The page items of "Move to page ▸": every other page. */
function moveToPage(ed: EditorController): MenuEntry | null {
  const pages = ed.store.pages.filter((p) => p.guid !== ed.store.page);
  const items: MenuEntry[] = pages.map((p) => ({ id: `${MOVE_TO_PAGE}${p.guid}`, label: p.name }));
  return { id: "submenu:move-to-page", label: t("Move to page"), items, disabled: !items.length };
}

/** Plugins ▸ in the canvas menu (plugins/menus.ts); Widgets ▸ open, its items disabled (widgets aren't built). */
const PLUGINS = (ed: EditorController): MenuEntry => canvasPluginsMenu(ed, (id, label) => withoutCheck(commandItem(ed, id, label)));
/** Buttons ▸ (ours): a canvas button where the menu was opened (model/canvasButtons.ts). */
const BUTTONS = (): MenuEntry => ({
  id: "submenu:buttons",
  label: t("Buttons"),
  items: [
    { id: `${ADD_BUTTON}primary`, label: t("Primary button") },
    { id: `${ADD_BUTTON}secondary`, label: t("Secondary button") },
  ],
});
const WIDGETS = (ed: EditorController): MenuEntry => kept({ id: "submenu:widgets", label: t("Widgets"), items: build(ed, ["widgets.manage", "widgets.select-all"], "widgets.") });

/**
 * Add motion ▸ (atlas 03 §4: Figma's metronome rows) — Position, Scale, Rotation, Opacity, More ▸, then Apply
 * animation style ▸ (the composite styles): each switches to Motion and keys that field (commands.ts addMotion).
 */
const ADD_MOTION = (ed: EditorController): MenuEntry => kept({
  id: "submenu:add-motion",
  label: t("Add motion"),
  items: build(ed, [
    "motion.add.position",
    "motion.add.scale",
    "motion.add.rotation",
    "motion.add.opacity",
    { label: "More", items: ["motion.add.corner-radius", "motion.add.fill", "motion.add.stroke-paint", "motion.add.stroke-weight", "motion.add.drop-shadow"] },
    "-",
    { label: "Apply animation style", items: ANIMATION_STYLES.map((s) => `motion.add-style.${s.key}`) },
  ], "add-motion."),
});

/**
 * Rows Figma's canvas menu shows that Wecra can't run (yet): kept, greyed, rather than dropped (the owner's decision,
 * 2026-10-19 — the menu reads as Figma's): Send to Figma Make, Find similar designs, Outline stroke, Widgets ▸ and a
 * main component's Main component ▸ (with their disabled rows).
 */
const KEEP_VISIBLE = new Set(["canvas.send-to-make", "canvas.find-similar", "vector.outline-stroke"]);
const keptEntries = new WeakSet<object>();
function kept(entry: MenuEntry): MenuEntry {
  if (typeof entry === "object") keptEntries.add(entry);
  return entry;
}
/** Right-click › Create brush ▸ Stretch brush / Scatter brush (help.figma.com 31440438150935). */
const CREATE_BRUSH: SubSpec = { label: "Create brush", items: ["object.create-brush.stretch", "object.create-brush.scatter"] };

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
    return withoutDisabled(ed, [
      ...build(ed, ["edit.paste-here", "-"], "canvas."),
      withoutCheck(commandItem(ed, "view.toggle-ui")),
      withoutCheck(commandItem(ed, "view.comments", "Show/Hide comments")),
      "-",
      ...build(ed, ["canvas.cursor-chat", "tool.actions", PLUGINS, WIDGETS, BUTTONS], "canvas."),
    ]);
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
    { label: "Copy/Paste as", items: ["edit.copy-link", "edit.copy-as-text", { label: "Copy as code", items: COPY_AS_CODE }, "edit.copy-as-svg", "edit.copy-as-png", "-", "edit.copy-properties", "edit.paste-properties"] },
    "canvas.send-to-make",
    ...(multi ? [] : ["canvas.find-similar"]),
    ...(allComponents ? [] : [ADD_MOTION]),
    // Motion (docs/motion.md §6.9, round 8e): Mute audio while the timeline's root has audio (help: right-click › Mute audio).
    ...(ed.ui.get().mode === "motion" && isEnabled(ed, command("motion.mute-audio")) ? ["motion.mute-audio"] : []),
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
    // "AI" tag (editor/ai: renames the selected layers' default names).
    ...(row ? ["object.rename", (e: EditorController): MenuEntry => ({ ...commandItem(e, "canvas.rename-layers-ai"), badge: "AI" })] : []),
    "vector.flatten",
    "vector.outline-stroke",
    // Draw (round 7c, docs/draw.md §5.7): Create brush ▸ for one vector-like layer in Draw mode (help.figma.com's Draw
    // article names the submenu; Design's live menus haven't it; its place after Outline stroke is ours), Apply
    // transforms for a transform group, Flip for text on a path.
    ...(single && isBrushSource(single.type) && ed.ui.get().mode === "draw" ? [CREATE_BRUSH] : []),
    ...(nodes.some((n) => n.type === "TRANSFORM") ? ["object.apply-transforms"] : []),
    ...(nodes.some((n) => n.type === "TEXT_PATH") ? [{ id: "text.flip-path", label: "Flip text orientation" }] : []),
    ...(thumbnail && !row ? ["object.set-as-thumbnail"] : []),
    "object.use-as-mask",
    "-",
    autoLayout ? "object.remove-auto-layout" : "object.add-auto-layout",
    ...((topFrame || multi || (single && isFrameLike(single))) && !instance ? [MORE_LAYOUT] : []),
    ...componentEntries(ed),
    PLUGINS,
    WIDGETS,
    BUTTONS,
    "-",
    { id: "object.toggle-visible", label: "Show/Hide" },
    { id: "object.toggle-lock", label: "Lock/Unlock" },
    "-",
    "object.flip-horizontal",
    "object.flip-vertical",
  ];
  // Social (docs/social.md §6.6, ours): over post frames alone, the posts' own rows first.
  const posts = modeOf(ed) === "social" ? selectedPosts(ed) : [];
  const social: MenuEntry[] = posts.length && posts.length === ed.selection.length ? [...postCanvasRows(ed, posts), "-"] : [];
  return withoutDisabled(ed, [...social, ...build(ed, specs, "canvas.")]);
}

/** Copy as SVG / PNG stay, greyed, when the file's owner blocks exports (Figma's `disabledAndForceVisible`). */
const FORCE_VISIBLE = new Set(["edit.copy-as-svg", "edit.copy-as-png"]);

/**
 * A canvas menu without the rows that can't run (Atlas 03 §4: Figma's canvas menus `removeDisabledItems`), but the
 * ones it forces visible; a submenu left empty goes too, and the lines are tidied (none first, last or twice).
 */
export function withoutDisabled(ed: EditorController, entries: MenuEntry[]): MenuEntry[] {
  const blocked = ed.selection.length > 0 && !exportAllowed(ed);
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e === "-") {
      if (out.length && out[out.length - 1] !== "-") out.push(e);
      continue;
    }
    if (!("id" in e) || keptEntries.has(e)) {
      out.push(e);
      continue;
    }
    if (e.items) {
      const items = withoutDisabled(ed, e.items);
      if (!e.disabled && items.some((i) => i !== "-")) out.push({ ...e, items });
      continue;
    }
    if (!e.disabled || (blocked && FORCE_VISIBLE.has(e.id)) || KEEP_VISIBLE.has(e.id)) out.push(e);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

/**
 * The width live measured for a canvas menu whose rows alone come out wider: an instance's (context-instance.txt: 203 x
 * 749; ours 204.2 with "Go to main component ⌃⌥G" the widest row). Others stay at the context menus' 200 least.
 */
export function canvasMenuWidth(entries: readonly MenuEntry[]): number | undefined {
  return entries.some((e) => typeof e === "object" && "id" in e && e.id === "object.detach-instance") ? 203 : undefined;
}

/**
 * "Select layer ▸": every layer under the pointer, each with its Layers glyph (help.figma.com: type icons), locked ones
 * too with their padlock after the name.
 */
function selectLayerSubmenu(ed: EditorController, layers: { id: Guid; name: string; locked?: boolean; icon?: IconName }[]): MenuEntry {
  return {
    id: "submenu:select-layer",
    label: t("Select layer"),
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
    ...(at > 0 ? [{ id: "page:move-up", label: t("Move up") }] : []),
    ...(at >= 0 && at < pages.length - 1 ? [{ id: "page:move-down", label: t("Move down") }] : []),
  ];
  return [
    { id: "page:copy-link", label: t("Copy link to page"), disabled: true },
    "-",
    { id: "page:rename", label: t("Rename page") },
    { id: "page:duplicate", label: t("Duplicate page"), disabled: !can("DUPLICATE_PAGE") },
    "-",
    ...moves,
    "-",
    { id: "page:delete", label: t("Delete page"), disabled: pages.length < 2 || !can("DELETE_PAGE") },
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
  /** A toggle: its check (Actions keeps itself open 300 ms after running one, the check flipping) */
  checked?: boolean;
}

/**
 * Actions the Figma menu hasn't that Actions finds (Figma's search-only items, Atlas 03 §9: rename-selection,
 * create-multiple-symbols, reset-variable-modes, component-insert, toggle-library, publish-selection, auto-rename-layers),
 * under the menu they would be in.
 */
const SEARCH_ONLY: [id: string, section: string][] = [
  ["object.rename", "Object"],
  ["object.create-multiple-components", "Object"],
  ["object.reset-variable-modes", "Object"],
  ["canvas.rename-layers-ai", "Object"],
  ["view.component-search", "View"],
  ["view.team-library", "View"],
  ["file.publish-library", "File"],
];

/** The toolbar's tools, as the palette lists them (the bottom toolbar's order). */
const TOOL_ACTIONS = ["tool.move", "tool.hand", "tool.scale", "tool.frame", "tool.section", "tool.slice", "tool.rectangle", "tool.line", "tool.arrow", "tool.ellipse", "tool.polygon", "tool.star", "tool.image", "tool.pen", "tool.pencil", "tool.brush", "tool.text", "tool.text-on-path", "tool.comment", "tool.annotation", "tool.measurement"];

/**
 * The Actions palette's commands (⌘K; panels/ActionsPanel.tsx): every command of the Figma menu (live main-*.txt) in
 * its order, under its submenu's name, then the tools and the search-only ones — each once, the palette itself left out.
 */
export function actionItems(ed: EditorController): ActionItem[] {
  const out: ActionItem[] = [];
  const seen = new Set<string>(["tool.actions"]);
  const add = (id: string, section: string, label?: string) => {
    if (seen.has(id) || !COMMAND_BY_ID.has(id)) return;
    seen.add(id);
    const item = commandItem(ed, id, label);
    out.push({ id, label: item.label, section, shortcut: item.shortcut, disabled: !!item.disabled, ...(item.checked !== undefined ? { checked: item.checked } : {}) });
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
  for (const id of branchMenuIds(ed)) add(id, "File");
  add("view.dev-mode", "View", "Switch to Dev Mode");
  for (const id of TOOL_ACTIONS) add(id, "Tools");
  for (const [id, section] of SEARCH_ONLY) add(id, section);
  return out;
}
