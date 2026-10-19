/**
 * The left sidebar (240, resizable): the file header (name ▾ with the Edit file menu and rename, the location,
 * Minimize UI), then what the navigation bar's tab shows — File: Pages and Layers (or Find and replace, ⌘F),
 * Assets, Agents (panels/agents: chats with the AI tools on this computer) and Tools (the plugins this person can run
 * here, docs/plugins.md §6: by Source — Development, Your organization — and type; a row runs it).
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import { EmptyState, Icon, IconButton, MenuButton, ResizeHandle, SearchField, Select, TextInput, showToast, type MenuEntry } from "@/ds";
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
import { TabHeader } from "./TabHeader";
import { NavStrip } from "./Rail";
import { AgentsPanel } from "./agents/AgentsPanel";
import { BrandsPanel } from "../studio/BrandsPanel";
import { usePluginService, usePlugins } from "../plugins/service";
import { pluginRows } from "../plugins/actions";
import { isEnabled } from "../commands";
import styles from "./Panels.module.css";
import { t, useT } from "@/i18n";

export function LeftPanel() {
  useT();
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const tab = useUI((s) => s.railTab);
  const finding = useUI((s) => !!s.find);
  const navMinimized = useUI((s) => !!s.navMinimized);
  return (
    <aside className={styles.left} style={{ width: width + 1 /* live: 240 and the 1px line */ }} aria-label={t("Layers panel")} data-panel="left" data-tab={tab}>
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
      ) : tab === "brands" ? (
        <BrandsPanel />
      ) : (
        <ToolsPanel />
      )}
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}

/** Tools (plugins, widgets, shaders, Weave tools; live: search, Source and Category): the plugins here (no Community, no shaders as tools). */
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
  { value: "development", label: "Development" },
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
  useT();
  const ed = useEditor();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("source");
  const [category, setCategory] = useState("category");
  const [filter, setFilter] = useState({ price: "price-all", type: "type-all" });
  return (
    <div className={styles.placeholderTab} data-tools="">
      {/* Live: "Create" as text (11 / 450, primary) at 173, 18 — New plugin… */}
      <TabHeader
        title={t("Tools")}
        actions={
          <button
            type="button"
            className={styles.toolsCreate}
            onClick={() => {
              if (isEnabled(ed, command("plugins.new"))) runEditorCommand(ed, "plugins.new");
              else showToast({ message: t("Developing plugins needs the desktop app") });
            }}
          >
            {t("Create")}
          </button>
        }
      />
      <div className={styles.toolsSearch}>
        <SearchField value={query} onChange={setQuery} placeholder={t("Search all tools")} label={t("Search all tools")} />
        {/* Live: enabled (rail-tools.txt). Its menu — price, then type — isn't captured (help "Find tools": free / paid, plugins / widgets / shaders): unverified */}
        <MenuButton
          label={t("Filter by price and type")}
          entries={TOOLS_FILTER.map((e) => (typeof e === "string" ? e : { ...e, label: t(e.label), checked: filter[e.group] === e.id }))}
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
        <Select label={t("Filter by source")} variant="ghost" width="hug" prefix="24.globe" className={styles.toolsFilter} value={source} options={TOOLS_SOURCES.map((o) => ({ ...o, label: t(o.label) }))} onChange={setSource} />
        <Select label={t("Filter by category")} variant="ghost" width="hug" prefix="24.filter" className={styles.toolsFilter} value={category} options={TOOLS_CATEGORIES.map((o) => ({ ...o, label: t(o.label) }))} onChange={setCategory} />
      </div>
      <ToolsList query={query} source={source} type={filter.type} />
    </div>
  );
}

/** The plugins as rows (widgets aren't built: the Widgets type lists none). */
function ToolsList({ query, source, type }: { query: string; source: string; type: string }) {
  useT();
  const ed = useEditor();
  const plugins = usePluginService(ed);
  usePlugins(plugins);
  if (!plugins || type === "type-widgets" || type === "type-shaders") return <EmptyState icon="24.tools" title={t("No tools")} body={plugins ? t("Widgets and shaders aren’t built in this app yet.") : t("Plugins aren’t available here.")} />;
  const rows = pluginRows(plugins, query).filter((r) => (source === "development" ? r.ref.source.type === "development" : source === "organization" ? r.ref.source.type === "private" : true));
  // Recents and Saved repeat the plugins listed by source: by source only here.
  const shown = rows.filter((r, i) => (r.section !== "Recents" && r.section !== "Saved") || !rows.some((x, j) => j !== i && x.ref.id === r.ref.id && x.section !== r.section));
  const unique = shown.filter((r, i) => shown.findIndex((x) => x.key === r.key || (x.ref.id === r.ref.id && x.command === r.command)) === i);
  if (!unique.length) return <EmptyState icon="24.tools" title={t("No tools")} body={query ? t("No plugins match.") : t("Import a plugin from Plugins › Development › Import plugin from manifest…")} />;
  return (
    <div className={styles.toolsList} role="list" aria-label={t("Plugins")}>
      {unique.map((r, i) => (
        <div key={r.key} style={{ display: "contents" }}>
          {(i === 0 || unique[i - 1].section !== r.section) && <div className={styles.toolsSection}>{t(r.section)}</div>}
          <button type="button" role="listitem" className={styles.toolsRow} disabled={!!r.disabled} title={r.disabled ?? undefined} onClick={() => void plugins.run(r.ref, r.command)}>
            <Icon name="24.plugin" />
            <span className={styles.toolsRowLabel}>{r.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

/** `menu`: the name's menu in place of Edit file's (Dev Mode's: version history, Library ▸ …). */
export function FileHeader({ menu }: { menu?: () => MenuEntry[] } = {}) {
  useT();
  const ed = useEditor();
  const name = useUI((s) => s.fileName);
  const renaming = useUI((s) => s.renaming?.kind === "file");
  // Where the file is (its folder, or Drafts): follows moves, and an org file's folder name once the store read it.
  const location = useSyncExternalStore(
    useCallback((changed: () => void) => ed.source.onMetaChanged?.(changed) ?? (() => {}), [ed]),
    () => ed.source.location
  );
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
          <MenuButton label={t("Edit file")} entries={menu ?? entries}onSelect={(id) => runEditorCommand(ed, id)} className={styles.fileButton}>
            <BranchTitle name={name} />
            <Icon name="16.chevron.down" />
          </MenuButton>
        )}
        <span className={styles.fileLocation}>{location}</span>
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
