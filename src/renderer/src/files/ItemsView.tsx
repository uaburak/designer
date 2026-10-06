/**
 * The main area's items, folders first: FolderCards and FileCards in a grid, or list rows under a sortable header,
 * all inside the DS's CollectionView (arrow keys, ⌘A, Esc, ⌫, marquee). Items drag onto folders — here or in the
 * sidebar — to move.
 */
import { CollectionView, FileCard, FileKindIcon, FolderCard, folderColor, Icon, InlineEdit, ListHeader, ListRow, type ListColumn, type ListSort } from "@/ds";
import { timeAgo } from "@/ds/util/time";
import type { FileListItem, FolderId } from "@shared/store/types";
import { dateColumn, fileSubtitle, folderSubtitle, type FolderIndex, type Item, type Layout, type Location, type SortKey, type SortOrder } from "./model";
import { FolderGlyph } from "./parts";
import styles from "./Files.module.css";

export interface ItemsViewProps {
  items: Item[];
  layout: Layout;
  location: Location;
  sort: SortKey;
  order: SortOrder;
  folders: FolderIndex;
  selected: ReadonlySet<string>;
  renaming: string | null;
  now: number;
  /** Up to four files of each folder, for its card */
  previews: Readonly<Record<FolderId, FileListItem[]>>;
  starredFolders: ReadonlySet<FolderId>;
  thumbnailUrl: (f: FileListItem) => string | null;
  onItemClick: (e: React.MouseEvent | React.KeyboardEvent, item: Item) => void;
  onOpen: (item: Item) => void;
  onItemMenu: (e: React.MouseEvent, item: Item) => void;
  onBlankMenu: (e: React.MouseEvent) => void;
  onNavigate: (id: string, extend: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDelete: () => void;
  onMarquee: (hits: string[], additive: boolean) => void;
  onRename: (item: Item, name: string | null) => void;
  onStar: (item: Item, on: boolean) => void;
  /** The list header's sort: a column was clicked */
  onSortColumn?: (column: "name" | "date") => void;
  onDragItems: (e: React.DragEvent, item: Item) => void;
  dropOn: FolderId | null;
  folderDrop: (id: FolderId) => Partial<Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop">>;
}

const ITEM = "[data-collection-item]";

export function ItemsView(props: ItemsViewProps) {
  const { items, layout, location, sort, order, folders, selected, renaming, now, previews, starredFolders, thumbnailUrl, onItemClick, onOpen, onItemMenu, onBlankMenu, onNavigate, onSelectAll, onClearSelection, onDelete, onMarquee, onRename, onStar, onSortColumn, onDragItems, dropOn, folderDrop } = props;
  const inTrash = location.kind === "trash";
  const drag = (item: Item) => (inTrash || renaming === item.id ? {} : { draggable: true, onDragStart: (e: React.DragEvent) => onDragItems(e, item) });
  const place = (folderId: FolderId | null) => (folderId === null ? "Drafts" : (folders.get(folderId)?.name ?? ""));
  const date = dateColumn(sort);

  const columns: ListColumn[] = [
    { id: "name", label: "Name", sortable: !inTrash },
    { id: "date", label: inTrash ? "Deleted" : date.label, width: "minmax(0, var(--ds-size-panel))", sortable: !inTrash },
    { id: "place", label: "Location", width: "minmax(0, var(--ds-size-panel))" },
  ];
  const listSort: ListSort | null = inTrash ? null : sort === "alphabetical" ? { column: "name", direction: order === "default" ? "ascending" : "descending" } : { column: "date", direction: order === "default" ? "descending" : "ascending" };

  const nameCell = (item: Item, name: string, icon: React.ReactNode, starred: boolean) => (
    <span className={styles.rowName}>
      {icon}
      <InlineEdit className={styles.rowTitle} label="Rename" value={name} editing={renaming === item.id} onCommit={(n) => onRename(item, n)} onCancel={() => onRename(item, null)} />
      {starred && (
        <span className={styles.rowStar} aria-label="Starred">
          <Icon name="24.star" />
        </span>
      )}
    </span>
  );

  const children = items.map((item) => {
    const events = {
      selected: selected.has(item.id),
      onSelect: (e: React.MouseEvent | React.KeyboardEvent) => onItemClick(e, item),
      onOpen: () => onOpen(item),
      onContextMenu: (e: React.MouseEvent) => onItemMenu(e, item),
    };
    if (item.kind === "folder") {
      const f = item.folder;
      const starred = starredFolders.has(f.id);
      if (layout === "list") {
        return (
          <ListRow
            key={item.id}
            id={item.id}
            columns={columns}
            cells={{ name: nameCell(item, f.name, <FolderGlyph color={f.color} />, starred), date: inTrash && f.trashedAt ? timeAgo(f.trashedAt, now) : folderSubtitle(item, now), place: f.parentId ? place(f.parentId) : "All folders" }}
            dropTarget={dropOn === f.id}
            {...events}
            {...drag(item)}
            {...folderDrop(f.id)}
          />
        );
      }
      return (
        <FolderCard
          key={item.id}
          id={item.id}
          title={f.name}
          subtitle={folderSubtitle(item, now)}
          color={folderColor(f.color)}
          thumbnails={(previews[f.id] ?? []).map(thumbnailUrl).filter((u): u is string => !!u)}
          starred={starred}
          renaming={renaming === item.id}
          dropTarget={dropOn === f.id}
          onRename={(n) => onRename(item, n)}
          onStar={inTrash ? undefined : (on) => onStar(item, on)}
          {...events}
          {...drag(item)}
          {...folderDrop(f.id)}
        />
      );
    }
    const f = item.file;
    if (layout === "list") {
      const t = inTrash ? f.trashedAt : date.value(f);
      return <ListRow key={item.id} id={item.id} columns={columns} cells={{ name: nameCell(item, f.name, <span className={styles.kindCell}><FileKindIcon /></span>, f.starred), date: t ? timeAgo(t, now) : "—", place: place(f.folderId) }} {...events} {...drag(item)} />;
    }
    return (
      <div key={item.id} className={styles.dragWrap} {...drag(item)}>
        <FileCard
          id={item.id}
          title={f.name}
          subtitle={fileSubtitle(f, now)}
          thumbnail={thumbnailUrl(f) ?? undefined}
          starred={f.starred}
          renaming={renaming === item.id}
          onRename={(n) => onRename(item, n)}
          onStar={inTrash ? undefined : (on) => onStar(item, on)}
          {...events}
        />
      </div>
    );
  });

  return (
    <div
      className={styles.content}
      onContextMenu={(e) => {
        if ((e.target as Element).closest(ITEM)) return;
        onBlankMenu(e);
      }}
    >
      <CollectionView
        className={styles.collection}
        layout={layout}
        label={location.kind === "folders" ? "Folders" : "Files"}
        header={layout === "list" ? <ListHeader columns={columns} sort={listSort} onSort={onSortColumn ? (c) => onSortColumn(c as "name" | "date") : undefined} /> : undefined}
        onNavigate={onNavigate}
        onSelectAll={onSelectAll}
        onClearSelection={onClearSelection}
        onDelete={onDelete}
        onMarquee={(ids, info) => onMarquee(ids, info.additive)}
      >
        {children}
      </CollectionView>
    </div>
  );
}
