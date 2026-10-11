/**
 * The plugin host's way to main (docs/plugins.md §3.3 / §3.4 "As built — main"): the editor preload's
 * `window.designer.plugins` (src/shared/desktop.ts PluginsDesktopApi) over the `plugins:*` channels. Null in a
 * browser, Home or the viewer (no main): development plugins, `fetch` from plugin code and the `plugin:` scheme are
 * the desktop app's.
 */
import type { PluginsDesktopApi } from "@shared/desktop";

export type PluginDesktop = PluginsDesktopApi;

/** The editor view's plugin channels, or null. */
export function pluginDesktop(): PluginDesktop | null {
  const d = (window as unknown as { designer?: { role?: string; plugins?: PluginsDesktopApi } }).designer;
  return d?.role === "editor" && d.plugins ? d.plugins : null;
}
