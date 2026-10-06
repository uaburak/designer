import { useMemo, useState } from "react";
import { Breadcrumb } from "../components/Breadcrumb";
import { InlineEdit } from "../components/InlineEdit";
import { CollectionView } from "../components/CollectionView";
import { ListHeader, ListRow, nextSort, type ListColumn, type ListSort } from "../components/ListView";
import { FolderCard, FolderGlyph } from "../components/FolderCard";
import { FileCard, FileKindIcon } from "../components/FileCard";
import { Banner } from "../components/Banner";
import { Skeleton } from "../components/Misc";
import { SegmentedControl } from "../components/SegmentedControl";
import { ContextMenu, type MenuEntry } from "../components/Menu";
import { showToast } from "../components/Toast";
import { useSelection } from "../util/selection";
import { FOLDER_COLOR_IDS, FOLDER_COLOR_LABEL, folderColor } from "../util/folderColor";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { formatEdited } from "../util/time";
import { Cell, Comp, noop, Row } from "./parts";
import styles from "./Gallery.module.css";

const NOW = Date.UTC(2026, 9, 6, 15, 5);
const DAY = 86_400_000;

/** A stand-in thumbnail: a frame with a few blocks, in one hue. */
export function demoThumb(hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="268" height="151" viewBox="0 0 268 151"><rect width="268" height="151" fill="hsl(${hue} 30% 92%)"/><rect x="54" y="22" width="160" height="107" rx="4" fill="#fff"/><rect x="66" y="34" width="70" height="8" rx="2" fill="hsl(${hue} 70% 55%)"/><rect x="66" y="50" width="136" height="44" rx="3" fill="hsl(${hue} 60% 85%)"/><rect x="66" y="102" width="40" height="14" rx="3" fill="hsl(${hue} 70% 55%)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

type Item = { id: string; kind: "file" | "folder"; title: string; edited: number; where: string; color?: string; hue: number };
const ITEMS: Item[] = [
  { id: "clients", kind: "folder", title: "Clients", edited: NOW - 2 * DAY, where: "Drafts", color: "#9747ff", hue: 270 },
  { id: "archive", kind: "folder", title: "Archive", edited: NOW - 40 * DAY, where: "Drafts", hue: 0 },
  { id: "portfolio", kind: "file", title: "Portfolio", edited: NOW - 34 * 60_000, where: "Drafts", hue: 205 },
  { id: "atlas", kind: "file", title: "Case study — Atlas", edited: NOW - 3 * DAY, where: "Clients", hue: 150 },
  { id: "icons", kind: "file", title: "Icons", edited: NOW - 5 * DAY, where: "Drafts", hue: 30 },
  { id: "brand", kind: "file", title: "Brand", edited: NOW - 31 * DAY, where: "Clients", hue: 330 },
];

const FILE_MENU: MenuEntry[] = [
  { id: "open", label: "Open" },
  { id: "open-tab", label: "Open in new tab" },
  "-",
  { id: "rename", label: "Rename" },
  { id: "duplicate", label: "Duplicate" },
  { id: "move", label: "Move to…" },
  { id: "star", label: "Add to starred" },
  "-",
  { id: "trash", label: "Move to trash" },
];

const COLUMNS: ListColumn[] = [
  { id: "name", label: "Name", sortable: true },
  { id: "where", label: "Location", width: 160 },
  { id: "edited", label: "Last modified", width: 160, sortable: true },
];

/** Home's file browser, live: grid or list, ⌘/⇧-click, arrows, ⌘A, Esc, marquee, rename, context menu, trash with Undo. */
function LiveBrowser() {
  const [items, setItems] = useState(ITEMS);
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState<ListSort>({ column: "edited", direction: "descending" });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const sorted = useMemo(() => {
    const dir = sort.direction === "ascending" ? 1 : -1;
    const by = sort.column === "name" ? (a: Item, b: Item) => a.title.localeCompare(b.title) : (a: Item, b: Item) => a.edited - b.edited;
    return [...items].sort((a, b) => (a.kind === b.kind ? by(a, b) * dir : a.kind === "folder" ? -1 : 1));
  }, [items, sort]);
  const order = useMemo(() => sorted.map((i) => i.id), [sorted]);
  const sel = useSelection(order);
  const [marqueeBase, setMarqueeBase] = useState<string[] | null>(null);

  const rename = (id: string, name: string | null) => {
    setRenaming(null);
    if (name) setItems((all) => all.map((i) => (i.id === id ? { ...i, title: name } : i)));
  };
  const trash = () => {
    const gone = items.filter((i) => sel.isSelected(i.id));
    if (!gone.length) return;
    setItems((all) => all.filter((i) => !sel.isSelected(i.id)));
    sel.clear();
    showToast({ message: gone.length === 1 ? `"${gone[0].title}" moved to trash` : `${gone.length} files moved to trash`, action: { label: "Undo", onAction: () => setItems((all) => [...all, ...gone]) } });
  };
  const common = (i: Item) => ({
    onSelect: (e: React.MouseEvent | React.KeyboardEvent) => sel.select(i.id, e),
    onOpen: () => showToast({ message: `Open "${i.title}"` }),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      if (!sel.isSelected(i.id)) sel.select(i.id);
      setMenu({ x: e.clientX, y: e.clientY });
    },
  });

  return (
    <div className={styles.browser}>
      <div className={styles.browserBar}>
        <Breadcrumb items={[{ id: "team", label: "burakkoc.net" }, { id: "drafts", label: "Drafts" }]} onNavigate={noop} menu={[{ id: "new-folder", label: "New folder" }]} onMenuSelect={noop} />
        <span className={styles.grow} />
        <span className={styles.cellLabel}>{sel.selected.length ? `${sel.selected.length} selected` : "Drag on empty space to select"}</span>
        <SegmentedControl label="View" value={layout} onChange={(v) => setLayout(v as "grid" | "list")} options={[{ value: "grid", icon: "24.view.grid", tooltip: "Grid view" }, { value: "list", icon: "24.view.list", tooltip: "List view" }]} />
      </div>
      <CollectionView
        layout={layout}
        label="Files"
        className={styles.browserBody}
        header={<ListHeader columns={COLUMNS} sort={sort} onSort={(c) => setSort(nextSort(sort, c, c === "edited" ? "descending" : "ascending"))} />}
        onNavigate={(id, extend) => sel.extendTo(id, extend)}
        onSelectAll={sel.selectAll}
        onClearSelection={sel.clear}
        onDelete={trash}
        onMarquee={(ids, { additive, final }) => {
          const base = additive ? (marqueeBase ?? sel.selected) : [];
          if (!final && marqueeBase === null) setMarqueeBase(sel.selected);
          sel.set([...base, ...ids]);
          if (final) setMarqueeBase(null);
        }}
      >
        {sorted.map((i) =>
          layout === "grid" ? (
            i.kind === "folder" ? (
              <FolderCard key={i.id} id={i.id} title={i.title} subtitle={`${items.filter((f) => f.where === i.title).length} files`} color={i.color} thumbnails={items.filter((f) => f.where === i.title).map((f) => demoThumb(f.hue))} selected={sel.isSelected(i.id)} renaming={renaming === i.id} onRename={(n) => rename(i.id, n)} {...common(i)} />
            ) : (
              <FileCard key={i.id} id={i.id} title={i.title} subtitle={formatEdited(i.edited, NOW)} thumbnail={demoThumb(i.hue)} selected={sel.isSelected(i.id)} renaming={renaming === i.id} onRename={(n) => rename(i.id, n)} onStar={noop} {...common(i)} />
            )
          ) : (
            <ListRow
              key={i.id}
              id={i.id}
              columns={COLUMNS}
              selected={sel.isSelected(i.id)}
              cells={{
                name: (
                  <>
                    {i.kind === "folder" ? <FolderGlyph color={i.color} size={16} /> : <FileKindIcon />}
                    <InlineEdit label="Rename" value={i.title} editing={renaming === i.id} onCommit={(n) => rename(i.id, n)} onCancel={() => setRenaming(null)} />
                  </>
                ),
                where: <span>{i.where}</span>,
                edited: <span>{formatEdited(i.edited, NOW)}</span>,
              }}
              {...common(i)}
            />
          ),
        )}
      </CollectionView>
      {menu && (
        <ContextMenu
          entries={FILE_MENU}
          at={menu}
          onClose={() => setMenu(null)}
          onSelect={(id) => {
            setMenu(null);
            if (id === "rename") setRenaming(sel.selected[0] ?? null);
            else if (id === "trash") trash();
            else showToast({ message: `${id}: not in this demo` });
          }}
        />
      )}
    </div>
  );
}

