// Design: an auto layout frame of three plan cards, selected, and its Auto layout section in the Design panel (the
// app's SegmentedControl, AlignmentMatrix and NumericInputs). One idea (docs/site.md §2.1): the gap is scrubbed from 12
// to 32 on the Gap field and every card moves with it, the frame hugging them. The reflow is transforms on the scrub's
// own curve (the cards slide, the frame's white stretches, the selection's edges follow, the gap overlays open by a
// clip) while the numbers count in step. Then the scene rests, the cursor still on the field.
import { useState } from "react";
import { AlignmentMatrix } from "@/ds/components/AlignmentMatrix";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { Collage, CURSOR, Cursor, Dims, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { noop, Num, PanelColumn } from "../collage/ui";
import { BEZIER, css, ease } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import styles from "./home.module.css";

const X = 250;
const Y = 214;
const CARD = { w: 156, h: 220 };
const PAD = 16;
const GAPS = [12, 32] as const;
const MAX_W = PAD * 2 + CARD.w * 3 + GAPS[1] * 2;
/** How long the scrub takes, ms, and its curve (the cards, the frame, the selection and the numbers share them). */
const SCRUB = 1500;
const SCRUB_EASE = BEZIER.standard;
/** The Design panel, and where the Gap field's prefix sits in it (stage px). */
const PANEL = { x: 846, y: 136 };
const GAP_FIELD: [number, number] = [PANEL.x + 124, PANEL.y + 188];
const PLANS: [string, string, string][] = [
  ["Starter", "Free", "For one person"],
  ["Pro", "$12", "For a small team"],
  ["Team", "$40", "For the whole studio"],
];

function Face({ name, price, line }: { name: string; price: string; line: string }) {
  return (
    <>
      <span className={styles.planName}>{name}</span>
      <span className={styles.planPrice}>{price}</span>
      <span className={styles.planLine}>{line}</span>
      <span className={styles.planButton}>Choose</span>
    </>
  );
}

export default function DesignCollage() {
  const [gap, setGap] = useState<number>(GAPS[0]);
  const [scrub, setScrub] = useState(false);
  const me = usePointer([PANEL.x + 150, 560]);

  const script = async (run: Run) => {
    await run.wait(1200);
    await me.to(run, GAP_FIELD);
    await run.wait(300);
    await me.drag(run, [GAP_FIELD[0] + 60, GAP_FIELD[1]], SCRUB, {
      ease: SCRUB_EASE,
      bend: 0.01,
      start: () => {
        setScrub(true);
        setGap(GAPS[1]);
      },
    });
    await run.wait(400);
    setScrub(false);
  };

  const width = PAD * 2 + CARD.w * 3 + gap * 2;
  const frame = { x: X, y: Y, w: width, h: CARD.h + PAD * 2 };
  const moving = { transition: `transform ${SCRUB}ms ${css(SCRUB_EASE)}` };
  const count = { ms: SCRUB, ease: ease.standard };

  return (
    <Collage size={[1312, 640]} focus={[0.59, 0.5]} safe={640} script={script}>
      <FrameName x={frame.x} y={frame.y} selected>
        Plans
      </FrameName>
      <Piece x={frame.x} y={frame.y} w={MAX_W} h={frame.h} d={0} from="fade" className={styles.plans}>
        {/* The frame's white hugs the cards: stretched by transform, never resized */}
        <span className={styles.plansBg} style={{ ...moving, transform: `scaleX(${width / MAX_W})` }} />
        {PLANS.map(([name, price, line], i) => (
          <div key={name} className={styles.plan} style={{ ...moving, transform: `translateX(${PAD + i * (CARD.w + gap)}px)` }}>
            <div className={styles.planFace}>
              <Face name={name} price={price} line={line} />
            </div>
          </div>
        ))}
        {[0, 1].map((i) => (
          <span
            key={i}
            className={styles.gap}
            data-on={scrub || undefined}
            style={{
              transition: `transform ${SCRUB}ms ${css(SCRUB_EASE)}, clip-path ${SCRUB}ms ${css(SCRUB_EASE)}, opacity var(--dur-1) var(--ease-standard)`,
              transform: `translateX(${PAD + CARD.w + i * (CARD.w + gap)}px)`,
              clipPath: `inset(0 ${GAPS[1] - gap}px 0 0)`,
            }}
          />
        ))}
      </Piece>
      <Selection box={frame} size={<Dims w={frame.w} h="Hug" {...count} />} ms={SCRUB} ease={SCRUB_EASE} />

      <Piece surface x={PANEL.x} y={PANEL.y} w={240} d={160} from="right">
        <PanelColumn>
          <PanelSection title="Auto layout">
            <PropertyGrid labels>
              <PropertyRow label="Flow" span={2}>
                <SegmentedControl
                  label="Layout"
                  fullWidth
                  value="HORIZONTAL"
                  onChange={noop}
                  options={[
                    { value: "NONE", icon: "24.layout.freeform", tooltip: "Freeform" },
                    { value: "VERTICAL", icon: "24.layout.vertical", tooltip: "Vertical" },
                    { value: "HORIZONTAL", icon: "24.layout.horizontal", tooltip: "Horizontal" },
                    { value: "GRID", icon: "24.layout.grid", tooltip: "Grid" },
                  ]}
                />
              </PropertyRow>
              <PropertyRow label="Dimensions">
                <Num label="Width" prefix="W" value={frame.w} modeLabel="Hug" dimValue {...count} />
                <Num label="Height" prefix="H" value={frame.h} modeLabel="Hug" dimValue />
              </PropertyRow>
              <PropertyRow labels={["Alignment", "Gap"]}>
                <AlignmentMatrix direction="horizontal" value={{ primary: "MIN", counter: "MIN" }} onChange={noop} />
                <Num label="Gap" prefix="24.al.spacing-horizontal" value={gap} {...count} />
              </PropertyRow>
              <PropertyRow label="Padding">
                <Num label="Horizontal padding" prefix="24.al.padding-horizontal" value={PAD} />
                <Num label="Vertical padding" prefix="24.al.padding-vertical" value={PAD} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
        </PanelColumn>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
