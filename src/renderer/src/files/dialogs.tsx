/** Home's modals (in-view, docs/desktop.md §7): New folder, Move to folder, and the irreversible confirmations. */
import { useMemo, useState } from "react";
import { Button, Dialog, Icon, SearchField, TextInput } from "@/ds";
import type { FolderId } from "@shared/store/types";
import { searchKey, type FolderIndex } from "./model";
import { FolderGlyph } from "./parts";
import styles from "./Files.module.css";

export function NewFolderDialog({ onCreate, onClose }: { onCreate: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const ok = name.trim().length > 0;
  return (
    <Dialog
      open
      title="New folder"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="large" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="large" disabled={!ok} onClick={() => ok && onCreate(name.trim())}>
            Create folder
          </Button>
        </>
      }
    >
      <div className={styles.dialogField}>
        <TextInput label="Folder name" placeholder="Folder name" size="large" value={name} onChange={setName} autoFocus onExit={(r) => (r === "enter" && ok ? onCreate(name.trim()) : r === "escape" && onClose())} />
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({ title, body, confirm, onConfirm, onClose }: { title: string; body: string; confirm: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="large" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" size="large" onClick={onConfirm}>
            {confirm}
          </Button>
        </>
      }
    >
      <p className={styles.dialogText}>{body}</p>
    </Dialog>
  );
}

/**
 * Move to folder: files go to Drafts or a folder; folders go to the top level ("All folders") or under another
 * folder, never into themselves.
 */
export function MoveDialog({ title, folders, forFolders, exclude, current, onMove, onClose }: { title: string; folders: FolderIndex; forFolders: boolean; exclude: Set<FolderId>; current: FolderId | null | undefined; onMove: (dest: FolderId | null) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<FolderId | null | undefined>(undefined);
  const rows = useMemo(() => {
    const all = folders.flatten(exclude);
    const needle = searchKey(query.trim());
    return needle ? all.filter((r) => searchKey(r.folder.name).includes(needle)).map((r) => ({ ...r, depth: 1 })) : all;
  }, [folders, exclude, query]);
  const rootLabel = forFolders ? "All folders" : "Drafts";
  const canMove = picked !== undefined && picked !== current;
  return (
    <Dialog
      open
      size="medium"
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="large" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="large" disabled={!canMove} onClick={() => canMove && onMove(picked ?? null)}>
            Move
          </Button>
        </>
      }
    >
      <SearchField value={query} onChange={setQuery} placeholder="Search folders" size="large" autoFocus onExit={(r) => r === "escape" && onClose()} />
      <div role="listbox" aria-label="Destinations" className={styles.moveList}>
        {!query.trim() && (
          <button type="button" role="option" aria-selected={picked === null} aria-disabled={current === null || undefined} className={styles.moveRow} onClick={() => setPicked(null)} onDoubleClick={() => current !== null && onMove(null)}>
            <Icon name={forFolders ? "24.view.grid" : "24.file"} />
            <span className={styles.moveName}>{rootLabel}</span>
          </button>
        )}
        {rows.map(({ folder, depth }) => (
          <button
            key={folder.id}
            type="button"
            role="option"
            aria-selected={picked === folder.id}
            aria-disabled={current === folder.id || undefined}
            className={styles.moveRow}
            style={{ paddingLeft: `calc(var(--ds-space-2) + ${depth - 1} * var(--ds-space-4))` }}
            onClick={() => setPicked(folder.id)}
            onDoubleClick={() => current !== folder.id && onMove(folder.id)}
          >
            <FolderGlyph color={folder.color} />
            <span className={styles.moveName}>{folder.name}</span>
          </button>
        ))}
        {query.trim() && !rows.length && <span className={styles.moveRow}>No results</span>}
      </div>
    </Dialog>
  );
}
