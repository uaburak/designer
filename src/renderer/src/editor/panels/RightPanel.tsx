/**
 * The right panel (240, resizable): a 48px header (the account's avatar ▾,
 * Present ▸ ▾, Share), the Design / Prototype tabs with the zoom menu at the
 * right (a line at 80), then the tab's sections.
 */
import { Avatar, Button, Icon, IconButton, MenuButton, ResizeHandle, Tabs, type MenuEntry } from "@/ds";
import { useCamera } from "@/engine/hooks";
import { useEditor } from "../controller";
import { runEditorCommand } from "../commands";
import { useUI } from "../hooks";
import { commandItem } from "../menus";
import { useEffect } from "react";
import { DesignPanel } from "./design/DesignPanel";
import { PrototypePanel } from "./prototype/PrototypePanel";
import { designPanelTab } from "./design/tabOrder";
import { present } from "../present";
import styles from "./Panels.module.css";

/** `floating`: Minimize UI with a selection — the panel over the canvas, a card at the right (help "Navigate the left sidebar"). */
export function RightPanel({ floating }: { floating?: boolean } = {}) {
  const ed = useEditor();
  const width = useUI((s) => s.rightWidth);
  const tab = useUI((s) => s.rightTab);
  // The Prototype tab shows the connections on the canvas (prototype mode).
  useEffect(() => {
    if (!ed.engine.destroyed && typeof ed.engine.setPrototypeMode === "function") ed.engine.setPrototypeMode(tab === "prototype");
  }, [ed, tab]);
  return (
    <aside className={floating ? `${styles.right} ${styles.rightFloating}` : styles.right} style={{ width }} aria-label="Properties panel" data-panel="right" data-floating={floating || undefined}>
      <RightHeader />
      <div className={styles.rightTabs}>
        <Tabs
          label="Properties"
          idBase="editor-right"
          value={tab}
          tabs={[
            // Live (left/rail-assets.txt): 53 × 24 at 1208 and 69 × 24 at 1265
            { value: "design", label: "Design", width: 53 },
            { value: "prototype", label: "Prototype", width: 69 },
          ]}
          onChange={(v) => ed.ui.set({ rightTab: v as "design" | "prototype" })}
        />
        <ZoomMenu />
      </div>
      <div className={styles.rightBody} role="tabpanel" id={`editor-right-panel-${tab}`} aria-labelledby={`editor-right-tab-${tab}`} onKeyDownCapture={tab === "design" ? designPanelTab : undefined}>
        {tab === "design" ? <DesignPanel /> : <PrototypePanel />}
      </div>
      {!floating && <ResizeHandle side="left" value={width} onChange={(px) => ed.ui.set({ rightWidth: px })} />}
    </aside>
  );
}

export function RightHeader({ compact }: { compact?: boolean }) {
  const ed = useEditor();
  const account: MenuEntry[] = [{ header: "Theme" }, commandItem(ed, "theme.light"), commandItem(ed, "theme.dark"), commandItem(ed, "theme.system"), "-", commandItem(ed, "help.shortcuts"), commandItem(ed, "file.back-to-files")];
  const presentEntries: MenuEntry[] = [
    commandItem(ed, "view.present"),
    commandItem(ed, "view.present-here"),
    "-",
    commandItem(ed, "view.preview"),
  ];
  return (
    <div className={compact ? undefined : styles.rightHeader} style={compact ? { display: "contents" } : undefined}>
      <MenuButton label="Account" entries={account} onSelect={(id) => runEditorCommand(ed, id)} className={styles.account}>
        <Avatar name="Burak Koç" size={28} />
        <span className={styles.accountMore}><Icon name="16.chevron.down" /></span>
      </MenuButton>
      <span className={styles.grow} />
      <span className={styles.present}>
        <IconButton icon="24.play" label="Present" shortcut="⌥⌘↩" size="large" onClick={() => present(ed)} />
        <MenuButton label="Present options" entries={presentEntries} onSelect={(id) => runEditorCommand(ed, id)} className={`${styles.chip} ${styles.presentChevron}`}>
          <Icon name="16.chevron.down" />
        </MenuButton>
      </span>
      <Button variant="primary" size="large" className={styles.share} onClick={() => runEditorCommand(ed, "file.share-preview")}>
        Share
      </Button>
    </div>
  );
}

/** "100% ⌄": the zoom (re-rendered on every camera change, so kept small) and its menu. */
export function ZoomMenu() {
  const ed = useEditor();
  const camera = useCamera(ed.store);
  const entries: MenuEntry[] = [
    commandItem(ed, "view.zoom-in"),
    commandItem(ed, "view.zoom-out"),
    commandItem(ed, "view.zoom-fit"),
    commandItem(ed, "view.zoom-selection"),
    "-",
    commandItem(ed, "view.zoom-50"),
    commandItem(ed, "view.zoom-100"),
    commandItem(ed, "view.zoom-200"),
    "-",
    commandItem(ed, "view.pixel-grid"),
    commandItem(ed, "view.snap-pixel-grid"),
    commandItem(ed, "view.layout-guides"),
    commandItem(ed, "view.rulers"),
    commandItem(ed, "view.outlines"),
  ];
  return (
    <MenuButton
      label="Zoom"
      entries={entries}
      onSelect={(id) => {
        runEditorCommand(ed, id);
        ed.focusCanvas();
      }}
      className={styles.zoom}
    >
      <span>{Math.round(camera.zoom * 100)}%</span>
      <Icon name="16.chevron.down" />
    </MenuButton>
  );
}
