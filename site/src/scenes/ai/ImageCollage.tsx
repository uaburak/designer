// Image tools (docs/ai.md §4): a selected picture and its toolbar, with the app's own labels (ImageToolbar.tsx: Edit
// with prompt, Remove background, Select area, More) on the ds Toolbar and ToolTextButton. One action: Remove
// background is clicked; the toolbar shows the run ("Removing background…", Cancel) while its sweep passes over the
// picture, on this computer; the background goes and the plant stays, on the checkerboard.
import { useRef, useState } from "react";
import { Spinner } from "@/ds/components/Spinner";
import { Toolbar, ToolbarDivider, ToolTextButton } from "@/ds/components/Toolbar";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { BEZIER } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { Plant } from "../home/art";
import { pointOf } from "../together/pick";
import styles from "./ai.module.css";

const IMG = { x: 270, y: 84, w: 320, h: 320 };

export default function ImageCollage() {
  const [busy, setBusy] = useState(false);
  const [cut, setCut] = useState(false);
  const me = usePointer([700, 500]);
  const bar = useRef<HTMLDivElement>(null);

  const script = async (run: Run) => {
    await run.wait(1200);
    const remove = pointOf([...(bar.current?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Remove background")), [0.5, 0.55]);
    if (remove) await me.click(run, remove, { beat: 260 });
    setBusy(true);
    // The hand steps off the toolbar, so the work can be seen
    if (remove) void me.to(run, [remove[0] + 28, remove[1] + 34], { ms: 700, ease: BEZIER.standard, wait: false });
    await run.wait(2200);
    setBusy(false);
    setCut(true);
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
        <div className={styles.scan} data-on={busy || undefined} />
      </Piece>
      <Selection box={IMG} size="320 × 320" />

      <Piece x={IMG.x - 70} y={440} w={460} h={60} d={120} className={styles.imageTools}>
        {/* The tools and the run in progress take turns in one place */}
        <div ref={bar} className={styles.imageToolbar} data-out={busy || undefined}>
          <Toolbar floating secondary label="Image tools">
            <ToolTextButton label="Edit with prompt" onSelect={() => {}} />
            <ToolTextButton label="Remove background" onSelect={() => {}} />
            <ToolTextButton label="Select area" onSelect={() => {}} />
            <ToolbarDivider />
            <ToolTextButton label="More" chevron onSelect={() => {}} />
          </Toolbar>
        </div>
        <div className={styles.imageToolbar} data-out={!busy || undefined}>
          <Toolbar floating secondary label="Working">
            <span className={styles.busyLabel}>
              <Spinner size={16} />
              Removing background…
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
