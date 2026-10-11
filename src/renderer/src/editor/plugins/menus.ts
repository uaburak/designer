/**
 * The plugin parts of the editor's menus (docs/plugins.md §6): the Figma menu's Plugins ▸ — Run last plugin, Saved
 * plugins ▸, the plugins run here (by their manifest `menu`), Development ▸, Manage plugins… — and the canvas menu's
 * Plugins ▸ (the same run section). A plugin's row id is `plugin:<source>:<id>:<command>`; `runPluginMenuItem` runs it.
 */
import type { MenuEntry, MenuItem } from "@/ds";
import type { PluginMenuItem, PluginRef } from "@shared/plugins/types";
import type { EditorController } from "../controller";
import { pluginsOf, type PluginService } from "./service";

export const PLUGIN_ITEM = "plugin:";

const itemId = (ref: PluginRef, command: string) => `${PLUGIN_ITEM}${ref.source.type}:${encodeURIComponent(ref.id)}:${encodeURIComponent(command)}`;

/** A plugin as a menu row: a plain row runs it; a manifest `menu` makes it a submenu of its commands. */
function pluginEntry(s: PluginService, ref: PluginRef, disabled: string | null = null): MenuItem {
  const manifest = s.manifestOf(ref.id);
  const menu = manifest?.menu;
  if (!menu?.length || disabled) return { id: itemId(ref, ""), label: ref.name, disabled: !!disabled, ...(disabled ? { hint: disabled } : {}) };
  const build = (items: readonly PluginMenuItem[], path: string): MenuEntry[] =>
    items.map((m, i): MenuEntry => {
      if ("separator" in m) return "-";
      if ("menu" in m) return { id: `submenu:plugin:${ref.id}:${path}${i}`, label: m.name, items: build(m.menu, `${path}${i}.`) };
      return { id: itemId(ref, m.command), label: m.name };
    });
  return { id: `submenu:plugin:${ref.id}`, label: ref.name, items: build(menu, "") };
}

/** Saved plugins ▸, then the plugins run here (recents), as the menu's run section. */
function runSection(s: PluginService): MenuEntry[] {
  const snap = s.get();
  const saved: MenuEntry[] = snap.saved.length ? snap.saved.map((r) => pluginEntry(s, r)) : [{ id: "plugins.none", label: "No saved plugins", disabled: true }];
  const recents = snap.recents.map((r) => pluginEntry(s, r));
  return [{ id: "submenu:plugins.saved", label: "Saved plugins", items: saved }, ...(recents.length ? ["-" as const, ...recents] : [])];
}

/** Development ▸ */
function development(s: PluginService, item: (id: string, label?: string) => MenuItem): MenuItem {
  const snap = s.get();
  const plugins = snap.development.map((e) => pluginEntry(s, e.ref, e.disabled));
  return {
    id: "submenu:plugins.development",
    label: "Development",
    items: [
      item("plugins.new"),
      item("plugins.import"),
      ...(plugins.length ? ["-" as const, ...plugins] : []),
      "-",
      item("plugins.hot-reload"),
      item("plugins.developer-vm"),
      item("plugins.open-console"),
    ],
  };
}

/** The Figma menu's Plugins ▸ (its items from the command registry through `item`). */
export function pluginsMenu(ed: EditorController, item: (id: string, label?: string) => MenuItem): MenuItem {
  const s = pluginsOf(ed);
  if (!s) return { id: "submenu:plugins", label: "Plugins", width: 181, items: [item("plugins.run-last"), "-", { id: "submenu:plugins.saved", label: "Saved plugins", items: [item("plugins.none")] }, "-", item("plugins.manage")] };
  const org = s.get().organization;
  return {
    id: "submenu:plugins",
    label: "Plugins",
    width: 181,
    items: [
      item("plugins.run-last"),
      "-",
      ...runSection(s),
      "-",
      development(s, item),
      ...(org.length ? [{ id: "submenu:plugins.org", label: `From ${s.get().orgName ?? "your organization"}`, items: org.map((e) => pluginEntry(s, e.ref, e.disabled)) } as MenuItem] : []),
      "-",
      item("plugins.manage"),
    ],
  };
}

/** The canvas menu's Plugins ▸: the run section and Manage plugins…. */
export function canvasPluginsMenu(ed: EditorController, item: (id: string, label?: string) => MenuItem): MenuItem {
  const s = pluginsOf(ed);
  if (!s) return { id: "submenu:canvas.plugins", label: "Plugins", items: [item("plugins.run-last"), "-", { id: "submenu:plugins.saved", label: "Saved plugins", items: [item("plugins.none")] }, "-", item("plugins.manage")] };
  const dev = s.get().development.map((e) => pluginEntry(s, e.ref, e.disabled));
  return {
    id: "submenu:canvas.plugins",
    label: "Plugins",
    items: [item("plugins.run-last"), "-", ...runSection(s), ...(dev.length ? ["-" as const, { id: "submenu:canvas.plugins.development", label: "Development", items: dev } as MenuItem] : []), "-", item("plugins.manage")],
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
