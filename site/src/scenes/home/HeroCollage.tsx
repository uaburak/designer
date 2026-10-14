// The home page's hero tile: a frame is drawn on the canvas (its size counting in the Design panel), Layers fills in
// as the page's parts land, a teammate drops a picture in, and the toolbar goes back to Move. The panels are the app's
// (file header, Layers, Design sections, the bottom toolbar), cut out and laid on the colour.
import { useState } from "react";
import { EditorToolbar } from "@/ds/components/EditorToolbar";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection } from "../collage/kit";
import { FileHeader, FrameSections, Layers, noop, PanelColumn, type Row } from "../collage/ui";
import { mix, type Run } from "../runtime/motion";
import { Sky } from "./art";
import styles from "./home.module.css";

const FRAME = { x: 404, y: 132, w: 504, h: 360 };

interface State {
  tool: "frame" | "move";
  drawn: number; // 0…1 of the frame
  parts: number; // how many of the page's parts have landed
  picture: boolean;
  me: [number, number, boolean?];
  ada: [number, number];
  ken: [number, number];
  select: "frame" | "image" | "button" | null;
}

const START: State = { tool: "frame", drawn: 0, parts: 0, picture: false, me: [300, 120], ada: [1150, 560], ken: [820, 640], select: null };

export default function HeroCollage() {
  const [s, setS] = useState<State>(START);
  const set = (p: Partial<State>) => setS((c) => ({ ...c, ...p }));

  const script = async (run: Run) => {
    await run.wait(700);
    set({ me: [FRAME.x, FRAME.y, true] });
    await run.wait(900);
    await run.tween(1300, (t) => setS((c) => ({ ...c, drawn: t, me: [FRAME.x + FRAME.w * t, FRAME.y + FRAME.h * t, true] })));
    set({ me: [FRAME.x + FRAME.w, FRAME.y + FRAME.h], select: "frame", tool: "move" });
    for (let i = 1; i <= 4; i++) {
      await run.wait(380);
      set({ parts: i });
    }
    await run.wait(500);
    set({ ada: [FRAME.x + 330, FRAME.y + 150], me: [FRAME.x + FRAME.w + 120, FRAME.y + FRAME.h - 40] });
    await run.wait(1200);
    set({ select: null, picture: true });
    await run.wait(900);
    set({ ken: [FRAME.x + 150, FRAME.y + 270] });
    await run.wait(1300);
    set({ select: "button" });
    // Idle: the two teammates keep working, slowly
    const spots: [number, number][] = [
      [FRAME.x + 360, FRAME.y + 120],
      [FRAME.x + 420, FRAME.y + 220],
      [FRAME.x + 300, FRAME.y + 300],
    ];
    for (let i = 0; !run.reduced; i++) {
      await run.wait(2600);
      set({ ada: spots[i % spots.length], ken: [FRAME.x + 150 + (i % 2) * 40, FRAME.y + 270 + (i % 3) * 8] });
    }
  };

  const w = mix(0, FRAME.w, s.drawn);
  const h = mix(0, FRAME.h, s.drawn);
  const rows: Row[] = [
    { id: "home", name: "Home", icon: "16.frame", strong: true, expanded: s.parts > 0, selected: s.select === "frame", hidden: s.drawn === 0 },
    { id: "nav", name: "Nav", icon: "16.autolayout.horizontal", depth: 1, hidden: s.parts < 1 },
    { id: "headline", name: "Weather that plans your week.", icon: "16.text", depth: 1, hidden: s.parts < 2 },
    { id: "button", name: "Get the app", icon: "16.autolayout.horizontal", depth: 1, hidden: s.parts < 3, selected: s.select === "button" },
    { id: "image", name: "Hero image", icon: "16.image", depth: 1, hidden: s.parts < 4, selected: s.select === "image" },
  ];

  return (
    <Collage size={[1312, 680]} focus={[0.5, 0.42]} safe={560} script={script}>
      {/* The canvas: the frame being drawn and what lands in it */}
      <FrameName x={FRAME.x} y={FRAME.y} selected={s.select === "frame"} show={s.drawn > 0}>
        Home
      </FrameName>
      <div className={styles.heroFrame} style={{ left: FRAME.x, top: FRAME.y, width: w, height: h, opacity: s.drawn > 0 ? 1 : 0 }}>
        <div className={styles.heroNav} data-out={s.parts < 1 || undefined}>
          <span className={styles.heroLogo} />
          <span>Orbit</span>
          <span className={styles.heroLinks}>Forecast&nbsp;&nbsp;&nbsp;Maps&nbsp;&nbsp;&nbsp;Pricing</span>
        </div>
        <div className={styles.heroHeadline} data-out={s.parts < 2 || undefined}>
          Weather that
          <br />
          plans your week.
        </div>
        <div className={styles.heroButtons} data-out={s.parts < 3 || undefined}>
          <span>Get the app</span>
          <span>See plans</span>
        </div>
        <div className={styles.heroImage} data-out={s.parts < 4 || undefined}>
          <span className={styles.heroImageEmpty}>
            <Icon name="24.image" />
          </span>
          <div className={styles.heroPicture} data-out={!s.picture || undefined}>
            <Sky />
          </div>
        </div>
      </div>
      {s.drawn > 0 && s.drawn < 1 && <Selection box={{ ...FRAME, w, h }} size={`${w} × ${h}`} />}
      <Selection box={FRAME} size={`${FRAME.w} × ${FRAME.h}`} show={s.select === "frame"} />
      <Selection box={{ x: FRAME.x + 290, y: FRAME.y + 92, w: 186, h: 190 }} show={s.select === "image"} />
      <Selection box={{ x: FRAME.x + 32, y: FRAME.y + 236, w: 104, h: 36 }} show={s.select === "button"} size="104 × 36" />

      {/* The panels */}
      <Piece surface x={40} y={56} w={240} d={100} from="left">
        <FileHeader name="Orbit — Website" />
        <Layers rows={rows} />
      </Piece>
      <Piece surface x={1032} y={56} w={240} d={250} from="right">
        <PanelColumn>
          <FrameSections x={FRAME.x - 404} y={0} w={w || FRAME.w} h={h || FRAME.h} radius={0} fill="#FFFFFF" />
        </PanelColumn>
      </Piece>
      <Piece x={406} y={560} w={500} h={60} d={400}>
        <div className={styles.toolbarSlot}>
          <EditorToolbar floating tool={s.tool} mode="design" onMode={noop} onTool={noop} />
        </div>
      </Piece>

      <Cursor x={s.ada[0]} y={s.ada[1]} color={CURSOR.purple} name="Ada" d={600} />
      <Cursor x={s.ken[0]} y={s.ken[1]} color={CURSOR.green} name="Kerem" d={900} />
      <Cursor x={s.me[0]} y={s.me[1]} press={s.me[2]} instant={s.drawn > 0 && s.drawn < 1} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
