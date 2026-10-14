// Dev Mode (docs/site.md §2.1): a card marked Ready for dev (the app's StatusTag), selected in Dev Mode's green, and
// its CSS in Inspect (the ds CodeBlock). The cursor hovers the card's parts, one after another: each hovered layer gets
// its outline and its distances to the selection in red, right where the cursor is (the 24s are the card's padding,
// as the code says). Then the scene rests.
import { useState } from "react";
import { CodeBlock } from "@/ds/components/Misc";
import { PanelSection } from "@/ds/components/PanelSection";
import { Select } from "@/ds/components/Select";
import { Icon } from "@/ds/icons/Icon";
import { StatusTag } from "@/editor/devmode/StatusTag";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer, type Box } from "../collage/kit";
import { noop, PanelColumn } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./home.module.css";

const CARD = { x: 340, y: 170, w: 320, h: 300 };
const PANEL = { x: 700, y: 120 };

const CSS = [
  ".order-card {",
  "  display: flex;",
  "  flex-direction: column;",
  "  gap: 16px;",
  "  padding: 24px;",
  "  border-radius: 16px;",
  "  background: #FFFFFF;",
  "}",
];

interface Measure {
  x: number;
  y: number;
  len: number;
  dir: "h" | "v";
  label: string;
}

/** What the cursor hovers, in turn: the layer's box and its distances to the card (stage px). */
const HOVERS: { box: Box; measures: Measure[]; at: [number, number] }[] = [
  {
    // "Order #2048": 24 from the card's left and top
    box: { x: CARD.x + 24, y: CARD.y + 24, w: 84, h: 18 },
    measures: [
      { x: CARD.x, y: CARD.y + 33, len: 24, dir: "h", label: "24" },
      { x: CARD.x + 66, y: CARD.y, len: 24, dir: "v", label: "24" },
    ],
    at: [CARD.x + 70, CARD.y + 36],
  },
  {
    // "Track parcel": 24 from the card's left and bottom
    box: { x: CARD.x + 24, y: CARD.y + CARD.h - 24 - 40, w: CARD.w - 48, h: 40 },
    measures: [
      { x: CARD.x, y: CARD.y + CARD.h - 44, len: 24, dir: "h", label: "24" },
      { x: CARD.x + CARD.w / 2, y: CARD.y + CARD.h - 24, len: 24, dir: "v", label: "24" },
    ],
    at: [CARD.x + CARD.w / 2 + 40, CARD.y + CARD.h - 40],
  },
];

export default function DevModeCollage() {
  const [hover, setHover] = useState(-1);
  const me = usePointer([CARD.x + CARD.w + 60, 560]);

  const script = async (run: Run) => {
    await run.wait(1200);
    for (let i = 0; i < HOVERS.length; i++) {
      await me.to(run, HOVERS[i].at, { ms: i ? 900 : undefined });
      setHover(i);
      await run.wait(1600);
    }
  };

  return (
    <Collage size={[1312, 640]} focus={[0.488, 0.5]} safe={640} script={script}>
      <FrameName x={CARD.x} y={CARD.y - 8}>
        <span className={styles.devName}>
          <Icon name="16.frame" /> Order card
          <span className={styles.devStatus}>
            <StatusTag workflow="ready-to-dev" variant="chip" />
          </span>
        </span>
      </FrameName>
      <Piece x={CARD.x} y={CARD.y} w={CARD.w} h={CARD.h} d={0} from="fade" className={styles.order}>
        <span className={styles.orderLabel}>Order #2048</span>
        <span className={styles.orderTitle}>Arrives Thursday</span>
        <div className={styles.orderSteps}>
          {["Placed", "Packed", "On the way", "Delivered"].map((s, i) => (
            <span key={s} data-done={i < 3 || undefined}>
              <i />
              {s}
            </span>
          ))}
        </div>
        <span className={styles.orderButton}>Track parcel</span>
      </Piece>
      <Selection box={CARD} tone="dev" size={`${CARD.w} × ${CARD.h}`} />
      {HOVERS.map((h, i) => (
        <Selection key={i} box={h.box} tone="dev" handles={false} show={hover === i} z={11} />
      ))}
      {HOVERS.flatMap((h, i) =>
        h.measures.map((m, j) => (
          <span
            key={`${i}-${j}`}
            className={styles.measure}
            data-dir={m.dir}
            data-out={hover !== i || undefined}
            style={{ left: m.x, top: m.y, width: m.dir === "h" ? m.len : 1, height: m.dir === "v" ? m.len : 1 }}
          >
            <i />
            <b>{m.label}</b>
          </span>
        )),
      )}

      <Piece surface x={PANEL.x} y={PANEL.y} w={240} d={160} from="right">
        <PanelColumn>
          <PanelSection title="Order card" pad="none" />
          <PanelSection title="Code" actions={<Select label="Language" variant="ghost" width="hug" value="css" options={[{ value: "css", label: "CSS" }]} onChange={noop} />}>
            <div className={styles.code}>
              <CodeBlock code={CSS.join("\n")} />
            </div>
          </PanelSection>
        </PanelColumn>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
