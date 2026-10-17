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
 * ⌫ deletes, ⇧↵ duplicates, ⌘A selects every row shown, right click (Figma's
 * order): Copy, Paste, New group with selection, Edit variable, Move to top /
 * up / down / to bottom, Duplicate, Delete. "+ Create variable" with the type
 * menu. Atlas 11 (wave 3): the Name column resizes 50 … 500 (double-click:
 * 200); modes past the plan's limit (40) show disabled, read-only.
 * Round 5 (help "Create and manage variables", "Extend a variable collection"):
 * Extend collection (the extension lists its root's variables with its own
 * modes; edits override, in blue, "Reset change"), Reorder collections / Sort A
 * to Z, Filter by type, Edit variables on a selection, Copy / Paste, Ungroup
 * and Duplicate group.
 * Esc or × closes it; ⌘Z / ⇧⌘Z undo and redo inside it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Button, ContextMenu, Icon, IconButton, InlineEdit, MenuButton, ResizeHandle, SearchField, cx, type MenuEntry } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { runEditorCommand } from "../../commands";
import { useLocalAssets, useUI } from "../../hooks";
import { canExtend, formatLiteral, groupTree, inGroup, LIMITS, matchesQuery, orphanMode, resolveVariable, rootOf, splitName, valueIn, VAR_TYPE_ICON, VAR_TYPE_LABEL, VAR_TYPES, type Collection, type GroupNode, type Variable, type VarType } from "../../model/variables";
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
import { t, tp, useT } from "@/i18n";

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

/** The Name column: 200 wide, resized 50 … 500 (atlas 11 §8.1). */
const NAME_WIDTH = 200;
const NAME_WIDTH_MIN = 50;
const NAME_WIDTH_MAX = 500;

/** help.figma.com "Create and manage variables" (the empty state's Learn more). */
const VARIABLES_HELP = "https://help.figma.com/hc/en-us/articles/15145852043927";

