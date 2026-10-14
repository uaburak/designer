// Libraries: a library this file uses has published a change. The notice (ds Banner) offers the review, the update
// lists what changed (the Button's colour), and "Update all" brings it in: the instance on the canvas follows.
import { useState } from "react";
import { Banner } from "@/ds/components/Banner";
import { Button, IconButton } from "@/ds/components/Button";
import { PanelSection } from "@/ds/components/PanelSection";
import { Swatch } from "@/ds/components/Swatch";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, FrameName, Piece } from "../collage/kit";
import { noop } from "../collage/ui";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

const OLD = "#9747FF";
const NEW = "#0D99FF";

export default function LibrariesCollage() {
  const [review, setReview] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [me, setMe] = useState<[number, number, boolean?]>([300, 380]);

  const script = async (run: Run) => {
    await run.wait(1400);
    setMe([336, 60]);
    await run.wait(1000);
    setMe([336, 60, true]);
    await run.wait(140);
    setMe([336, 60]);
    setReview(true);
    await run.wait(900);
    setMe([334, 330]);
    await run.wait(1100);
    setMe([334, 330, true]);
    await run.wait(140);
    setMe([334, 330]);
    setUpdated(true);
    await run.wait(400);
    setMe([250, 380]);
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <Piece x={24} y={36} w={352} d={0}>
        <div className={styles.libBanner}>
          {updated ? (
            <Banner icon="24.check">Orbit Design System is up to date</Banner>
          ) : (
            <Banner tone="brand" action={{ label: "Review", onClick: noop }}>
              1 library update available
            </Banner>
          )}
        </div>
      </Piece>
      <FrameName x={40} y={140}>
        <span className={styles.compName}>
          <Icon name="16.instance" /> Sign up
        </span>
      </FrameName>
      <Piece x={40} y={140} w={140} h={40} d={150}>
        <span className={styles.libChip} style={{ background: updated ? NEW : OLD }}>
          Sign up
        </span>
      </Piece>

      <Piece surface x={96} y={176} w={296} show={review} from="scale">
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
      <Cursor x={me[0]} y={me[1]} press={me[2]} color={CURSOR.ink} d={400} z={30} />
    </Collage>
  );
}
