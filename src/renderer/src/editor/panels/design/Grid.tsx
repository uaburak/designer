/**
 * The Auto layout section in Figma's grid flow (docs/research/figma/R9-grid-auto-layout.md): the grid picker's
 * "Number of columns" / "Number of rows", "Toggle automatic positioning", "Gap between columns" / "Gap between rows"
 * (bindable to variables), and each track's size (Fixed px, Fill container in fr, Hug contents); for an item in a grid,
 * "Column span" / "Row span". Edits go through the grid model (model/grid.ts) as whole field values, one undo step each.
 */
import { useState, type ReactNode } from "react";
import { Icon, IconButton, MIXED, MenuButton, NumericInput, Popover, PropertyRow, Select, TextInput, cx, tooltipProps, type ChangeInfo, type IconName, type MenuEntry } from "@/ds";
import type { Guid, NodeFields } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { fieldValue, mixed, mixedNumber } from "../../model/mixed";
import { isAutoRows, parseRowCount, parseTrackInput, removeTrackAt, rowCountLabel, setTrackCount, setTrackSizing, spanOf, trackLabel, tracksLabel, tracksOf, type GridAxis, type GridItemNode, type GridNode, type TrackType } from "../../model/grid";
import { useUI } from "../../hooks";
import styles from "./Grid.module.css";
import { VariableField } from "./Variables";
import { PANEL_MENU_GAP, type PanelNode } from "./shared";
import dstyles from "./Design.module.css";

const asFields = (f: Record<string, unknown>) => f as unknown as NodeFields;
const sessionOf = (guid: Guid) => Number(String(guid).replace(/^I/, "").split(":")[0]) || 1;

/** Writes `fn(fresh node)` to every node as one undo step. */
function editGrids(ed: EditorController, label: string, info: ChangeInfo, refs: readonly Guid[], fn: (n: PanelNode & GridNode) => Record<string, unknown> | null) {
  ed.edit(label, info, () => {
    for (const n of ed.engine.readNodes(refs) as (PanelNode & GridNode)[]) {
      const f = fn(n);
      if (f) ed.engine.setProps([n.guid], asFields(f));
    }
  });
}

const FINAL: ChangeInfo = { final: true, source: "step" };

const TRACK_TYPES: { value: TrackType; label: string }[] = [
  { value: "FIXED", label: "Fixed" },
  { value: "FLEX", label: "Fill container" },
  { value: "HUG", label: "Hug contents" },
];

/**
 * Writes a sizing to tracks `indices` of the grid `guid` along `axis` (the panel's rows and the canvas label editor):
 * one undo step. Fill tracks can't sit on an axis the frame hugs (Figma): that axis turns Fixed.
 */
export function writeTrackSizing(ed: EditorController, guid: Guid, axis: GridAxis, indices: readonly number[], sizing: { type: TrackType; value: number }) {
  const fresh = ed.engine.readNodes([guid])[0] as unknown as GridNode | undefined;
  if (!fresh) return;
  const fields: Record<string, unknown> = { ...setTrackSizing(fresh, axis, indices, sizing) };
  const f = fresh as { stackPrimarySizing?: string; stackCounterSizing?: string };
  const hugs = axis === "columns" ? f.stackPrimarySizing !== "FIXED" : f.stackCounterSizing !== undefined && f.stackCounterSizing !== "FIXED";
  if (sizing.type === "FLEX" && hugs) fields[axis === "columns" ? "stackPrimarySizing" : "stackCounterSizing"] = "FIXED";
  const name = axis === "columns" ? "Column" : "Row";
  ed.setProps([guid], asFields(fields), indices.length > 1 ? `${name}s size` : `${name} size`);
}

