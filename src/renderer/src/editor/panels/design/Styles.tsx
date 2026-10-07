/**
 * Styles in the Design panel (UI3, R3-38…42): the section headers' "Apply
 * styles" button (four dots) on Fill, Stroke, Effects, Layout guide and
 * Typography opens the style picker (the kind's local styles; Fill and
 * Stroke add colour variables) with "Create style"; a section whose layers
 * share a style shows it as one row — its glyph and name (a click opens Edit
 * style) and Detach style. With nothing selected: "Local variables" (Open
 * variables) and the local Styles list — Text, Color, Effect, Layout guide
 * styles, folders by slash names, hover Edit style, right click Edit /
 * Duplicate / Delete, "+" to create one.
 */
import { useRef, useState, type ReactNode } from "react";
import { ContextMenu, Icon, IconButton, InlineEdit, MenuButton, PanelSection, cx, tooltipProps, type MenuEntry } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { useLocalAssets, useUI } from "../../hooks";
import { groupTree, type GroupNode } from "../../model/variables";
import { STYLE_KIND_LABEL, STYLE_KIND_SINGULAR, STYLE_KINDS, STYLE_SLOT, styleIdOf, styleLeaf, textStyleSummary, type Style, type StyleKind, type StyleSlot } from "../../model/styles";
import { applyStyle, bindPaint, deleteStyle, duplicateStyle, renameStyle } from "../../variables";
import { CreateStylePopover, EditStylePopover } from "../variables/EditStyle";
import { OpenVariablesButton, StyleGlyph, VariablePicker } from "../variables/VariablePicker";
import vstyles from "../variables/Variables.module.css";
import { paintScope } from "./Variables";
import type { PanelNode } from "./shared";
import styles from "./Design.module.css";

const SLOT_LABEL: Record<StyleSlot, string> = { fill: "Fill", stroke: "Stroke", text: "Text", effect: "Effect", grid: "Layout guide" };

/** The style every node uses in `slot`; null when none does, "mixed" when they differ. */
export function sharedStyle(nodes: readonly PanelNode[], slot: StyleSlot): Guid | null | "mixed" {
  let out: Guid | null | undefined;
  for (const n of nodes) {
    const id = styleIdOf(n as never, slot);
    if (out === undefined) out = id;
    else if (out !== id) return "mixed";
  }
  return out ?? null;
}

/** The section header's "Apply styles" (four dots): the style picker, with colour variables for Fill and Stroke. */
export function StylesButton({ nodes, slot }: { nodes: readonly PanelNode[]; slot: StyleSlot }) {
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const [create, setCreate] = useState<HTMLElement | DOMRect | null>(null);
  const refs = nodes.map((n) => n.guid);
  const kind = STYLE_SLOT[slot].kind;
  const paints = slot === "fill" || slot === "stroke";
  const label = paints ? "Apply styles and variables" : "Apply styles";
  const current = sharedStyle(nodes, slot);
  return (
    <>
      <IconButton icon="24.styles" label={label} tone="secondary" aria-expanded={!!open} data-styles-button={slot} onClick={(e) => setOpen(open ? null : e.currentTarget)} />
      {open && (
        <VariablePicker
          anchor={open}
          title={paints ? "Libraries" : `${SLOT_LABEL[slot]} styles`}
          types={paints ? ["COLOR"] : []}
          scope={paints ? paintScope(nodes, slot === "fill" ? "fillPaints" : "strokePaints") : null}
          consumer={refs[0] ?? null}
          styleKind={kind}
          currentStyle={current === "mixed" ? null : current}
          onPickStyle={(s) => applyStyle(ed, refs, slot, s.id)}
          onPick={(v) => bindPaint(ed, refs, slot === "fill" ? "fillPaints" : "strokePaints", 0, v.id, true)}
          footer={
            <>
              <IconButton
                icon="24.plus.small"
                label="Create style"
                onClick={(e) => {
                  setCreate(e.currentTarget.getBoundingClientRect());
                  setOpen(null);
                }}
              />
              {paints && <OpenVariablesButton onDone={() => setOpen(null)} />}
            </>
          }
          onClose={() => setOpen(null)}
        />
      )}
      {create && <CreateStylePopover kind={kind} slot={slot} from={refs[0] ?? null} applyTo={refs} anchor={create} onClose={() => setCreate(null)} />}
    </>
  );
}

