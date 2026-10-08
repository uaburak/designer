/**
 * The left sidebar (240, resizable): the file header (name ▾ with the Edit file menu and rename, the location,
 * Minimize UI), then what the navigation bar's tab shows — File: Pages and Layers (or Find and replace, ⌘F),
 * Assets, and the Agents and Tools tabs (not built in this app: their headers and an empty state).
 */
import { useState } from "react";
import { Button, EmptyState, Icon, IconButton, MenuButton, ResizeHandle, SearchField, Select, TextInput, showToast } from "@/ds";
import { useEditor } from "../controller";
import { command, runEditorCommand, shortcutOf } from "../commands";
import { useUI } from "../hooks";
import { commandItem } from "../menus";
import { Pages } from "./Pages";
import { Layers } from "./Layers";
import { Assets } from "./Assets";
import { FindPanel } from "./Find";
import { TabHeader } from "./TabHeader";
import styles from "./Panels.module.css";

export function LeftPanel() {
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const tab = useUI((s) => s.railTab);
  const finding = useUI((s) => !!s.find);
  return (
    <aside className={styles.left} style={{ width: width + 1 /* live: 240 and the 1px line */ }} aria-label="Layers panel" data-panel="left" data-tab={tab}>
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
        <AgentsPanel />
      ) : (
        <ToolsPanel />
      )}
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}

/** Agents (Figma's agent and its chats): not part of this app — the tab's header, New chat disabled, a word why. */
function AgentsPanel() {
  return (
    <div className={styles.placeholderTab} data-agents="">
      <TabHeader title="Agents" actions={<IconButton icon="24.plus.small" label="New chat" tone="secondary" disabled />} />
      <EmptyState icon="24.agents" title="No chats" body="The Figma agent isn’t part of this app." />
    </div>
  );
}

/** Tools (plugins, widgets, shaders, Weave tools; live: search, Source and Category): not part of this app. */
function ToolsPanel() {
  const [query, setQuery] = useState("");
  return (
    <div className={styles.placeholderTab} data-tools="">
      <TabHeader title="Tools" actions={<Button variant="ghost" disabled>Create</Button>} />
      <div className={styles.toolsSearch}>
        <SearchField value={query} onChange={setQuery} placeholder="Search all tools" label="Search all tools" />
        <IconButton icon="24.adjust.small" label="Filter by price and type" tone="secondary" disabled />
      </div>
      <div className={styles.toolsFilters}>
        <Select label="Filter by source" variant="ghost" width="hug" value="source" options={[{ value: "source", label: "Source" }]} onChange={() => {}} disabled />
        <Select label="Filter by category" variant="ghost" width="hug" value="category" options={[{ value: "category", label: "Category" }]} onChange={() => {}} disabled />
      </div>
      <EmptyState icon="24.tools" title="No tools" body="Plugins, widgets and shaders aren’t part of this app." />
    </div>
  );
}

function FileHeader() {
  const ed = useEditor();
  const name = useUI((s) => s.fileName);
  const renaming = useUI((s) => s.renaming?.kind === "file");
  // The Edit file menu (help "Navigate the left sidebar": rename, version history, color profile, move).
  const entries = [
    commandItem(ed, "file.rename"),
    commandItem(ed, "file.duplicate"),
    commandItem(ed, "file.move"),
    "-" as const,
    commandItem(ed, "file.save-version"),
    commandItem(ed, "file.version-history"),
    "-" as const,
    commandItem(ed, "file.publish-library"),
    "-" as const,
    commandItem(ed, "file.color-profile"),
  ];
  return (
    <div className={styles.fileHeader}>
      <div className={styles.fileTitle}>
        {renaming ? (
          <RenameFile name={name} />
        ) : (
          <MenuButton label="Edit file" entries={entries} onSelect={(id) => runEditorCommand(ed, id)} className={styles.fileButton}>
            <span>{name}</span>
            <Icon name="16.chevron.down" />
          </MenuButton>
        )}
        <span className={styles.fileLocation}>{ed.source.location}</span>
      </div>
      <IconButton icon="24.sidebar.closed" label="Minimize UI" shortcut={shortcutOf(command("view.minimize-ui"))} onClick={() => runEditorCommand(ed, "view.minimize-ui")} />
    </div>
  );
}

function RenameFile({ name }: { name: string }) {
  const ed = useEditor();
  const [value] = useState(name);
  return (
    <div className={styles.fileRename}>
      <TextInput
        label="File name"
        value={value}
        autoFocus
        onCommit={(next) => {
          const trimmed = next.trim();
          if (!trimmed || trimmed === name) return;
          ed.ui.set({ fileName: trimmed });
          void Promise.resolve(ed.source.rename?.(trimmed)).catch(() => showToast({ message: "The file couldn't be renamed", kind: "error" }));
        }}
        onExit={(reason) => {
          ed.ui.set({ renaming: null });
          if (reason === "enter" || reason === "escape") ed.focusCanvas();
        }}
      />
    </div>
  );
}