/** Sets the counts on every grid in `refs` (rows: a number turns Auto off, `auto` turns it on). */
function setCounts(ed: EditorController, refs: readonly Guid[], label: string, info: ChangeInfo, want: { columns?: number; rows?: number; auto?: boolean }) {
  ed.edit(label, info, () => {
    for (const n of ed.engine.readNodes(refs) as (PanelNode & GridNode)[]) {
      const kids = (ed.engine.readNodes([n.guid], { childIds: true })[0]?.childIds ?? []) as Guid[];
      const items = (kids.length ? ed.engine.readNodes(kids) : []).map((k) => ({ guid: k.guid, node: k as unknown as GridItemNode }));
      let node: GridNode = n;
      for (const axis of ["columns", "rows"] as const) {
        const count = want[axis];
        if (count === undefined) continue;
        const r = setTrackCount(node, axis, count, sessionOf(n.guid), items);
        ed.engine.setProps([n.guid], asFields(r.frame));
        for (const it of r.items) ed.engine.setProps([it.guid], asFields(it.fields));
        node = { ...node, ...r.frame } as GridNode;
      }
      if (want.auto !== undefined) ed.engine.setProps([n.guid], asFields({ gridAutoTracks: want.auto ? "ROWS" : "NONE" }));
      else if (want.rows !== undefined) ed.engine.setProps([n.guid], asFields({ gridAutoTracks: "NONE" }));
    }
  });
}

/**
 * Figma's live panel: "Grid" and "Gap" — the grid's dimensions as a button (88 × 56: its cells and "3 × 2") that
 * opens the picker with Number of columns / Number of rows, and "Gap between columns" over "Gap between rows";
 * the row's action is "Auto layout settings". (Each track's size is edited on the canvas, its pill.)
 */
export function GridDimensionsRow({ nodes, action }: { nodes: PanelNode[]; action?: ReactNode }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const grids = nodes as (PanelNode & GridNode)[];
  const first = grids[0];
  const cols = first ? tracksOf(first, "columns").length : 1;
  const rowsAuto = !!first && isAutoRows(first);
  const rows = first ? Math.max(1, tracksOf(first, "rows").length) : 1;
  const colGap = mixedNumber(grids.map((n) => n.gridColumnGap ?? 0));
  const rowGap = mixedNumber(grids.map((n) => n.gridRowGap ?? 0));
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const shownCols = Math.min(cols, 6);
  const shownRows = Math.min(rows, 4);
  return (
    <>
      {/* Live: "Auto layout settings" level with the first gap field (208, 404), not centred on the 56 high row */}
      <PropertyRow labels={["Grid", "Gap"]} action={action} className={styles.topRow}>
        <button
          type="button"
          className={styles.dimensions}
          aria-label={`Open grid dimensions picker. Current grid dimensions: ${cols} columns and ${rowsAuto ? "auto" : rows} rows`}
          aria-expanded={!!picker}
          data-grid-dimensions={`${cols}x${rows}`}
          style={{ ["--cols" as string]: shownCols, ["--rows" as string]: shownRows }}
          onClick={(e) => setPicker(picker ? null : e.currentTarget)}
        >
          {Array.from({ length: shownCols * shownRows }, (_, i) => (
            <span key={i} className={styles.dimensionsCell} />
          ))}
          <span className={styles.dimensionsText}>
            {cols}
            <span className={styles.dimensionsTimes}>×</span>
            {rowsAuto ? "Auto" : rows}
          </span>
        </button>
        <div className={styles.gapStack}>
          <VariableField nodes={nodes} fields={["GRID_COLUMN_GAP"]} prefix="24.al.spacing-horizontal">
            <NumericInput
              label="Gap between columns"
              prefix="24.al.spacing-horizontal"
              value={fieldValue(colGap)}
              min={0}
              onChange={(v, info) => editGrids(ed, "Gap", info, refs, () => ({ gridColumnGap: Math.max(0, v) }))}
              onCancel={() => ed.cancelEdit()}
              onStep={(d) => editGrids(ed, "Gap", FINAL, refs, (n) => ({ gridColumnGap: Math.max(0, (n.gridColumnGap ?? 0) + d) }))}
              onExpression={(each, info) => editGrids(ed, "Gap", info, refs, (n) => ({ gridColumnGap: Math.max(0, each(n.gridColumnGap ?? 0)) }))}
            />
          </VariableField>
          <VariableField nodes={nodes} fields={["GRID_ROW_GAP"]} prefix="24.al.spacing-vertical">
            <NumericInput
              label="Gap between rows"
              prefix="24.al.spacing-vertical"
              value={fieldValue(rowGap)}
              min={0}
              onChange={(v, info) => editGrids(ed, "Gap", info, refs, () => ({ gridRowGap: Math.max(0, v) }))}
              onCancel={() => ed.cancelEdit()}
              onStep={(d) => editGrids(ed, "Gap", FINAL, refs, (n) => ({ gridRowGap: Math.max(0, (n.gridRowGap ?? 0) + d) }))}
              onExpression={(each, info) => editGrids(ed, "Gap", info, refs, (n) => ({ gridRowGap: Math.max(0, each(n.gridRowGap ?? 0)) }))}
            />
          </VariableField>
        </div>
      </PropertyRow>
      {picker && <GridPicker anchor={picker} refs={refs} grids={grids} onClose={() => setPicker(null)} />}
    </>
  );
}

