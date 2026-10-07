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
 * Esc or × closes it; ⌘Z / ⇧⌘Z undo and redo inside it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ContextMenu, EmptyState, Icon, IconButton, InlineEdit, MenuButton, SearchField, cx, type MenuEntry } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { runEditorCommand } from "../../commands";
import { useLocalAssets } from "../../hooks";
import { formatLiteral, groupTree, inGroup, matchesQuery, resolveVariable, splitName, valueIn, VAR_TYPE_ICON, VAR_TYPE_LABEL, VAR_TYPES, type Collection, type GroupNode, type Variable, type VarType } from "../../model/variables";
import {
  addMode,
  createCollection,
  createVariable,
  deleteCollection,
  deleteGroup,
  deleteMode,
  deleteVariables,
  duplicateCollection,
  duplicateVariables,
  groupVariables,
  moveMode,
  moveVariables,
  renameCollection,
  renameGroup,
  renameMode,
  renameVariable,
  setDefaultMode,
} from "../../variables";
import { EditVariablePopover } from "./EditVariable";
import { ValueEditor } from "./ValueEditor";
import styles from "./LocalVariables.module.css";

type Renaming = { kind: "variable" | "mode" | "collection" | "group"; id: string } | null;
type Row = { kind: "group"; path: string; label: string } | { kind: "variable"; v: Variable };
type Menu = { x: number; y: number; entries: MenuEntry[]; pick: (id: string) => void } | null;

