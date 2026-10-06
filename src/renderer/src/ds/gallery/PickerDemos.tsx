import { useRef, useState } from "react";
import { ColorPicker } from "../components/ColorPicker";
import { ColorInput } from "../components/ColorInput";
import { AlignmentMatrix, type Alignment } from "../components/AlignmentMatrix";
import { EditorToolbar, groupOf, type EditorMode, type ToolGroupId, type ToolId } from "../components/EditorToolbar";
import { hexToRgba, rgbToHex } from "../util/color";
import type { PickerPaint } from "../util/paint";
import { Cell, Comp, noop, Row } from "./parts";
import styles from "./Gallery.module.css";

const DOC_COLORS = ["#0c8ce9", "#9747ff", "#14ae5c", "#f24822", "#ffcd29", "#ffffff", "#1e1e1e", "rgba(12, 140, 233, 0.4)"];
const SOLID: PickerPaint = { type: "SOLID", color: { r: 12 / 255, g: 140 / 255, b: 233 / 255, a: 1 }, opacity: 1 };
const LINEAR: PickerPaint = {
  type: "GRADIENT_LINEAR",
  opacity: 1,
  stops: [
    { color: { r: 151 / 255, g: 71 / 255, b: 1, a: 1 }, position: 0 },
    { color: { r: 12 / 255, g: 140 / 255, b: 233 / 255, a: 1 }, position: 0.55 },
    { color: { r: 20 / 255, g: 174 / 255, b: 92 / 255, a: 0.6 }, position: 1 },
  ],
};

/** A fill row whose swatch opens the real picker (popover), as the editor will. */
function LivePicker() {
  const [paint, setPaint] = useState<PickerPaint>(SOLID);
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const row = useRef<HTMLDivElement>(null);
  const hex = paint.type === "SOLID" && paint.color ? rgbToHex(paint.color) : "#000000";
  return (
    <div ref={row} style={{ width: 184 }}>
      <ColorInput
        label="Fill"
        color={hex}
        opacity={Math.round((paint.opacity ?? 1) * 100)}
        onColor={(h) => { const c = hexToRgba(h); if (c) setPaint({ ...paint, type: "SOLID", color: c }); }}
        onOpacity={(o) => setPaint({ ...paint, opacity: o / 100 })}
        onSwatchClick={() => setOpen(open ? null : row.current)}
      />
      <div className={styles.cellLabel} style={{ marginTop: 6, whiteSpace: "normal" }}>{log.slice(-3).join(" · ") || "Click the swatch"}</div>
      {open && (
        <ColorPicker
          value={paint}
          anchor={open}
          placement="right"
          documentColors={DOC_COLORS}
          onClose={() => setOpen(null)}
          onChange={(next, info) => {
            setPaint(next);
            if (info.final) setLog((l) => [...l, `${info.source} ✓`]);
          }}
        />
      )}
    </div>
  );
}

function LiveAlignment({ direction }: { direction: "horizontal" | "vertical" }) {
  const [value, setValue] = useState<Alignment>({ primary: "MIN", counter: "MIN" });
  return <AlignmentMatrix direction={direction} value={value} onChange={setValue} />;
}

function LiveToolbar() {
  const [tool, setTool] = useState<ToolId>("move");
  const [groups, setGroups] = useState<Partial<Record<ToolGroupId, ToolId>>>({});
  const [mode, setMode] = useState<EditorMode>("design");
  return (
    <div className={styles.stage}>
      <EditorToolbar
        tool={tool}
        groupTools={groups}
        mode={mode}
        onMode={setMode}
        onTool={(t) => {
          setTool(t);
          setGroups((g) => ({ ...g, [groupOf(t)]: t }));
        }}
      />
    </div>
  );
}

export function PickerDemos() {
  return (
    <>
      <Comp name="ColorPicker" note="Drag the square, sliders or a stop: previews, then one final change. Esc during a drag puts it back.">
        <Row>
          <Cell id="ColorPicker/solid/default/static"><ColorPicker static value={SOLID} anchor={null} documentColors={DOC_COLORS} onChange={noop} onClose={noop} /></Cell>
          <Cell id="ColorPicker/linear/default/static"><ColorPicker static value={LINEAR} anchor={null} stop={1} documentColors={DOC_COLORS} onChange={noop} onClose={noop} /></Cell>
          <Cell id="ColorPicker/image/default/static"><ColorPicker static value={{ type: "IMAGE", imageScaleMode: "FILL", opacity: 1 }} anchor={null} onChooseImage={noop} onChange={noop} onClose={noop} /></Cell>
          <Cell id="ColorPicker/rgb/default/static"><ColorPicker static value={{ ...SOLID, opacity: 0.5 }} anchor={null} colorModel="rgb" onChange={noop} onClose={noop} /></Cell>
          <Cell id="ColorPicker/live/default/default" label="live"><LivePicker /></Cell>
        </Row>
      </Comp>
      <Comp name="AlignmentMatrix" note="Auto layout's alignment: 88 × 56; hover previews, arrows move.">
        <Row>
          <Cell id="AlignmentMatrix/horizontal/default/live" label="horizontal · live"><LiveAlignment direction="horizontal" /></Cell>
          <Cell id="AlignmentMatrix/vertical/default/live" label="vertical · live"><LiveAlignment direction="vertical" /></Cell>
          <Cell id="AlignmentMatrix/horizontal/default/center"><AlignmentMatrix direction="horizontal" value={{ primary: "CENTER", counter: "CENTER" }} onChange={noop} /></Cell>
          <Cell id="AlignmentMatrix/horizontal/default/space-between"><AlignmentMatrix direction="horizontal" value={{ primary: "SPACE_BETWEEN", counter: "MAX" }} onChange={noop} /></Cell>
          <Cell id="AlignmentMatrix/vertical/default/space-between"><AlignmentMatrix direction="vertical" value={{ primary: "SPACE_BETWEEN", counter: "CENTER" }} onChange={noop} /></Cell>
          <Cell id="AlignmentMatrix/horizontal/default/hover"><AlignmentMatrix direction="horizontal" value={{ primary: "MAX", counter: "MAX" }} onChange={noop} data-hover /></Cell>
          <Cell id="AlignmentMatrix/horizontal/default/disabled"><AlignmentMatrix direction="horizontal" value={{ primary: "MIN", counter: "MIN" }} onChange={noop} disabled /></Cell>
        </Row>
      </Comp>
      <Comp name="EditorToolbar" note="Figma's bottom toolbar (530 × 48): tool slots with their menus, Actions, the mode switch.">
        <Row>
          <Cell id="EditorToolbar/default/default/live" label="live"><LiveToolbar /></Cell>
          <Cell id="EditorToolbar/default/default/disabled" label="disabled: Pen, the comment tools, Motion, Dev Mode">
            <div className={styles.stage}>
              <EditorToolbar tool="move" onTool={noop} mode="design" onMode={noop} disabledTools={["pen", "comment", "annotation", "measurement"]} disabledModes={["motion", "dev"]} />
            </div>
          </Cell>
        </Row>
      </Comp>
    </>
  );
}
