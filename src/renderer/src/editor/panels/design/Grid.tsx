/**
 * The Auto layout section in Figma's grid flow (docs/research/figma/R9-grid-auto-layout.md): the grid picker's
 * "Number of columns" / "Number of rows", "Toggle automatic positioning", "Gap between columns" / "Gap between rows"
 * (bindable to variables), and each track's size (Fixed px, Fill container in fr, Hug contents); for an item in a grid,
 * "Column span" / "Row span". Edits go through the grid model (model/grid.ts) as whole field values, one undo step each.
 */
import { NumericInput, PropertyRow, Select, TextInput, ToggleIconButton, type ChangeInfo } from "@/ds";
import type { Guid, NodeFields } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { fieldValue, mixed, mixedNumber } from "../../model/mixed";
import { parseTrackInput, setTrackCount, setTrackSizing, spanOf, trackLabel, tracksOf, type GridAxis, type GridItemNode, type GridNode, type TrackType } from "../../model/grid";
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

/** The grid picker's counts, automatic positioning and the gaps. */
export function GridRows({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const grids = nodes as (PanelNode & GridNode)[];
  const cols = mixedNumber(grids.map((n) => tracksOf(n, "columns").length));
  const rows = mixedNumber(grids.map((n) => tracksOf(n, "rows").length));
  const reflow = mixed(grids.map((n) => n.gridReflowEnabled === true));
  const colGap = mixedNumber(grids.map((n) => n.gridColumnGap ?? 0));
  const rowGap = mixedNumber(grids.map((n) => n.gridRowGap ?? 0));
  const setCount = (axis: GridAxis, v: number, info: ChangeInfo) =>
    ed.edit(axis === "columns" ? "Number of columns" : "Number of rows", info, () => {
      for (const n of ed.engine.readNodes(refs) as (PanelNode & GridNode)[]) {
        const kids = (ed.engine.readNodes([n.guid], { childIds: true })[0]?.childIds ?? []) as Guid[];
        const items = (kids.length ? ed.engine.readNodes(kids) : []).map((k) => ({ guid: k.guid, node: k as unknown as GridItemNode }));
        const r = setTrackCount(n, axis, v, sessionOf(n.guid), items);
        ed.engine.setProps([n.guid], asFields(r.frame));
        for (const it of r.items) ed.engine.setProps([it.guid], asFields(it.fields));
      }
    });
  return (
    <>
      <PropertyRow
        label="Grid"
        action={
          <ToggleIconButton
            icon="24.layout-tidy-up-grid"
            label="Toggle automatic positioning"
            pressed={reflow ?? false}
            onPressedChange={(on) => ed.setProps(refs, asFields({ gridReflowEnabled: on }), "Automatic positioning")}
          />
        }
      >
        <NumericInput label="Number of columns" prefix="24.grid-column" value={fieldValue(cols)} min={1} max={1000} precision={0} onChange={(v, info) => setCount("columns", v, info)} onCancel={() => ed.cancelEdit()} />
        <NumericInput label="Number of rows" prefix="24.grid-row" value={fieldValue(rows)} min={1} max={1000} precision={0} onChange={(v, info) => setCount("rows", v, info)} onCancel={() => ed.cancelEdit()} />
      </PropertyRow>
      <PropertyRow label="Gap">
        <VariableField nodes={nodes} fields={["GRID_COLUMN_GAP"]} prefix="24.al.spacing-horizontal">
          <NumericInput
            label="Gap between columns"
            prefix="24.al.spacing-horizontal"
            value={fieldValue(colGap)}
            min={0}
            onChange={(v, info) => editGrids(ed, "Gap", info, refs, () => ({ gridColumnGap: Math.max(0, v) }))}
            onCancel={() => ed.cancelEdit()}
            onStep={(d) => editGrids(ed, "Gap", FINAL, refs, (n) => ({ gridColumnGap: Math.max(0, (n.gridColumnGap ?? 0) + d) }))}
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
          />
        </VariableField>
      </PropertyRow>
      {nodes.length === 1 && <TrackRows node={grids[0]} axis="columns" />}
      {nodes.length === 1 && <TrackRows node={grids[0]} axis="rows" />}
    </>
  );
}

/** One row per track: its size as Figma labels it ("1fr", "120", "Hug"), typed or picked from the dropdown. */
function TrackRows({ node, axis }: { node: PanelNode & GridNode; axis: GridAxis }) {
  const ed = useEditor();
  const tracks = tracksOf(node, axis);
  const name = axis === "columns" ? "Column" : "Row";
  const write = (index: number, sizing: { type: TrackType; value: number }) => {
    const fresh = ed.engine.readNodes([node.guid])[0] as unknown as GridNode;
    const fields: Record<string, unknown> = { ...setTrackSizing(fresh, axis, index, sizing) };
    // Fill tracks can't sit on an axis the frame hugs (Figma): that axis turns Fixed.
    const hugs = axis === "columns" ? (fresh as { stackPrimarySizing?: string }).stackPrimarySizing !== "FIXED" : (fresh as { stackCounterSizing?: string }).stackCounterSizing !== undefined && (fresh as { stackCounterSizing?: string }).stackCounterSizing !== "FIXED";
    if (sizing.type === "FLEX" && hugs) fields[axis === "columns" ? "stackPrimarySizing" : "stackCounterSizing"] = "FIXED";
    ed.setProps([node.guid], asFields(fields), `${name} size`);
  };
  return (
    <>
      {tracks.map((t, i) => (
        <PropertyRow key={`${t.id.sessionID}:${t.id.localID}`} label={`${name} ${i + 1}`}>
          <TextInput
            label={`${name} ${i + 1} size`}
            prefix={axis === "columns" ? "24.grid-column" : "24.grid-row"}
            value={trackLabel(t.sizing)}
            onCommit={(text) => {
              const s = parseTrackInput(text);
              if (s) write(i, s);
            }}
          />
          <Select
            label={`${name} ${i + 1} resizing`}
            value={t.sizing.type}
            options={TRACK_TYPES}
            onChange={(v) => write(i, { type: v as TrackType, value: v === "FIXED" ? Math.round(t.sizing.type === "FIXED" ? t.sizing.value : 100) : 1 })}
          />
        </PropertyRow>
      ))}
    </>
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

