// Image tools (docs/ai.md §4): a selected picture and the image toolbar, with the app's own labels (ImageToolbar.tsx:
// Edit with prompt, Remove background, Select area, More › Expand, Boost resolution, Vectorize) on the ds Toolbar and
// ToolTextButton. Remove background runs on this computer (the toolbar shows the work), the background goes and the
// plant stays on the checkerboard; then More › Boost resolution doubles it.
import { useState } from "react";
import { Spinner } from "@/ds/components/Spinner";
import { Toolbar, ToolbarDivider, ToolTextButton } from "@/ds/components/Toolbar";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection } from "../collage/kit";
import type { Run } from "../runtime/motion";
import { Plant } from "../home/art";
import styles from "./ai.module.css";

const IMG = { x: 270, y: 64, w: 320, h: 320 };
const REMOVE: [number, number] = [404, 500];
const MORE: [number, number] = [588, 500];
const BOOST: [number, number] = [600, 436];

export default function ImageCollage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  const [menu, setMenu] = useState(false);
  const [boosted, setBoosted] = useState(false);
  const [me, setMe] = useState<[number, number, boolean?]>([720, 520]);

  const script = async (run: Run) => {
    const click = async (p: [number, number], ms = 900) => {
      setMe(p);
      await run.wait(ms);
      setMe([p[0], p[1], true]);
      await run.wait(150);
      setMe(p);
    };
    await run.wait(1000);
    await click(REMOVE, 1100);
    setBusy("Removing background…");
    await run.wait(1700);
    setBusy(null);
    setCut(true);
    await run.wait(1300);
    await click(MORE);
    setMenu(true);
    await click(BOOST, 700);
    setMenu(false);
    setBusy("Boosting resolution…");
    await run.wait(1400);
    setBusy(null);
    setBoosted(true);
    setMe([720, 520]);
  };

  return (
    <Collage size={[860, 560]} focus={[0.5, 0.45]} safe={520} script={script}>
      <FrameName x={IMG.x} y={IMG.y} selected>
        Fern
      </FrameName>
      <Piece x={IMG.x} y={IMG.y} w={IMG.w} h={IMG.h} d={0} from="fade" className={styles.image}>
        <div className={styles.checker} />
        <div className={styles.imageBg} data-out={cut || undefined}>
          <Plant ground="#F3E6CF" />
        </div>
        <div className={styles.imageCut} data-on={cut || undefined}>
          <Plant bare />
        </div>
        <div className={styles.scan} data-on={!!busy || undefined} />
      </Piece>
      <Selection box={IMG} size={boosted ? "640 × 640" : "320 × 320"} />

      <Piece x={MORE[0] - 40} y={BOOST[1] - 56} w={189} show={menu} from="down" className={styles.menu}>
        <span>Expand</span>
        <span data-hover="">Boost resolution</span>
        <span>Vectorize</span>
      </Piece>
      <Piece x={IMG.x - 70} y={470} w={460} h={60} d={250}>
        <div className={styles.imageToolbar}>
          <Toolbar floating secondary label="Image tools">
            {busy ? (
              <>
                <span className={styles.busyLabel}>
                  <Spinner size={16} />
                  {busy}
                </span>
                <ToolbarDivider />
                <ToolTextButton label="Cancel" onSelect={() => {}} />
              </>
            ) : (
              <>
                <ToolTextButton label="Edit with prompt" onSelect={() => {}} />
                <ToolTextButton label="Remove background" onSelect={() => {}} />
                <ToolTextButton label="Select area" onSelect={() => {}} />
                <ToolbarDivider />
                <ToolTextButton label="More" chevron active={menu} onSelect={() => {}} />
              </>
            )}
          </Toolbar>
        </div>
      </Piece>
      <Cursor x={me[0]} y={me[1]} press={me[2]} color={CURSOR.ink} d={500} z={30} />
    </Collage>
  );
}