/**
 * The picker's Number of columns × Number of rows (live grid/grid-dimensions-picker.txt: two 85 × 24 fields at 8 and
 * 117 with "×" between; rows a number or "Auto", its chevron at 178 — the chevron's entries are unverified).
 */
function CountFields({ refs, grids }: { refs: Guid[]; grids: (PanelNode & GridNode)[] }) {
  const ed = useEditor();
  const cols = mixedNumber(grids.map((n) => tracksOf(n, "columns").length));
  const rows = mixed(grids.map((n) => rowCountLabel(n)));
  const auto = grids.length > 0 && grids.every((n) => isAutoRows(n));
  const setRows = (text: string) => {
    const r = parseRowCount(text);
    if (!r) return;
    if (r.auto) setCounts(ed, refs, "Number of rows", FINAL, { auto: true });
    else setCounts(ed, refs, "Number of rows", FINAL, { rows: r.count });
  };
  return (
    <div className={styles.pickerFields}>
      <NumericInput
        className={styles.pickerField}
        label="Number of columns"
        prefix="24.grid-column"
        value={fieldValue(cols)}
        min={1}
        max={1000}
        precision={0}
        onChange={(v, info) => setCounts(ed, refs, "Number of columns", info, { columns: v })}
        onCancel={() => ed.cancelEdit()}
      />
      <span className={styles.pickerTimes}>×</span>
      <TextInput
        className={styles.pickerField}
        label="Number of rows"
        prefix="24.grid-row"
        value={rows === MIXED ? MIXED : (rows ?? "")}
        onCommit={setRows}
        suffix={
          <MenuButton
            label="Number of rows"
            className={styles.pickerRowsMenu}
            tooltip={false}
            entries={[
              { id: "FIXED", label: "Fixed", checked: !auto },
              { id: "AUTO", label: "Auto", checked: auto },
            ]}
            onSelect={(id) => {
              const first = grids[0];
              if (id === "AUTO") setCounts(ed, refs, "Number of rows", FINAL, { auto: true });
              else if (first) setCounts(ed, refs, "Number of rows", FINAL, { rows: Math.max(1, tracksOf(first, "rows").length) });
            }}
          >
            <Icon name="16.chevron.down" />
          </MenuButton>
        }
      />
    </div>
  );
}

/** Live: a board of 12 columns × 8 rows, the picker 210 wide */
export const GRID_PICKER = { columns: 12, rows: 8, width: 210 } as const;
const PICKER_COLUMNS = GRID_PICKER.columns;
const PICKER_ROWS = GRID_PICKER.rows;
const PICKER_WIDTH = GRID_PICKER.width;

/** Where the picker opens (live: 12 left of the grid's button and 57 above it — 1204,427 for a button at 1216,484). */
export function gridPickerOrigin(button: { left: number; top: number }): { x: number; y: number } {
  return { x: button.left - 12, y: button.top - 57 };
}

