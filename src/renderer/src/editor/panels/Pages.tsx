/**
 * The Pages section: a 40px header (search, "+" = Add page), the pages at a
 * 32 pitch (the current one highlighted). Click goes to a page, double-click
 * renames it, the context menu has Rename / Duplicate / Delete, and a drag
 * reorders (when the engine can move nodes).
 */
import { useRef, useState } from "react";
import { ContextMenu, IconButton, PageRow, PanelSection, SearchField, showToast, type MenuEntry } from "@/ds";
import { CMD_ENABLED, Status } from "@/engine/abi";
import { useCurrentPage } from "@/engine/hooks";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { usePages, useUI } from "../hooks";
import styles from "./Panels.module.css";

const PAGE_PITCH = 32;

const enabled = (ed: EditorController, name: "DELETE_PAGE" | "DUPLICATE_PAGE") => (ed.engine.commandState(name) & CMD_ENABLED) !== 0;

function createPage(ed: EditorController) {
  if (ed.engine.command("CREATE_PAGE") === Status.E_UNSUPPORTED) showToast({ message: "Adding pages needs the engine's page commands" });
}

export function Pages() {
  const ed = useEditor();
  const pages = usePages();
  const current = useCurrentPage(ed.store);
  const search = useUI((s) => s.pageSearch);
  const renaming = useUI((s) => (s.renaming?.kind === "page" ? s.renaming.id : null));
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; page: Guid } | null>(null);
  const [drag, setDrag] = useState<{ page: Guid; index: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = search ? pages.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())) : pages;

  const rename = (page: Guid, name: string | null) => {
    ed.ui.set({ renaming: null });
    if (name && name !== pages.find((p) => p.guid === page)?.name) ed.setProps([page], { name }, "Rename page");
  };

  const menuEntries = (page: Guid): MenuEntry[] => [
    { id: "rename", label: "Rename" },
    { id: "duplicate", label: "Duplicate", disabled: !enabled(ed, "DUPLICATE_PAGE") },
    { id: "delete", label: "Delete", disabled: pages.length < 2 || !enabled(ed, "DELETE_PAGE") },
    "-",
    { id: "copy-link", label: "Copy link to page", disabled: true },
    { id: "go", label: "Go to page", disabled: page === current },
  ];

  const onMenu = (id: string, page: Guid) => {
    if (id === "rename") ed.ui.set({ renaming: { kind: "page", id: page } });
    else if (id === "duplicate") ed.engine.command("DUPLICATE_PAGE", { page });
    else if (id === "delete") ed.engine.command("DELETE_PAGE", { page });
    else if (id === "go") ed.engine.setCurrentPage(page);
  };

  // Drag to reorder: past 4px the row follows the pointer; the drop index counts the other pages.
  const startDrag = (e: React.PointerEvent, page: Guid) => {
    if (e.button !== 0 || search || renaming) return;
    const startY = e.clientY;
    let index: number | null = null;
    const move = (ev: PointerEvent) => {
      if (index === null && Math.abs(ev.clientY - startY) < 4) return;
      const box = list.current?.getBoundingClientRect();
      if (!box) return;
      index = Math.max(0, Math.min(pages.length - 1, Math.round((ev.clientY - box.top - PAGE_PITCH / 2) / PAGE_PITCH)));
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

  const header = search !== null ? (
    <SearchField
      className={styles.pageSearch}
      value={search}
      autoFocus
      placeholder="Search pages"
      onChange={(v) => ed.ui.set({ pageSearch: v })}
      onExit={(r) => {
        if (r === "escape") ed.ui.set({ pageSearch: null });
      }}
    />
  ) : null;

  return (
    <PanelSection
      className={styles.pages}
      title="Pages"
      collapsible
      open={open}
      onOpenChange={(o) => setOpen(o)}
      pad="none"
      actions={
        <>
          {header}
          {search === null && <IconButton icon="24.search.small" label="Search pages" tone="secondary" onClick={() => ed.ui.set({ pageSearch: "" })} />}
          <IconButton icon="24.plus.small" label="Add new page" tone="secondary" onClick={() => createPage(ed)} />
        </>
      }
    >
      <div ref={list} className={styles.pageList} role="listbox" aria-label="Pages">
        {shown.map((p) => (
          <PageRow
            key={p.guid}
            id={p.guid}
            name={p.name}
            current={p.guid === current}
            divider={/^[-–—*\s]+$/.test(p.name) && p.name.trim().length > 0}
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
        {search && !shown.length && <div className={styles.noResults}>No pages match “{search}”</div>}
      </div>
      {menu && <ContextMenu at={menu.at} entries={menuEntries(menu.page)} label="Page" onSelect={(id) => onMenu(id, menu.page)} onClose={() => setMenu(null)} />}
    </PanelSection>
  );
}