/** The style a section's layers share: its glyph and name (Edit style), Detach style. */
export function AppliedStyle({ nodes, slot }: { nodes: readonly PanelNode[]; slot: StyleSlot }) {
  const ed = useEditor();
  const a = useLocalAssets();
  const [edit, setEdit] = useState<HTMLElement | null>(null);
  const id = sharedStyle(nodes, slot);
  if (!id || id === "mixed") return null;
  const style = a.style(id);
  const refs = nodes.map((n) => n.guid);
  const name = style ? styleLeaf(style.name) : "Missing style";
  return (
    <div className={vstyles.styleRow} data-applied-style={style?.name ?? ""}>
      <button type="button" className={vstyles.styleBox} aria-label={`${STYLE_KIND_SINGULAR[STYLE_SLOT[slot].kind]}: ${style?.name ?? name}`} {...tooltipProps(style?.name ?? name)} onClick={(e) => setEdit(e.currentTarget)}>
        {style && <StyleGlyph style={style} />}
        <span className={vstyles.styleName}>{name}</span>
        {style?.kind === "TEXT" && <span className={vstyles.styleMeta}>{textStyleSummary(style.node)}</span>}
      </button>
      <span className={vstyles.styleActions}>
        <IconButton icon="24.detach.small" label="Detach style" tone="secondary" onClick={() => applyStyle(ed, refs, slot, null)} />
      </span>
      {edit && style && <EditStylePopover id={style.id} anchor={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

// ---- Nothing selected: Local variables and the Styles list ------------------------------------------------------------

/** "Local variables": opens the Local variables window. */
export function LocalVariablesSection() {
  const ed = useEditor();
  const a = useLocalAssets();
  return (
    <PanelSection title="Local variables">
      <button type="button" className={vstyles.openVariables} data-open-variables="" onClick={() => ed.ui.set({ variablesOpen: true })}>
        <Icon name="24.variable.small" />
        <span>Open variables</span>
        {a.variables.length > 0 && <span className={vstyles.styleMeta}>{a.variables.length}</span>}
      </button>
    </PanelSection>
  );
}

export function LocalStylesSection() {
  const ed = useEditor();
  const a = useLocalAssets();
  const closed = useUI((s) => s.stylesClosed);
  const [edit, setEdit] = useState<{ id: Guid; anchor: HTMLElement } | null>(null);
  const [create, setCreate] = useState<{ kind: StyleKind; anchor: DOMRect } | null>(null);
  const [menu, setMenu] = useState<{ style: Style; x: number; y: number; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<Guid | null>(null);
  const plus = useRef<HTMLSpanElement>(null);
  const add: MenuEntry[] = STYLE_KINDS.map((k) => ({ id: k, label: STYLE_KIND_SINGULAR[k] }));
  const toggle = (key: string) =>
    ed.ui.set((s) => {
      const next = new Set(s.stylesClosed);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { stylesClosed: next };
    });

  const item = (s: Style, depth: number) => (
    <div
      key={s.id}
      role="button"
      tabIndex={0}
      className={cx(vstyles.styleItem, edit?.id === s.id && vstyles.styleItemOn)}
      style={{ ["--indent" as string]: `${depth * 16}px` }}
      data-style-item={s.name}
      onDoubleClick={() => setRenaming(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ style: s, x: e.clientX, y: e.clientY, anchor: e.currentTarget });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) setEdit({ id: s.id, anchor: e.currentTarget });
      }}
    >
      <StyleGlyph style={s} />
      <InlineEdit
        label="Rename style"
        value={styleLeaf(s.name)}
        editing={renaming === s.id}
        onEditingChange={(on) => setRenaming(on ? s.id : null)}
        onCommit={(leaf) => {
          setRenaming(null);
          const folder = s.name.includes("/") ? s.name.slice(0, s.name.lastIndexOf("/") + 1) : "";
          renameStyle(ed, s.id, folder + leaf);
        }}
        onCancel={() => setRenaming(null)}
        className={vstyles.styleName}
      />
      {s.kind === "TEXT" && <span className={vstyles.styleMeta}>{textStyleSummary(s.node)}</span>}
      <IconButton className={vstyles.itemEdit} icon="24.adjust.small" label="Edit style" tone="secondary" onClick={(e) => setEdit({ id: s.id, anchor: e.currentTarget })} />
    </div>
  );

  const folder = (kind: StyleKind, g: GroupNode, list: Style[], depth: number): ReactNode => {
    const key = `${kind}:${g.path}`;
    const shut = closed.has(key);
    return (
      <div key={key}>
        <div role="button" tabIndex={0} className={cx(vstyles.styleItem, shut && vstyles.folderClosed)} style={{ ["--indent" as string]: `${depth * 16}px` }} data-style-folder={g.path} aria-expanded={!shut} onClick={() => toggle(key)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(key)}>
          <span className={vstyles.folderChevron}>
            <Icon name="16.chevron.down" />
          </span>
          <span className={vstyles.styleName}>{g.name}</span>
        </div>
        {!shut && level(kind, list, g.path, g.children, depth + 1)}
      </div>
    );
  };

  /** One folder level: its sub-folders, then the styles directly in it. */
  const level = (kind: StyleKind, list: Style[], path: string, folders: GroupNode[], depth: number): ReactNode => (
    <>
      {folders.map((g) => folder(kind, g, list, depth))}
      {list.filter((s) => (s.name.includes("/") ? s.name.slice(0, s.name.lastIndexOf("/")) : "") === path).map((s) => item(s, depth))}
    </>
  );

  const menuEntries: MenuEntry[] = menu
    ? [
        { id: "edit", label: "Edit style" },
        { id: "rename", label: "Rename" },
        { id: "duplicate", label: "Duplicate style" },
        "-",
        { id: "delete", label: "Delete style" },
      ]
    : [];

  const empty = a.styles.length === 0;
  return (
    <PanelSection
      title="Styles"
      empty={empty}
      actions={
        <span ref={plus} style={{ display: "contents" }}>
          <MenuButton label="Create style" entries={add} className={styles.iconMenu} onSelect={(k) => setCreate({ kind: k as StyleKind, anchor: (plus.current?.firstElementChild ?? document.body).getBoundingClientRect() })}>
            <Icon name="24.plus.small" />
          </MenuButton>
        </span>
      }
    >
      {!empty && (
        <div className={vstyles.styleList} data-local-styles="">
          {STYLE_KINDS.map((kind) => {
            const list = a.styles.filter((s) => s.kind === kind);
            if (!list.length) return null;
            return (
              <div key={kind}>
                <div className={vstyles.styleKind}>{STYLE_KIND_LABEL[kind]}</div>
                {level(kind, list, "", groupTree(list.map((s) => s.name)), 0)}
              </div>
            );
          })}
        </div>
      )}
      {edit && <EditStylePopover id={edit.id} anchor={edit.anchor} onClose={() => setEdit(null)} />}
      {create && <CreateStylePopover kind={create.kind} from={null} applyTo={[]} anchor={create.anchor} onClose={() => setCreate(null)} />}
      {menu && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          entries={menuEntries}
          onClose={() => setMenu(null)}
          onSelect={(id) => {
            const s = menu.style;
            setMenu(null);
            if (id === "edit") setEdit({ id: s.id, anchor: menu.anchor });
            if (id === "rename") setRenaming(s.id);
            if (id === "duplicate") duplicateStyle(ed, s.id);
            if (id === "delete") deleteStyle(ed, s.id);
          }}
        />
      )}
    </PanelSection>
  );
}
