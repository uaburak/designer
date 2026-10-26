/**
 * A canvas button's links (ours, model/canvasButtons.ts): one row per link — where it goes ("/home", a website) —
 * with − to remove it; + adds one from a pasted link (⌘L "Copy link" on a layer, in this file or another, or a
 * website's address). The button's look is the frame's own Fill, Stroke, corner radius and its text's.
 */
import { useMemo, useState } from "react";
import { t, useT } from "@/i18n";
import { Icon, IconButton, PanelSection, TextInput, showToast } from "@/ds";
import { useUndoState } from "@/engine/hooks";
import { useEditor } from "../../controller";
import { buttonEntry, buttonOf, newButtonLink, writeButton } from "../../model/canvasButtons";
import type { PanelNode } from "./shared";
import styles from "./Design.module.css";

export function ButtonSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const [adding, setAdding] = useState(false);
  const id = nodes.length === 1 ? nodes[0].guid : null;
  // Every committed edit moves the undo state: links read again after a change (here, or an undo).
  const undo = useUndoState(ed.store);
  const button = useMemo(() => (id && !ed.engine.destroyed ? buttonOf(ed.engine.readNode(id, { fields: ["pluginData"] })) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again on every edit
    [ed, id, undo]);
  if (!id || !button) return null;
  const links = button.links;
  const add = (text: string) => {
    setAdding(false);
    if (!text.trim()) return;
    const link = newButtonLink(ed, text);
    if (!link) {
      showToast({ kind: "error", message: t("Paste a layer’s link (⌘L) or a website’s address") });
      return;
    }
    writeButton(ed, id, { links: [...links, link] }, "Add button link");
  };
  return (
    <PanelSection
      title={t("Button")}
      empty={!links.length && !adding}
      actions={<IconButton icon="24.plus.small" label={t("Add link")} tone="secondary" onClick={() => setAdding(true)} />}
      data-button-section=""
    >
      {links.map((l, i) => {
        const e = buttonEntry(ed, l);
        return (
          <div key={`${i}:${l.link}`} className={styles.buttonLink} title={l.link}>
            <Icon name={e.target?.kind === "url" ? "24.external" : "24.link"} />
            <span className={styles.buttonLinkLabel}>{e.label}</span>
            <IconButton icon="24.minus.small" label={t("Remove")} tone="secondary" onClick={() => writeButton(ed, id, { links: links.filter((_, j) => j !== i) }, "Remove button link")} />
          </div>
        );
      })}
      {adding && (
        <div className={styles.buttonLinkField}>
          <TextInput label={t("Link")} value="" placeholder={t("Paste a layer’s link or a website")} autoFocus onCommit={add} onExit={(r) => (r === "escape" ? setAdding(false) : undefined)} />
        </div>
      )}
    </PanelSection>
  );
}
