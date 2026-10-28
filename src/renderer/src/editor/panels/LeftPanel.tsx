/**
 * The left sidebar (240, resizable): the file header (the name, a double-click renames; ▾ the Edit file menu; Minimize
 * UI — no location line under the name: the owner, 2026-10-23), then what the navigation bar's tab shows — File: Pages and Layers (or Find and replace, ⌘F),
 * Assets, Agents (panels/agents: chats with the AI tools on this computer) and Brands. Figma's Tools tab is not built
 * (the owner, 2026-10-19): the plugins run from Actions (⌘K) › Plugins and the main menu's Plugins ▸, Wecra's image
 * tools from Actions and the image's own entry points.
 */
import { useState } from "react";
import { Icon, IconButton, MenuButton, ResizeHandle, TextInput, showToast, type MenuEntry } from "@/ds";
import { useEditor } from "../controller";
import { command, runEditorCommand, shortcutOf } from "../commands";
import { useUI } from "../hooks";
import { commandItem } from "../menus";
import { BranchTitle } from "../branching/Branching";
import { branchMenuEntries } from "../branching/commands";
import { Pages } from "./Pages";
import { Layers } from "./Layers";
import { Assets } from "./Assets";
import { FindPanel } from "./Find";
import { NavStrip } from "./Rail";
import { AgentsPanel } from "./agents/AgentsPanel";
import styles from "./Panels.module.css";
import { t, useT } from "@/i18n";

export function LeftPanel() {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const tab = useUI((s) => s.railTab);
  const finding = useUI((s) => !!s.find);
  const navMinimized = useUI((s) => !!s.navMinimized);
  // What the chrome drafts for the agent (Brands' Ask agent…, Design posts) lands in the Agents tab's composer.
  const draft = useUI((s) => s.socialDraft ?? null);
  return (
    <aside className={styles.left} style={{ width: width + 1 /* live: 240 and the 1px line */, ["--left-panel-width" as string]: `${width}px` }} aria-label={t("Layers panel")} data-panel="left" data-tab={tab}>
      {navMinimized && <NavStrip />}
      {tab === "file" && <FileHeader />}
      {tab === "file" ? (
        finding ? (
          <FindPanel />
        ) : (
          <>
            <Pages />
            <Layers />
          </>
        )
      ) : tab === "assets" ? (
        <Assets />
      ) : tab === "agents" ? (
        <AgentsPanel draft={draft} onDraftTaken={() => ed.ui.set({ socialDraft: null })} />
      ) : null /* Brands: the full-size view over the panels (studio/brands/BrandsWindow) */}
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}

/** `menu`: the name's menu in place of Edit file's (Dev Mode's: version history, Library ▸ …). */
export function FileHeader({ menu }: { menu?: () => MenuEntry[] } = {}) {
  useT();
  const ed = useEditor();
  const name = useUI((s) => s.fileName);
  const renaming = useUI((s) => s.renaming?.kind === "file");
  // The Edit file menu in Figma's order (docs/research/atlas/02-editor-chrome.md §3.3, EDITOR_FILENAME_DROPDOWN): the
  // branch rows; version history, the library's, analytics, Export; the color profile; Duplicate, Rename, Move. Built
  // when the menu opens (the branch rows follow the file's branch state).
  const entries = () => [
    ...branchMenuEntries(ed, commandItem).slice(1),
    "-" as const,
    commandItem(ed, "file.version-history"),
    commandItem(ed, "file.save-version"),
    commandItem(ed, "file.publish-library"),
    commandItem(ed, "file.library-analytics"),
    commandItem(ed, "file.export"),
    "-" as const,
    commandItem(ed, "file.color-profile"),
    "-" as const,
    commandItem(ed, "file.duplicate"),
    commandItem(ed, "file.rename"),
    commandItem(ed, "file.move"),
  ];
  return (
    <div className={styles.fileHeader}>
      <div className={styles.fileTitle}>
        {renaming ? (
          <RenameFile name={name} />
        ) : (
          // Figma (live left-panel.txt): a double-click on the name renames it in place (Enter / leaving commits, Esc
          // cancels); the chevron after it, its own 24 button, opens the Edit file menu.
          <span className={styles.fileName} data-file-name="">
            <button type="button" className={styles.fileButton} onDoubleClick={() => runEditorCommand(ed, "file.rename")}>
              <BranchTitle name={name} />
            </button>
            <MenuButton label={t("Edit file menu")} tooltip entries={menu ?? entries} onSelect={(id) => runEditorCommand(ed, id)} className={styles.fileMenu}>
              <Icon name="16.chevron.down" />
            </MenuButton>
          </span>
        )}
      </div>
      <IconButton icon="24.minimize-ui" size="large" className={styles.fileMinimize} label={t("Minimize UI")} shortcut={shortcutOf(command("view.minimize-ui"))} onClick={() => runEditorCommand(ed, "view.minimize-ui")} />
    </div>
  );
}

function RenameFile({ name }: { name: string }) {
  useT();
  const ed = useEditor();
  const [value] = useState(name);
  return (
    <div className={styles.fileRename}>
      <TextInput
        label={t("File name")}
        value={value}
        autoFocus
        onCommit={(next) => {
          const trimmed = next.trim();
          if (!trimmed || trimmed === name) return;
          ed.ui.set({ fileName: trimmed });
          void Promise.resolve(ed.source.rename?.(trimmed)).catch(() => showToast({ message: t("The file couldn't be renamed"), kind: "error" }));
        }}
        onExit={(reason) => {
          ed.ui.set({ renaming: null });
          if (reason === "enter" || reason === "escape") ed.focusCanvas();
        }}
      />
    </div>
  );
}