function LiveInlineEdit() {
  const [name, setName] = useState("Logo.svg");
  const [editing, setEditing] = useState(false);
  return (
    <div style={{ width: 200, font: "var(--ds-font-body-medium-strong)" }}>
      <InlineEdit label="Rename" value={name} editing={editing} editOnDoubleClick select="name" onEditingChange={setEditing} onCommit={setName} />
    </div>
  );
}

/** A dialog opened from a context menu item: it takes the column's theme, not the menu's dark. */
function MenuToDialog() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState(false);
  return (
    <div className={styles.stage} style={{ width: 220, height: 80 }} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
      <span className={styles.cellLabel}>Right-click → Delete…</span>
      {menu && <ContextMenu at={menu} entries={[{ id: "delete", label: "Delete…" }]} onClose={() => setMenu(null)} onSelect={() => setDialog(true)} />}
      <Dialog title="Delete folder?" open={dialog} onClose={() => setDialog(false)} footer={<><Button variant="secondary" onClick={() => setDialog(false)}>Cancel</Button><Button variant="destructive" onClick={() => setDialog(false)}>Delete</Button></>}>
        "Clients" and its 4 files move to the trash.
      </Dialog>
    </div>
  );
}

export function BrowserDemos() {
  return (
    <>
      <Comp name="Breadcrumb" note="Ancestors are quiet buttons; the current place may open its own menu; long paths fold their middle.">
        <Row>
          <Cell id="Breadcrumb/default/large/default"><Breadcrumb items={[{ id: "t", label: "burakkoc.net" }, { id: "c", label: "Clients" }, { id: "a", label: "Acme" }]} onNavigate={noop} /></Cell>
          <Cell id="Breadcrumb/menu/large/default"><Breadcrumb items={[{ id: "d", label: "Drafts" }, { id: "c", label: "Clients", icon: <FolderGlyph size={16} /> }]} onNavigate={noop} menu={[{ id: "rename", label: "Rename" }]} onMenuSelect={noop} /></Cell>
          <Cell id="Breadcrumb/folded/default/default"><Breadcrumb size="default" items={["burakkoc.net", "Clients", "Acme", "2026", "Q4 launch"].map((l) => ({ id: l, label: l }))} onNavigate={noop} /></Cell>
        </Row>
      </Comp>

      <Comp name="InlineEdit" note="Rename in place, in the text's own font: Enter or leaving keeps, Esc puts back. Double-click the live one.">
        <Row>
          <Cell id="InlineEdit/default/default/live" label="live · double-click"><LiveInlineEdit /></Cell>
          <Cell id="InlineEdit/default/default/editing"><div style={{ width: 200 }}><InlineEdit label="Rename" value="Case study — Atlas" editing onCommit={noop} /></div></Cell>
        </Row>
      </Comp>

      <Comp name="FolderCard / ListRow / Skeleton" note="A folder shows up to four of its files; drop targets get the ring.">
        <Row>
          <Cell id="FolderCard/default/default/default"><FolderCard id="f1" title="Clients" subtitle="4 files" thumbnails={[205, 150, 30, 330].map(demoThumb)} onStar={noop} /></Cell>
          <Cell id="FolderCard/empty/default/hover"><FolderCard id="f2" title="Archive" subtitle="No files" color="#9747ff" forceHover onStar={noop} /></Cell>
          <Cell id="FolderCard/default/default/selected"><FolderCard id="f3" title="Two files" subtitle="2 files" thumbnails={[205, 150].map(demoThumb)} selected /></Cell>
          <Cell id="FolderCard/default/default/drop-target"><FolderCard id="f4" title="Drop here" subtitle="1 file" thumbnails={[30].map(demoThumb)} dropTarget /></Cell>
          <Cell id="FolderCard/default/default/renaming"><FolderCard id="f5" title="Renaming" subtitle="No files" renaming onRename={noop} /></Cell>
          <Cell id="FolderCard/starred/default/default"><FolderCard id="f6" title="Starred" subtitle="No files" color={folderColor("teal")} starred onStar={noop} /></Cell>
          <Cell id="FileCard/starred/default/hover"><FileCard id="f7" title="Starred vs not" subtitle="Hover shows the outline on others" thumbnail={demoThumb(205)} starred forceHover onStar={noop} /></Cell>
        </Row>
        <Row label="folder colours (the store's ids)">
          {FOLDER_COLOR_IDS.map((id) => (
            <Cell key={id} id={`FolderGlyph/${id}/24/default`} label={FOLDER_COLOR_LABEL[id]}><FolderGlyph color={folderColor(id)} /></Cell>
          ))}
        </Row>
        <Row label="a dialog from a context menu takes the page's theme">
          <Cell id="Dialog/from-menu/default/live" label="live"><MenuToDialog /></Cell>
        </Row>
        <Row>
          <Cell id="ListRow/default/default/states" width={560}>
            <div style={{ width: 560 }}>
              <ListHeader columns={COLUMNS} sort={{ column: "edited", direction: "descending" }} onSort={noop} />
              <ListRow id="l1" columns={COLUMNS} cells={{ name: <><FolderGlyph size={16} /><span>Clients</span></>, where: <span>Drafts</span>, edited: <span>{formatEdited(NOW - 2 * DAY, NOW)}</span> }} />
              <ListRow id="l2" columns={COLUMNS} forceHover cells={{ name: <><FileKindIcon /><span>Hovered</span></>, where: <span>Drafts</span>, edited: <span>{formatEdited(NOW - 3 * DAY, NOW)}</span> }} />
              <ListRow id="l3" columns={COLUMNS} selected cells={{ name: <><FileKindIcon /><span>Selected</span></>, where: <span>Clients</span>, edited: <span>{formatEdited(NOW - 31 * DAY, NOW)}</span> }} />
              <ListRow id="l4" columns={COLUMNS} dropTarget cells={{ name: <><FolderGlyph size={16} /><span>Drop target</span></>, where: <span>Drafts</span>, edited: <span>{formatEdited(NOW - 40 * DAY, NOW)}</span> }} />
              <ListRow id="l5" columns={COLUMNS} muted cells={{ name: <><FileKindIcon /><span>Muted</span></>, where: <span>Trash</span>, edited: <span>{formatEdited(NOW - 60 * DAY, NOW)}</span> }} />
            </div>
          </Cell>
          <Cell id="Skeleton/default/default/default" width={268}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 268 }}>
              <Skeleton width={268} height={151} radius="medium-large" />
              <Skeleton width={160} height={12} />
              <Skeleton width={100} height={12} />
            </div>
          </Cell>
        </Row>
      </Comp>

      <Comp name="Banner" note="A notice inside a page (Trash, library updates); stays until the page changes.">
        <Row>
          <Cell id="Banner/default/default/default" width={420}><div style={{ width: 420 }}><Banner>Files in trash are kept until you delete them forever.</Banner></div></Cell>
          <Cell id="Banner/brand/default/action" width={420}><div style={{ width: 420 }}><Banner tone="brand" action={{ label: "Review", onClick: noop }} onDismiss={noop}>2 libraries have updates.</Banner></div></Cell>
          <Cell id="Banner/warning/default/default" width={420}><div style={{ width: 420 }}><Banner tone="warning" action={{ label: "Empty trash", onClick: noop }}>Trash has 12 files.</Banner></div></Cell>
          <Cell id="Banner/danger/default/default" width={420}><div style={{ width: 420 }}><Banner tone="danger" onDismiss={noop}>Couldn't load your files.</Banner></div></Cell>
        </Row>
      </Comp>

      <Comp name="CollectionView" note="Home's grid and list, live: ⌘/⇧-click, arrows (⇧ extends), ⌘A, Esc, drag on empty space, right-click → Rename / Move to trash (Undo in the toast).">
        <Row>
          <Cell id="CollectionView/default/default/live" label="live"><LiveBrowser /></Cell>
        </Row>
      </Comp>
    </>
  );
}
