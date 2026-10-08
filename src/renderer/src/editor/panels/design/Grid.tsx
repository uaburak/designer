/**
 * The Auto layout section in Figma's grid flow (docs/research/figma/R9-grid-auto-layout.md): the grid picker's
 * "Number of columns" / "Number of rows", "Toggle automatic positioning", "Gap between columns" / "Gap between rows"
 * (bindable to variables), and each track's size (Fixed px, Fill container in fr, Hug contents); for an item in a grid,
 * "Column span" / "Row span". Edits go through the grid model (model/grid.ts) as whole field values, one undo step each.
 */
import { useState, type ReactNode } from "react";
import { MIXED, NumericInput, Popover, PropertyRow, Select, TextInput, type ChangeInfo } from "@/ds";
import type { Guid, NodeFields } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { fieldValue, mixed, mixedNumber } from "../../model/mixed";
import { isAutoRows, parseRowCount, parseTrackInput, rowCountLabel, setTrackCount, setTrackSizing, spanOf, tracksLabel, tracksOf, type GridAxis, type GridItemNode, type GridNode, type TrackType } from "../../model/grid";
import { useUI } from "../../hooks";
import styles from "./Grid.module.css";
import { VariableField } from "./Variables";
import type { PanelNode } from "./shared";

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

/** The picker's Number of columns and Number of rows (a number or "Auto"). */
function CountFields({ refs, grids }: { refs: Guid[]; grids: (PanelNode & GridNode)[] }) {
  const ed = useEditor();
  const cols = mixedNumber(grids.map((n) => tracksOf(n, "columns").length));
  const rows = mixed(grids.map((n) => rowCountLabel(n)));
  const setRows = (text: string) => {
    const r = parseRowCount(text);
    if (!r) return;
    if (r.auto) setCounts(ed, refs, "Number of rows", FINAL, { auto: true });
    else setCounts(ed, refs, "Number of rows", FINAL, { rows: r.count });
  };
  return (
    <div className={styles.pickerFields}>
      <NumericInput
        label="Number of columns"
        prefix="24.grid-column"
        value={fieldValue(cols)}
        min={1}
        max={1000}
        precision={0}
        onChange={(v, info) => setCounts(ed, refs, "Number of columns", info, { columns: v })}
        onCancel={() => ed.cancelEdit()}
      />
      <TextInput label="Number of rows" prefix="24.grid-row" value={rows === MIXED ? MIXED : (rows ?? "")} onCommit={setRows} />
    </div>
  );
}

const PICKER_SIZE = 12;

/**
 * The grid picker (help: Number of columns, Number of rows and "the interactive selector"): hovering a cell of the
 * 12 × 12 board previews that many columns × rows, a click sets them (rows: no longer Auto).
 */
function GridPicker({ anchor, refs, grids, onClose }: { anchor: HTMLElement; refs: Guid[]; grids: (PanelNode & GridNode)[]; onClose: () => void }) {
  const ed = useEditor();
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null);
  const first = grids[0];
  const cols = first ? tracksOf(first, "columns").length : 1;
  const rows = first ? (isAutoRows(first) ? Math.max(1, tracksOf(first, "rows").length) : tracksOf(first, "rows").length) : 1;
  const cells: React.ReactNode[] = [];
  for (let r = 1; r <= PICKER_SIZE; r++)
    for (let c = 1; c <= PICKER_SIZE; c++)
      cells.push(
        <button
          key={`${r}:${c}`}
          type="button"
          className={styles.cell}
          aria-label={`${c} × ${r}`}
          data-grid-cell={`${c}x${r}`}
          data-on={!hover && c <= cols && r <= rows}
          data-preview={!!hover && c <= hover.c && r <= hover.r}
          onPointerEnter={() => setHover({ c, r })}
          onClick={() => {
            setCounts(ed, refs, "Grid", FINAL, { columns: c, rows: r });
            onClose();
          }}
        />,
      );
  return (
    <Popover anchor={anchor} title="Grid" width={240} onClose={onClose} label="Grid picker">
      <div className={styles.picker} data-grid-picker="">
        <CountFields refs={refs} grids={grids} />
        <div className={styles.board} onPointerLeave={() => setHover(null)}>
          {cells}
        </div>
        <div className={styles.pickerCaption}>{hover ? `${hover.c} × ${hover.r}` : `${cols} × ${first && isAutoRows(first) ? "Auto" : rows}`}</div>
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
    <PropertyRow label="Span">
      <NumericInput label="Column span" prefix="24.grid-column" value={fieldValue(colSpan)} min={1} max={1000} precision={0} onChange={(v, info) => set("gridColumnSpan", v, info)} onCancel={() => ed.cancelEdit()} />
      <NumericInput label="Row span" prefix="24.grid-row" value={fieldValue(rowSpan)} min={1} max={1000} precision={0} onChange={(v, info) => set("gridRowSpan", v, info)} onCancel={() => ed.cancelEdit()} />
    </PropertyRow>
  );
}

