// Home: the file browser (the ds SidebarItem, SearchField and FileCard). Two steps (docs/site.md §2.1): a search is
// typed and the grid narrows to what matches, then one of the matches is starred where the cursor is. Then the scene
// rests. Thumbnails are small drawings of each file's first frame (thumbs.ts).
import { useRef, useState } from "react";
import { FileCard, FileKindIcon } from "@/ds/components/FileCard";
import { SearchField } from "@/ds/components/SearchField";
import { FolderIcon, SidebarDivider, SidebarHeader, SidebarItem } from "@/ds/components/SidebarItem";
import { Collage, CURSOR, Cursor, FieldCaret, Piece, useFlip, usePointer } from "../collage/kit";
import { noop } from "../collage/ui";
import type { Run } from "../runtime/motion";
import { THUMBS } from "../collage/thumbs";
import styles from "./features.module.css";

const FILES: { id: string; title: string; subtitle: string; thumb: string }[] = [
  { id: "a", title: "Orbit — Website", subtitle: "Edited 2 minutes ago", thumb: THUMBS.launch },
  { id: "b", title: "Bloom — App", subtitle: "Edited 1 hour ago", thumb: THUMBS.mobile },
  { id: "c", title: "Design system", subtitle: "Edited yesterday", thumb: THUMBS.system },
  { id: "d", title: "Bloom — Landing", subtitle: "Edited 3 days ago", thumb: THUMBS.landing },
];
const QUERY = "bloom";

/** Home, cut to two rows of files (stage px); on a phone the files and the search stay in view. */
const PIECE = { x: 226, y: 40, w: 860, h: 560 };
/** The search field, and the star on the first card once the grid has narrowed (stage px, measured). */
const SEARCH: [number, number] = [PIECE.x + 640, PIECE.y + 28];
const STAR: [number, number] = [PIECE.x + 516, PIECE.y + 98];

export default function FilesCollage() {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(false);
  const [typing, setTyping] = useState(false);
  const [filter, setFilter] = useState("");
  const [gone, setGone] = useState(false);
  const [starred, setStarred] = useState<string[]>(["c"]);
  const me = usePointer([PIECE.x + 700, 620]);
  const gridRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  useFlip(gridRef, gone);

  const script = async (run: Run) => {
    await run.wait(1100);
    await me.click(run, SEARCH, { beat: 260 });
    setFocus(true);
    await run.wait(400);
    setTyping(true);
    await run.type(QUERY, setQuery, 3);
    setTyping(false);
    // The grid narrows after a short pause: the others fade, then the matches slide together
    await run.wait(320);
    setFilter(QUERY);
    await run.wait(260);
    setGone(true);
    await run.wait(900);
    await me.click(run, STAR, { beat: 300 });
    setStarred((s) => [...s, "b"]);
  };

  const out = (f: (typeof FILES)[number]) => !f.title.toLowerCase().includes(filter);

  return (
    <Collage size={[1312, 640]} focus={[0.59, 0.5]} safe={640} script={script}>
      <Piece surface x={PIECE.x} y={PIECE.y} w={PIECE.w} h={PIECE.h} d={0} from="up">
        <div className={styles.home}>
          <div className={styles.homeSide}>
            <SidebarItem icon="24.recent" label="Recents" selected />
            <SidebarItem icon={<FileKindIcon />} label="Drafts" />
            <SidebarItem icon="24.star.outline" label="Starred" />
            <SidebarItem icon="24.trash.outline" label="Trash" />
            <SidebarDivider />
            <SidebarHeader title="Folders" />
            <SidebarItem icon={<FolderIcon />} label="Orbit" />
            <SidebarItem icon={<FolderIcon />} label="Bloom" />
            <SidebarItem icon={<FolderIcon />} label="Brand" />
          </div>
          <div className={styles.homeMain}>
            <div className={styles.homeHead}>
              <span>Recents</span>
              <div ref={fieldRef} className={styles.homeSearch} data-focus={focus || undefined}>
                <SearchField value={query} onChange={noop} placeholder="Search files" size="large" />
                <FieldCaret host={fieldRef} text={query} show={focus} typing={typing} />
              </div>
            </div>
            <div ref={gridRef} className={styles.homeGrid}>
              {FILES.map((f, i) => (
                <div key={f.id} className={styles.homeCard} data-flip="" data-out={out(f) || undefined} data-gone={(gone && out(f)) || undefined} style={{ ["--i" as string]: i }}>
                  <FileCard id={f.id} title={f.title} subtitle={f.subtitle} thumbnail={f.thumb} starred={starred.includes(f.id)} onStar={noop} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
