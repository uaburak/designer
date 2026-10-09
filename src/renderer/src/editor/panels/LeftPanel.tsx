/**
 * The left sidebar (240, resizable): the file header (name ▾ with the Edit file menu and rename, the location,
 * Minimize UI), then what the navigation bar's tab shows — File: Pages and Layers (or Find and replace, ⌘F),
 * Assets, Agents (panels/agents: chats with the AI tools on this computer) and Tools (not built in this app).
 */
import { useState } from "react";
import { EmptyState, Icon, IconButton, MenuButton, ResizeHandle, SearchField, Select, TextInput, showToast } from "@/ds";
import { useEditor } from "../controller";
import { command, runEditorCommand, shortcutOf } from "../commands";
import { useUI } from "../hooks";
import { commandItem } from "../menus";
import { Pages } from "./Pages";
import { Layers } from "./Layers";
import { Assets } from "./Assets";
import { FindPanel } from "./Find";
import { TabHeader } from "./TabHeader";
import { NavStrip } from "./Rail";
import { AgentsPanel } from "./agents/AgentsPanel";
import styles from "./Panels.module.css";

export function LeftPanel() {
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const tab = useUI((s) => s.railTab);
  const finding = useUI((s) => !!s.find);
  const navMinimized = useUI((s) => !!s.navMinimized);
  return (
    <aside className={styles.left} style={{ width: width + 1 /* live: 240 and the 1px line */ }} aria-label="Layers panel" data-panel="left" data-tab={tab}>
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
        <AgentsPanel />
      ) : (
        <ToolsPanel />
      )}
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}

/** Tools (plugins, widgets, shaders, Weave tools; live: search, Source and Category): not part of this app. */
const TOOLS_FILTER = [
  { id: "price-all", label: "All prices", group: "price" as const },
  { id: "price-free", label: "Free", group: "price" as const },
  { id: "price-paid", label: "Paid", group: "price" as const },
  "-" as const,
  { id: "type-all", label: "All types", group: "type" as const },
  { id: "type-plugins", label: "Plugins", group: "type" as const },
  { id: "type-widgets", label: "Widgets", group: "type" as const },
  { id: "type-shaders", label: "Shaders", group: "type" as const },
];

/** Source and Category (live shows them as "Source" and "Category"; their lists are not captured: unverified, help "Find tools"). */
const TOOLS_SOURCES = [
  { value: "source", label: "Source" },
  { value: "figma", label: "Figma" },
  { value: "community", label: "Community" },
  { value: "organization", label: "Your organization" },
];
const TOOLS_CATEGORIES = [
  { value: "category", label: "Category" },
  { value: "generative", label: "Generative" },
  { value: "design", label: "Design" },
  { value: "development", label: "Development" },
  { value: "productivity", label: "Productivity" },
];

function ToolsPanel() {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("source");
  const [category, setCategory] = useState("category");
  const [filter, setFilter] = useState({ price: "price-all", type: "type-all" });
  return (
    <div className={styles.placeholderTab} data-tools="">
      {/* Live: "Create" as text (11 / 450, primary) at 173, 18 — nothing to create here: it says so */}
      <TabHeader
        title="Tools"
        actions={
          <button type="button" className={styles.toolsCreate} onClick={() => showToast({ message: "Plugins, widgets and shaders aren’t part of this app" })}>
            Create
          </button>
        }
      />
      <div className={styles.toolsSearch}>
        <SearchField value={query} onChange={setQuery} placeholder="Search all tools" label="Search all tools" />
        {/* Live: enabled (rail-tools.txt). Its menu — price, then type — isn't captured (help "Find tools": free / paid, plugins / widgets / shaders): unverified */}
        <MenuButton
          label="Filter by price and type"
          entries={TOOLS_FILTER.map((e) => (typeof e === "string" ? e : { ...e, checked: filter[e.group] === e.id }))}
          onSelect={(id) => {
            const e = TOOLS_FILTER.find((x) => typeof x !== "string" && x.id === id);
            if (e && typeof e !== "string") setFilter({ ...filter, [e.group]: e.id });
          }}
          className={styles.toolsFilterButton}
        >
          <Icon name="24.adjust.small" />
        </MenuButton>
      </div>
      <div className={styles.toolsFilters}>
        {/* Live (rail-tools.txt): enabled, 79 / 91 wide, the label after a 24 glyph (which glyphs and which lists: unverified; the list itself stays "No tools") */}
        <Select label="Filter by source" variant="ghost" width="hug" prefix="24.globe" className={styles.toolsFilter} value={source} options={TOOLS_SOURCES} onChange={setSource} />
        <Select label="Filter by category" variant="ghost" width="hug" prefix="24.filter" className={styles.toolsFilter} value={category} options={TOOLS_CATEGORIES} onChange={setCategory} />
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
