// Draw: the pen at work, and nothing else (docs/site.md §2.1). The pen is the toolbar's tool; on the Logo frame a
// click places a corner, a press and drag places a point and pulls its handles out (the segment before it bends as
// they grow, on the drag's own curve), a click places another corner, and a click on the first point closes the path.
// Each point and segment appears where the cursor is, when it is clicked; nothing is drawn for show. Then the scene
// rests with the closed path selected.
import { useState, type CSSProperties } from "react";
import { EditorToolbar } from "@/ds/components/EditorToolbar";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { BEZIER, css } from "../runtime/easing";
import { noop } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

type P = readonly [number, number];
const A: P = [536, 430];
const B: P = [660, 196];
const C: P = [784, 430];
/** B's handles once pulled out: the drag ends on the right one; the left one mirrors it. */
const HB: [P, P] = [
  [590, 196],
  [730, 196],
];
const at = (p: P) => `${p[0]} ${p[1]}`;
/** A → B: straight when B is placed, bending as B's handles are pulled out (the same commands, so it can morph). */
const AB_STRAIGHT = `M ${at(A)} C ${at(A)}, ${at(B)}, ${at(B)}`;
const AB_CURVE = `M ${at(A)} C ${at(A)}, ${at(HB[0])}, ${at(B)}`;
const BC = `M ${at(B)} C ${at(HB[1])}, ${at(C)}, ${at(C)}`;
const CA = `M ${at(C)} L ${at(A)}`;
const SHAPE = `M ${at(A)} C ${at(A)}, ${at(HB[0])}, ${at(B)} C ${at(HB[1])}, ${at(C)}, ${at(C)} Z`;
const BOX = { x: A[0], y: B[1], w: C[0] - A[0], h: A[1] - B[1] };
const LOGO = { x: 456, y: 120, w: 408, h: 380 };

/** The handles' drag, ms, and its curve (the handles grow and the segment bends on it). */
const PULL = 700;
const PULL_EASE = BEZIER.standard;

export default function DrawCollage() {
  const [step, setStep] = useState(0); // points placed; 4 = closed
  const [pulled, setPulled] = useState(false); // B's handles pulled out
  const me = usePointer([C[0] + 120, 470]);

  const script = async (run: Run) => {
    await run.wait(1100);
    await me.click(run, A, { beat: 260 });
    setStep(1);
    await run.wait(500);
    // B: pressed, and dragged to pull its handles out
    await me.to(run, B);
    await run.wait(260);
    await me.drag(run, HB[1], PULL, { ease: PULL_EASE, bend: 0, start: () => setPulled(true) });
    setStep(2);
    await run.wait(500);
    await me.click(run, C, { beat: 260 });
    setStep(3);
    await run.wait(500);
    await me.click(run, A, { beat: 300 });
    setStep(4);
    await me.to(run, [A[0] + 26, A[1] + 30], { ms: 600 });
  };

  // B appears on its press (the drag's start), before its segment bends
  const placed = (i: number) => step > i || (i === 1 && pulled);
  const closed = step >= 4;
  const morph: CSSProperties & Record<string, string> = { d: `path("${pulled ? AB_CURVE : AB_STRAIGHT}")`, transition: `d ${PULL}ms ${css(PULL_EASE)}` };

  return (
    <Collage size={[1312, 640]} focus={[0.5, 0.48]} safe={520} script={script}>
      <FrameName x={LOGO.x} y={LOGO.y}>
        Logo
      </FrameName>
      <Piece x={LOGO.x} y={LOGO.y} w={LOGO.w} h={LOGO.h} d={0} from="fade" className={styles.logoFrame} />
      <svg className={styles.pen} data-closed={closed || undefined} width="1312" height="640" viewBox="0 0 1312 640" aria-hidden="true">
        <path className={styles.penShape} d={SHAPE} />
        <path className={styles.penStroke} d={pulled ? AB_CURVE : AB_STRAIGHT} style={morph} data-on={placed(1) || undefined} />
        <path className={styles.penStroke} d={BC} data-on={step >= 3 || undefined} />
        <path className={styles.penStroke} d={CA} data-on={closed || undefined} />
        {/* B's handles grow out of it as they are dragged (transform on the drag's own curve) */}
        <g className={styles.penHandles} data-on={(pulled && !closed) || undefined} style={{ transformOrigin: `${B[0]}px ${B[1]}px`, transition: `transform ${PULL}ms ${css(PULL_EASE)}, opacity var(--dur-2) var(--ease-standard)` }}>
          <line x1={HB[0][0]} y1={HB[0][1]} x2={HB[1][0]} y2={HB[1][1]} />
          <circle cx={HB[0][0]} cy={HB[0][1]} r="3" />
          <circle cx={HB[1][0]} cy={HB[1][1]} r="3" />
        </g>
        {[A, B, C].map((p, i) => (
          <circle key={i} className={styles.penAnchor} data-on={placed(i) || undefined} data-active={(!closed && (step === i + 1 || (i === 1 && pulled && step < 2))) || undefined} cx={p[0]} cy={p[1]} r="4" />
        ))}
      </svg>
      <Selection box={BOX} size={`${BOX.w} × ${BOX.h}`} show={closed} />

      <Piece x={406} y={556} w={500} h={60} d={240}>
        <div className={styles.toolbarSlot}>
          <EditorToolbar floating tool="pen" mode="design" onMode={noop} onTool={noop} />
        </div>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