/**
 * The grid dimensions picker (live grid/grid-dimensions-picker.txt: 210 × 204, no header): the counts, then a board
 * of 16 × 16 cells (a 14 × 14 square in each; the grid's own on #4a5878, the hovered size on #394360, the rest
 * #383838) with "C × R" on hover, and "Open grid settings" (the Grid panel). A click on a cell sets that many columns ×
 * rows (rows no longer Auto).
 */
function GridPicker({ anchor, refs, grids, onClose }: { anchor: HTMLElement; refs: Guid[]; grids: (PanelNode & GridNode)[]; onClose: () => void }) {
  const ed = useEditor();
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null);
  const first = grids[0];
  const cols = first ? tracksOf(first, "columns").length : 1;
  const rows = first ? (isAutoRows(first) ? Math.max(1, tracksOf(first, "rows").length) : tracksOf(first, "rows").length) : 1;
  // ("left" placement: the box ends at the rect's left, level with its top, kept 16 above the window's bottom)
  const o = gridPickerOrigin(anchor.getBoundingClientRect());
  const at = new DOMRect(o.x + PICKER_WIDTH, o.y, 0, 0);
  const cells: React.ReactNode[] = [];
  for (let row = 1; row <= PICKER_ROWS; row++)
    for (let c = 1; c <= PICKER_COLUMNS; c++) {
      const name = `${c} × ${row}`;
      cells.push(
        <label key={`${row}:${c}`} className={styles.cell} {...tooltipProps(name, undefined, "bottom")}>
          <input
            type="radio"
            name="grid-dimensions"
            className={styles.cellInput}
            aria-label={name}
            value={`${c}x${row}`}
            data-grid-cell={`${c}x${row}`}
            checked={c === cols && row === rows}
            onChange={() => undefined}
            onPointerEnter={() => setHover({ c, r: row })}
            onFocus={() => setHover({ c, r: row })}
            onClick={() => {
              setCounts(ed, refs, "Grid", FINAL, { columns: c, rows: row });
              onClose();
            }}
          />
          <span className={styles.cellSquare} data-on={c <= cols && row <= rows} data-preview={!!hover && c <= hover.c && row <= hover.r} />
          <span className={styles.cellName}>{name}</span>
        </label>,
      );
    }
  return (
    <Popover anchor={at} placement="left" width={PICKER_WIDTH} onClose={onClose} label="Grid dimensions picker">
      <div className={styles.picker} data-grid-picker="" data-hover={hover ? `${hover.c}x${hover.r}` : undefined}>
        <CountFields refs={refs} grids={grids} />
        <div role="radiogroup" aria-label="Grid dimensions" className={styles.board} onPointerLeave={() => setHover(null)}>
          {/* Live: the board's legend, kept for assistive tech and clipped from view */}
          <span className={styles.boardLegend}>Grid dimensions</span>
          {cells}
        </div>
        <button
          type="button"
          className={styles.pickerSettings}
          onClick={() => {
            onClose();
            if (first) ed.ui.set({ gridSettings: first.guid });
          }}
        >
          Open grid settings
        </button>
      </div>
    </Popover>
  );
}


/**
 * The label editor of the tracks selected on the canvas (a click on a pill's label, or Enter): their size typed
 * ("120", "2fr", "Hug", "Auto") or picked (Fixed / Fill container / Hug contents), applied to every selected track.
 */
