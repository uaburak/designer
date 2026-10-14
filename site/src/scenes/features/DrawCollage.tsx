// Draw: the pen at work. A corner, a curve dragged out with its two handles, a corner, and a click on the first point
// closes the path; the shape gets a fill and a stroke in the Design panel, and Layers lists the new vector. The
// toolbar shows the Pen.
import { useState } from "react";
import { EditorToolbar } from "@/ds/components/EditorToolbar";
import { IconButton } from "@/ds/components/Button";
import { ColorInput } from "@/ds/components/ColorInput";
import { NumericInput } from "@/ds/components/NumericInput";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { BEZIER, css } from "../runtime/easing";
import { FileHeader, FillSection, Layers, noop, PanelColumn, type Row } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

type P = [number, number];
const A: P = [536, 440];
const B: P = [660, 186];
const C: P = [784, 440];
const HB: [P, P] = [
  [604, 190],
  [716, 190],
];
const SEGMENTS = [
  `M ${A} C ${A[0] + 10} ${A[1] - 120}, ${HB[0]}, ${B}`,
  `M ${B} C ${HB[1]}, ${C[0] - 10} ${C[1] - 120}, ${C}`,
  `M ${C} C ${C[0] - 70} ${C[1] + 44}, ${A[0] + 70} ${A[1] + 44}, ${A}`,
];
const SHAPE = `M ${A} C ${A[0] + 10} ${A[1] - 120}, ${HB[0]}, ${B} C ${HB[1]}, ${C[0] - 10} ${C[1] - 120}, ${C} C ${C[0] - 70} ${C[1] + 44}, ${A[0] + 70} ${A[1] + 44}, ${A} Z`;
const BOX = { x: A[0], y: B[1], w: C[0] - A[0], h: A[1] + 33 - B[1] };
const LOGO = { x: 456, y: 140, w: 408, h: 360 };

/** The curve's handles, pulled out with a drag, ms (the handles grow on the drag's curve). */
const PULL = 700;

export default function DrawCollage() {
  const [step, setStep] = useState(0); // anchors placed; 4 = closed
  const [handles, setHandles] = useState(false); // the curve's handles pulled out
  const [filled, setFilled] = useState(false);
  const me = usePointer([400, 560]);

  const script = async (run: Run) => {
    await run.wait(800);
    await me.click(run, A);
    setStep(1);
    await me.to(run, B);
    await run.wait(120);
    setStep(2);
    await me.drag(run, HB[1], PULL, { start: () => setHandles(true) });
    await me.click(run, C, { beat: 100 });
    setStep(3);
    await me.click(run, A, { beat: 100 });
    setStep(4);
    await me.to(run, [A[0] + 16, A[1] + 14], { ms: 420 });
    await run.wait(500);
    await me.click(run, [1100, 418]);
    setFilled(true);
    await me.idle(run, [
      [1060, 430],
      [C[0] + 60, C[1] - 40],
      [1100, 418],
    ]);
  };

  const closed = step >= 4;
  const rows: Row[] = [
    { id: "logo", name: "Logo", icon: "16.frame", strong: true, expanded: closed },
    { id: "vector", name: "Vector", icon: "16.vector", depth: 1, selected: closed, hidden: !closed },
  ];

  return (
    <Collage size={[1312, 640]} focus={[0.5, 0.5]} safe={540} script={script}>
      <FrameName x={LOGO.x} y={LOGO.y}>
        Logo
      </FrameName>
      <Piece x={LOGO.x} y={LOGO.y} w={LOGO.w} h={LOGO.h} d={0} from="fade" className={styles.logoFrame} />
      <svg className={styles.pen} width="1312" height="640" viewBox="0 0 1312 640" aria-hidden="true">
        <path className={styles.penFill} d={SHAPE} data-on={filled || undefined} />
        {SEGMENTS.map((d, i) => (
          <path key={i} className={styles.penStroke} d={d} pathLength={1} strokeDasharray="1 1" data-on={step > i + 1 || (i === 2 && closed) || undefined} data-filled={filled || undefined} />
        ))}
        {/* The handles grow out of B as they are dragged (transform on the drag's own curve) */}
        <g className={styles.penHandles} data-on={(handles && !closed) || undefined} style={{ transformOrigin: `${B[0]}px ${B[1]}px`, transition: `transform ${PULL}ms ${css(BEZIER.standard)}, opacity var(--dur-2) var(--ease-standard)` }}>
          <line x1={HB[0][0]} y1={HB[0][1]} x2={HB[1][0]} y2={HB[1][1]} />
          <circle cx={HB[0][0]} cy={HB[0][1]} r="3.5" />
          <circle cx={HB[1][0]} cy={HB[1][1]} r="3.5" />
        </g>
        {[A, B, C].map((p, i) => (
          <rect key={i} className={styles.penAnchor} data-on={step > i || undefined} data-active={(!closed && step === i + 1) || undefined} x={p[0] - 4} y={p[1] - 4} width="8" height="8" />
        ))}
      </svg>
      <Selection box={BOX} size={`${BOX.w} × ${BOX.h}`} show={closed} handles />

      <Piece surface x={56} y={64} w={240} d={80} from="left">
        <FileHeader name="Orbit — Brand" />
        <Layers rows={rows} />
      </Piece>
      <Piece surface x={1016} y={64} w={240} d={160} from="right">
        <PanelColumn>
          <PanelSection title="Vector" pad="none" />
          <FillSection hex={filled ? "14AE5C" : "D9D9D9"} />
          <PanelSection title="Stroke" actions={<IconButton icon="24.plus.small" label="Add stroke" tone="secondary" />}>
            <PropertyGrid>
              <PropertyRow span={2} action={<IconButton icon="24.eye.small" label="Hide stroke" tone="secondary" />}>
                <ColorInput label="Stroke" color="1E1E1E" opacity={100} onColor={noop} onOpacity={noop} />
              </PropertyRow>
              <PropertyRow>
                <NumericInput label="Stroke weight" prefix="24.stroke-weight" value={2} onChange={noop} />
                <span />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
        </PanelColumn>
      </Piece>
      <Piece x={406} y={556} w={500} h={60} d={240}>
        <div className={styles.toolbarSlot}>
          <EditorToolbar floating tool="pen" mode="design" onMode={noop} onTool={noop} />
        </div>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
