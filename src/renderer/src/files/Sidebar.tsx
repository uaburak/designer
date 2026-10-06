/**
 * Home's sidebar (Figma's 2026 file browser): the account, Search, Recents | the team: Drafts, All folders (the
 * folder tree, nested and coloured), Trash | Starred. Drafts and folders take dropped files.
 */
import { useState, type ReactNode } from "react";
import { Avatar, FileKindIcon, Icon, SearchField, SidebarDivider, SidebarHeader, SidebarItem } from "@/ds";
import type { FileKey, FileListItem, Folder, FolderId } from "@shared/store/types";
import type { FolderIndex, Location } from "./model";
import { FolderGlyph } from "./parts";
import styles from "./Files.module.css";

export interface DropApi {
  /** Is a Home drag over the page (only then do targets light up) */
  accepts(e: React.DragEvent): boolean;
  drop(e: React.DragEvent, dest: FolderId | null): void;
}

export interface SidebarProps {
  ownerName: string;
  teamName: string;
  location: Location;
  search: string;
  onSearch: (text: string) => void;
  onSearchExit: () => void;
  go: (loc: Location) => void;
  folders: FolderIndex;
  expanded: ReadonlySet<FolderId>;
  onToggle: (id: FolderId) => void;
  starredFolders: Folder[];
  starredFiles: FileListItem[];
  starredOpen: boolean;
  onStarredOpen: (open: boolean) => void;
  onOpenFile: (fileKey: FileKey) => void;
  onFolderMenu: (e: React.MouseEvent, folder: Folder) => void;
  onFileMenu: (e: React.MouseEvent, file: FileListItem) => void;
  onAllFoldersMenu: (e: React.MouseEvent) => void;
  onTrashMenu: (e: React.MouseEvent) => void;
  dnd: DropApi;
}

/** A sidebar entry that takes dropped files/folders. */
function DropTarget({ dest, dnd, children }: { dest: FolderId | null; dnd: DropApi; children: (over: boolean) => ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (!dnd.accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes("Files") ? "copy" : "move";
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!dnd.accepts(e)) return;
        e.preventDefault();
        dnd.drop(e, dest);
      }}
    >
      {children(over)}
    </div>
  );
}

function FolderTree({ parent, depth, props }: { parent: FolderId | null; depth: number; props: SidebarProps }) {
  const { folders, expanded, onToggle, location, go, onFolderMenu, dnd } = props;
  return (
    <>
      {folders.children(parent).map((f) => {
        const kids = folders.children(f.id).length > 0;
        const open = expanded.has(f.id);
        return (
          <div key={f.id} role="treeitem" aria-expanded={kids ? open : undefined} aria-level={depth}>
            <DropTarget dest={f.id} dnd={dnd}>
              {(over) => (
                <div className={styles.treeRow}>
                  <SidebarItem icon={<FolderGlyph color={f.color} />} label={f.name} indent={depth} selected={location.kind === "folder" && location.folderId === f.id} dropTarget={over} onClick={() => go({ kind: "folder", folderId: f.id })} onContextMenu={(e) => onFolderMenu(e, f)} />
                  {kids && (
                    <button
                      type="button"
                      className={styles.disclosure}
                      style={{ left: `calc(var(--ds-size-row-inset) + ${depth - 1} * var(--ds-space-4) + var(--ds-space-2))` }}
                      aria-label={open ? "Collapse" : "Expand"}
                      aria-expanded={open}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(f.id);
                      }}
                    >
                      <Icon name="16.chevron.down" />
                    </button>
                  )}
                </div>
              )}
            </DropTarget>
            {kids && open && (
              <div role="group">
                <FolderTree parent={f.id} depth={depth + 1} props={props} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function Sidebar(props: SidebarProps) {
  const { ownerName, teamName, location, search, onSearch, onSearchExit, go, starredFolders, starredFiles, starredOpen, onStarredOpen, onOpenFile, onFolderMenu, onFileMenu, onAllFoldersMenu, onTrashMenu, dnd } = props;
  const is = (kind: Location["kind"]) => location.kind === kind;
  return (
    <nav className={styles.sidebar} aria-label="File browser">
      <div className={styles.account}>
        <Avatar name={ownerName} />
        <span className={styles.accountName}>{ownerName}</span>
      </div>
      <div className={styles.search}>
        <SearchField value={search} onChange={onSearch} size="large" placeholder="Search" onExit={(r) => r === "escape" && onSearchExit()} />
      </div>
      <div className={styles.navGroup}>
        <SidebarItem icon="24.recent" label="Recents" selected={is("recents")} onClick={() => go({ kind: "recents" })} />
      </div>
      <SidebarDivider />
      <div className={styles.team}>
        <Avatar name={teamName} size={16} />
        <span className={styles.teamName}>{teamName}</span>
      </div>
      <div className={styles.navGroup}>
        <DropTarget dest={null} dnd={dnd}>
          {(over) => <SidebarItem icon="24.file" label="Drafts" selected={is("drafts")} dropTarget={over} onClick={() => go({ kind: "drafts" })} />}
        </DropTarget>
        <SidebarItem icon="24.view.grid" label="All folders" selected={is("folders")} onClick={() => go({ kind: "folders" })} onContextMenu={onAllFoldersMenu} />
        <div role="tree" aria-label="Folders">
          <FolderTree parent={null} depth={1} props={props} />
        </div>
        <SidebarItem icon="24.trash.outline" label="Trash" selected={is("trash")} onClick={() => go({ kind: "trash" })} onContextMenu={onTrashMenu} />
      </div>
      <SidebarDivider />
      <SidebarHeader title="Starred" open={starredOpen} onOpenChange={onStarredOpen} />
      {starredOpen && (
        <div className={styles.navGroup}>
          {starredFolders.map((f) => (
            <SidebarItem key={f.id} icon={<FolderGlyph color={f.color} />} label={f.name} selected={location.kind === "folder" && location.folderId === f.id} onClick={() => go({ kind: "folder", folderId: f.id })} onContextMenu={(e) => onFolderMenu(e, f)} />
          ))}
          {starredFiles.map((f) => (
            <SidebarItem key={f.fileKey} icon={<FileKindIcon />} label={f.name} onClick={() => onOpenFile(f.fileKey)} onContextMenu={(e) => onFileMenu(e, f)} />
          ))}
        </div>
      )}
    </nav>
  );
}