export function GridTrackEditor() {
  const ed = useEditor();
  const at = useUI((s) => s.gridTrackEditor);
  const sel = useUI((s) => s.gridTracks);
  if (!at || !sel || !sel.tracks.length) return null;
  const node = ed.engine.readNodes([sel.frame])[0] as unknown as (GridNode & { guid: Guid }) | undefined;
  if (!node) return null;
  const axis: GridAxis = sel.axis === "COLUMNS" ? "columns" : "rows";
  const tracks = tracksOf(node, axis);
  const types = [...new Set(sel.tracks.filter((i) => i < tracks.length).map((i) => tracks[i].sizing.type))];
  const close = () => {
    ed.ui.set({ gridTrackEditor: null });
    ed.canvas?.focus({ preventScroll: true });
  };
  const name = axis === "columns" ? "Column" : "Row";
  return (
    <Popover anchor={new DOMRect(at.x, at.y, at.width, at.height)} placement="bottom" onClose={close} label={`${name} size`} width={200}>
      <div className={styles.trackEditor} data-grid-track-editor={sel.axis}>
        <TextInput
          label={`${name} size`}
          value={tracksLabel(node, axis, sel.tracks)}
          autoFocus
          onCommit={(text) => {
            const s = parseTrackInput(text);
            if (s) writeTrackSizing(ed, sel.frame, axis, sel.tracks, s);
          }}
          onExit={(r) => (r === "escape" || r === "enter" ? close() : undefined)}
        />
        <Select
          label={`${name} resizing`}
          value={types.length === 1 ? types[0] : MIXED}
          options={TRACK_TYPES}
          onChange={(v) => {
            const first = tracks[sel.tracks[0]];
            writeTrackSizing(ed, sel.frame, axis, sel.tracks, { type: v as TrackType, value: v === "FIXED" ? Math.round(first && first.sizing.type === "FIXED" ? first.sizing.value : 100) : 1 });
          }}
        />
      </div>
    </Popover>
  );
}

