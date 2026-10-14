// Design: an auto layout frame of three plan cards. The gap is scrubbed from 12 to 32 in the Auto layout section
// (the app's SegmentedControl, AlignmentMatrix and NumericInputs) and the cards move with it, the frame hugging them;
// then the middle card's fill is changed in the Fill row.
import { useState } from "react";
import { AlignmentMatrix } from "@/ds/components/AlignmentMatrix";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { NumericInput } from "@/ds/components/NumericInput";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection } from "../collage/kit";
import { FileHeader, FillSection, Layers, noop, PanelColumn, type Row } from "../collage/ui";
import { mix, type Run } from "../runtime/motion";
import styles from "./home.module.css";

const X = 392;
const Y = 196;
const CARD = { w: 156, h: 220 };
const PAD = 16;
/** Where the Gap field's prefix and the Fill row's hex sit in the panel (stage px). */
const GAP_FIELD: [number, number] = [1140, 252];
const FILL_FIELD: [number, number] = [1100, 404];
const PLANS: [string, string, string][] = [
  ["Starter", "Free", "For one person"],
  ["Pro", "$12", "For a small team"],
  ["Team", "$40", "For the whole studio"],
];

export default function DesignCollage() {
  const [gap, setGap] = useState(12);
  const [scrub, setScrub] = useState(false);
  const [pro, setPro] = useState(false);
  const [select, setSelect] = useState<"frame" | "pro">("frame");
  const [me, setMe] = useState<[number, number, boolean?]>([1080, 560]);

  const script = async (run: Run) => {
    await run.wait(1200);
    setMe([GAP_FIELD[0], GAP_FIELD[1]]);
    await run.wait(1200);
    setMe([GAP_FIELD[0], GAP_FIELD[1], true]);
    setScrub(true);
    await run.tween(1600, (t) => {
      setGap(mix(12, 32, t));
      setMe([GAP_FIELD[0] + 60 * t, GAP_FIELD[1], true]);
    });
    setScrub(false);
    setMe([GAP_FIELD[0] + 60, GAP_FIELD[1]]);
    await run.wait(900);
    setSelect("pro");
    setMe([X + PAD + CARD.w + 32 + 90, Y + 120]);
    await run.wait(1100);
    setMe([FILL_FIELD[0], FILL_FIELD[1]]);
    await run.wait(1100);
    setPro(true);
    for (let i = 0; !run.reduced; i++) {
      await run.wait(2800);
      setMe(i % 2 ? [FILL_FIELD[0], FILL_FIELD[1]] : [X + PAD + CARD.w + 32 + 90, Y + 160]);
    }
  };

  const width = PAD * 2 + CARD.w * 3 + gap * 2;
  const frame = { x: X, y: Y, w: width, h: CARD.h + PAD * 2 };
  const proBox = { x: X + PAD + CARD.w + gap, y: Y + PAD, w: CARD.w, h: CARD.h };
  const rows: Row[] = [
    { id: "plans", name: "Plans", icon: "16.autolayout.horizontal", strong: true, expanded: true, selected: select === "frame" },
    ...PLANS.map(([name]) => ({ id: name, name, icon: "16.autolayout.vertical" as const, depth: 1, selected: select === "pro" && name === "Pro" })),
  ];

  return (
    <Collage size={[1312, 640]} focus={[0.52, 0.5]} safe={600} script={script}>
      <FrameName x={frame.x} y={frame.y} selected={select === "frame"}>
        Plans
      </FrameName>
      <Piece x={frame.x} y={frame.y} w={frame.w} h={frame.h} d={0} from="fade" className={styles.plans}>
        {PLANS.map(([name, price, line], i) => (
          <div key={name} className={styles.plan} data-pro={(i === 1 && pro) || undefined} style={{ transform: `translateX(${PAD + i * (CARD.w + gap)}px)` }}>
            <span className={styles.planName}>{name}</span>
            <span className={styles.planPrice}>{price}</span>
            <span className={styles.planLine}>{line}</span>
            <span className={styles.planButton}>Choose</span>
          </div>
        ))}
        {[0, 1].map((i) => (
          <span key={i} className={styles.gap} data-on={scrub || undefined} style={{ width: gap, transform: `translateX(${PAD + CARD.w + i * (CARD.w + gap)}px)` }} />
        ))}
      </Piece>
      <Selection box={frame} size={`${frame.w} × Hug`} show={select === "frame"} />
      <Selection box={proBox} show={select === "pro"} />

      <Piece surface x={56} y={64} w={240} d={150} from="left">
        <FileHeader name="Pricing" location="Drafts" />
        <Layers rows={rows} />
      </Piece>
      <Piece surface x={1016} y={64} w={240} d={300} from="right">
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
                <NumericInput label="Width" prefix="W" value={frame.w} modeLabel="Hug" dimValue onChange={noop} />
                <NumericInput label="Height" prefix="H" value={frame.h} modeLabel="Hug" dimValue onChange={noop} />
              </PropertyRow>
              <PropertyRow labels={["Alignment", "Gap"]}>
                <AlignmentMatrix direction="horizontal" value={{ primary: "MIN", counter: "MIN" }} onChange={noop} />
                <NumericInput label="Gap" prefix="24.al.spacing-horizontal" value={gap} onChange={noop} />
              </PropertyRow>
              <PropertyRow label="Padding">
                <NumericInput label="Horizontal padding" prefix="24.al.padding-horizontal" value={PAD} onChange={noop} />
                <NumericInput label="Vertical padding" prefix="24.al.padding-vertical" value={PAD} onChange={noop} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
          <FillSection hex={select === "pro" ? (pro ? "9747FF" : "FFFFFF") : "F5F5F5"} />
        </PanelColumn>
      </Piece>
      <Cursor x={me[0]} y={me[1]} press={me[2]} instant={scrub} color={CURSOR.ink} d={400} z={30} />
    </Collage>
  );
}
