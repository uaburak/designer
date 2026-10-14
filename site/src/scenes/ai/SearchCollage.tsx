// Visual search (docs/ai.md §6): a few words typed into search, and the frames of the opened files come back: exact
// names first, then what looks or reads the same. The canvas follows the result under the pointer.
import { useState } from "react";
import { SearchField } from "@/ds/components/SearchField";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection } from "../collage/kit";
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
  const [typed, setTyped] = useState(0);
  const [shown, setShown] = useState(0);
  const [hover, setHover] = useState(-1);
  const [me, setMe] = useState<[number, number]>([560, 500]);

  const script = async (run: Run) => {
    await run.wait(900);
    for (let i = 1; i <= QUERY.length; i++) {
      await run.wait(90);
      setTyped(i);
    }
    for (let i = 1; i <= RESULTS.length; i++) {
      await run.wait(260);
      setShown(i);
    }
    await run.wait(600);
    for (let i = 0; i < RESULTS.length && !run.reduced; i = (i + 1) % RESULTS.length) {
      setHover(i);
      setMe([300, 150 + i * 92 + (i >= 2 ? 30 : 0)]);
      await run.wait(2200);
    }
    setHover(0);
  };

  const at = Math.max(0, hover);
  return (
    <Collage size={[860, 560]} focus={[0.47, 0.5]} safe={760} script={script}>
      <Piece surface x={56} y={40} w={300} h={480} d={0} from="left">
        <div className={styles.searchHead}>
          <SearchField value={QUERY.slice(0, typed)} onChange={noop} placeholder="Search" />
        </div>
        <div className={styles.results}>
          {RESULTS.map((r, i) => (
            <div key={r.name}>
              {(i === 0 || r.kind !== RESULTS[i - 1].kind) && (
                <span className={styles.resultsHeading} data-out={shown <= i || undefined}>
                  {r.kind === "name" ? "Names" : "Looks similar"}
                </span>
              )}
              <div className={styles.result} data-out={shown <= i || undefined} data-hover={hover === i || undefined}>
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
        {RESULTS[at].name}
      </FrameName>
      <Piece x={420} y={88} w={380} h={238} d={200} from="fade" className={styles.preview}>
        {RESULTS.map((r, i) => (
          <img key={r.name} src={r.thumb} alt="" data-on={at === i || undefined} />
        ))}
      </Piece>
      <Selection box={{ x: 420, y: 88, w: 380, h: 238 }} show={hover >= 0} />
      <Cursor x={me[0]} y={me[1]} color={CURSOR.ink} d={500} z={30} />
    </Collage>
  );
}
