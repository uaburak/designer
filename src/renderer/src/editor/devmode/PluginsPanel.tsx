/**
 * Dev Mode's Plugins panel (docs/plugins.md §7; the right sidebar's second tab): the plugins made for Dev Mode
 * (`editorType` "dev"), pinned ones first. Running an inspect plugin opens its UI here, docked under its name (the run's
 * `showUI` window is marked docked by the host, so the floating layer leaves it alone); codegen plugins are chosen in
 * Inspect › Code's language menu instead. More › Pin to top / Unpin.
 */
import { useMemo, useState } from "react";
import { EmptyState, Icon, IconButton, MenuButton } from "@/ds";
import { runnableIn } from "@shared/plugins/manifest";
import { useEditor } from "../controller";
import { usePluginService, usePlugins, type PluginEntry } from "../plugins/service";
import { PluginFrame } from "../plugins/ui/PluginLayer";
import { usePluginUi } from "../plugins/ui/store";
import styles from "./DevMode.module.css";

const PINNED_KEY = "designer.devmode.pinnedPlugins";

function readPinned(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Dev Mode's plugins: `editorType` includes "dev" (a codegen-only plugin is listed too; it runs from Inspect). */
export function devPlugins(entries: readonly PluginEntry[], pinned: readonly string[]): PluginEntry[] {
  const dev = entries.filter((e) => (e.manifest ? runnableIn(e.manifest).includes("dev") : e.ref.editorTypes.includes("dev")));
  const rank = (e: PluginEntry) => {
    const i = pinned.indexOf(e.ref.id);
    return i < 0 ? pinned.length : i;
  };
  return [...dev].sort((a, b) => rank(a) - rank(b) || a.ref.name.localeCompare(b.ref.name));
}

export function DevPluginsPanel() {
  const ed = useEditor();
  const service = usePluginService(ed);
  const snap = usePlugins(service);
  const ui = usePluginUi(service?.ui ?? EMPTY_UI);
  const [pinned, setPinned] = useState<string[]>(readPinned);
  const list = useMemo(() => (snap ? devPlugins([...snap.development, ...snap.organization], pinned) : []), [snap, pinned]);
  const docked = ui.windows.filter((w) => w.docked);
  const pin = (id: string, on: boolean) => {
    const next = on ? [id, ...pinned.filter((x) => x !== id)] : pinned.filter((x) => x !== id);
    setPinned(next);
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(next));
    } catch {
      // this session only
    }
  };
  if (!service) return null;
  return (
    <div className={styles.devPlugins} data-dev-plugins="">
      {docked.map((w) => (
        <section key={w.runId} className={styles.dockedPlugin} data-docked-plugin={w.pluginId}>
          <header className={styles.dockedHeader}>
            <span className={styles.grow}>{w.title}</span>
            <IconButton icon="24.close.small" label="Close" onClick={() => service.ui.handlers.get(w.runId)?.close()} />
          </header>
          <div className={styles.dockedBody} style={{ height: w.height }} hidden={!w.visible}>
            <PluginFrame w={w} ui={service.ui} className={styles.dockedFrame} />
          </div>
        </section>
      ))}
      {list.length === 0 ? (
        <EmptyState icon="24.plugin" title="No plugins for Dev Mode" body="Plugins made for Dev Mode (editorType “dev”) show up here." />
      ) : (
        list.map((e) => {
          const isPinned = pinned.includes(e.ref.id);
          const inspect = !!e.manifest?.capabilities?.includes("inspect");
          const codegen = !!e.manifest?.capabilities?.includes("codegen");
          return (
            <div key={`${e.ref.source.type}:${e.ref.id}`} className={styles.pluginRow} data-dev-plugin={e.ref.id}>
              <button type="button" className={styles.pluginRun} disabled={!!e.disabled || (codegen && !inspect)} title={e.disabled ?? (codegen && !inspect ? "Choose its language in Inspect › Code" : undefined)} onClick={() => void service.run(e.ref, "", { mode: inspect ? "inspect" : "default" })}>
                <Icon name="24.plugin" />
                <span className={styles.grow}>{e.ref.name}</span>
                {isPinned && <span className={styles.hint}>Pinned</span>}
              </button>
              <MenuButton label="More" entries={[{ id: "pin", label: isPinned ? "Unpin" : "Pin to top" }]} onSelect={() => pin(e.ref.id, !isPinned)}>
                <Icon name="24.more" />
              </MenuButton>
            </div>
          );
        })
      )}
    </div>
  );
}

const EMPTY_UI = (() => {
  const snap = { windows: [], running: [] };
  return { subscribe: () => () => {}, get: () => snap } as unknown as Parameters<typeof usePluginUi>[0];
})();
