import { webContents } from "electron";
import { DEFAULT_SHORTCUT_SETTINGS, sanitizeShortcutSettings, type ShortcutSettings } from "../shared/shortcuts";
import { refreshAppMenu } from "./menu";
import { readSettings, writeSettings } from "./session";
import { viewOf } from "./views";

/**
 * The user's keyboard shortcuts (src/shared/shortcuts.ts): main keeps them in settings.json, the one place every
 * window and tab reads them from. A change from an editor's Keyboard shortcuts panel is checked, kept, put on the menu
 * bar (its accelerators — only when the bindings changed) and sent to every editor view (`shortcuts:changed`).
 */
export const shortcutSettings = (): ShortcutSettings => readSettings().shortcuts ?? DEFAULT_SHORTCUT_SETTINGS;

export function setShortcutSettings(patch: unknown): ShortcutSettings {
  const before = shortcutSettings();
  const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  const next = sanitizeShortcutSettings({
    bindings: "bindings" in p ? p.bindings : before.bindings,
    used: "used" in p ? p.used : before.used,
    layout: "layout" in p ? p.layout : before.layout,
    layoutPicked: "layoutPicked" in p ? p.layoutPicked : before.layoutPicked,
  });
  writeSettings({ ...readSettings(), shortcuts: next });
  if (JSON.stringify(next.bindings) !== JSON.stringify(before.bindings)) refreshAppMenu();
  for (const contents of webContents.getAllWebContents()) if (!contents.isDestroyed() && viewOf(contents)?.role === "editor") contents.send("shortcuts:changed", next);
  return next;
}
