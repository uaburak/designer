/**
 * The Ready for dev view (docs/editor.md D-4; help.figma.com 23918228264855), over the canvas in Dev Mode: "Ready for
 * dev" with the count, filters All / Ready / Completed, sort Recent activity / Pages / Name (A-Z), and a card per
 * design — its thumbnail (the engine's, cached by the design's last edit), name, page, status and "Edited … ago". A
 * card opens the design in focus view. Opened from the left panel's "Ready for dev" row or a Dev Mode notification
 * (`OpenIntent.devMode = "ready"`).
 */
import { useEffect, useMemo, useState } from "react";
import { IconButton, ScrollArea, SegmentedControl, Select } from "@/ds";
import { ViewerDoc } from "../../../../viewer/viewerDoc";
import { editedAgo, STATUS_LABEL } from "../../../../viewer/inspect/devMode";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { openFocus } from "./devMode";
import { FILTERS, SORTS, filterReady, readyItems, sortReady, type ReadyItem } from "./readyFeed";
import { setRound5, useRound5, type Round5State } from "./round5";
import styles from "./DevMode.module.css";

const thumbs = new Map<string, string | null>();

function thumbnail(ed: EditorController, item: ReadyItem): string | null {
  const key = `${item.id}@${item.editedAt}`;
  if (thumbs.has(key)) return thumbs.get(key)!;
  let url: string | null = null;
  try {
    const px = ed.engine.renderNodeThumbnailPixels({ node: item.id, maxSize: 280 });
    if (px) {
      const c = document.createElement("canvas");
      c.width = px.width;
      c.height = px.height;
      c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
      url = c.toDataURL();
    }
  } catch {
    url = null;
  }
  thumbs.set(key, url);
  return url;
}

/** The view's items, read again after each committed change. */
export function useReadyItems(ed: EditorController): ReadyItem[] {
  const [version, setVersion] = useState(0);
  useEffect(() => ed.engine.on("DOCUMENT_CHANGED", () => setVersion((v) => v + 1)), [ed]);
  return useMemo(() => {
    void version;
    if (ed.engine.destroyed) return [];
    const doc = new ViewerDoc(ed.engine);
    return readyItems({
      pages: () => ed.engine.pages(),
      statuses: (page) => doc.statuses(page),
      times: (ids) =>
        (ed.engine.readNodes(ids, { fields: ["sectionStatusInfo", "editInfo"] }) as { sectionStatusInfo?: { lastUpdateUnixTimestamp?: number }; editInfo?: { lastEditedAt?: number } }[]).map((n) => ({
          editedAt: n?.editInfo?.lastEditedAt ?? 0,
          statusAt: n?.sectionStatusInfo?.lastUpdateUnixTimestamp ?? 0,
        })),
    });
  }, [ed, version]);
}

const selectView = (s: Round5State) => (s.ready ? `${s.readyFilter}|${s.readySort}` : null);

export function ReadyForDev() {
  const ed = useEditor();
  const dev = useUI((s) => s.mode === "dev");
  const view = useRound5(ed, selectView);
  if (!dev || !view) return null;
  const [filter, sort] = view.split("|") as [Round5State["readyFilter"], Round5State["readySort"]];
  return <ReadyView ed={ed} filter={filter} sort={sort} />;
}

function ReadyView({ ed, filter, sort }: { ed: EditorController; filter: Round5State["readyFilter"]; sort: Round5State["readySort"] }) {
  const all = useReadyItems(ed);
  const shown = useMemo(() => sortReady(filterReady(all, filter), sort), [all, filter, sort]);
  const close = () => setRound5(ed, { ready: false });
  const open = (item: ReadyItem) => {
    close();
    if (item.page !== ed.store.page) ed.engine.setCurrentPage(item.page);
    openFocus(ed, item.id);
  };
  return (
    <div
      className={styles.ready}
      role="region"
      aria-label="Ready for dev"
      data-ready-for-dev=""
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <header className={styles.readyHeader}>
        <span className={styles.readyTitle}>Ready for dev</span>
        <span className={styles.hint} data-ready-count="">
          {all.length}
        </span>
        <span className={styles.grow} />
        <SegmentedControl label="Filter" value={filter} options={FILTERS} onChange={(v) => setRound5(ed, { readyFilter: v as Round5State["readyFilter"] })} />
        <Select label="Sort" value={sort} options={SORTS} onChange={(v) => setRound5(ed, { readySort: v as Round5State["readySort"] })} variant="ghost" width="hug" />
        <IconButton icon="24.close.small" label="Close" onClick={close} />
      </header>
      <ScrollArea>
        {shown.length === 0 ? (
          <div className={styles.readyHeader}>
            <span className={styles.hint}>{filter === "completed" ? "No designs are marked as completed." : "No designs are marked ready for dev."}</span>
          </div>
        ) : (
          <div className={styles.readyGrid}>
            {shown.map((item) => (
              <ReadyCard key={item.id} ed={ed} item={item} onOpen={() => open(item)} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function ReadyCard({ ed, item, onOpen }: { ed: EditorController; item: ReadyItem; onOpen: () => void }) {
  const [src, setSrc] = useState<string | null>(() => thumbs.get(`${item.id}@${item.editedAt}`) ?? null);
  useEffect(() => {
    // Drawn after the view: a thumbnail is a small offscreen render.
    const t = setTimeout(() => setSrc(thumbnail(ed, item)), 0);
    return () => clearTimeout(t);
  }, [ed, item]);
  const ago = editedAgo(item.editedAt || item.statusAt);
  return (
    <button type="button" className={styles.readyCard} onClick={onOpen} data-ready-card={item.status}>
      <span className={styles.readyThumb}>{src && <img src={src} alt="" />}</span>
      <span className={styles.readyName}>{item.name}</span>
      <span className={styles.readyMeta}>
        <span className={styles.focusStatus} data-status={item.status}>
          {STATUS_LABEL[item.status]}
        </span>
        <span>{item.pageName}</span>
      </span>
      {ago && <span className={styles.hint}>{ago}</span>}
    </button>
  );
}
