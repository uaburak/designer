/**
 * Relaunch buttons (docs/plugins.md §4 `relaunchButtons`, §8): at the top of the Design panel, a button per plugin
 * command that `setRelaunchData` put on the selected layers — the manifest's button name, the node's message under
 * it — Figma's. With several layers selected, only the commands every one of them has and whose manifest entry says
 * `multipleSelection`; with nothing selected, the current page's and the document's. A click runs the plugin with that
 * command (`figma.command`).
 */
import { useMemo } from "react";
import { Button } from "@/ds";
import type { Guid, NodeChange } from "@/engine/codec";
import { useUndoState } from "@/engine/hooks";
import { useEditor } from "../../controller";
import { usePluginService, usePlugins, type PluginService } from "../../plugins/service";
import styles from "./Design.module.css";

interface Relaunch {
  pluginId: string;
  command: string;
  name: string;
  message: string;
}

/** The buttons for these nodes (the manifests the service knows decide names and multipleSelection). */
export function relaunchesOf(s: PluginService, read: readonly (Pick<NodeChange, "pluginRelaunchData"> | null | undefined)[] | null | undefined): Relaunch[] {
  // While a file loads (after a reload) a read can come back without nodes, or without some of them.
  const nodes = (read ?? []).filter((n): n is Pick<NodeChange, "pluginRelaunchData"> => !!n);
  if (!nodes.length) return [];
  const per = nodes.map((n) => (n.pluginRelaunchData ?? []).filter((e) => !e.isDeleted && e.pluginID && e.command));
  const out: Relaunch[] = [];
  for (const e of per[0]) {
    const manifest = s.entries().find((x) => x.manifest?.id === e.pluginID || x.ref.id === e.pluginID)?.manifest ?? null;
    const button = manifest?.relaunchButtons?.find((b) => b.command === e.command);
    if (!button) continue;
    if (nodes.length > 1 && (!button.multipleSelection || !per.every((list) => list.some((x) => x.pluginID === e.pluginID && x.command === e.command)))) continue;
    out.push({ pluginId: e.pluginID!, command: e.command!, name: button.name, message: nodes.length === 1 ? (e.message ?? "") : "" });
  }
  return out;
}

export function RelaunchButtons({ refs }: { refs: readonly Guid[] }) {
  const ed = useEditor();
  const service = usePluginService(ed);
  const snap = usePlugins(service);
  const key = refs.join(",");
  // Every committed edit moves the undo state: a run's setRelaunchData shows at once.
  const undo = useUndoState(ed.store);
  const nodes = useMemo(() => (refs.length && !ed.engine.destroyed ? (ed.engine.readNodes([...refs], { fields: ["pluginRelaunchData"] }) ?? []) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the selection or the plugin lists change
    [ed, key, snap, undo]);
  const buttons = service ? relaunchesOf(service, nodes) : [];
  if (!service || !buttons.length) return null;
  return (
    <div className={styles.relaunch} data-relaunch-buttons="">
      {buttons.map((b) => (
        <div key={`${b.pluginId}:${b.command}`} className={styles.relaunchRow}>
          <Button
            variant="secondary"
            className={styles.relaunchButton}
            onClick={() => {
              const entry = service.entries().find((x) => x.manifest?.id === b.pluginId || x.ref.id === b.pluginId);
              if (entry) void service.run(entry.ref, b.command);
            }}
          >
            {b.name}
          </Button>
          {b.message && <span className={styles.relaunchMessage}>{b.message}</span>}
        </div>
      ))}
    </div>
  );
}
