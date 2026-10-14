// Home: the file browser (the ds SidebarItem, SearchField and FileCard). A search is typed and the grid narrows to
// what matches, a file is starred, then the search is cleared and every file comes back. Thumbnails are small
// drawings of each file's first frame (thumbs.ts).
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
  { id: "e", title: "Icons", subtitle: "Edited last week", thumb: THUMBS.icons },
  { id: "f", title: "Pitch deck", subtitle: "Edited last week", thumb: THUMBS.pitch },
];
const QUERY = "bloom";

const SEARCH: [number, number] = [1040, 92];
/** The star on the first card once the grid has narrowed (stage px). */
const STAR: [number, number] = [571, 153];

export default function FilesCollage() {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(false);
  const [typing, setTyping] = useState(false);
  const [filter, setFilter] = useState("");
  const [gone, setGone] = useState(false);
  const [starred, setStarred] = useState<string[]>(["c"]);
  const me = usePointer([1100, 600]);
  const gridRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  useFlip(gridRef, gone);

  const script = async (run: Run) => {
    await run.wait(1000);
    await me.click(run, SEARCH);
    setFocus(true);
    await run.wait(380);
    setTyping(true);
    await run.type(QUERY, setQuery, 3);
    setTyping(false);
    // The grid narrows after a short pause: the others fade, then the matches slide together
    await run.wait(320);
    setFilter(QUERY);
    await run.wait(260);
    setGone(true);
    await run.wait(700);
    await me.click(run, STAR);
    setStarred((s) => [...s, "b"]);
    await run.wait(1700);
    // Cleared: the files make room again, then fade back in, one after another
    setQuery("");
    setFocus(false);
    setGone(false);
    await run.wait(60);
    setFilter("");
    await me.to(run, [1000, 560], { ms: 1100 });
    await me.idle(run, [
      [960, 520],
      [1040, 470],
      [1000, 560],
    ]);
  };

  const out = (f: (typeof FILES)[number]) => !f.title.toLowerCase().includes(filter);

  return (
    <Collage size={[1312, 640]} focus={[0.42, 0.4]} safe={720} script={script}>
      <Piece surface x={56} y={56} w={1200} h={560} d={0} from="up">
        <div className={styles.home}>
          <div className={styles.homeSide}>
            <SidebarItem icon="24.recent" label="Recents" selected />
            <SidebarItem icon={<FileKindIcon />} label="Drafts" />
            <SidebarItem icon="24.star.outline" label="Starred" count={starred.length} />
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