export function LocalVariables() {
  const ed = useEditor();
  const a = useLocalAssets();
  const [collectionId, setCollectionId] = useState<Guid | null>(null);
  const [group, setGroup] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<Guid>>(new Set());
  const [anchor, setAnchor] = useState<Guid | null>(null);
  const [renaming, setRenaming] = useState<Renaming>(null);
  const [edit, setEdit] = useState<{ id: Guid; anchor: HTMLElement } | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [drop, setDrop] = useState<{ id: Guid; side: "before" | "after" } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const collection = a.collections.find((c) => c.id === collectionId) ?? a.collections[0] ?? null;

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  const inCollection = useMemo(() => (collection ? a.variables.filter((v) => v.collection === collection.id) : []), [a, collection]);
  const tree = useMemo(() => groupTree(inCollection.map((v) => v.name)), [inCollection]);
  const shown = inCollection.filter((v) => inGroup(v.name, group) && matchesQuery(v, query, collection ? formatLiteral(v.type, resolveVariable(v.id, a.lookup)) : ""));
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
    setMenu({
      x,
      y,
      entries: [
        { id: "edit", label: "Edit variable", disabled: many },
        { id: "rename", label: "Rename", disabled: many },
        { id: "duplicate", label: many ? "Duplicate variables" : "Duplicate", shortcut: "⇧↵" },
        { id: "group", label: "New group with selection" },
        "-",
        { id: "delete", label: many ? `Delete ${ids.length} variables` : "Delete variable" },
      ],
      pick: (id) => {
        if (id === "edit") setEdit({ id: v.id, anchor: target });
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

  const modeMenu = (c: Collection, modeId: Guid, x: number, y: number) => {
    const i = c.modes.findIndex((m) => m.id === modeId);
    setMenu({
      x,
      y,
      entries: [
        { id: "rename", label: "Rename mode" },
        { id: "duplicate", label: "Duplicate mode" },
        { id: "default", label: "Set as default", disabled: i === 0 },
        "-",
        { id: "left", label: "Move left", disabled: i === 0 },
        { id: "right", label: "Move right", disabled: i === c.modes.length - 1 },
        "-",
        { id: "delete", label: "Delete mode", disabled: c.modes.length < 2 },
      ],
      pick: (id) => {
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
      entries: [{ id: "rename", label: "Rename" }, { id: "duplicate", label: "Duplicate collection" }, "-", { id: "delete", label: "Delete collection" }],
      pick: (id) => {
        if (id === "rename") setRenaming({ kind: "collection", id: c.id });
        if (id === "duplicate") {
          const copy = duplicateCollection(ed, c.id);
          if (copy) setCollectionId(copy);
        }
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
      entries: [{ id: "rename", label: "Rename group" }, "-", { id: "delete", label: "Delete group" }],
      pick: (id) => {
        if (!collection) return;
        if (id === "rename") setRenaming({ kind: "group", id: g.path });
        if (id === "delete") {
          deleteGroup(ed, collection.id, g.path);
          setGroup("");
        }
      },
    });

  // ---- Drag to reorder ----------------------------------------------------------------------------------------------
  const startDrag = (e: ReactPointerEvent, v: Variable) => {
    if (e.button !== 0 || (e.target as Element).closest("input, textarea, button")) return;
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
    } else if ((e.key === "Backspace" || e.key === "Delete") && selected.size) {
      e.preventDefault();
      deleteVariables(ed, chosen());
      setSelected(new Set());
    } else if (e.key === "Enter" && e.shiftKey && selected.size) {
      e.preventDefault();
      setSelected(new Set(duplicateVariables(ed, chosen())));
    } else if (mod && e.code === "KeyA") {
      e.preventDefault();
      setSelected(new Set(order));
    }
  };

  const columns = collection ? `minmax(240px, 0.75fr) repeat(${collection.modes.length}, minmax(200px, 1fr)) 40px` : "1fr";
  const createMenu: MenuEntry[] = VAR_TYPES.map((t) => ({ id: t, label: VAR_TYPE_LABEL[t], icon: VAR_TYPE_ICON[t] }));

  const groupRows = (nodes: GroupNode[], depth: number): ReactNode =>
    nodes.map((g) => (
      <div key={g.path}>
        <div
          role="button"
          tabIndex={0}
          className={cx(styles.sideRow, group === g.path && styles.sideRowOn)}
          style={{ ["--indent" as string]: `${depth * 16}px` }}
          data-group={g.path}
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
          <span className={styles.sideCount}>{g.count}</span>
        </div>
        {groupRows(g.children, depth + 1)}
      </div>
    ));

  return (
    <div ref={root} className={styles.window} role="dialog" aria-label="Local variables" tabIndex={-1} data-local-variables="" onKeyDown={onKeyDown}>
      <div className={styles.titleBar}>Local variables</div>
      <div className={styles.toolbar}>
        <span className={styles.collectionTitle}>{collection?.name ?? ""}</span>
        <SearchField className={styles.search} value={query} onChange={setQuery} placeholder="Search" />
        <IconButton icon="24.close.small" label="Close" onClick={close} />
      </div>

      <aside className={styles.sidebar} aria-label="Collections">
        <div className={styles.sideHeader}>
          <span>Collections</span>
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
            className={cx(styles.sideRow, collection?.id === c.id && styles.sideRowOn)}
            data-collection={c.name}
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
          </div>
        ))}
        {collection && (
          <>
            <div className={styles.sideDivider} />
            <div role="button" tabIndex={0} className={cx(styles.sideRow, group === "" && styles.sideRowOn)} data-group="" onClick={() => setGroup("")}>
              <span className={styles.sideName}>All variables</span>
              <span className={styles.sideCount}>{inCollection.length}</span>
            </div>
            {groupRows(tree, 0)}
          </>
        )}
      </aside>

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
                      onDoubleClick={() => setRenaming({ kind: "mode", id: m.id })}
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
                  <div className={cx(styles.cell, styles.head, styles.addMode)} role="columnheader">
                    <IconButton
                      icon="24.plus.small"
                      label="New variable mode"
                      tone="secondary"
                      onClick={() => {
                        const id = addMode(ed, collection.id);
                        if (id) setRenaming({ kind: "mode", id });
                      }}
                    />
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
                        onDoubleClick={() => setRenaming({ kind: "variable", id: r.v.id })}
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
                        <IconButton className={styles.rowEdit} icon="24.adjust.small" label="Edit variable" tone="secondary" aria-expanded={edit?.id === r.v.id} onClick={(e) => setEdit({ id: r.v.id, anchor: e.currentTarget })} />
                      </div>
                      {collection.modes.map((m) => (
                        <ValueEditor key={m.id} variable={r.v} mode={m.id} collection={collection} />
                      ))}
                      <div className={cx(styles.cell, styles.filler)} />
                    </div>
                  )
                )}
              </div>
              {rows.length === 0 && query && <div className={styles.footer}>No results for “{query}”</div>}
              <div className={styles.footer}>
                <MenuButton label="Create variable" entries={createMenu} onSelect={(t) => create(t as VarType)} className={styles.createButton}>
                  <Icon name="24.plus.small" />
                  <span>Create variable</span>
                </MenuButton>
              </div>
            </div>
          </>
        )}
      </main>

      {edit && <EditVariablePopover id={edit.id} anchor={edit.anchor} onClose={() => setEdit(null)} />}
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

/** The default-mode value of a variable as text (tests, tooltips). */
export function defaultValueText(v: Variable, c: Collection): string {
  const value = valueIn(v, c.defaultMode, c);
  return value.kind === "alias" ? value.id : formatLiteral(v.type, value.value);
}
