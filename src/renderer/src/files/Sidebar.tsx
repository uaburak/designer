/**
 * Home's sidebar (Figma's 2026 file browser, as the owner laid it out on 2026-10-19): the account, Search, All projects
 * and Shared (in Recents' place) | the space: signed in, the person's own
 * (their name: Drafts, Trash — docs/cloud.md §2) or an org's (OrgSidebar); signed out, the local team (Drafts, All
 * folders with the folder tree, nested and coloured, Trash) | Starred. Drafts and folders take dropped files.
 */
import { useState, type ReactNode } from "react";
import { Avatar, Badge, FileKindIcon, Icon, SearchField, SidebarDivider, SidebarHeader, SidebarItem } from "@/ds";
import { t, useT } from "@/i18n";
import type { FileKey, FileListItem, Folder, FolderId } from "@shared/store/types";
import type { FolderIndex, Location } from "./model";
import { FolderGlyph, TeamIcon } from "./parts";
import styles from "./Files.module.css";

export interface DropApi {
  /** Is a Home drag over the page (only then do targets light up) */
  accepts(e: React.DragEvent): boolean;
  drop(e: React.DragEvent, dest: FolderId | null): void;
}

export interface SidebarProps {
  ownerName: string;
  /** The account's photo (a data: URL — main fetches Google's), else initials */
  ownerPicture?: string;
  /** The account row's menu (Log in / Log out — docs/multiplayer.md §2); absent: the row is a plain label */
  onAccountMenu?: (e: React.MouseEvent) => void;
  /** At the account row's right: the notifications bell (docs/multiplayer.md §12; live 1.png) */
  accountAccessory?: ReactNode;
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
  /** The space row's chevron (1.png "Anex Softw… ⌄"): the space switcher; absent, a plain label */
  onSpaceMenu?: (e: React.MouseEvent) => void;
  /** The space's icon (§14.16: the org's `iconUrl`); absent: its initial */
  spaceIconUrl?: string | null;
  /** The space row's context menu (the local team's Rename); absent: none */
  onSpaceContextMenu?: (e: React.MouseEvent) => void;
  /** The plan badge at the space row's right (1.png "Professional") */
  spaceBadge?: string;
  /** An organization's entries (OrgSidebar), in place of the local Drafts / All folders / Trash */
  spaceSection?: ReactNode;
  /**
   * The person's own space (docs/cloud.md §2, Figma's Starter layout): their name with the photo, then Drafts and Trash
   * — no folders (personal Drafts are flat). Absent: the local workspace's team with its folders (signed out).
   */
  personal?: { picture?: string };
  /** All projects (in Recents' place): an org's every file the person can open (`all-projects`); outside an org the
   *  person's own files (Drafts). */
  allProjects: Location;
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
  useT();
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
                      aria-label={open ? t("Collapse") : t("Expand")}
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
  useT();
  const { ownerName, ownerPicture, onAccountMenu, accountAccessory, teamName, location, search, onSearch, onSearchExit, go, starredFolders, starredFiles, starredOpen, onStarredOpen, onOpenFile, onFolderMenu, onFileMenu, onAllFoldersMenu, onTrashMenu, dnd, onSpaceMenu, spaceBadge, spaceSection, spaceIconUrl, onSpaceContextMenu, personal } = props;
  // The person's space shows their photo; an org its icon (spaceSection set), the local team its initial
  const spaceIcon = personal && !spaceSection ? <Avatar name={teamName} src={personal.picture} size={16} /> : <TeamIcon name={teamName} iconUrl={spaceIconUrl} />;
  const is = (kind: Location["kind"]) => location.kind === kind;
  return (
    <nav className={styles.sidebar} aria-label={t("File browser")}>
      <div className={styles.accountRow}>
        {onAccountMenu ? (
          <button type="button" className={styles.account} aria-haspopup="menu" aria-label={t("{name}, account", { name: ownerName })} onClick={onAccountMenu}>
            <Avatar name={ownerName} src={ownerPicture} />
            <span className={styles.accountName}>{ownerName}</span>
            <Icon name="16.chevron.down" />
          </button>
        ) : (
          <div className={styles.account}>
            <Avatar name={ownerName} src={ownerPicture} />
            <span className={styles.accountName}>{ownerName}</span>
          </div>
        )}
        {accountAccessory}
      </div>
      <div className={styles.search}>
        <SearchField value={search} onChange={onSearch} size="large" className={styles.searchPill} placeholder={t("Search")} onExit={(r) => r === "escape" && onSearchExit()} />
      </div>
      <div className={styles.navGroup}>
        <DropTarget dest={null} dnd={dnd}>
          {(over) => <SidebarItem icon="24.file" label={t("All projects")} selected={location.kind === props.allProjects.kind} dropTarget={over} onClick={() => go(props.allProjects)} />}
        </DropTarget>
        {/* The owner's Home (2026-10-19): Shared in Recents' place — what others shared with the person, and theirs */}
        <SidebarItem icon="24.person" label={t("Shared")} selected={is("shared")} onClick={() => go({ kind: "shared" })} />
        {/* Ours (docs/studio.md §3.2): the brand and product library, full page */}
        <SidebarItem icon="24.library" label={t("Brands")} selected={is("brands")} onClick={() => go({ kind: "brands" })} />
      </div>
      <SidebarDivider />
      <div className={styles.team} onContextMenu={onSpaceContextMenu}>
        {onSpaceMenu ? (
          <button type="button" className={styles.spaceButton} aria-haspopup="menu" aria-label={t("{name}, switch space", { name: teamName })} onClick={onSpaceMenu}>
            {spaceIcon}
            <span className={styles.teamName}>{teamName}</span>
            <Icon name="16.chevron.down" />
          </button>
        ) : (
          <>
            <Avatar name={teamName} src={personal?.picture} size={16} />
            <span className={styles.teamName}>{teamName}</span>
          </>
        )}
        {spaceBadge && (
          <Badge tone="brand" className={styles.planBadge}>
            {t(spaceBadge)}
          </Badge>
        )}
      </div>
      {spaceSection ?? (
      <div className={styles.navGroup}>
        {!personal && (
          <>
            <SidebarItem icon="24.view.grid" label={t("All folders")} selected={is("folders")} onClick={() => go({ kind: "folders" })} onContextMenu={onAllFoldersMenu} />
            <div role="tree" aria-label={t("Folders")}>
              <FolderTree parent={null} depth={1} props={props} />
            </div>
          </>
        )}
        <SidebarItem icon="24.trash.outline" label={t("Trash")} selected={is("trash")} onClick={() => go({ kind: "trash" })} onContextMenu={onTrashMenu} />
      </div>
      )}
      <SidebarDivider />
      <SidebarHeader title={t("Starred")} open={starredOpen} onOpenChange={onStarredOpen} />
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