export function LocalVariables() {
  useT();
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
  // The Name column's width (Figma: 200, its edge dragged 50 … 500, a double-click resets — atlas 11 §8.1).
  const [nameWidth, setNameWidth] = useState(NAME_WIDTH);
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

  // The empty state's Create (live: "Create variable button"): a first collection with its first variable, named at once
  // (unverified: live's result isn't captured) — and Import: the DTCG files picked become a collection's modes.
  const createFirst = () => {
    const c = createCollection(ed);
    if (!c) return;
    setCollectionId(c);
    setGroup("");
    const id = createVariable(ed, c, "COLOR", "");
    if (id) {
      setSelected(new Set([id]));
      setAnchor(id);
      setRenaming({ kind: "variable", id });
    }
  };
  const importFirst = async () => {
    const files = await pickJsonFiles(true);
    if (!files.length) return;
    const c = createCollection(ed);
    if (!c) return;
    setCollectionId(c);
    importModes(ed, c, files);
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
        entries: [{ id: "copy", label: t("Copy"), shortcut: "⌘C" }, "-", { id: "reset", label: many ? t("Reset changes") : t("Reset change"), disabled: !changed.length }],
        pick: (id) => {
          if (id === "copy") copyVariables(ids);
          if (id === "reset") resetOverride(ed, collection.id, changed, null);
        },
      });
      return;
    }
    // Figma's order (atlas 11 §8.3): Copy, Paste, New group with selection, Edit, then Move to top / up / down / to
    // bottom (within the rows' group) and Duplicate, then Delete.
    const siblings = inCollection.filter((x) => splitName(x.name).group === splitName(v.name).group);
    const first = siblings.findIndex((x) => ids.includes(x.id));
    const last = siblings.length - 1 - [...siblings].reverse().findIndex((x) => ids.includes(x.id));
    setMenu({
      x,
      y,
      entries: [
        { id: "copy", label: t("Copy"), shortcut: "⌘C" },
        { id: "paste", label: t("Paste"), shortcut: "⌘V" },
        { id: "group", label: t("New group with selection") },
        { id: "edit", label: many ? t("Edit variables") : t("Edit variable") },
        "-",
        { id: "top", label: t("Move to top"), disabled: first <= 0 },
        { id: "up", label: t("Move up"), disabled: first <= 0 },
        { id: "down", label: t("Move down"), disabled: last < 0 || last >= siblings.length - 1 },
        { id: "bottom", label: t("Move to bottom"), disabled: last < 0 || last >= siblings.length - 1 },
        { id: "duplicate", label: many ? t("Duplicate variables") : t("Duplicate"), shortcut: "⇧↵" },
        "-",
        { id: "delete", label: many ? t("Delete {n} variables", { n: ids.length }) : t("Delete variable") },
      ],
      pick: (id) => {
        if (id === "edit" && many) setBulk({ ids, anchor: target });
        else if (id === "edit") setEdit({ id: v.id, anchor: target });
        if (id === "copy") copyVariables(ids);
        if (id === "paste") void paste();
        if (id === "top" || id === "up" || id === "down" || id === "bottom") {
          // Before the group's first row / the row above / after the row below / after the group's last row.
          const rest = siblings.filter((x) => !ids.includes(x.id));
          const all = inCollection.filter((x) => !ids.includes(x.id));
          const below = siblings.slice(last + 1).find((x) => !ids.includes(x.id));
          const after = (x: Variable | undefined) => (x ? all[all.indexOf(x) + 1] : undefined);
          const before =
            id === "top" ? rest[0] : id === "up" ? [...siblings.slice(0, first)].reverse().find((x) => !ids.includes(x.id)) : after(id === "down" ? below : rest[rest.length - 1]);
          moveVariables(ed, ids, before?.id ?? null);
        }
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
    // A mode past the plan's limit is read-only (only Delete); none becomes the default while there are too many.
    const beyond = i >= LIMITS.modes;
    const full = c.modes.length >= LIMITS.modes;
    setMenu({
      x,
      y,
      entries: [
        { id: "rename", label: t("Rename mode"), disabled: inherited || beyond },
        { id: "duplicate", label: t("Duplicate mode"), disabled: inherited || full },
        { id: "default", label: t("Set as default"), disabled: inherited || beyond || i === 0 || c.modes.length > LIMITS.modes },
        "-",
        { id: "left", label: t("Move column left"), disabled: inherited || beyond || i === 0 },
        { id: "right", label: t("Move column right"), disabled: inherited || beyond || i === c.modes.length - 1 || i + 1 >= LIMITS.modes },
        "-",
        { id: "import", label: t("Import mode"), disabled: beyond },
        { id: "export", label: t("Export mode") },
        "-",
        // An extension removes a mode only when the parent's mode was deleted (docs/data.md §16.8).
        { id: "delete", label: t("Delete mode"), disabled: (inherited && !orphanMode(c, modeId)) || c.modes.length < 2 },
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
        { id: "rename", label: t("Rename collection") },
        { id: "duplicate", label: t("Duplicate collection"), disabled: !!c.parent },
        { id: "extend", label: t("Extend collection"), disabled: !canExtend(c) },
        { id: "reorder", label: t("Reorder collections"), disabled: a.collections.length < 2 },
        "-",
        { id: "export", label: t("Export modes") },
        "-",
        { id: "delete", label: t("Delete collection") },
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
        { id: "rename", label: t("Rename group"), disabled: extended },
        { id: "ungroup", label: t("Ungroup"), disabled: extended },
        { id: "duplicate", label: t("Duplicate group"), disabled: extended },
        "-",
        { id: "delete", label: t("Delete group"), disabled: extended },
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
        const f = (ev.clientY - r.top) / r.height;
        target = { path: over, where: f < 0.25 ? "before" : f > 0.75 ? "after" : "into" };
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

  // Live (rail-variables-table.txt): Name 200 (resizable), a 280 column per mode, the rest, then 40 for New variable mode / Edit variable.
  const columns = collection ? `${nameWidth}px repeat(${collection.modes.length}, 280px) minmax(0, 1fr) 40px` : "1fr";
  const modesFull = !!collection && collection.modes.length >= LIMITS.modes;
  const createMenu: MenuEntry[] = VAR_TYPES.map((vt) => ({ id: vt, label: t(VAR_TYPE_LABEL[vt]), icon: VAR_TYPE_ICON[vt] }));

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
            label={t("Rename group")}
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
      aria-label={t("Local variables")}
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
          <IconButton icon="24.sidebar.closed" size="large" label={t("Hide panel")} tone="secondary" onClick={() => setSidebar(false)} />
        </div>
      )}
      <div className={styles.toolbar}>
        {!sidebar && <IconButton icon="24.sidebar.closed" label={t("Show panel")} tone="secondary" onClick={() => setSidebar(true)} />}
        {/* Live: the collection's name as the table's title (13 / 450) */}
        {/* (a file with no collection: "Variables", 4 further in — live rail-variables-full-view.txt) */}
        <h2 className={cx(styles.collectionTitle, !collection && styles.emptyTitle)}>{collection?.name ?? t("Variables")}</h2>
        {parent && <span className={styles.extendedFrom} data-extended-from={parent.name}>{t("Extended from {name}", { name: parent.name })}</span>}
        {/* Live: Search (175) and Filter (24) as one 200 × 24 group (not with no collection) */}
        {collection && (
        <div role="group" aria-label={t("Search and filter")} className={styles.searchGroup}>
          <SearchField className={styles.search} value={query} onChange={setQuery} placeholder={t("Search")} />
          <MenuButton
            label={t("Filter")}
            className={styles.typeFilter}
            entries={[{ id: "", label: t("All types"), checked: !typeFilter }, "-", ...VAR_TYPES.map((vt) => ({ id: vt, label: t(VAR_TYPE_LABEL[vt]), icon: VAR_TYPE_ICON[vt], checked: typeFilter === vt }))]}
            onSelect={(vt) => setTypeFilter((vt || null) as VarType | null)}
          >
            <Icon name={typeFilter ? VAR_TYPE_ICON[typeFilter] : "24.adjust.small"} />
          </MenuButton>
        </div>
        )}
        {/* Live: Minimize is a toggle (a smaller, resizable modal while on) */}
        <label className={styles.minimize} data-on={minimized || undefined}>
          <input type="checkbox" aria-label={t("Minimize")} checked={minimized} onChange={(e) => setMinimized(e.target.checked)} />
          <Icon name={minimized ? "24.expand" : "24.minimize"} />
        </label>
        <Button variant="primary" size="large" onClick={() => runEditorCommand(ed, "file.share-preview")}>
          {t("Share")}
        </Button>
      </div>

      {sidebar && (
      <aside className={styles.sidebar} aria-label={t("Collections")}>
        <section className={styles.collections} aria-label={t("Variable collections")}>
          <div className={styles.sideHeader}>
            <span className={styles.sideHeading}>{t("Collections")}</span>
            <IconButton icon="24.adjust.small" label={t("Collections options")} tone="secondary" onClick={(e) => setReorder(e.currentTarget)} />
            <IconButton
              icon="24.plus.small"
              label={t("Create collection")}
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
                label={t("Rename collection")}
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
              <span className={styles.groupsHeading}>{t("Groups")}</span>
              <IconButton
                icon="24.collapse-layers.small"
                label={groupsCollapsed ? t("Expand groups") : t("Collapse groups")}
                tone="secondary"
                aria-pressed={groupsCollapsed}
                onClick={() => setGroupsCollapsed(!groupsCollapsed)}
              />
            </div>
            <div role="button" tabIndex={0} className={cx(styles.sideRow, group === "" && styles.sideRowOn)} data-group="" onClick={() => setGroup("")}>
              <span className={styles.sideName}>{t("All")}</span>
              <Count n={inCollection.length} />
            </div>
            {groupRows(tree, 0)}
          </>
        )}
      </aside>
      )}

      <main className={styles.main}>
        {!collection ? (
          <div className={styles.emptyPane} data-variables-empty="">
            {/* Live (rail-variables-full-view.txt): 15 / 550, 11 / 450 with Learn more →, Create (primary) and Import */}
            <h3 className={styles.emptyHeading}>{t("No variables created in this file")}</h3>
            <p className={styles.emptyBody}>
              {t("Save colors, numbers, text, and states to reuse them in styles, prototypes, and across files.")}{" "}
              <a className={styles.learn} href={VARIABLES_HELP} target="_blank" rel="noreferrer">
                {t("Learn more")}<span className={styles.learnArrow} aria-hidden="true">→</span>
              </a>
            </p>
            <div className={styles.emptyActions}>
              <Button variant="primary" className={styles.emptyButton} aria-label={t("Create variable button")} onClick={createFirst}>
                {t("Create")}
              </Button>
              <Button variant="secondary" className={styles.emptyButton} aria-label={t("Import variables button")} onClick={() => void importFirst()}>
                {t("Import")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.scroll}>
              <div className={styles.table} role="grid" aria-label={collection.name} style={{ gridTemplateColumns: columns }}>
                <div className={styles.row} role="row">
                  <div className={cx(styles.cell, styles.head, styles.headName)} role="columnheader">
                    {t("Name")}
                    <ResizeHandle side="right" value={nameWidth} min={NAME_WIDTH_MIN} max={NAME_WIDTH_MAX} defaultValue={NAME_WIDTH} onChange={(px) => setNameWidth(px)} />
                  </div>
                  {collection.modes.map((m, i) => (
                    <div
                      key={m.id}
                      className={cx(styles.cell, styles.head, styles.modeHead, i >= LIMITS.modes && styles.modeDisabled)}
                      role="columnheader"
                      aria-disabled={i >= LIMITS.modes || undefined}
                      data-mode={m.name}
                      data-default={i === 0 ? "" : undefined}
                      onDoubleClick={() => !extended && i < LIMITS.modes && setRenaming({ kind: "mode", id: m.id })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        modeMenu(collection, m.id, e.clientX, e.clientY);
                      }}
                    >
                      <InlineEdit
                        label={t("Rename mode")}
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
                      // At the limit Figma disables it and names the limit (`reached_hard_mode_limit`; no plan above ours to upgrade to)
                      label={modesFull ? t("Limited to {n} modes only", { n: LIMITS.modes }) : t("New variable mode")}
                      tone="secondary"
                      disabled={modesFull}
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
                          label={t("Rename variable")}
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
                      {collection.modes.map((m, i) => (
                        <ValueEditor key={m.id} variable={r.v} mode={m.id} collection={collection} disabled={i >= LIMITS.modes} />
                      ))}
                      <div className={cx(styles.cell, styles.filler)} />
                      {/* Live: Edit variable in the last column, at 8, 8 */}
                      <div className={cx(styles.cell, styles.addMode)} data-edit-cell={r.v.name}>
                        {!extended && <IconButton icon="24.adjust.small" label={t("Edit variable")} tone="secondary" className={styles.editButton} aria-expanded={edit?.id === r.v.id} onClick={(e) => setEdit({ id: r.v.id, anchor: e.currentTarget })} />}
                      </div>
                    </div>
                  )
                )}
              </div>
              {rows.length === 0 && query && <div className={styles.footer}>{t("No results for “{query}”", { query })}</div>}
            </div>
            {/* Live: "Create variable" 8 from the view's bottom-left corner, over the table */}
            {!extended && (
              <div className={styles.createBar}>
                <MenuButton label={t("Create variable")} entries={createMenu} onSelect={(vt) => create(vt as VarType)} className={styles.createButton}>
                  <Icon name="24.plus.small" />
                  <span>{t("Create variable")}</span>
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
  useT();
  return (
    <span className={styles.sideCount}>
      <span className={styles.srOnly}>{tp(n, "{n} variable", "{n} variables")}</span>
      <span aria-hidden="true">{n}</span>
    </span>
  );
}

/** The default-mode value of a variable as text (tests, tooltips). */
export function defaultValueText(v: Variable, c: Collection): string {
  const value = valueIn(v, c.defaultMode, c);
  return value.kind === "alias" ? value.id : formatLiteral(v.type, value.value);
}
