/**
 * The Pages section (live capture: the header's title at 16, Find and "Add new page" at 180 / 208; rows 224 × 24
 * buttons 8 in and 8 apart, the current one highlighted with its name 550; an 8px "Resize handle" on the line under
 * the list). Click
 * goes to a page, double-click renames it, a new page opens its rename, the context menu is live Figma's (menus.ts
 * pageMenu: Copy link to page │ Rename page, Duplicate page │ Move up / down │ Delete page), and a drag reorders. An
 * empty page named like a divider is one (Figma's rules, docs/research/atlas/02-editor-chrome.md §3.5): a line on a 16
 * pitch, not a page to go to — or, "--- Components", a titled one; renaming a divider writes "--- <title>". Find (⌘F)
 * opens Find and replace in place of Pages and Layers.
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
import { t, useT } from "@/i18n";

const PAGE_PITCH = 32;
/** Figma's `pageDividerRowHeight`: a divider's line takes half a page row */
const DIVIDER_PITCH = 16;
/** The list's height before it scrolls, until the divider is dragged (Figma lets the Pages list grow with its pages up to a cap) */
const DEFAULT_CAP = 0.4;

/** "Add new page": the new page, its name in a rename field (Figma: "Give your new page a name"). */
export function createPage(ed: EditorController): void {
  const before = new Set(ed.engine.pages().map((p) => p.guid));
  if (ed.engine.command("CREATE_PAGE") === Status.E_UNSUPPORTED) {
    showToast({ message: t("Adding pages needs the engine's page commands") });
    return;
  }
  const made = ed.engine.pages().find((p) => !before.has(p.guid));
  if (made) ed.ui.set({ railTab: "file", find: null, renaming: { kind: "page", id: made.guid } });
}

/** Figma's divider name: one or more of one of -, –, — or *, or only spaces ("---", "***"). */
const DIVIDER = /^(-+|–+|—+|\*+|\s+)$/;
/** Figma's titled divider: two or more of one of them, then the title ("--- Components") */
const TITLED_DIVIDER = /^(-{2,}|–{2,}|—{2,}|\*{2,})\s*(\S.*?)\s*$/;

/** Is the page, when empty, a divider by its name ("---")? Live Figma: "---" is a divider, "- hyphen page" and
 *  "– Divider test" are ordinary pages (behaviour/pages.md #1). */
export function isDividerName(name: string): boolean {
  return DIVIDER.test(name);
}

/** A titled divider's title ("--- Components" → "Components"); null when the name isn't one (or its title is all dashes). */
export function dividerTitle(name: string): string | null {
  const m = TITLED_DIVIDER.exec(name);
  return m && !DIVIDER.test(m[2]) ? m[2] : null;
}

/** The name a divider renamed to `title` gets (Figma): "--- <title>", the name as typed when it is one already, "---" for none. */
export function dividerName(title: string): string {
  const t = title.trim();
  return t ? (dividerTitle(t) !== null ? t : `--- ${t}`) : "---";
}

export function Pages() {
  useT();
  const ed = useEditor();
  const pages = usePages();
  const current = useCurrentPage(ed.store);
  const renaming = useUI((s) => (s.renaming?.kind === "page" ? s.renaming.id : null));
  const height = useUI((s) => s.pagesHeight ?? null);
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; page: Guid } | null>(null);
  const [drag, setDrag] = useState<{ page: Guid; index: number; dy: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // Dividers: only pages named like one are read (their child count), and only those that are empty count — a plain
  // one ("---", title "") or a titled one ("--- Components").
  const empty = (page: Guid) => (ed.engine.readNode(page, { childIds: true })?.childIds?.length ?? 0) === 0;
  const dividers = new Map<Guid, string>();
  for (const p of pages) {
    const title = isDividerName(p.name) ? "" : dividerTitle(p.name);
    if (title !== null && empty(p.guid)) dividers.set(p.guid, title);
  }

  const rename = (page: Guid, name: string | null) => {
    ed.ui.set({ renaming: null });
    // A divider's field holds its title: the name written back is Figma's "--- <title>".
    const next = name !== null && dividers.has(page) ? dividerName(name) : name;
    if (next && next !== pages.find((p) => p.guid === page)?.name) ed.setProps([page], { name: next }, "Rename page");
  };

  // Drag to reorder: past 4px the row follows the pointer; the drop index counts the other rows whose middle is above it.
  const startDrag = (e: React.PointerEvent, page: Guid) => {
    if (e.button !== 0 || renaming) return;
    const startY = e.clientY;
    const from = pages.findIndex((p) => p.guid === page);
    let index: number | null = null;
    const move = (ev: PointerEvent) => {
      if (index === null && Math.abs(ev.clientY - startY) < 4) return;
      const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-ds="PageRow"]') ?? [])];
      if (!rows.length) return;
      index = rows.filter((el, i) => {
        if (i === from) return false;
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2 < ev.clientY;
      }).length;
      setDrag({ page, index, dy: ev.clientY - startY });
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
  const natural = pages.reduce((h, p) => h + (dividers.get(p.guid) === "" ? DIVIDER_PITCH : PAGE_PITCH), 0);
  const shown = height ?? Math.min(natural, Math.round(window.innerHeight * DEFAULT_CAP));

  return (
    <PanelSection
      className={styles.pages}
      title={t("Pages")}
      collapsible
      open={open}
      onOpenChange={(o) => setOpen(o)}
      pad="none"
      actions={
        <span className={styles.pageActions}>
          <IconButton icon="24.search.small" label={t(find.label)} shortcut={shortcutOf(find)} tone="secondary" data-open-find="" onClick={() => openFind(ed)} />
          <IconButton icon="24.plus.small" label={t("Add new page")} tone="secondary" onClick={() => createPage(ed)} />
        </span>
      }
    >
      <div ref={list} className={styles.pageList} style={height !== null ? { height: `calc(${shown}px + var(--ds-space-2))`, maxHeight: "none" } : undefined} data-keys="panel">
        {pages.map((p) => (
          <PageRow
            key={p.guid}
            id={p.guid}
            name={p.name}
            current={p.guid === current}
            divider={dividers.has(p.guid)}
            dividerTitle={dividers.get(p.guid) || undefined}
            renaming={renaming === p.guid}
            tabIndex={p.guid === current ? 0 : -1}
            className={drag?.page === p.guid ? styles.pageDragging : undefined}
            style={drag?.page === p.guid ? { transform: `translateY(${drag.dy}px)` } : undefined}
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
          data-pages-resize=""
          value={shown}
          min={PAGE_PITCH}
          max={maxHeight}
          defaultValue={Math.min(natural, Math.round(window.innerHeight * DEFAULT_CAP))}
          onChange={(px, info) => ed.ui.set({ pagesHeight: info.final && px === Math.min(natural, Math.round(window.innerHeight * DEFAULT_CAP)) ? null : px })}
        />
      )}
      {menu && <ContextMenu at={menu.at} entries={pageMenu(ed, menu.page)} label={t("Page")} context onSelect={(id) => void runPageMenuItem(ed, menu.page, id)} onClose={() => setMenu(null)} />}
    </PanelSection>
  );
}
