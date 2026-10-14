// Visual search (docs/ai.md §6): a few words typed into search, and the frames of the opened files come back: exact
// names first, then what looks or reads the same. The canvas follows the result under the pointer.
import { useLayoutEffect, useRef, useState } from "react";
import { SearchField } from "@/ds/components/SearchField";
import { Collage, CURSOR, Cursor, FieldCaret, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { BEZIER } from "../runtime/easing";
import { noop } from "../collage/ui";
import { THUMBS } from "../collage/thumbs";
import type { Run } from "../runtime/motion";
import styles from "./ai.module.css";

const QUERY = "plant shop";
const RESULTS: { name: string; file: string; thumb: string; kind: "name" | "like" }[] = [
  { name: "Plant shop — Home", file: "Bloom — App", thumb: THUMBS.mobile, kind: "name" },
  { name: "Plant shop — Landing", file: "Bloom — Landing", thumb: THUMBS.landing, kind: "name" },
  { name: "Garden store", file: "Explorations", thumb: THUMBS.wireframes, kind: "like" },
  { name: "Florist — Story", file: "Social", thumb: THUMBS.moodboard, kind: "like" },
];

export default function SearchCollage() {
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);
  const [shown, setShown] = useState(0);
  const [hover, setHover] = useState(-1);
  const me = usePointer([560, 500]);
  const fieldRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [rowTops, setRowTops] = useState<number[]>([]);
  useLayoutEffect(() => setRowTops(rowRefs.current.map((r) => r?.offsetTop ?? 0)), []);

  const script = async (run: Run) => {
    await run.wait(800);
    setTyping(true);
    await run.type(QUERY, setTyped, 11);
    setTyping(false);
    await run.wait(240);
    for (let i = 1; i <= RESULTS.length; i++) {
      setShown(i);
      await run.wait(70);
    }
    await run.wait(700);
    // Idle: the pointer wanders down the results, the canvas following each one
    for (let i = 0; !run.reduced; i = (i + 1) % RESULTS.length) {
      const y = 41 + (fieldRef.current?.offsetHeight ?? 52) + (rowRefs.current[i]?.offsetTop ?? i * 92) + 40;
      await me.to(run, [300 + (i % 2) * 18, y], { ms: 900, ease: BEZIER.standard, bend: 0.08 });
      setHover(i);
      await run.wait(2000);
    }
    setHover(0);
  };

  const at = Math.max(0, hover);
  return (
    <Collage size={[860, 560]} focus={[0.47, 0.5]} safe={760} script={script}>
      <Piece surface x={56} y={40} w={300} h={480} d={0} from="left">
        <div ref={fieldRef} className={styles.searchHead}>
          <SearchField value={typed} onChange={noop} placeholder="Search" />
          <FieldCaret host={fieldRef} text={typed} show={typing || (typed.length > 0 && hover < 0)} typing={typing} />
        </div>
        <div className={styles.results}>
          <span className={styles.resultsHover} data-on={hover >= 0 || undefined} style={{ transform: `translate3d(0, ${rowTops[at] ?? 0}px, 0)` }} />
          {RESULTS.map((r, i) => (
            <div key={r.name}>
              {(i === 0 || r.kind !== RESULTS[i - 1].kind) && (
                <span className={styles.resultsHeading} data-out={shown <= i || undefined}>
                  {r.kind === "name" ? "Names" : "Looks similar"}
                </span>
              )}
              <div ref={(el) => void (rowRefs.current[i] = el)} className={styles.result} data-out={shown <= i || undefined}>
                <img src={r.thumb} alt="" />
                <span>
                  {r.name}
                  <small>{r.file}</small>
                </span>
              </div>
            </div>
          ))}
        </div>
      </Piece>
      <FrameName x={420} y={88}>
        <span className={styles.swap}>
          {RESULTS.map((r, i) => (
            <span key={r.name} data-out={at !== i || undefined}>
              {r.name}
            </span>
          ))}
        </span>
      </FrameName>
      <Piece x={420} y={88} w={380} h={238} d={120} from="fade" className={styles.preview}>
        {RESULTS.map((r, i) => (
          <img key={r.name} src={r.thumb} alt="" data-on={at === i || undefined} />
        ))}
      </Piece>
      <Selection box={{ x: 420, y: 88, w: 380, h: 238 }} show={hover >= 0} />
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
