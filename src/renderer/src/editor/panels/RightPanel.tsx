/**
 * The right panel (240, resizable): a 48px header (the account's avatar ▾,
 * Present ▸ ▾, Share), the Design / Prototype tabs with the zoom menu at the
 * right (a line at 80), then the tab's sections.
 */
import { Avatar, Button, Icon, IconButton, MenuButton, ResizeHandle, Tabs, size, type MenuEntry } from "@/ds";
import { useCamera } from "@/engine/hooks";
import type { Guid } from "@/engine/codec";
import { readCategories, syncEngine } from "../devmode/devMode";
import { CATEGORY_HEX, type Category } from "../devmode/annotations";
import { useEditor } from "../controller";
import { runEditorCommand, setViewOption } from "../commands";
import { zoomTo } from "../actions";
import { useUI } from "../hooks";
import { commandItem } from "../menus";
import { useEffect, useState } from "react";
import { useTool } from "@/engine/hooks";
import { CommentsPanel } from "../comments/CommentsPanel";
import { DesignPanel } from "./design/DesignPanel";
import { PrototypePanel } from "./prototype/PrototypePanel";
import { designPanelTab } from "./design/tabOrder";
import { rightPanelTabs } from "../draw/panels/drawPanel";
import { present } from "../present";
import { useAccount } from "../../files/account";
import { AgentFaces, Facepile, useFacepile } from "../multiplayer/Multiplayer";
import { SaveStatusIcon } from "../SaveStatusIcon";
import { usePresence } from "../multiplayer/presence";
import { t, useT } from "@/i18n";
import styles from "./Panels.module.css";

