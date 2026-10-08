/**
 * Minimize UI (⇧⌘\, help "Navigate the left sidebar"): the navigation bar and both sidebars fold into floating cards
 * over the canvas — the file (Figma menu, name, expand) at the top left, the account, Share and the zoom at the top
 * right. "If you select an object while the panels are minimized, the left sidebar remains minimized while the right
 * sidebar expands so you can update the properties of the selected object. Once all objects are deselected, the
 * right panel minimizes again."
 */
import { useRef, useState } from "react";
import { ContextMenu, IconButton } from "@/ds";
import { useSelection } from "@/engine/hooks";
import { useEditor } from "../controller";
import { command, runEditorCommand, shortcutOf } from "../commands";
import { useUI } from "../hooks";
import { mainMenu, runMenuItem } from "../menus";
import { RightHeader, RightPanel, ZoomMenu } from "./RightPanel";
import styles from "./Panels.module.css";

export function MinimizedPanels() {
  const ed = useEditor();
  const name = useUI((s) => s.fileName);
  const rulers = useUI((s) => s.rulers);
  const selected = useSelection(ed.store).refs.length > 0;
  const below = rulers ? { marginTop: "var(--ds-size-ruler)", marginLeft: 0 } : undefined;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className={`${styles.card} ${styles.cardLeft}`} style={rulers ? { marginTop: "var(--ds-size-ruler)", marginLeft: "var(--ds-size-ruler)" } : undefined} data-minimized="left">
        <div ref={button} style={{ display: "contents" }}>
          <IconButton
            icon="24.figma"
            label="Main menu"
            size="large"
            onClick={(e) => {
              if (menu) return setMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4 });
            }}
          />
        </div>
        <span className={styles.cardName}>{name}</span>
        <IconButton icon="24.sidebar.closed" label="Expand UI" shortcut={shortcutOf(command("view.minimize-ui"))} size="large" onClick={() => runEditorCommand(ed, "view.minimize-ui")} />
      </div>
      {selected ? (
        <RightPanel floating />
      ) : (
        <div className={`${styles.card} ${styles.cardRight}`} style={below} data-minimized="right">
          <RightHeader compact />
          <ZoomMenu />
        </div>
      )}
      {menu && <ContextMenu at={menu} entries={mainMenu(ed)} label="Main menu" ignore={button} onSelect={(id) => runMenuItem(ed, id)} onClose={() => setMenu(null)} />}
    </>
  );
}
