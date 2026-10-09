/**
 * The Local variables window (UI3, R3-21; opened from the right panel's
 * "Local variables" with nothing selected, View ▸ Local variables): edge to
 * edge over the canvas. The sidebar lists the collections ("+" Create
 * collection; double-click renames; right click Rename / Duplicate / Delete)
 * and the selected one's groups ("All variables", then the slash-path tree).
 * The table: Name, one column per mode (the first is the default; double-click
 * renames; right click Rename / Duplicate / Set as default / Move left / Move
 * right / Delete mode), "+" adds a mode. Rows: the type's glyph and the name
 * (double-click renames, a slash moves it into groups), a value per mode
 * edited in place (ValueEditor: colours, numbers, strings, booleans, aliases),
 * Edit variable on hover. Click / ⌘-click / ⇧-click select, drag reorders
 * (dropped next to a row of another group, it moves into that group),
 * ⌫ deletes, ⇧↵ duplicates, right click: Edit variable, Rename, Duplicate,
 * Delete, New group with selection. "+ Create variable" with the type menu.
 * Round 5 (help "Create and manage variables", "Extend a variable collection"):
 * Extend collection (the extension lists its root's variables with its own
 * modes; edits override, in blue, "Reset change"), Reorder collections / Sort A
 * to Z, Filter by type, Edit variables on a selection, Copy / Paste, Ungroup
 * and Duplicate group.
 * Esc or × closes it; ⌘Z / ⇧⌘Z undo and redo inside it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Button, ContextMenu, EmptyState, Icon, IconButton, InlineEdit, MenuButton, SearchField, cx, type MenuEntry } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { runEditorCommand } from "../../commands";
import { useLocalAssets, useUI } from "../../hooks";
import { formatLiteral, groupTree, inGroup, matchesQuery, resolveVariable, rootOf, splitName, valueIn, VAR_TYPE_ICON, VAR_TYPE_LABEL, VAR_TYPES, type Collection, type GroupNode, type Variable, type VarType } from "../../model/variables";
import {
  addMode,
  createCollection,
  createVariable,
  deleteCollection,
  deleteGroup,
  deleteMode,
  deleteVariables,
  duplicateCollection,
  duplicateGroup,
  duplicateVariables,
  extendCollection,
  groupVariables,
  moveGroup,
  moveMode,
  moveVariables,
  pasteVariables,
  renameCollection,
  renameGroup,
  renameMode,
  renameVariable,
  resetOverride,
  setDefaultMode,
  ungroupVariables,
} from "../../variables";
import { clipboardText, exportModes, importIntoMode, importModes, pasteClipboardVariables, readClipboardText } from "../../variablesIO";
import { EditVariablesPopover, ReorderCollectionsPopover } from "./CollectionTools";
import { EditVariablePopover } from "./EditVariable";
import { ValueEditor } from "./ValueEditor";
import styles from "./LocalVariables.module.css";

type Renaming = { kind: "variable" | "mode" | "collection" | "group"; id: string } | null;
type Row = { kind: "group"; path: string; label: string } | { kind: "variable"; v: Variable };
type Menu = { x: number; y: number; entries: MenuEntry[]; pick: (id: string) => void } | null;

/**
 * Variables copied with "Copy": their ids (a paste in this file keeps aliases between them), and the system
 * clipboard's text (variablesIO.ts) — another file's window pastes from there.
 */
let copiedVariables: Guid[] = [];
let copiedText = "";

/** "Copy": the ids kept, and the variables put on the system clipboard as text. */
function rememberCopy(ed: ReturnType<typeof useEditor>, ids: Guid[]) {
  copiedVariables = ids;
  copiedText = clipboardText(ed, ids);
  void navigator.clipboard?.writeText?.(copiedText).catch(() => {});
}

/** Reads the system clipboard's text (the desktop's clipboard, else the browser's), "" when it can't. */
async function clipboardRead(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? "";
  } catch {
    return "";
  }
}

