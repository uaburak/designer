// Design: an auto layout frame of three plan cards. The gap is scrubbed from 12 to 32 in the Auto layout section
// (the app's SegmentedControl, AlignmentMatrix and NumericInputs) and the cards move with it, the frame hugging them;
// then the middle card's fill is changed in the Fill row. The reflow is transforms on the scrub's own curve (the cards
// slide, the frame's white stretches, the selection's edges follow, the gap overlays open by a clip) while the numbers
// count in step; the new fill cross-fades in.
import { useState } from "react";
import { AlignmentMatrix } from "@/ds/components/AlignmentMatrix";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { around, Collage, CURSOR, Cursor, Dims, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { FileHeader, FillSection, Layers, noop, Num, PanelColumn, type Row } from "../collage/ui";
import { BEZIER, css, ease } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import styles from "./home.module.css";

const X = 392;
const Y = 196;
const CARD = { w: 156, h: 220 };
const PAD = 16;
const GAPS = [12, 32] as const;
const MAX_W = PAD * 2 + CARD.w * 3 + GAPS[1] * 2;
/** How long the scrub takes, ms, and its curve (the cards, the frame, the selection and the numbers share them). */
const SCRUB = 1500;
const SCRUB_EASE = BEZIER.standard;
/** Where the Gap field's prefix and the Fill row's hex sit in the panel (stage px). */
const GAP_FIELD: [number, number] = [1140, 252];
const FILL_FIELD: [number, number] = [1100, 404];
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
  const [pro, setPro] = useState(false);
  const [select, setSelect] = useState<"frame" | "pro">("frame");
  const me = usePointer([1080, 560]);
  const proSpot: [number, number] = [X + PAD + CARD.w + GAPS[1] + 90, Y + 120];

  const script = async (run: Run) => {
    await run.wait(1100);
    await me.to(run, GAP_FIELD);
    await run.wait(160);
    await me.drag(run, [GAP_FIELD[0] + 60, GAP_FIELD[1]], SCRUB, {
      ease: SCRUB_EASE,
      bend: 0.01,
      start: () => {
        setScrub(true);
        setGap(GAPS[1]);
      },
    });
    await run.wait(200);
    setScrub(false);
    await run.wait(500);
    await me.click(run, proSpot);
    setSelect("pro");
    await run.wait(600);
    await me.click(run, FILL_FIELD);
    setPro(true);
    await me.idle(run, [...around(FILL_FIELD, 12), [proSpot[0], proSpot[1] + 40], ...around(proSpot, 14)]);
  };

  const width = PAD * 2 + CARD.w * 3 + gap * 2;
  const frame = { x: X, y: Y, w: width, h: CARD.h + PAD * 2 };
  const proBox = { x: X + PAD + CARD.w + gap, y: Y + PAD, w: CARD.w, h: CARD.h };
  const rows: Row[] = [
    { id: "plans", name: "Plans", icon: "16.autolayout.horizontal", strong: true, expanded: true, selected: select === "frame" },
    ...PLANS.map(([name]) => ({ id: name, name, icon: "16.autolayout.vertical" as const, depth: 1, selected: select === "pro" && name === "Pro" })),
  ];
  const moving = { transition: `transform ${SCRUB}ms ${css(SCRUB_EASE)}` };
  const count = { ms: SCRUB, ease: ease.standard };

  return (
    <Collage size={[1312, 640]} focus={[0.52, 0.5]} safe={600} script={script}>
      <FrameName x={frame.x} y={frame.y} selected={select === "frame"}>
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
            {i === 1 && (
              <div className={styles.planFace} data-pro="" data-on={pro || undefined}>
                <Face name={name} price={price} line={line} />
              </div>
            )}
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
      <Selection box={frame} size={<Dims w={frame.w} h="Hug" {...count} />} show={select === "frame"} ms={SCRUB} ease={SCRUB_EASE} />
      <Selection box={proBox} show={select === "pro"} />

      <Piece surface x={56} y={64} w={240} d={80} from="left">
        <FileHeader name="Pricing" location="Drafts" />
        <Layers rows={rows} />
      </Piece>
      <Piece surface x={1016} y={64} w={240} d={160} from="right">
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
          <FillSection hex={select === "pro" ? (pro ? "9747FF" : "FFFFFF") : "F5F5F5"} />
        </PanelColumn>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
