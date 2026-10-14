// Home: the file browser (the ds SidebarItem, SearchField and FileCard). A search is typed and the grid narrows to
// what matches, a file is starred, then the search is cleared and every file comes back. Thumbnails are small
// drawings of each file's first frame (thumbs.ts).
import { useState } from "react";
import { FileCard, FileKindIcon } from "@/ds/components/FileCard";
import { SearchField } from "@/ds/components/SearchField";
import { FolderIcon, SidebarDivider, SidebarHeader, SidebarItem } from "@/ds/components/SidebarItem";
import { Collage, CURSOR, Cursor, Piece } from "../collage/kit";
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

export default function FilesCollage() {
  const [query, setQuery] = useState("");
  const [starred, setStarred] = useState<string[]>(["c"]);
  const [me, setMe] = useState<[number, number, boolean?]>([1100, 600]);

  const script = async (run: Run) => {
    await run.wait(1000);
    setMe([1040, 92]);
    await run.wait(1000);
    setMe([1040, 92, true]);
    await run.wait(140);
    setMe([1040, 92]);
    for (let i = 1; i <= QUERY.length; i++) {
      await run.wait(170);
      setQuery(QUERY.slice(0, i));
    }
    await run.wait(900);
    setMe([798, 266]);
    await run.wait(1000);
    setMe([798, 266, true]);
    await run.wait(140);
    setStarred((s) => [...s, "b"]);
    setMe([798, 266]);
    await run.wait(1800);
    setQuery("");
    setMe([1000, 560]);
  };

  const shown = FILES.filter((f) => f.title.toLowerCase().includes(query));

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
              <SearchField value={query} onChange={noop} placeholder="Search files" size="large" />
            </div>
            <div className={styles.homeGrid}>
              {shown.map((f) => (
                <div key={f.id} className={styles.homeCard}>
                  <FileCard id={f.id} title={f.title} subtitle={f.subtitle} thumbnail={f.thumb} starred={starred.includes(f.id)} onStar={noop} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Piece>
      <Cursor x={me[0]} y={me[1]} press={me[2]} color={CURSOR.ink} d={400} z={30} />
    </Collage>
  );
}
