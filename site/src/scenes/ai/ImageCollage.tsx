// Image tools (docs/ai.md §4): a selected picture and the image toolbar, with the app's own labels (ImageToolbar.tsx:
// Edit with prompt, Remove background, Select area, More › Expand, Boost resolution, Vectorize) on the ds Toolbar and
// ToolTextButton. Remove background runs on this computer (the toolbar shows the work), the background goes and the
// plant stays on the checkerboard; then More › Boost resolution doubles it.
import { useRef, useState } from "react";
import { Spinner } from "@/ds/components/Spinner";
import { Toolbar, ToolbarDivider, ToolTextButton } from "@/ds/components/Toolbar";
import { around, Collage, CURSOR, Cursor, Dims, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { BEZIER, DURATION, ease } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { Plant } from "../home/art";
import styles from "./ai.module.css";

const IMG = { x: 270, y: 64, w: 320, h: 320 };
const REMOVE: [number, number] = [407, 442];
const MORE: [number, number] = [585, 442];
const BOOST: [number, number] = [620, 374];

export default function ImageCollage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  const [menu, setMenu] = useState(false);
  const [boosted, setBoosted] = useState(false);
  const me = usePointer([720, 520]);
  const lastBusy = useRef("");
  if (busy) lastBusy.current = busy;

  const script = async (run: Run) => {
    await run.wait(1000);
    await me.click(run, REMOVE);
    setBusy("Removing background…");
    await me.to(run, [REMOVE[0] + 40, REMOVE[1] + 40], { ms: 900, ease: BEZIER.standard, wait: false });
    await run.wait(1700);
    setBusy(null);
    setCut(true);
    await run.wait(1300);
    await me.click(run, MORE);
    setMenu(true);
    await run.wait(200);
    await me.click(run, BOOST, { ms: 520, ease: BEZIER.standard });
    setMenu(false);
    setBusy("Boosting resolution…");
    await me.to(run, [720, 520], { ms: 1000, ease: BEZIER.standard, wait: false });
    await run.wait(1400);
    setBusy(null);
    setBoosted(true);
    await me.idle(run, around([720, 520], 16));
  };

  return (
    <Collage size={[860, 560]} focus={[0.5, 0.45]} safe={520} script={script}>
      <FrameName x={IMG.x} y={IMG.y} selected>
        Fern
      </FrameName>
      <Piece x={IMG.x} y={IMG.y} w={IMG.w} h={IMG.h} d={0} from="fade" className={styles.image}>
        <div className={styles.checker} />
        <div className={styles.imageCut}>
          <Plant bare />
        </div>
        <div className={styles.imageBg} data-out={cut || undefined}>
          <Plant ground="#F3E6CF" />
        </div>
        <div className={styles.scan} data-on={!!busy || undefined} />
        <div className={styles.shine} data-on={boosted || undefined} />
      </Piece>
      <Selection box={IMG} size={<Dims w={boosted ? 640 : 320} h={boosted ? 640 : 320} ms={DURATION.xl} ease={ease.standard} />} />

      <Piece x={MORE[0] - 40} y={BOOST[1] - 44} w={189} show={menu} from="scale" origin="40px 100%" className={styles.menu}>
        <span>Expand</span>
        <span data-pressable="">Boost resolution</span>
        <span>Vectorize</span>
      </Piece>
      <Piece x={IMG.x - 70} y={470} w={460} h={60} d={120}>
        {/* The tools and the work in progress are two toolbars in one place: one hands over to the other */}
        <div className={styles.imageToolbar} data-out={!!busy || undefined}>
          <Toolbar floating secondary label="Image tools">
            <ToolTextButton label="Edit with prompt" onSelect={() => {}} />
            <ToolTextButton label="Remove background" onSelect={() => {}} />
            <ToolTextButton label="Select area" onSelect={() => {}} />
            <ToolbarDivider />
            <ToolTextButton label="More" chevron active={menu} onSelect={() => {}} />
          </Toolbar>
        </div>
        <div className={styles.imageToolbar} data-out={!busy || undefined}>
          <Toolbar floating secondary label="Working">
            <span className={styles.busyLabel}>
              <Spinner size={16} />
              {busy ?? lastBusy.current}
            </span>
            <ToolbarDivider />
            <ToolTextButton label="Cancel" onSelect={() => {}} />
          </Toolbar>
        </div>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
