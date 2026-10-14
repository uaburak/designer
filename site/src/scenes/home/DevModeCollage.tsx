// Dev Mode: a card marked Ready to Dev (the app's StatusTag), selected in Dev Mode's green, the distances to its
// parts measured in red, and its CSS written out line by line in Inspect (the ds CodeBlock); the bottom toolbar is in
// Dev Mode.
import { useState } from "react";
import { EditorToolbar } from "@/ds/components/EditorToolbar";
import { CodeBlock } from "@/ds/components/Misc";
import { PanelSection } from "@/ds/components/PanelSection";
import { Select } from "@/ds/components/Select";
import { Icon } from "@/ds/icons/Icon";
import { StatusTag } from "@/editor/devmode/StatusTag";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { noop, PanelColumn } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./home.module.css";

const CARD = { x: 432, y: 150, w: 320, h: 300 };

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

const MEASURES: Measure[] = [
  { x: CARD.x, y: CARD.y + 33, len: 24, dir: "h", label: "24" },
  { x: CARD.x + 160, y: CARD.y, len: 24, dir: "v", label: "24" },
  { x: CARD.x + 160, y: CARD.y + 42, len: 16, dir: "v", label: "16" },
];

export default function DevModeCollage() {
  const [ready, setReady] = useState(false);
  const [measured, setMeasured] = useState(0);
  const [lines, setLines] = useState(0);
  const me = usePointer([860, 600]);

  const script = async (run: Run) => {
    await run.wait(900);
    setReady(true);
    await run.wait(500);
    await me.to(run, [CARD.x + 60, CARD.y + 30]);
    for (let i = 1; i <= MEASURES.length; i++) {
      await run.wait(i === 1 ? 160 : 420);
      setMeasured(i);
      if (i === 2) void me.to(run, [CARD.x + 120, CARD.y + 70], { wait: false });
    }
    await run.wait(300);
    for (let i = 1; i <= CSS.length; i++) {
      setLines(i);
      await run.wait(110 + (CSS[i - 1].length % 4) * 20);
    }
    await me.idle(run, [
      [CARD.x + 160, CARD.y + 112],
      [CARD.x + 60, CARD.y + 52],
      [CARD.x + 220, CARD.y + 250],
    ]);
  };

  return (
    <Collage size={[1312, 640]} focus={[0.46, 0.5]} safe={560} script={script}>
      <FrameName x={CARD.x} y={CARD.y - 8}>
        <span className={styles.devName}>
          <Icon name="16.frame" /> Order card
          <span className={styles.devStatus} data-out={!ready || undefined}>
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
      {MEASURES.map((m, i) => (
        <span
          key={i}
          className={styles.measure}
          data-dir={m.dir}
          data-out={measured <= i || undefined}
          style={{ left: m.x, top: m.y, width: m.dir === "h" ? m.len : 1, height: m.dir === "v" ? m.len : 1 }}
        >
          <i />
          <b>{m.label}</b>
        </span>
      ))}

      <Piece surface x={1008} y={56} w={240} d={160} from="right">
        <PanelColumn>
          <PanelSection title="Order card" pad="none" />
          <PanelSection title="Code" actions={<Select label="Language" variant="ghost" width="hug" value="css" options={[{ value: "css", label: "CSS" }]} onChange={noop} />}>
            {/* The CSS writes itself out: a cover in the block's colour slides down line by line (transform only) */}
            <div className={styles.code} style={{ ["--lines" as string]: lines }}>
              <CodeBlock code={CSS.join("\n")} />
            </div>
          </PanelSection>
        </PanelColumn>
      </Piece>
      <Piece x={400} y={556} w={384} h={60} d={240}>
        <div className={styles.toolbarSlot}>
          <EditorToolbar floating tool="move" mode="dev" onMode={noop} onTool={noop} />
        </div>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
