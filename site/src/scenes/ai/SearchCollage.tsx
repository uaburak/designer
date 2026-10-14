// Visual search (docs/ai.md §6): the app's "Visual search" dialog (the ds Dialog, drawn in place, with
// editor/search/VisualSearch.module.css): a few words typed into "Search by keywords", and the frames and components
// of the files opened on this computer come back — components first, then "Other designs", what reads or looks the
// same. A result that shares no word with the search, "Garden store", is clicked and previews larger, with "Open the
// file" and "Insert".
import { useRef, useState } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { Dialog } from "@/ds/components/Dialog";
import { SearchField } from "@/ds/components/SearchField";
import { Select } from "@/ds/components/Select";
import { Tabs } from "@/ds/components/Tabs";
import vs from "@/editor/search/VisualSearch.module.css";
import { Collage, CURSOR, Cursor, FieldCaret, Piece, usePointer } from "../collage/kit";
import { noop } from "../collage/ui";
import { THUMBS } from "../collage/thumbs";
import type { Run } from "../runtime/motion";
import { pointOf } from "../together/pick";
import styles from "./ai.module.css";

const QUERY = "plant shop";
interface Hit {
  name: string;
  file: string;
  thumb: string;
}
const COMPONENTS: Hit[] = [
  { name: "Plant card", file: "Bloom — Design system", thumb: THUMBS.system },
  { name: "Shop header", file: "Bloom — Design system", thumb: THUMBS.brand },
];
const DESIGNS: Hit[] = [
  { name: "Plant shop — Home", file: "Bloom — App", thumb: THUMBS.mobile },
  { name: "Garden store", file: "Explorations", thumb: THUMBS.launch },
  { name: "Florist — Story", file: "Social", thumb: THUMBS.moodboard },
];
const PICK = 1;

export default function SearchCollage() {
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);
  const [shown, setShown] = useState(0);
  const [hover, setHover] = useState(false);
  const [preview, setPreview] = useState(false);
  const me = usePointer([720, 520]);
  const fieldRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<HTMLDivElement>(null);

  const script = async (run: Run) => {
    await run.wait(900);
    setTyping(true);
    await run.type(QUERY, setTyped, 11);
    setTyping(false);
    await run.wait(400);
    setShown(1);
    await run.wait(160);
    setShown(2);
    await run.wait(1400);
    const at = pointOf(pickRef.current?.querySelector("button"), [0.42, 0.55]);
    if (at) await me.to(run, at, { ms: 900 });
    setHover(true);
    await me.click(run, undefined, { beat: 420 });
    setHover(false);
    setPreview(true);
  };

  const tile = (h: Hit, i: number, designs?: boolean) => {
    const picked = designs && i === PICK;
    return (
      <div key={h.name} ref={picked ? pickRef : undefined} className={`${vs.tile} ${picked && hover ? styles.tileHover : ""}`}>
        <button type="button" className={vs.thumbButton} tabIndex={-1}>
          <span className={`${vs.thumb} ${styles.thumb}`}>
            <img src={h.thumb} alt="" />
          </span>
        </button>
        <div className={vs.meta}>
          <span className={vs.name}>{h.name}</span>
          <span className={vs.file}>{h.file}</span>
        </div>
        <div className={vs.actions}>
          <Button variant="primary">Insert</Button>
        </div>
      </div>
    );
  };

  const pick = DESIGNS[PICK];
  return (
    <Collage size={[860, 560]} focus={[0.5, 0.5]} safe={640} script={script}>
      <Piece x={110} y={36} w={640} d={0} from="up" className={styles.searchDialog}>
        <Dialog title="Visual search" size="large" open static onClose={noop}>
          <div className={`${vs.view} ${styles.searchView}`}>
            <div className={vs.bar}>
              <div ref={fieldRef} className={`${vs.field} ${styles.searchField}`}>
                <SearchField value={typed} onChange={noop} placeholder="Search by keywords" label="Search by keywords" />
                <FieldCaret host={fieldRef} text={typed} show={!preview} typing={typing} />
              </div>
              <IconButton icon="24.image" label="Search with image or selection" tooltip={false} />
            </div>
            <div className={vs.tabs}>
              <Tabs label="Results" value="figma" tabs={[{ value: "figma", label: "Figma" }]} onChange={noop} />
              <Select label="Library" value="" width="hug" variant="ghost" options={[{ value: "", label: "All libraries" }]} onChange={noop} />
            </div>
            <div className={vs.body}>
              {preview ? (
                <div className={`${vs.preview} ${styles.appear}`}>
                  <div className={vs.previewBar}>
                    <IconButton icon="24.arrow.left" label="Back" tone="secondary" tooltip={false} />
                    <span className={vs.name}>{pick.name}</span>
                    <span className={vs.file}>{pick.file} · Page 1</span>
                  </div>
                  <div className={vs.previewBox}>
                    <span className={`${vs.thumbLarge} ${styles.thumbLarge}`}>
                      <img src={pick.thumb} alt="" />
                    </span>
                  </div>
                  <div className={vs.previewActions}>
                    <Button variant="secondary" size="large">
                      Open the file
                    </Button>
                    <Button variant="primary" size="large">
                      Insert
                    </Button>
                  </div>
                </div>
              ) : (
                <div className={vs.results}>
                  <div className={styles.resultGroup} data-out={shown < 1 || undefined}>
                    <div className={vs.heading}>Components</div>
                    <div className={`${vs.grid} ${styles.grid}`}>{COMPONENTS.map((h, i) => tile(h, i))}</div>
                  </div>
                  <div className={styles.resultGroup} data-out={shown < 2 || undefined}>
                    <div className={vs.heading}>Other designs</div>
                    <div className={`${vs.grid} ${styles.grid}`}>{DESIGNS.map((h, i) => tile(h, i, true))}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Dialog>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
