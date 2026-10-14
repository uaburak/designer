// The home page's hero tile: a frame is drawn on the canvas (its size counting in the Design panel and under the
// selection), Layers fills in as the page's parts land, a teammate drops a picture in, and the toolbar goes back to
// Move. The panels are the app's (file header, Layers, Design sections, the bottom toolbar), cut out and laid on the
// colour. The frame is drawn by a clip (it is full size from the start), the selection by transforming its edges, both
// on the drag's own curve, so the cursor, the frame, the outline and the numbers move as one.
import { useState } from "react";
import { EditorToolbar } from "@/ds/components/EditorToolbar";
import { Icon } from "@/ds/icons/Icon";
import { around, Collage, CURSOR, Cursor, Dims, FrameName, Piece, Reveal, Selection, usePointer } from "../collage/kit";
import { FileHeader, FrameSections, Layers, noop, PanelColumn, type Row } from "../collage/ui";
import { BEZIER, css, ease } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { Sky } from "./art";
import styles from "./home.module.css";

const FRAME = { x: 404, y: 132, w: 504, h: 360 };
/** How long the frame takes to draw, ms (the drag, the clip, the outline and the numbers share it). */
const DRAW = 1400;
const DRAW_EASE = BEZIER.standard;

export default function HeroCollage() {
  const [tool, setTool] = useState<"frame" | "move">("frame");
  const [drawn, setDrawn] = useState(false);
  const [parts, setParts] = useState(0);
  const [picture, setPicture] = useState(false);
  const [select, setSelect] = useState<"frame" | "button" | null>(null);
  const me = usePointer([300, 120]);
  const ada = usePointer([1150, 560]);
  const ken = usePointer([820, 640]);

  const script = async (run: Run) => {
    await run.wait(700);
    await me.to(run, [FRAME.x, FRAME.y]);
    await run.wait(120);
    await me.drag(run, [FRAME.x + FRAME.w, FRAME.y + FRAME.h], DRAW, {
      ease: DRAW_EASE,
      start: () => {
        setDrawn(true);
        setSelect("frame");
      },
    });
    setTool("move");
    for (let i = 1; i <= 4; i++) {
      await run.wait(i === 1 ? 260 : 340);
      setParts(i);
    }
    await run.wait(300);
    void me.to(run, [FRAME.x + FRAME.w + 120, FRAME.y + FRAME.h - 40], { wait: false });
    await ada.to(run, [FRAME.x + 330, FRAME.y + 150]);
    await run.wait(220);
    setPicture(true);
    await run.wait(700);
    await ken.to(run, [FRAME.x + 92, FRAME.y + 254]);
    await ken.click(run);
    setSelect("button");
    // Idle: the teammates keep working, slowly; the visitor's own hand rests
    await Promise.all([
      ada.idle(run, [
        [FRAME.x + 360, FRAME.y + 120],
        [FRAME.x + 420, FRAME.y + 220],
        [FRAME.x + 300, FRAME.y + 300],
      ]),
      ken.idle(run, around([FRAME.x + 150, FRAME.y + 300], 18), { pause: 2800 }),
      me.idle(run, around([FRAME.x + FRAME.w + 120, FRAME.y + FRAME.h - 40], 10), { pause: 3400 }),
    ]);
  };

  const rows: Row[] = [
    { id: "home", name: "Home", icon: "16.frame", strong: true, expanded: parts > 0, selected: select === "frame", hidden: !drawn },
    { id: "nav", name: "Nav", icon: "16.autolayout.horizontal", depth: 1, hidden: parts < 1 },
    { id: "headline", name: "Weather that plans your week.", icon: "16.text", depth: 1, hidden: parts < 2 },
    { id: "button", name: "Get the app", icon: "16.autolayout.horizontal", depth: 1, hidden: parts < 3, selected: select === "button" },
    { id: "image", name: "Hero image", icon: "16.image", depth: 1, hidden: parts < 4 },
  ];
  const drawing = { ms: DRAW, ease: ease.standard };

  return (
    <Collage size={[1312, 680]} focus={[0.5, 0.42]} safe={560} script={script}>
      {/* The canvas: the frame being drawn and what lands in it */}
      <FrameName x={FRAME.x} y={FRAME.y} selected={select === "frame"} show={drawn}>
        Home
      </FrameName>
      <div
        className={styles.heroFrame}
        data-drawn={drawn || undefined}
        style={{ left: FRAME.x, top: FRAME.y, width: FRAME.w, height: FRAME.h, transition: `clip-path ${DRAW}ms ${css(DRAW_EASE)}` }}
      >
        <div className={styles.heroNav} data-out={parts < 1 || undefined}>
          <span className={styles.heroLogo} />
          <span>Orbit</span>
          <span className={styles.heroLinks}>Forecast&nbsp;&nbsp;&nbsp;Maps&nbsp;&nbsp;&nbsp;Pricing</span>
        </div>
        <div className={styles.heroHeadline} data-out={parts < 2 || undefined}>
          Weather that
          <br />
          plans your week.
        </div>
        <div className={styles.heroButtons} data-out={parts < 3 || undefined}>
          <span>Get the app</span>
          <span>See plans</span>
        </div>
        <div className={styles.heroImage} data-out={parts < 4 || undefined}>
          <span className={styles.heroImageEmpty}>
            <Icon name="24.image" />
          </span>
          <Reveal on={picture}>
            <Sky />
          </Reveal>
        </div>
      </div>
      <Selection
        box={drawn ? FRAME : { x: FRAME.x, y: FRAME.y, w: 0, h: 0 }}
        draw={false}
        ms={DRAW}
        ease={DRAW_EASE}
        size={<Dims w={drawn ? FRAME.w : 0} h={drawn ? FRAME.h : 0} {...drawing} />}
        show={select === "frame"}
      />
      <Selection box={{ x: FRAME.x + 32, y: FRAME.y + 236, w: 104, h: 36 }} show={select === "button"} size="104 × 36" />

      {/* The panels */}
      <Piece surface x={40} y={56} w={240} d={80} from="left">
        <FileHeader name="Orbit — Website" />
        <Layers rows={rows} />
      </Piece>
      <Piece surface x={1032} y={56} w={240} d={160} from="right">
        <PanelColumn>
          <FrameSections x={0} y={0} w={drawn ? FRAME.w : 0} h={drawn ? FRAME.h : 0} radius={0} fill="#FFFFFF" {...drawing} />
        </PanelColumn>
      </Piece>
      <Piece x={406} y={560} w={500} h={60} d={240}>
        <div className={styles.toolbarSlot}>
          <EditorToolbar floating tool={tool} mode="design" onMode={noop} onTool={noop} />
        </div>
      </Piece>

      <Cursor {...ada.state} color={CURSOR.purple} name="Ada" d={500} />
      <Cursor {...ken.state} color={CURSOR.green} name="Kerem" d={700} />
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