/** Opens the system's file picker for DTCG files. */
function pickJsonFiles(multiple: boolean): Promise<{ name: string; text: string }[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = multiple;
    input.onchange = async () => resolve(await Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name, text: await f.text() }))));
    input.click();
  });
}

export function LocalVariables() {
  const ed = useEditor();
  const a = useLocalAssets();
  const copyVariables = (ids: Guid[]) => rememberCopy(ed, ids);
  // Minimize (a smaller, resizable modal) / Expand (the whole window again); Toggle sidebar.
  const [minimized, setMinimized] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [groupDrop, setGroupDrop] = useState<{ path: string; where: "before" | "after" | "into" } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [collectionId, setCollectionId] = useState<Guid | null>(null);
  const [group, setGroup] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<Guid>>(new Set());
  const [anchor, setAnchor] = useState<Guid | null>(null);
  const [renaming, setRenaming] = useState<Renaming>(null);
  const [edit, setEdit] = useState<{ id: Guid; anchor: HTMLElement } | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [drop, setDrop] = useState<{ id: Guid; side: "before" | "after" } | null>(null);
  const [typeFilter, setTypeFilter] = useState<VarType | null>(null);
  const [reorder, setReorder] = useState<HTMLElement | null>(null);
  // Groups ▸ Collapse groups (live rail-variables-table.txt): the nested groups folded under their parents.
  const [groupsCollapsed, setGroupsCollapsed] = useState(false);
  const fileName = useUI((s) => s.fileName);
  const [bulk, setBulk] = useState<{ ids: Guid[]; anchor: HTMLElement | DOMRect } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const collection = a.collections.find((c) => c.id === collectionId) ?? a.collections[0] ?? null;
  // An extended collection: its root's variables, its own modes, values only (Figma: no new variables or modes).
  const extended = !!collection?.parent;
  const parent = collection?.parentCollection ?? null;

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  const inCollection = useMemo(() => {
    if (!collection) return [];
    const owner = rootOf(collection).id;
    return [...a.variables, ...a.library.variables].filter((v) => v.collection === owner);
  }, [a, collection]);
  const tree = useMemo(() => groupTree(inCollection.map((v) => v.name)), [inCollection]);
  const shown = inCollection.filter(
    (v) => (!typeFilter || v.type === typeFilter) && inGroup(v.name, group) && matchesQuery(v, query, collection ? formatLiteral(v.type, resolveVariable(v.id, a.lookup)) : "")
  );
  // A group's variables sit together (where the group first appears); the selected group's own ones first.
  const firstAt = new Map<string, number>();
  shown.forEach((v, i) => {
    const g = splitName(v.name).group;
    if (!firstAt.has(g)) firstAt.set(g, g === group ? -1 : i);
  });
  const ordered = shown.map((v, i) => ({ v, i, at: firstAt.get(splitName(v.name).group)! })).sort((x, y) => x.at - y.at || x.i - y.i).map((x) => x.v);
  const rows: Row[] = [];
  let lastGroup: string | null = null;
  for (const v of ordered) {
    const g = splitName(v.name).group;
    if (g !== lastGroup && g !== group) rows.push({ kind: "group", path: g, label: (group ? g.slice(group.length + 1) : g).split("/").join(" / ") });
    lastGroup = g;
    rows.push({ kind: "variable", v });
  }
  const order = ordered.map((v) => v.id);

  const close = () => ed.ui.set({ variablesOpen: false });
  const select = (id: Guid, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (e.shiftKey && anchor && order.includes(anchor)) {
      const [i, j] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
      setSelected(new Set(order.slice(i, j + 1)));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
    } else setSelected(new Set([id]));
    setAnchor(id);
  };
  const chosen = () => (selected.size ? order.filter((id) => selected.has(id)) : []);

  const create = (type: VarType) => {
    if (!collection) return;
    const id = createVariable(ed, collection.id, type, group);
    if (id) {
      setSelected(new Set([id]));
      setAnchor(id);
      setRenaming({ kind: "variable", id });
    }
  };

  const variableMenu = (v: Variable, x: number, y: number, target: HTMLElement) => {
    const ids = selected.has(v.id) ? chosen() : [v.id];
    if (!selected.has(v.id)) setSelected(new Set([v.id]));
    const many = ids.length > 1;
    if (extended && collection) {
      // An extended collection overrides values only: "Reset changes" brings back every value of the parent's.
      const changed = ids.filter((i) => collection.overrides.has(i));
      setMenu({
        x,
        y,
        entries: [{ id: "copy", label: "Copy", shortcut: "⌘C" }, "-", { id: "reset", label: many ? "Reset changes" : "Reset change", disabled: !changed.length }],
        pick: (id) => {
          if (id === "copy") copyVariables(ids);
          if (id === "reset") resetOverride(ed, collection.id, changed, null);
        },
      });
      return;
    }
    setMenu({
      x,
      y,
      entries: [
        { id: "edit", label: many ? "Edit variables" : "Edit variable" },
        { id: "rename", label: "Rename", disabled: many },
        { id: "duplicate", label: many ? "Duplicate variables" : "Duplicate", shortcut: "⇧↵" },
        { id: "group", label: "New group with selection" },
        "-",
        { id: "copy", label: "Copy", shortcut: "⌘C" },
        { id: "paste", label: "Paste", shortcut: "⌘V" },
        "-",
        { id: "delete", label: many ? `Delete ${ids.length} variables` : "Delete variable" },
      ],
      pick: (id) => {
        if (id === "edit" && many) setBulk({ ids, anchor: target });
        else if (id === "edit") setEdit({ id: v.id, anchor: target });
        if (id === "copy") copyVariables(ids);
        if (id === "paste") void paste();
        if (id === "rename") setRenaming({ kind: "variable", id: v.id });
        if (id === "duplicate") setSelected(new Set(duplicateVariables(ed, ids)));
        if (id === "group") {
          const path = groupVariables(ed, ids);
          if (path) setRenaming({ kind: "group", id: path });
        }
        if (id === "delete") {
          deleteVariables(ed, ids);
          setSelected(new Set());
        }
      },
    });
  };

  const paste = async () => {
    if (!collection || extended) return;
    // What this window copied (aliases between the copies kept), else another file's copy on the system clipboard.
    const text = await clipboardRead();
    const clip = text && text !== copiedText ? readClipboardText(text) : null;
    const made = clip ? pasteClipboardVariables(ed, clip, collection.id, group) : copiedVariables.length ? pasteVariables(ed, copiedVariables, collection.id, group) : [];
    if (made.length) setSelected(new Set(made));
  };

  const modeMenu = (c: Collection, modeId: Guid, x: number, y: number) => {
    const i = c.modes.findIndex((m) => m.id === modeId);
    // An extended collection inherits its parent's modes: names, order and the default come from the parent.
    const inherited = !!c.parent;
    setMenu({
      x,
      y,
      entries: [
        { id: "rename", label: "Rename mode", disabled: inherited },
        { id: "duplicate", label: "Duplicate mode", disabled: inherited },
        { id: "default", label: "Set as default", disabled: inherited || i === 0 },
        "-",
        { id: "left", label: "Move column left", disabled: inherited || i === 0 },
        { id: "right", label: "Move column right", disabled: inherited || i === c.modes.length - 1 },
        "-",
        { id: "import", label: "Import mode" },
        { id: "export", label: "Export mode" },
        "-",
        { id: "delete", label: "Delete mode", disabled: inherited || c.modes.length < 2 },
      ],
      pick: (id) => {
        if (id === "export") void exportModes(ed, c.id, [modeId]);
        if (id === "import")
          void pickJsonFiles(false).then((files) => {
            if (files[0]) importIntoMode(ed, c.id, modeId, files[0]);
          });
        if (id === "rename") setRenaming({ kind: "mode", id: modeId });
        if (id === "duplicate") addMode(ed, c.id, modeId);
        if (id === "default") setDefaultMode(ed, c.id, modeId);
        if (id === "left") moveMode(ed, c.id, modeId, -1);
        if (id === "right") moveMode(ed, c.id, modeId, 1);
        if (id === "delete") deleteMode(ed, c.id, modeId);
      },
    });
  };

  const collectionMenu = (c: Collection, x: number, y: number) =>
    setMenu({
      x,
      y,
      entries: [
        { id: "rename", label: "Rename collection" },
        { id: "duplicate", label: "Duplicate collection", disabled: !!c.parent },
        { id: "extend", label: "Extend collection" },
        { id: "reorder", label: "Reorder collections", disabled: a.collections.length < 2 },
        "-",
        { id: "export", label: "Export modes" },
        "-",
        { id: "delete", label: "Delete collection" },
      ],
      pick: (id) => {
        if (id === "export") void exportModes(ed, c.id);
        if (id === "rename") setRenaming({ kind: "collection", id: c.id });
        if (id === "duplicate") {
          const copy = duplicateCollection(ed, c.id);
          if (copy) setCollectionId(copy);
        }
        if (id === "extend") {
          const ext = extendCollection(ed, c.id);
          if (ext) {
            setCollectionId(ext);
            setGroup("");
            setRenaming({ kind: "collection", id: ext });
          }
        }
        if (id === "reorder") setReorder(root.current?.querySelector<HTMLElement>(`[data-collection="${CSS.escape(c.name)}"]`) ?? null);
        if (id === "delete") {
          deleteCollection(ed, c.id);
          setCollectionId(null);
          setGroup("");
        }
      },
    });

  const groupMenu = (g: GroupNode, x: number, y: number) =>
    setMenu({
      x,
      y,
      entries: [
        { id: "rename", label: "Rename group", disabled: extended },
        { id: "ungroup", label: "Ungroup", disabled: extended },
        { id: "duplicate", label: "Duplicate group", disabled: extended },
        "-",
        { id: "delete", label: "Delete group", disabled: extended },
      ],
      pick: (id) => {
        if (!collection) return;
        if (id === "rename") setRenaming({ kind: "group", id: g.path });
        if (id === "ungroup") {
          ungroupVariables(ed, collection.id, g.path);
          setGroup("");
        }
        if (id === "duplicate") duplicateGroup(ed, collection.id, g.path);
        if (id === "delete") {
          deleteGroup(ed, collection.id, g.path);
          setGroup("");
        }
      },
    });

  // ---- Drag to reorder ----------------------------------------------------------------------------------------------
  const startDrag = (e: ReactPointerEvent, v: Variable) => {
    if (extended || e.button !== 0 || (e.target as Element).closest("input, textarea, button")) return;
    const ids = selected.has(v.id) ? chosen() : [v.id];
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let target: { id: Guid; side: "before" | "after" } | null = null;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      dragging = true;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-variable-row]");
      const id = el?.dataset.variableRow ?? null;
      if (!el || !id || ids.includes(id)) {
        target = null;
      } else {
        const r = el.querySelector("[data-name-cell]")!.getBoundingClientRect();
        target = { id, side: ev.clientY < r.top + r.height / 2 ? "before" : "after" };
      }
      setDrop(target);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrop(null);
      if (!dragging || !target || !collection) return;
      const over = a.lookup.variable(target.id);
      if (!over) return;
      const rest = inCollection.filter((x) => !ids.includes(x.id));
      const at = rest.findIndex((x) => x.id === target!.id) + (target.side === "after" ? 1 : 0);
      moveVariables(ed, ids, rest[at]?.id ?? null, splitName(over.name).group);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- Drag groups in the sidebar: reorder (the top or bottom of a group row) or nest (its middle) ----------------
  const startGroupDrag = (e: ReactPointerEvent, path: string) => {
    if (extended || e.button !== 0 || !collection || (e.target as Element).closest("input")) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let target: { path: string; where: "before" | "after" | "into" } | null = null;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      dragging = true;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-group]");
      const over = el?.dataset.group;
      if (!el || over === undefined || over === path || over.startsWith(`${path}/`)) target = null;
      else if (over === "") target = { path: "", where: "into" };
      else {
        const r = el.getBoundingClientRect();
        const t = (ev.clientY - r.top) / r.height;
        target = { path: over, where: t < 0.25 ? "before" : t > 0.75 ? "after" : "into" };
      }
      setGroupDrop(target);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGroupDrop(null);
      if (!dragging || !target) return;
      if (moveGroup(ed, collection.id, path, target.path, target.where)) setGroup("");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const typing = (e.target as Element).closest("input, textarea, [contenteditable='true']");
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === "KeyZ" && !typing) {
      e.preventDefault();
      runEditorCommand(ed, e.shiftKey ? "edit.redo" : "edit.undo");
      return;
    }
    if (typing || menu) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (selected.size) setSelected(new Set());
      else close();
    } else if (mod && e.code === "KeyC" && selected.size) {
      e.preventDefault();
      copyVariables(chosen());
    } else if (mod && e.code === "KeyV") {
      e.preventDefault();
      void paste();
    } else if (!extended && (e.key === "Backspace" || e.key === "Delete") && selected.size) {
      e.preventDefault();
      deleteVariables(ed, chosen());
      setSelected(new Set());
    } else if (!extended && e.key === "Enter" && e.shiftKey && selected.size) {
      e.preventDefault();
      setSelected(new Set(duplicateVariables(ed, chosen())));
    } else if (mod && e.code === "KeyA") {
      e.preventDefault();
      setSelected(new Set(order));
    }
  };

  // Live (rail-variables-table.txt): Name 200, a 280 column per mode, the rest, then 40 for New variable mode / Edit variable.
  const columns = collection ? `200px repeat(${collection.modes.length}, 280px) minmax(0, 1fr) 40px` : "1fr";
  const createMenu: MenuEntry[] = VAR_TYPES.map((t) => ({ id: t, label: VAR_TYPE_LABEL[t], icon: VAR_TYPE_ICON[t] }));

  const groupRows = (nodes: GroupNode[], depth: number): ReactNode =>
    nodes.map((g) => (
      <div key={g.path}>
        <div
          role="button"
          tabIndex={0}
          className={cx(styles.sideRow, group === g.path && styles.sideRowOn)}
          style={{ ["--indent" as string]: `${depth * 16 + 8}px` }}
          data-group={g.path}
          data-group-drop={groupDrop?.path === g.path ? groupDrop.where : undefined}
          onPointerDown={(e) => startGroupDrag(e, g.path)}
          onClick={() => setGroup(g.path)}
          onDoubleClick={() => setRenaming({ kind: "group", id: g.path })}
          onContextMenu={(e) => {
            e.preventDefault();
            groupMenu(g, e.clientX, e.clientY);
          }}
        >
          <InlineEdit
            label="Rename group"
            className={styles.sideName}
            value={g.name}
            editing={renaming?.kind === "group" && renaming.id === g.path}
            onEditingChange={(on) => setRenaming(on ? { kind: "group", id: g.path } : null)}
            onCommit={(name) => {
              setRenaming(null);
              if (!collection) return;
              const parent = g.path.includes("/") ? g.path.slice(0, g.path.lastIndexOf("/") + 1) : "";
              renameGroup(ed, collection.id, g.path, parent + name);
              if (group === g.path) setGroup(parent + name);
            }}
            onCancel={() => setRenaming(null)}
          />
          <Count n={g.count} />
        </div>
        {!groupsCollapsed && groupRows(g.children, depth + 1)}
      </div>
    ));

  return (
    <div
      ref={root}
      className={cx(styles.window, minimized && styles.windowMinimized, !sidebar && styles.noSidebar, dropping && styles.dropping)}
      role="dialog"
      aria-label="Local variables"
      tabIndex={-1}
      data-local-variables=""
      data-minimized={minimized || undefined}
      onKeyDown={onKeyDown}
      // DTCG files dropped on the view: one new mode per file (help "Modes for variables").
      onDragOver={(e) => {
        if (!collection || extended || ![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        if (!collection || extended || !e.dataTransfer.files.length) return;
        e.preventDefault();
        const files = [...e.dataTransfer.files].filter((f) => /\.json$/i.test(f.name));
        void Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))).then((list) => list.length && importModes(ed, collection.id, list));
      }}
    >
      {sidebar && (
        // Live: the file's name over the collections (13 / 550 at 16, 16), Hide panel at 200, 8.
        <div className={styles.titleBar}>
          <span className={styles.fileName}>{fileName}</span>
          <IconButton icon="24.sidebar.closed" size="large" label="Hide panel" tone="secondary" onClick={() => setSidebar(false)} />
        </div>
      )}
      <div className={styles.toolbar}>
        {!sidebar && <IconButton icon="24.sidebar.closed" label="Show panel" tone="secondary" onClick={() => setSidebar(true)} />}
        {/* Live: the collection's name as the table's title (13 / 450) */}
        <h2 className={styles.collectionTitle}>{collection?.name ?? ""}</h2>
        {parent && <span className={styles.extendedFrom} data-extended-from={parent.name}>Extended from {parent.name}</span>}
        {/* Live: Search (175) and Filter (24) as one 200 × 24 group */}
        <div role="group" aria-label="Search and filter" className={styles.searchGroup}>
          <SearchField className={styles.search} value={query} onChange={setQuery} placeholder="Search" />
          <MenuButton
            label="Filter"
            className={styles.typeFilter}
            entries={[{ id: "", label: "All types", checked: !typeFilter }, "-", ...VAR_TYPES.map((t) => ({ id: t, label: VAR_TYPE_LABEL[t], icon: VAR_TYPE_ICON[t], checked: typeFilter === t }))]}
            onSelect={(t) => setTypeFilter((t || null) as VarType | null)}
          >
            <Icon name={typeFilter ? VAR_TYPE_ICON[typeFilter] : "24.adjust.small"} />
          </MenuButton>
        </div>
        {/* Live: Minimize is a toggle (a smaller, resizable modal while on) */}
        <label className={styles.minimize} data-on={minimized || undefined}>
          <input type="checkbox" aria-label="Minimize" checked={minimized} onChange={(e) => setMinimized(e.target.checked)} />
          <Icon name={minimized ? "24.expand" : "24.minimize"} />
        </label>
        <Button variant="primary" size="large" onClick={() => runEditorCommand(ed, "file.share-preview")}>
          Share
        </Button>
      </div>

      {sidebar && (
      <aside className={styles.sidebar} aria-label="Collections">
        <section className={styles.collections} aria-label="Variable collections">
          <div className={styles.sideHeader}>
            <span className={styles.sideHeading}>Collections</span>
            <IconButton icon="24.adjust.small" label="Collections options" tone="secondary" onClick={(e) => setReorder(e.currentTarget)} />
            <IconButton
              icon="24.plus.small"
              label="Create collection"
              tone="secondary"
              onClick={() => {
                const id = createCollection(ed);
                if (id) {
                  setCollectionId(id);
                  setGroup("");
                  setRenaming({ kind: "collection", id });
                }
              }}
            />
          </div>
          {a.collections.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              className={cx(styles.collectionRow, c.parent && styles.sideExtension, collection?.id === c.id && styles.collectionOn)}
              data-collection={c.name}
              data-extension={c.parent ? "" : undefined}
              onClick={() => {
                setCollectionId(c.id);
                setGroup("");
                setSelected(new Set());
              }}
              onDoubleClick={() => setRenaming({ kind: "collection", id: c.id })}
              onContextMenu={(e) => {
                e.preventDefault();
                collectionMenu(c, e.clientX, e.clientY);
              }}
            >
              <InlineEdit
                label="Rename collection"
                className={styles.sideName}
                value={c.name}
                editing={renaming?.kind === "collection" && renaming.id === c.id}
                onEditingChange={(on) => setRenaming(on ? { kind: "collection", id: c.id } : null)}
                onCommit={(name) => {
                  setRenaming(null);
                  renameCollection(ed, c.id, name);
                }}
                onCancel={() => setRenaming(null)}
              />
              <Count n={[...a.variables, ...a.library.variables].filter((v) => v.collection === rootOf(c).id).length} />
            </div>
          ))}
        </section>
        {collection && (
          <>
            <div className={cx(styles.sideHeader, styles.groupsHeader)}>
              <span className={styles.groupsHeading}>Groups</span>
              <IconButton
                icon="24.collapse-layers.small"
                label={groupsCollapsed ? "Expand groups" : "Collapse groups"}
                tone="secondary"
                aria-pressed={groupsCollapsed}
                onClick={() => setGroupsCollapsed(!groupsCollapsed)}
              />
            </div>
            <div role="button" tabIndex={0} className={cx(styles.sideRow, group === "" && styles.sideRowOn)} data-group="" onClick={() => setGroup("")}>
              <span className={styles.sideName}>All</span>
              <Count n={inCollection.length} />
            </div>
            {groupRows(tree, 0)}
          </>
        )}
      </aside>
      )}

      <main className={styles.main}>
        {!collection ? (
          <div className={styles.emptyPane}>
            <EmptyState
              size="page"
              icon="24.variable.small"
              title="Create your first collection"
              body="Variables store reusable values — colors, numbers, strings and booleans — with a value per mode."
              action={{ label: "Create collection", onClick: () => setCollectionId(createCollection(ed)) }}
            />
          </div>
        ) : (
          <>
            <div className={styles.scroll}>
              <div className={styles.table} role="grid" aria-label={collection.name} style={{ gridTemplateColumns: columns }}>
                <div className={styles.row} role="row">
                  <div className={cx(styles.cell, styles.head, styles.headName)} role="columnheader">
                    Name
                  </div>
                  {collection.modes.map((m, i) => (
                    <div
                      key={m.id}
                      className={cx(styles.cell, styles.head, styles.modeHead)}
                      role="columnheader"
                      data-mode={m.name}
                      data-default={i === 0 ? "" : undefined}
                      onDoubleClick={() => !extended && setRenaming({ kind: "mode", id: m.id })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        modeMenu(collection, m.id, e.clientX, e.clientY);
                      }}
                    >
                      <InlineEdit
                        label="Rename mode"
                        className={styles.modeLabel}
                        value={m.name}
                        maxLength={40}
                        editing={renaming?.kind === "mode" && renaming.id === m.id}
                        onEditingChange={(on) => setRenaming(on ? { kind: "mode", id: m.id } : null)}
                        onCommit={(name) => {
                          setRenaming(null);
                          renameMode(ed, collection.id, m.id, name);
                        }}
                        onCancel={() => setRenaming(null)}
                      />
                    </div>
                  ))}
                  <div className={cx(styles.cell, styles.head, styles.filler)} role="columnheader" />
                  <div className={cx(styles.cell, styles.head, styles.addMode)} role="columnheader">
                    {!extended && (
                    <IconButton
                      icon="24.plus.small"
                      label="New variable mode"
                      tone="secondary"
                      onClick={() => {
                        const id = addMode(ed, collection.id);
                        if (id) setRenaming({ kind: "mode", id });
                      }}
                    />
                    )}
                  </div>
                </div>

                {rows.map((r) =>
                  r.kind === "group" ? (
                    <div key={`g:${r.path}`} className={styles.row} role="row">
                      <div className={cx(styles.cell, styles.groupCell)} role="rowheader" data-group-row={r.path}>
                        {r.label}
                      </div>
                    </div>
                  ) : (
                    <div
                      key={r.v.id}
                      className={cx(styles.row, selected.has(r.v.id) && styles.rowSelected)}
                      role="row"
                      aria-selected={selected.has(r.v.id)}
                      data-variable-row={r.v.id}
                      data-drop={drop?.id === r.v.id ? drop.side : undefined}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        variableMenu(r.v, e.clientX, e.clientY, e.currentTarget.querySelector<HTMLElement>("[data-name-cell]") ?? (e.target as HTMLElement));
                      }}
                    >
                      <div
                        className={cx(styles.cell, styles.nameCell)}
                        role="rowheader"
                        data-name-cell={r.v.name}
                        onPointerDown={(e) => startDrag(e, r.v)}
                        onClick={(e) => select(r.v.id, e)}
                        onDoubleClick={() => !extended && setRenaming({ kind: "variable", id: r.v.id })}
                      >
                        <span className={styles.glyph}>
                          <Icon name={VAR_TYPE_ICON[r.v.type]} />
                        </span>
                        <InlineEdit
                          label="Rename variable"
                          className={styles.nameText}
                          value={splitName(r.v.name).leaf}
                          editing={renaming?.kind === "variable" && renaming.id === r.v.id}
                          onEditingChange={(on) => setRenaming(on ? { kind: "variable", id: r.v.id } : null)}
                          onCommit={(leaf) => {
                            setRenaming(null);
                            const g = splitName(r.v.name).group;
                            renameVariable(ed, r.v.id, (g ? `${g}/` : "") + leaf);
                          }}
                          onCancel={() => setRenaming(null)}
                        />
                      </div>
                      {collection.modes.map((m) => (
                        <ValueEditor key={m.id} variable={r.v} mode={m.id} collection={collection} />
                      ))}
                      <div className={cx(styles.cell, styles.filler)} />
                      {/* Live: Edit variable in the last column, at 8, 8 */}
                      <div className={cx(styles.cell, styles.addMode)} data-edit-cell={r.v.name}>
                        {!extended && <IconButton icon="24.adjust.small" label="Edit variable" tone="secondary" aria-expanded={edit?.id === r.v.id} onClick={(e) => setEdit({ id: r.v.id, anchor: e.currentTarget })} />}
                      </div>
                    </div>
                  )
                )}
              </div>
              {rows.length === 0 && query && <div className={styles.footer}>No results for “{query}”</div>}
            </div>
            {/* Live: "Create variable" 8 from the view's bottom-left corner, over the table */}
            {!extended && (
              <div className={styles.createBar}>
                <MenuButton label="Create variable" entries={createMenu} onSelect={(t) => create(t as VarType)} className={styles.createButton}>
                  <Icon name="24.plus.small" />
                  <span>Create variable</span>
                </MenuButton>
              </div>
            )}
          </>
        )}
      </main>

      {edit && <EditVariablePopover id={edit.id} anchor={edit.anchor} onClose={() => setEdit(null)} />}
      {bulk && <EditVariablesPopover ids={bulk.ids} anchor={bulk.anchor} onClose={() => setBulk(null)} />}
      {reorder && <ReorderCollectionsPopover anchor={reorder} onClose={() => setReorder(null)} />}
      {menu && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          entries={menu.entries}
          onClose={() => setMenu(null)}
          onSelect={(id) => {
            const pick = menu.pick;
            setMenu(null);
            pick(id);
          }}
        />
      )}
    </div>
  );
}

/** A row's count (live: "4", read as "4 variables"). */
function Count({ n }: { n: number }) {
  return (
    <span className={styles.sideCount}>
      <span className={styles.srOnly}>{n === 1 ? "1 variable" : `${n} variables`}</span>
      <span aria-hidden="true">{n}</span>
    </span>
  );
}

/** The default-mode value of a variable as text (tests, tooltips). */
export function defaultValueText(v: Variable, c: Collection): string {
  const value = valueIn(v, c.defaultMode, c);
  return value.kind === "alias" ? value.id : formatLiteral(v.type, value.value);
}
