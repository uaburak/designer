/**
 * The canvas for screen readers (atlas 21 §6: Accessibility settings › Screen reader, Figma's accessible DOM mirror of
 * the canvas): while the preference is on, a visually hidden tree of the page's layers — the top-level ones and their
 * children, up to `MIRROR_MAX` — named and kinded as the Layers panel reads them out, the selected ones
 * `aria-selected`; Enter, Space or a click selects one; a polite live region says what is selected now. Figma's own
 * announcements (`fullscreen.accessibility.chit_*`) aren't in its build's English: ours say the layers' names and kinds.
 */
import { useMemo } from "react";
import type { Guid } from "@/engine/codec";
import { useSelection } from "@/engine/hooks";
import { t, tp, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useLayerTree, useUI } from "../hooks";
import { layerKind } from "../panels/Layers";
import { pref } from "../preferences";
import styles from "./ScreenReaderMirror.module.css";

/** The layers mirrored at most (the top-level ones first, then their children) — a page's whole tree would be thousands */
export const MIRROR_MAX = 500;

interface MirrorItem {
  id: Guid;
  name: string;
  kind: string;
  children: MirrorItem[];
}

export function ScreenReaderMirror() {
  const on = useUI((s) => pref(s, "screenReader"));
  return on ? <Mirror /> : null;
}

function Mirror() {
  useT();
  const ed = useEditor();
  const tree = useLayerTree();
  const selection = useSelection(ed.store);
  const items = useMemo(() => {
    let left = MIRROR_MAX;
    const page = tree.nodes.get(tree.page);
    const item = (id: Guid, deep: boolean): MirrorItem | null => {
      const node = tree.nodes.get(id);
      if (!node || left <= 0) return null;
      left--;
      const name = (ed.engine.readNode(id, { fields: ["name"] }) as { name?: string } | null)?.name ?? "";
      const kids = deep ? [...node.children].reverse() : [];
      return { id, name, kind: t(layerKind(node, node.parent ? tree.nodes.get(node.parent) : null)), children: kids.map((k) => item(k, false)).filter((x): x is MirrorItem => !!x) };
    };
    // Top to bottom, as the Layers panel lists them.
    return [...(page?.children ?? [])].reverse().map((id) => item(id, true)).filter((x): x is MirrorItem => !!x);
  }, [ed, tree]);

  const selected = selection.refs;
  // What the live region says as the selection changes.
  const said = useMemo(() => {
    if (!selected.length) return t("Nothing selected");
    if (selected.length > 1) return tp(selected.length, "{n} layer selected", "{n} layers selected");
    const node = tree.nodes.get(selected[0]);
    const name = (ed.engine.readNode(selected[0], { fields: ["name"] }) as { name?: string } | null)?.name ?? "";
    return t("{name}, {kind}, selected", { name, kind: node ? t(layerKind(node, node.parent ? tree.nodes.get(node.parent) : null)) : "" });
  }, [ed, tree, selected]);

  const choose = (id: Guid) => ed.engine.setSelection([id]);
  const row = (it: MirrorItem, level: number) => (
    <li
      key={it.id}
      role="treeitem"
      aria-level={level}
      aria-selected={selected.includes(it.id)}
      aria-label={`${it.name}, ${it.kind}`}
      tabIndex={-1}
      data-layer={it.id}
      onClick={() => choose(it.id)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        choose(it.id);
      }}
    >
      {it.name}
      {it.children.length > 0 && <ul role="group">{it.children.map((c) => row(c, level + 1))}</ul>}
    </li>
  );
  return (
    <div className={styles.mirror} data-screen-reader-mirror="">
      <ul role="tree" aria-label={t("Canvas")} aria-multiselectable="true">
        {items.map((it) => row(it, 1))}
      </ul>
      <div role="status" aria-live="polite">
        {said}
      </div>
    </div>
  );
}
