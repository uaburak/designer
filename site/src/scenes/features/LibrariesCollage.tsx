// Libraries: a library this file uses has published a change. The notice (ds Banner) offers the review; Review opens
// the updates from it (what changed: the Button's colour) and the notice goes; "Update all" closes them and the
// instance under them has the library's new colour (cross-fading, opacity only). Then the scene rests (§2.1).
import { useState } from "react";
import { Banner } from "@/ds/components/Banner";
import { Button, IconButton } from "@/ds/components/Button";
import { PanelSection } from "@/ds/components/PanelSection";
import { Swatch } from "@/ds/components/Swatch";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, FrameName, Piece, usePointer } from "../collage/kit";
import { noop } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

const OLD = "#9747FF";
const NEW = "#0D99FF";

/** The banner's Review and the panel's Update all (stage px, measured). */
const REVIEW: [number, number] = [340, 61];
const UPDATE: [number, number] = [322, 178];
/** The canvas: a sign-up card with the library's Button in it (stage px). */
const CARD = { x: 88, y: 132, w: 224, h: 220 };

export default function LibrariesCollage() {
  const [review, setReview] = useState(false);
  const [updated, setUpdated] = useState(false);
  const me = usePointer([260, 360]);

  const script = async (run: Run) => {
    await run.wait(1200);
    await me.click(run, REVIEW, { beat: 260 });
    setReview(true);
    await run.wait(900);
    await me.click(run, UPDATE, { beat: 260 });
    setReview(false);
    setUpdated(true);
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <Piece x={24} y={48} w={352} d={0} show={!review && !updated} className={styles.libBanner}>
        <Banner tone="brand" action={{ label: "Review", onClick: noop }}>
          1 library update available
        </Banner>
      </Piece>
      <FrameName x={CARD.x} y={CARD.y}>
        Sign up
      </FrameName>
      <Piece x={CARD.x} y={CARD.y} w={CARD.w} h={CARD.h} d={80} from="fade" className={styles.libCard}>
        <strong>Create your account</strong>
        <span className={styles.libField}>Email</span>
        <span className={styles.libField}>Password</span>
        <span className={styles.libChip} data-new={updated || undefined}>
          Sign up
        </span>
      </Piece>

      <Piece surface x={80} y={48} w={296} show={review} from="scale" origin="256px 24px" z={22}>
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
          <Button variant="primary">Update all</Button>
        </div>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
