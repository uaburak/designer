/**
 * The plugin parts of the editor's menus (docs/plugins.md §6), in Figma's order (docs/research/atlas/17-plugins.md
 * §10.1): the Figma menu's Plugins ▸ — the recent plugins (at most 6, each by its manifest `menu`), Run last plugin,
 * Saved plugins ▸, From ‹org› ▸, Development ▸, Manage plugins… — and the canvas menu's Plugins ▸ (the same).
 * A plugin's row id is `plugin:<source>:<id>:<command>`; `runPluginMenuItem` runs it.
 */
import type { MenuEntry, MenuItem } from "@/ds";
import type { PluginMenuItem, PluginRef } from "@shared/plugins/types";
import { t } from "@/i18n";
import type { EditorController } from "../controller";
import { pluginsOf, type PluginService } from "./service";

export const PLUGIN_ITEM = "plugin:";
/** Figma lists this many recent plugins above Run last plugin */
const RECENTS_SHOWN = 6;

const itemId = (ref: PluginRef, command: string) => `${PLUGIN_ITEM}${ref.source.type}:${encodeURIComponent(ref.id)}:${encodeURIComponent(command)}`;

/** A plugin as a menu row: a plain row runs it; a manifest `menu` makes it a submenu of its commands. */
function pluginEntry(s: PluginService, ref: PluginRef, disabled: string | null = null): MenuItem {
  const manifest = s.manifestOf(ref.id);
  const menu = manifest?.menu;
  if (!menu?.length || disabled) return { id: itemId(ref, ""), label: ref.name, disabled: !!disabled, ...(disabled ? { hint: t(disabled) } : {}) };
  const build = (items: readonly PluginMenuItem[], path: string): MenuEntry[] =>
    items.map((m, i): MenuEntry => {
      if ("separator" in m) return "-";
      if ("menu" in m) return { id: `submenu:plugin:${ref.id}:${path}${i}`, label: m.name, items: build(m.menu, `${path}${i}.`) };
      return { id: itemId(ref, m.command), label: m.name };
    });
  return { id: `submenu:plugin:${ref.id}`, label: ref.name, items: build(menu, "") };
}

/** The recent plugins (newest first, at most 6) with a line under them; none: nothing. */
function recentsSection(s: PluginService): MenuEntry[] {
  const recents = s.get().recents.slice(0, RECENTS_SHOWN).map((r) => pluginEntry(s, r));
  return recents.length ? [...recents, "-"] : [];
}

/** Saved plugins ▸ */
function savedMenu(s: PluginService): MenuItem {
  const saved = s.get().saved;
  return { id: "submenu:plugins.saved", label: t("Saved plugins"), items: saved.length ? saved.map((r) => pluginEntry(s, r)) : [{ id: "plugins.none", label: t("No saved plugins"), disabled: true }] };
}

/** From ‹org› ▸ (the org's private plugins), when it has any */
function orgMenu(s: PluginService): MenuItem[] {
  const snap = s.get();
  if (!snap.organization.length) return [];
  return [{ id: "submenu:plugins.org", label: snap.orgName ? t("From {name}", { name: snap.orgName }) : t("From your organization"), items: snap.organization.map((e) => pluginEntry(s, e.ref, e.disabled)) }];
}

/** Development ▸: the plugins, Manage plugins in development; New / Import; the API docs, console, VM and hot reload */
function development(s: PluginService, item: (id: string, label?: string) => MenuItem): MenuItem {
  const snap = s.get();
  const plugins = snap.development.map((e) => pluginEntry(s, e.ref, e.disabled));
  const valid = snap.development.some((e) => !e.disabled);
  return {
    id: "submenu:plugins.development",
    label: t("Development"),
    items: [
      ...plugins,
      ...(valid ? [item("plugins.manage-development")] : []),
      ...(plugins.length ? ["-" as const] : []),
      item("plugins.new"),
      item("plugins.import"),
      "-",
      item("plugins.api-docs"),
      item("plugins.open-console"),
      item("plugins.developer-vm"),
      item("plugins.hot-reload"),
    ],
  };
}

/** The Figma menu's Plugins ▸ (its items from the command registry through `item`). */
export function pluginsMenu(ed: EditorController, item: (id: string, label?: string) => MenuItem): MenuItem {
  const s = pluginsOf(ed);
  if (!s) return { id: "submenu:plugins", label: t("Plugins"), width: 181, items: [item("plugins.run-last"), "-", { id: "submenu:plugins.saved", label: t("Saved plugins"), items: [item("plugins.none")] }, "-", item("plugins.manage")] };
  return {
    id: "submenu:plugins",
    label: t("Plugins"),
    width: 181,
    items: [...recentsSection(s), item("plugins.run-last"), "-", savedMenu(s), ...orgMenu(s), development(s, item), "-", item("plugins.manage")],
  };
}

/** The canvas menu's Plugins ▸: the same as the Figma menu's (Figma builds both from one list, module 381085). */
export function canvasPluginsMenu(ed: EditorController, item: (id: string, label?: string) => MenuItem): MenuItem {
  const s = pluginsOf(ed);
  if (!s) return { id: "submenu:canvas.plugins", label: t("Plugins"), items: [item("plugins.run-last"), "-", { id: "submenu:plugins.saved", label: t("Saved plugins"), items: [item("plugins.none")] }, "-", item("plugins.manage")] };
  return {
    id: "submenu:canvas.plugins",
    label: t("Plugins"),
    items: [...recentsSection(s), item("plugins.run-last"), "-", savedMenu(s), ...orgMenu(s), development(s, item), "-", item("plugins.manage")],
  };
}

/** Runs a plugin row of a menu. True when the id was a plugin's. */
export function runPluginMenuItem(ed: EditorController, id: string): boolean {
  if (!id.startsWith(PLUGIN_ITEM)) return false;
  const [type, rawId, rawCommand] = id.slice(PLUGIN_ITEM.length).split(":");
  const s = pluginsOf(ed);
  if (!s) return false;
  const pluginId = decodeURIComponent(rawId ?? "");
  const command = decodeURIComponent(rawCommand ?? "");
  const snap = s.get();
  const ref = [...snap.development.map((e) => e.ref), ...snap.organization.map((e) => e.ref), ...snap.saved, ...snap.recents].find((r) => r.id === pluginId && r.source.type === type);
  if (!ref) return false;
  void s.run(ref, command);
  return true;
}