/** For layers in a grid: how many columns and rows each spans (Figma: "Column span" / "Row span"). */
export function GridSpanRow({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const items = nodes as (PanelNode & GridItemNode)[];
  const colSpan = mixedNumber(items.map((n) => spanOf(n, "columns")));
  const rowSpan = mixedNumber(items.map((n) => spanOf(n, "rows")));
  const set = (key: "gridColumnSpan" | "gridRowSpan", v: number, info: ChangeInfo) => editGrids(ed, key === "gridColumnSpan" ? "Column span" : "Row span", info, refs, () => ({ [key]: Math.max(1, Math.round(v)) }));
  return (
    // Live (design/grid-child.txt): "Column span" (16,340) and "Row span" (112,340) over the fields at 356 — 2 lower
    // than a plain row under Dimensions (a row with a label per column).
    <PropertyRow labels={["Column span", "Row span"]}>
      <NumericInput label="Column span" prefix="24.grid-column" value={fieldValue(colSpan)} min={1} max={1000} precision={0} onChange={(v, info) => set("gridColumnSpan", v, info)} onCancel={() => ed.cancelEdit()} />
      <NumericInput label="Row span" prefix="24.grid-row" value={fieldValue(rowSpan)} min={1} max={1000} precision={0} onChange={(v, info) => set("gridRowSpan", v, info)} onCancel={() => ed.cancelEdit()} />
    </PropertyRow>
  );
}


// ---- The Grid panel (live grid/row-track-selected-panel.txt) ----------------------------------------------------------

/** The panel's sizing dropdown: Fixed, Hug, Fill (live: "Fill"). */
const PANEL_TYPES: { value: TrackType; label: string }[] = [
  { value: "FIXED", label: "Fixed" },
  { value: "HUG", label: "Hug" },
  { value: "FLEX", label: "Fill" },
];

/**
 * A track's size as laid out: a fixed one its value, a fill one its share of what the fixed tracks, the gaps and the
 * padding leave (live grid/row-track-menu.txt: AL_grid's 1fr rows read 84). With a hug track on the axis the share
 * isn't known here (null).
 */
export function trackSize(node: GridNode & { size?: { x: number; y: number } }, axis: GridAxis, index: number): number | null {
  const tracks = tracksOf(node, axis);
  const t = tracks[index];
  if (!t) return null;
  if (t.sizing.type === "FIXED") return Math.round(t.sizing.value);
  if (t.sizing.type === "HUG" || tracks.some((x) => x.sizing.type === "HUG")) return null;
  const num = (k: string) => (typeof node[k] === "number" ? (node[k] as number) : 0);
  const length = axis === "columns" ? (node.size?.x ?? 0) - num("stackHorizontalPadding") - num("stackPaddingRight") : (node.size?.y ?? 0) - num("stackVerticalPadding") - num("stackPaddingBottom");
  const gaps = (tracks.length - 1) * num(axis === "columns" ? "gridColumnGap" : "gridRowGap");
  const fixed = tracks.reduce((sum, x) => sum + (x.sizing.type === "FIXED" ? x.sizing.value : 0), 0);
  const fr = tracks.reduce((sum, x) => sum + (x.sizing.type === "FLEX" ? x.sizing.value : 0), 0);
  return fr > 0 ? Math.round((Math.max(0, length - gaps - fixed) * t.sizing.value) / fr) : null;
}

/**
 * A track's sizing list (live grid/row-track-menu.txt, 156 × 72): "Fixed height (84)" with the track's size whatever its
 * sizing, Hug contents, "Fill container (1fr)" — each with its glyph, the current one checked.
 */
export function trackMenu(node: GridNode & { size?: { x: number; y: number } }, axis: GridAxis, index: number): MenuEntry[] {
  const t = tracksOf(node, axis)[index];
  if (!t) return [];
  const word = axis === "columns" ? "width" : "height";
  const glyph = (k: "fixed" | "hug" | "fill"): IconName => `24.al.${word}-${k}` as IconName;
  const size = trackSize(node, axis, index);
  return [
    { id: "FIXED", label: `Fixed ${word}${size === null ? "" : ` (${size})`}`, checked: t.sizing.type === "FIXED", radio: true, icon: glyph("fixed") },
    { id: "HUG", label: "Hug contents", checked: t.sizing.type === "HUG", radio: true, icon: glyph("hug") },
    { id: "FLEX", label: `Fill container (${t.sizing.type === "FLEX" ? trackLabel(t.sizing) : "1fr"})`, checked: t.sizing.type === "FLEX", radio: true, icon: glyph("fill") },
  ];
}

/**
 * While tracks of the selected grid are selected on the canvas, the Design tab is Figma's "Grid" panel: "Grid" and ×
 * (lets the tracks go), then Columns and Rows — each track's number (a click selects it, ⇧ / ⌘ add), its sizing
 * (Fixed / Hug / Fill) and its value ("1fr", "84", "Hug"), "Remove column n of m"; "Add column" / "Add row". The
 * selected tracks' rows are highlighted. The value's own list (live: a combobox) is the pill menu's choices.
 */
export function GridPanel({ frame }: { frame: Guid }) {
  const ed = useEditor();
  const sel = useUI((s) => s.gridTracks);
  const node = ed.engine.readNodes([frame])[0] as unknown as (GridNode & { guid: Guid }) | undefined;
  if (!node) return null;
  const select = (axis: GridAxis, tracks: number[]) => ed.engine.command("SELECT_GRID_TRACKS", { frame, axis: axis === "columns" ? "COLUMNS" : "ROWS", tracks });
  const close = () => {
    select("columns", []);
    ed.ui.set({ gridTracks: null, gridTrackEditor: null, gridSettings: null });
  };
  const items = () => {
    const kids = (ed.engine.readNodes([frame], { childIds: true })[0]?.childIds ?? []) as Guid[];
    return (kids.length ? ed.engine.readNodes(kids) : []).map((k) => ({ guid: k.guid, node: k as unknown as GridItemNode }));
  };
  const add = (axis: GridAxis) => {
    const count = tracksOf(node, axis).length + 1;
    setCounts(ed, [frame], axis === "columns" ? "Add column" : "Add row", FINAL, axis === "columns" ? { columns: count } : { rows: count });
  };
  const remove = (axis: GridAxis, index: number) => {
    const r = removeTrackAt(node, axis, index, items());
    if (!r) return;
    ed.batch(axis === "columns" ? "Remove column" : "Remove row", () => {
      ed.engine.setProps([frame], asFields({ ...r.frame, ...(axis === "rows" ? { gridAutoTracks: "NONE" } : {}) }));
      for (const it of r.items) ed.engine.setProps([it.guid], asFields(it.fields));
    });
    // The selected tracks stay selected (after the removed one, one index down); none left: the Design panel again.
    if (sel && sel.frame === frame && (sel.axis === "COLUMNS") === (axis === "columns")) {
      const next = sel.tracks.filter((x) => x !== index).map((x) => (x > index ? x - 1 : x));
      select(axis, next);
    }
  };
  const section = (axis: GridAxis) => {
    const tracks = tracksOf(node, axis);
    const selected = sel && sel.frame === frame && (sel.axis === "COLUMNS") === (axis === "columns") ? sel.tracks : [];
    const word = axis === "columns" ? "column" : "row";
    return (
      <div className={styles.gpSection} data-grid-panel-axis={axis}>
        <div className={styles.gpHeader}>
          <span>{axis === "columns" ? "Columns" : "Rows"}</span>
          <IconButton icon="24.plus.small" label={`Add ${word}`} tone="secondary" onClick={() => add(axis)} />
        </div>
        {tracks.map((t, i) => {
          const on = selected.includes(i);
          const name = `Grid ${word} ${i + 1} of ${tracks.length}`;
          const size = (sizing: { type: TrackType; value: number }) => writeTrackSizing(ed, frame, axis, on ? selected : [i], sizing);
          return (
            <div key={`${t.id.sessionID}:${t.id.localID}`} className={cx(styles.gpRow, on && styles.gpRowOn)} role="row" aria-selected={on}>
              <button
                type="button"
                className={styles.gpIndex}
                aria-label={`${name}, ${on ? "selected" : "not selected"}`}
                onClick={(e) => {
                  const extend = e.shiftKey || e.metaKey || e.ctrlKey;
                  select(axis, extend ? (on ? selected.filter((x) => x !== i) : [...selected, i]) : [i]);
                }}
              >
                {i + 1}
              </button>
              <Select
                label="Track sizing"
                variant="ghost"
                width={76}
                value={t.sizing.type}
                options={PANEL_TYPES}
                onChange={(v) => size({ type: v as TrackType, value: v === "FIXED" ? Math.round(t.sizing.type === "FIXED" ? t.sizing.value : 100) : 1 })}
              />
              <span className={styles.gpValue}>
                <TextInput
                  label={axis === "columns" ? "Column width" : "Row height"}
                  value={trackLabel(t.sizing)}
                  onCommit={(text) => {
                    const s = parseTrackInput(text);
                    if (s) size(s);
                  }}
                />
                <MenuButton
                  label={`${axis === "columns" ? "Column" : "Row"} ${i + 1} sizing`}
                  className={styles.gpValueMenu}
                  gap={PANEL_MENU_GAP}
                  menuClassName={cx(dstyles.panelMenu, dstyles.trackMenu)}
                  entries={trackMenu(node, axis, i)}
                  onSelect={(id) => size({ type: id as TrackType, value: id === "FIXED" ? Math.round(t.sizing.type === "FIXED" ? t.sizing.value : 100) : t.sizing.type === "FLEX" ? t.sizing.value : 1 })}
                >
                  <Icon name="16.chevron.down" />
                </MenuButton>
              </span>
              <IconButton icon="24.minus.small" label={`Remove ${word} ${i + 1} of ${tracks.length}`} tone="secondary" disabled={tracks.length <= 1} onClick={() => remove(axis, i)} />
            </div>
          );
        })}
      </div>
    );
  };
  return (
    <div className={styles.gridPanel} data-grid-panel="">
      <div className={styles.gpTitle}>
        <span>Grid</span>
        <IconButton icon="24.close.small" label="Close" onClick={close} />
      </div>
      {section("columns")}
      {section("rows")}
    </div>
  );
}
