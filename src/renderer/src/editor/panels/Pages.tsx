/**
 * The Pages section (live capture: the header's title at 16, Find and "Add new page" at 180 / 208; rows on a 32
 * pitch, the current one highlighted with its name 550; an 8px "Resize handle" on the line under the list). Click
 * goes to a page, double-click renames it, a new page opens its rename, the context menu is live Figma's (menus.ts
 * pageMenu: Copy link to page │ Rename page, Duplicate page │ Move up / down │ Delete page), and a drag reorders. An empty page whose name starts with a dash is a divider (help "Create and manage
 * pages"): a line, not a page to go to. Find (⌘F) opens Find and replace in place of Pages and Layers.
 */
import { useRef, useState } from "react";
import { ContextMenu, IconButton, PageRow, PanelSection, ResizeHandle, showToast } from "@/ds";
import { Status } from "@/engine/abi";
import { useCurrentPage } from "@/engine/hooks";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { command, shortcutOf } from "../commands";
import { openFind } from "../find";
import { pageMenu, runPageMenuItem } from "../menus";
import { usePages, useUI } from "../hooks";
import styles from "./Panels.module.css";

const PAGE_PITCH = 32;
/** The list's height before it scrolls, until the divider is dragged (Figma lets the Pages list grow with its pages up to a cap) */
const DEFAULT_CAP = 0.4;

/** "Add new page": the new page, its name in a rename field (Figma: "Give your new page a name"). */
export function createPage(ed: EditorController): void {
  const before = new Set(ed.engine.pages().map((p) => p.guid));
  if (ed.engine.command("CREATE_PAGE") === Status.E_UNSUPPORTED) {
    showToast({ message: "Adding pages needs the engine's page commands" });
    return;
  }
  const made = ed.engine.pages().find((p) => !before.has(p.guid));
  if (made) ed.ui.set({ railTab: "file", find: null, renaming: { kind: "page", id: made.guid } });
}

/** Is the page a divider: empty, and named only with dashes or asterisks ("---")? Live Figma: "---" is a
 *  divider, "- hyphen page" and "– Divider test" are ordinary pages (behaviour/pages.md #1). */
export function isDividerName(name: string): boolean {
  return /^[-–—*\s]+$/.test(name) && name.trim().length > 0;
}

export function Pages() {
  const ed = useEditor();
  const pages = usePages();
  const current = useCurrentPage(ed.store);
  const renaming = useUI((s) => (s.renaming?.kind === "page" ? s.renaming.id : null));
  const height = useUI((s) => s.pagesHeight ?? null);
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; page: Guid } | null>(null);
  const [drag, setDrag] = useState<{ page: Guid; index: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // Dividers: only pages named like one are read (their child count), and only those that are empty count.
  const empty = (page: Guid) => (ed.engine.readNode(page, { childIds: true })?.childIds?.length ?? 0) === 0;
  const dividers = new Set(pages.filter((p) => isDividerName(p.name) && empty(p.guid)).map((p) => p.guid));

  const rename = (page: Guid, name: string | null) => {
    ed.ui.set({ renaming: null });
    if (name && name !== pages.find((p) => p.guid === page)?.name) ed.setProps([page], { name }, "Rename page");
  };

  // Drag to reorder: past 4px the row follows the pointer; the drop index counts the other pages.
  const startDrag = (e: React.PointerEvent, page: Guid) => {
    if (e.button !== 0 || renaming) return;
    const startY = e.clientY;
    let index: number | null = null;
    const move = (ev: PointerEvent) => {
      if (index === null && Math.abs(ev.clientY - startY) < 4) return;
      const box = list.current?.getBoundingClientRect();
      if (!box) return;
      index = Math.max(0, Math.min(pages.length - 1, Math.round((ev.clientY - box.top + (list.current?.scrollTop ?? 0) - PAGE_PITCH / 2) / PAGE_PITCH)));
      setDrag({ page, index });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (index === null) return;
      const from = pages.findIndex((p) => p.guid === page);
      if (from >= 0 && index !== from) ed.engine.moveNodes([page], "0:0", index);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const find = command("edit.find");
  // The divider under the list: its height, from one row up to what leaves the layers room.
  const maxHeight = Math.max(PAGE_PITCH, Math.round(window.innerHeight * 0.7));
  const natural = pages.length * PAGE_PITCH;
  const shown = height ?? Math.min(natural, Math.round(window.innerHeight * DEFAULT_CAP));

  return (
    <PanelSection
      className={styles.pages}
      title="Pages"
      collapsible
      open={open}
      onOpenChange={(o) => setOpen(o)}
      pad="none"
      actions={
        <span className={styles.pageActions}>
          <IconButton icon="24.search.small" label={find.label} shortcut={shortcutOf(find)} tone="secondary" data-open-find="" onClick={() => openFind(ed)} />
          <IconButton icon="24.plus.small" label="Add new page" tone="secondary" onClick={() => createPage(ed)} />
        </span>
      }
    >
      <div ref={list} className={styles.pageList} style={height !== null ? { height: `calc(${shown}px + var(--ds-space-2))`, maxHeight: "none" } : undefined} role="listbox" aria-label="Pages" data-keys="panel">
        {pages.map((p) => (
          <PageRow
            key={p.guid}
            id={p.guid}
            name={p.name}
            current={p.guid === current}
            divider={dividers.has(p.guid)}
            renaming={renaming === p.guid}
            tabIndex={p.guid === current ? 0 : -1}
            className={drag?.page === p.guid ? styles.pageDragging : undefined}
            style={drag?.page === p.guid ? { transform: `translateY(${(drag.index - pages.findIndex((q) => q.guid === p.guid)) * PAGE_PITCH}px)` } : undefined}
            onSelect={() => {
              if (p.guid !== current) ed.engine.setCurrentPage(p.guid);
            }}
            onPointerDown={(e) => startDrag(e, p.guid)}
            onDoubleClick={() => ed.ui.set({ renaming: { kind: "page", id: p.guid } })}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ at: { x: e.clientX, y: e.clientY }, page: p.guid });
            }}
            onRename={(name) => rename(p.guid, name)}
          />
        ))}
      </div>
      {open && (
        <ResizeHandle
          side="bottom"
          role="separator"
          aria-hidden={false}
          aria-label="Resize handle"
          data-pages-resize=""
          value={shown}
          min={PAGE_PITCH}
          max={maxHeight}
          defaultValue={Math.min(natural, Math.round(window.innerHeight * DEFAULT_CAP))}
          onChange={(px, info) => ed.ui.set({ pagesHeight: info.final && px === Math.min(natural, Math.round(window.innerHeight * DEFAULT_CAP)) ? null : px })}
        />
      )}
      {menu && <ContextMenu at={menu.at} entries={pageMenu(ed, menu.page)} label="Page" context onSelect={(id) => void runPageMenuItem(ed, menu.page, id)} onClose={() => setMenu(null)} />}
    </PanelSection>
  );
}
