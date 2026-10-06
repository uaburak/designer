/**
 * The right panel (240, resizable): a 48px header (the account's avatar ▾,
 * Present ▸ ▾, Share), the Design / Prototype tabs with the zoom menu at the
 * right (a line at 80), then the tab's sections.
 */
import { Avatar, Button, EmptyState, Icon, IconButton, MenuButton, ResizeHandle, Tabs, showToast, type MenuEntry } from "@/ds";
import { useCamera } from "@/engine/hooks";
import { useEditor } from "../controller";
import { runEditorCommand } from "../commands";
import { useUI } from "../hooks";
import { commandItem } from "../menus";
import { DesignPanel } from "./design/DesignPanel";
import styles from "./Panels.module.css";

export function RightPanel() {
  const ed = useEditor();
  const width = useUI((s) => s.rightWidth);
  const tab = useUI((s) => s.rightTab);
  return (
    <aside className={styles.right} style={{ width }} aria-label="Properties panel" data-panel="right">
      <RightHeader />
      <div className={styles.rightTabs}>
        <Tabs
          label="Properties"
          idBase="editor-right"
          value={tab}
          tabs={[
            { value: "design", label: "Design" },
            { value: "prototype", label: "Prototype" },
          ]}
          onChange={(v) => ed.ui.set({ rightTab: v as "design" | "prototype" })}
        />
        <ZoomMenu />
      </div>
      <div className={styles.rightBody} role="tabpanel" id={`editor-right-panel-${tab}`} aria-labelledby={`editor-right-tab-${tab}`}>
        {tab === "design" ? <DesignPanel /> : <EmptyState icon="24.prototyping" title="Prototype" body="Connections, flows and presentation settings come with prototyping." />}
      </div>
      <ResizeHandle side="left" value={width} onChange={(px) => ed.ui.set({ rightWidth: px })} />
    </aside>
  );
}

export function RightHeader({ compact }: { compact?: boolean }) {
  const ed = useEditor();
  const account: MenuEntry[] = [{ header: "Theme" }, commandItem(ed, "theme.light"), commandItem(ed, "theme.dark"), commandItem(ed, "theme.system"), "-", commandItem(ed, "help.shortcuts"), commandItem(ed, "file.back-to-files")];
  const present: MenuEntry[] = [
    { id: "present", label: "Present in new tab", disabled: true },
    { id: "present-here", label: "Present in this tab", disabled: true },
    "-",
    { id: "preview", label: "Preview", shortcut: "⇧Space", disabled: true },
  ];
  return (
    <div className={compact ? undefined : styles.rightHeader} style={compact ? { display: "contents" } : undefined}>
      <MenuButton label="Account" entries={account} onSelect={(id) => runEditorCommand(ed, id)} className={styles.chip}>
        <Avatar name="Burak Koç" />
        <Icon name="16.chevron.down" />
      </MenuButton>
      <span className={styles.grow} />
      <span className={styles.present}>
        <IconButton icon="24.play" label="Present" size="large" onClick={() => showToast({ message: "Presenting comes with prototyping" })} />
        <MenuButton label="Present options" entries={present} onSelect={() => {}} className={`${styles.chip} ${styles.presentChevron}`}>
          <Icon name="16.chevron.down" />
        </MenuButton>
      </span>
      <Button variant="primary" size="large" onClick={() => showToast({ message: "Sharing comes with developer previews" })}>
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
    "-",
    commandItem(ed, "view.property-labels"),
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
      <Icon name="24.chevron.down" />
    </MenuButton>
  );
}