/** `floating`: Minimize UI with a selection — the panel over the canvas, a card at the right (help "Navigate the left sidebar"). */
export function RightPanel({ floating }: { floating?: boolean } = {}) {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.rightWidth);
  // Draw has no Prototype tab (docs/draw.md §5.3 [unverified]): the Design tab shows; Design mode gets the chosen one back.
  const drawMode = useUI((s) => s.mode === "draw");
  const chosen = useUI((s) => s.rightTab);
  const tab = drawMode ? "design" : chosen;
  const viewer = usePresence(ed).role === "viewer";
  const commenting = useTool(ed.store) === "COMMENT";
  const [viewerTab, setViewerTab] = useState<"comments" | "properties">("comments");
  // The Prototype tab shows the connections on the canvas (prototype mode).
  useEffect(() => {
    if (!ed.engine.destroyed && typeof ed.engine.setPrototypeMode === "function") ed.engine.setPrototypeMode(tab === "prototype");
  }, [ed, tab]);
  return (
    <aside className={floating ? `${styles.right} ${styles.rightFloating}` : styles.right} style={{ width }} aria-label={t("Properties panel")} data-panel="right" data-floating={floating || undefined}>
      <RightHeader />
      {viewer ? (
        // "can view" (live multiplayer README): Comments | Properties instead of Design | Prototype
        <>
          <div className={styles.rightTabs}>
            <Tabs
              label={t("Properties")}
              idBase="editor-right"
              value={viewerTab}
              tabs={[
                { value: "comments", label: t("Comments"), width: 74 },
                { value: "properties", label: t("Properties"), width: 72 },
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
              label={t("Properties")}
              idBase="editor-right"
              value={tab}
              tabs={[
                // Live (left/rail-assets.txt): 53 × 24 at 1208 and 69 × 24 at 1265
                { value: "design", label: t("Design"), width: 53 },
                ...(rightPanelTabs(drawMode ? "draw" : "design").includes("prototype") ? [{ value: "prototype", label: t("Prototype"), width: 69 }] : []),
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
      {/* Figma (atlas 02 §4.1): 241 to 500 with its line, no double-click default */}
      {!floating && <ResizeHandle side="left" value={width} max={size["right-panel-max"]} defaultValue={null} onChange={(px) => ed.ui.set({ rightWidth: px })} />}
    </aside>
  );
}

export function RightHeader({ compact }: { compact?: boolean }) {
  useT();
  const ed = useEditor();
  const me = useAccount().state?.user;
  const presence = usePresence(ed);
  // With other people in the file the facepile takes the account avatar's place (live Figma: your avatar is Multiplayer tools).
  const facepile = useFacepile();
  const account: MenuEntry[] = [{ header: t("Theme") }, commandItem(ed, "theme.light"), commandItem(ed, "theme.dark"), commandItem(ed, "theme.system"), "-", commandItem(ed, "help.shortcuts"), commandItem(ed, "file.back-to-files")];
  const onAccount = (id: string) => runEditorCommand(ed, id);
  const presentEntries: MenuEntry[] = [
    commandItem(ed, "view.present"),
    commandItem(ed, "view.present-here"),
    "-",
    commandItem(ed, "view.preview"),
  ];
  return (
    <div className={compact ? undefined : styles.rightHeader} style={compact ? { display: "contents" } : undefined}>
      <AgentFaces />
      {facepile ? (
        <Facepile />
      ) : (
        <MenuButton label={t("Account")} entries={account} onSelect={onAccount} className={styles.account}>
          <Avatar name={me?.name || me?.email || "Burak Koç"} src={me?.picture ?? undefined} size={28} />
          <span className={styles.accountMore}><Icon name="16.chevron.down" /></span>
        </MenuButton>
      )}
      <span className={styles.grow} />
      <SaveStatusIcon />
      <span className={styles.present}>
        <IconButton icon="24.play" label={t("Present")} shortcut="⌥⌘↩" size="large" onClick={() => present(ed)} />
        <MenuButton label={t("Present options")} entries={presentEntries} onSelect={(id) => runEditorCommand(ed, id)} className={`${styles.chip} ${styles.presentChevron}`}>
          <Icon name="16.chevron.down" />
        </MenuButton>
      </span>
      <Button variant="primary" size="large" className={styles.share} onClick={() => runEditorCommand(ed, "file.share-preview")} data-requests={presence.requests || undefined}>
        {t("Share")}
      </Button>
    </div>
  );
}

/** The zoom menu's own rows (not commands): Pixel preview's three, Property labels. */
const PIXEL_PREVIEW = ["zoom.pixel-preview-0", "zoom.pixel-preview-1", "zoom.pixel-preview-2"] as const;
const PROPERTY_LABELS = "zoom.property-labels";
/** Annotations ▸ Show all categories, and a category's row (its id after the prefix). */
const ALL_CATEGORIES = "zoom.annotation-categories";
const CATEGORY = "zoom.annotation-category:";

/**
 * "100% ⌄": the zoom (re-rendered on every camera change, so kept small) and its menu, in Figma's order
 * (docs/research/atlas/02-editor-chrome.md §4.3, `zoom_menu`): the zoom as a field; Zoom in / out (off at the zoom's
 * limits) / to fit, to 50 / 100 / 200 % (checked at that zoom); Pixel preview ▸, Pixel grid, Snap to pixel grid, Layout
 * guides, Rulers; Multiplayer cursors, Property labels, Comments; Outlines ▸ (Show hidden layers, Show object bounds),
 * Annotations (▸ its categories in Dev Mode). Each choice gives the keys back to the canvas.
 */
export function ZoomMenu() {
  useT();
  const ed = useEditor();
  const camera = useCamera(ed.store);
  const preview = useUI((s) => s.pixelPreview ?? 0);
  const labels = useUI((s) => s.propertyLabels);
  const dev = useUI((s) => s.mode === "dev");
  const filter = useUI((s) => s.annotationCategory ?? null);
  const at = (z: number) => Math.abs(camera.zoom - z) < 1e-6;
  // Figma's Annotations: in Dev Mode with the file's categories, a submenu — Show annotations; Show all categories and a
  // row per category, each showing only its own (`filterAnnotationCategoryId`); otherwise the one toggle.
  const categories = dev ? readCategories(ed).filter((c): c is Category & { id: Guid } => c.id !== null) : [];
  const annotations: MenuEntry = categories.length
    ? {
        id: "zoom.annotations",
        label: t("Annotations"),
        items: [
          commandItem(ed, "view.annotations", "Show annotations"),
          "-",
          { id: ALL_CATEGORIES, label: t("Show all categories"), checked: !filter },
          ...categories.map((c) => ({ id: CATEGORY + c.id, label: c.label, swatch: CATEGORY_HEX[c.color], checked: c.id === filter })),
        ],
      }
    : commandItem(ed, "view.annotations", "Show annotations");
  const entries: MenuEntry[] = [
    commandItem(ed, "view.zoom-in"),
    commandItem(ed, "view.zoom-out"),
    commandItem(ed, "view.zoom-fit"),
    { ...commandItem(ed, "view.zoom-50"), checked: at(0.5) },
    { ...commandItem(ed, "view.zoom-100"), checked: at(1) },
    { ...commandItem(ed, "view.zoom-200"), checked: at(2) },
    "-",
    {
      id: "zoom.pixel-preview",
      label: t("Pixel preview"),
      items: [
        { id: PIXEL_PREVIEW[0], label: t("Disabled"), checked: preview === 0, radio: true },
        { id: PIXEL_PREVIEW[1], label: "1x", checked: preview === 1, radio: true },
        { id: PIXEL_PREVIEW[2], label: "2x", checked: preview === 2, radio: true },
      ],
    },
    commandItem(ed, "view.pixel-grid"),
    commandItem(ed, "view.snap-pixel-grid"),
    commandItem(ed, "view.layout-guides"),
    commandItem(ed, "view.rulers"),
    "-",
    commandItem(ed, "view.multiplayer-cursors"),
    { id: PROPERTY_LABELS, label: t("Property labels"), checked: labels },
    commandItem(ed, "view.comments"),
    "-",
    { id: "zoom.outlines", label: t("Outlines"), items: [commandItem(ed, "view.outlines", "Outlines"), "-", commandItem(ed, "view.outline-hidden-layers"), commandItem(ed, "view.outline-object-bounds")] },
    annotations,
  ];
  return (
    <MenuButton
      label={t("Zoom")}
      entries={entries}
      head={(close) => <ZoomField zoom={camera.zoom} onDone={close} />}
      onSelect={(id) => {
        const level = PIXEL_PREVIEW.indexOf(id as (typeof PIXEL_PREVIEW)[number]);
        if (level >= 0) setViewOption(ed, { pixelPreview: level as 0 | 1 | 2 });
        else if (id === PROPERTY_LABELS) ed.ui.set((s) => ({ propertyLabels: !s.propertyLabels }));
        else if (id === ALL_CATEGORIES || id.startsWith(CATEGORY)) {
          ed.ui.set({ annotationCategory: id === ALL_CATEGORIES ? null : id.slice(CATEGORY.length) });
          syncEngine(ed);
        }
        else runEditorCommand(ed, id);
        ed.focusCanvas();
      }}
      className={styles.zoom}
    >
      <span>{Math.round(camera.zoom * 100)}%</span>
      <Icon name="16.chevron.down" />
    </MenuButton>
  );
}

/**
 * The zoom menu's field (Figma's: the zoom as "300%"): a number and Enter zooms to it (n / 100, about the view's
 * centre) and closes the menu; Esc leaves the field. Its keys stay in it (digits, %, Enter and Esc never reach the
 * canvas's shortcuts).
 */
function ZoomField({ zoom, onDone }: { zoom: number; onDone: () => void }) {
  useT();
  const ed = useEditor();
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className={styles.zoomField}
      aria-label={t("Zoom")}
      value={text ?? `${Math.round(zoom * 100)}%`}
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          const n = parseInt(e.currentTarget.value, 10);
          if (n > 0) zoomTo(ed, n / 100);
          setText(null);
          onDone();
          ed.focusCanvas();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setText(null);
          (e.currentTarget.closest('[data-ds="Menu"]') as HTMLElement | null)?.focus({ preventScroll: true });
        }
      }}
    />
  );
}
