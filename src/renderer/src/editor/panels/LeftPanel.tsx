/**
 * The left panel (240, resizable): the file header (name ▾ with the file
 * menu and rename, the location, Minimize UI), then — by the rail's tab —
 * Pages and Layers, or Assets.
 */
import { useState } from "react";
import { EmptyState, Icon, IconButton, MenuButton, ResizeHandle, SearchField, TextInput, showToast } from "@/ds";
import { useEditor } from "../controller";
import { command, runEditorCommand, shortcutOf } from "../commands";
import { useUI } from "../hooks";
import { commandItem } from "../menus";
import { Pages } from "./Pages";
import { Layers } from "./Layers";
import styles from "./Panels.module.css";

export function LeftPanel() {
  const ed = useEditor();
  const width = useUI((s) => s.leftWidth);
  const tab = useUI((s) => s.railTab);
  return (
    <aside className={styles.left} style={{ width }} aria-label="Layers panel" data-panel="left">
      <FileHeader />
      {tab === "file" ? (
        <>
          <Pages />
          <Layers />
        </>
      ) : (
        <Assets />
      )}
      <ResizeHandle side="right" value={width} onChange={(px) => ed.ui.set({ leftWidth: px })} />
    </aside>
  );
}

function FileHeader() {
  const ed = useEditor();
  const name = useUI((s) => s.fileName);
  const renaming = useUI((s) => s.renaming?.kind === "file");
  const entries = [commandItem(ed, "file.save-version"), commandItem(ed, "file.version-history"), "-" as const, commandItem(ed, "file.duplicate"), commandItem(ed, "file.rename"), commandItem(ed, "file.move"), "-" as const, commandItem(ed, "file.export"), "-" as const, commandItem(ed, "file.back-to-files")];
  return (
    <div className={styles.fileHeader}>
      <div className={styles.fileTitle}>
        {renaming ? (
          <RenameFile name={name} />
        ) : (
          <MenuButton label="File" entries={entries} onSelect={(id) => runEditorCommand(ed, id)} className={styles.fileButton}>
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

/** Assets (the rail's second tab): components and libraries come with E6 — a search and a note until then. */
function Assets() {
  const [query, setQuery] = useState("");
  return (
    <div className={styles.assets}>
      <div className={styles.assetsSearch}>
        <SearchField value={query} onChange={setQuery} placeholder="Search assets" />
      </div>
      <EmptyState icon="24.component" title="No components yet" body="Components you create in this file and the libraries you add show up here." />
    </div>
  );
}
