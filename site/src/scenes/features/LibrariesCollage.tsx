// Libraries: a library this file uses has published a change. The notice (ds Banner) offers the review, the update
// lists what changed (the Button's colour), and "Update all" brings it in: the instance on the canvas follows.
import { useState } from "react";
import { Banner } from "@/ds/components/Banner";
import { Button, IconButton } from "@/ds/components/Button";
import { PanelSection } from "@/ds/components/PanelSection";
import { Swatch } from "@/ds/components/Swatch";
import { Icon } from "@/ds/icons/Icon";
import { around, Collage, CURSOR, Cursor, FrameName, Piece, usePointer } from "../collage/kit";
import { BEZIER } from "../runtime/easing";
import { noop } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

const OLD = "#9747FF";
const NEW = "#0D99FF";

const REVIEW: [number, number] = [336, 60];
const UPDATE: [number, number] = [338, 306];

export default function LibrariesCollage() {
  const [review, setReview] = useState(false);
  const [updated, setUpdated] = useState(false);
  const me = usePointer([300, 380]);

  const script = async (run: Run) => {
    await run.wait(1300);
    await me.click(run, REVIEW);
    setReview(true);
    await run.wait(700);
    await me.click(run, UPDATE);
    setUpdated(true);
    await run.wait(500);
    await me.to(run, [250, 380], { ms: 1000, ease: BEZIER.standard });
    await me.idle(run, around([250, 380], 16));
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <Piece x={24} y={36} w={352} d={0}>
        {/* The notice and the confirmation share one place: one leaves as the other arrives */}
        <div className={styles.libBanner}>
          <div data-out={updated || undefined}>
            <Banner tone="brand" action={{ label: "Review", onClick: noop }}>
              1 library update available
            </Banner>
          </div>
          <div data-out={!updated || undefined}>
            <Banner icon="24.check">Orbit Design System is up to date</Banner>
          </div>
        </div>
      </Piece>
      <FrameName x={40} y={140}>
        <span className={styles.compName}>
          <Icon name="16.instance" /> Sign up
        </span>
      </FrameName>
      <Piece x={40} y={140} w={140} h={40} d={80}>
        <span className={styles.libChip} data-new={updated || undefined}>
          Sign up
        </span>
      </Piece>

      <Piece surface x={96} y={176} w={296} show={review} from="scale" origin="240px -100px">
        <PanelSection title="Library updates" actions={<IconButton icon="24.close.small" label="Close" tone="secondary" />}>
          <div className={styles.libRow}>
            <span className={styles.libThumb}>
              <Icon name="24.component" />
            </span>
            <span className={styles.libName}>
              Button
              <small>Orbit Design System</small>
            </span>
            <span className={styles.libSwatches}>
              <Swatch color={OLD} />
              <Icon name="24.arrow.right" />
              <Swatch color={NEW} />
            </span>
          </div>
        </PanelSection>
        <div className={styles.libFoot}>
          <Button variant="secondary">Later</Button>
          <Button variant="primary">{updated ? "Updated" : "Update all"}</Button>
        </div>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
