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
import { useEffect, useState } from "react";
import { useTool } from "@/engine/hooks";
import { CommentsPanel } from "../comments/CommentsPanel";
import { DesignPanel } from "./design/DesignPanel";
import { PrototypePanel } from "./prototype/PrototypePanel";
import { designPanelTab } from "./design/tabOrder";
import { present } from "../present";
import { useAccount } from "../../files/account";
import { ConnectionDot, Facepile, useFacepile } from "../multiplayer/Multiplayer";
import { usePresence } from "../multiplayer/presence";
import styles from "./Panels.module.css";

/** `floating`: Minimize UI with a selection — the panel over the canvas, a card at the right (help "Navigate the left sidebar"). */
export function RightPanel({ floating }: { floating?: boolean } = {}) {
  const ed = useEditor();
  const width = useUI((s) => s.rightWidth);
  const tab = useUI((s) => s.rightTab);
  const viewer = usePresence(ed).role === "viewer";
  const commenting = useTool(ed.store) === "COMMENT";
  const [viewerTab, setViewerTab] = useState<"comments" | "properties">("comments");
  // The Prototype tab shows the connections on the canvas (prototype mode).
  useEffect(() => {
    if (!ed.engine.destroyed && typeof ed.engine.setPrototypeMode === "function") ed.engine.setPrototypeMode(tab === "prototype");
  }, [ed, tab]);
  return (
    <aside className={floating ? `${styles.right} ${styles.rightFloating}` : styles.right} style={{ width }} aria-label="Properties panel" data-panel="right" data-floating={floating || undefined}>
      <RightHeader />
      {viewer ? (
        // "can view" (live multiplayer README): Comments | Properties instead of Design | Prototype
        <>
          <div className={styles.rightTabs}>
            <Tabs
              label="Properties"
              idBase="editor-right"
              value={viewerTab}
              tabs={[
                { value: "comments", label: "Comments", width: 74 },
                { value: "properties", label: "Properties", width: 72 },
              ]}
              onChange={(v) => setViewerTab(v as "comments" | "properties")}
            />
            <ZoomMenu />
          </div>
          <div className={styles.rightBody} role="tabpanel" id={`editor-right-panel-${viewerTab}`} aria-labelledby={`editor-right-tab-${viewerTab}`}>
            {viewerTab === "comments" ? <CommentsPanel /> : <DesignPanel />}
          </div>
        </>
      ) : commenting ? (
        // Comment mode (C): the panel lists the file's comments (R14)
        <div className={styles.rightBody}>
          <CommentsPanel />
        </div>
      ) : (
        <>
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
        </>
      )}
      {!floating && <ResizeHandle side="left" value={width} onChange={(px) => ed.ui.set({ rightWidth: px })} />}
    </aside>
  );
}

export function RightHeader({ compact }: { compact?: boolean }) {
  const ed = useEditor();
  const me = useAccount().state?.user;
  const presence = usePresence(ed);
  // With other people in the file the facepile takes the account avatar's place (live Figma: your avatar is Multiplayer tools).
  const facepile = useFacepile();
  const account: MenuEntry[] = [{ header: "Theme" }, commandItem(ed, "theme.light"), commandItem(ed, "theme.dark"), commandItem(ed, "theme.system"), "-", commandItem(ed, "help.shortcuts"), commandItem(ed, "file.back-to-files")];
  const onAccount = (id: string) => runEditorCommand(ed, id);
  const presentEntries: MenuEntry[] = [
    commandItem(ed, "view.present"),
    commandItem(ed, "view.present-here"),
    "-",
    commandItem(ed, "view.preview"),
  ];
  return (
    <div className={compact ? undefined : styles.rightHeader} style={compact ? { display: "contents" } : undefined}>
      {facepile ? (
        <Facepile />
      ) : (
        <MenuButton label="Account" entries={account} onSelect={onAccount} className={styles.account}>
          <Avatar name={me?.name || me?.email || "Burak Koç"} size={28} />
          <span className={styles.accountMore}><Icon name="16.chevron.down" /></span>
        </MenuButton>
      )}
      <span className={styles.grow} />
      <ConnectionDot />
      <span className={styles.present}>
        <IconButton icon="24.play" label="Present" shortcut="⌥⌘↩" size="large" onClick={() => present(ed)} />
        <MenuButton label="Present options" entries={presentEntries} onSelect={(id) => runEditorCommand(ed, id)} className={`${styles.chip} ${styles.presentChevron}`}>
          <Icon name="16.chevron.down" />
        </MenuButton>
      </span>
      <Button variant="primary" size="large" className={styles.share} onClick={() => runEditorCommand(ed, "file.share-preview")} data-requests={presence.requests || undefined}>
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
