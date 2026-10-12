/**
 * Assets' "Similar" (docs/ai.md §6): a keyword search in the Assets tab "uses AI to return exact name matches plus
 * visually or functionally similar components" (Figma's help 24037716110615). Under the exact matches Assets lists,
 * the components the visual search index finds for the query (CLIP text → their pictures, MiniLM → their names and
 * texts), leaving out those already listed. Nothing shows without the models ("Without AI, it matches only the exact
 * keywords in names or descriptions").
 */
import { useEffect, useState } from "react";
import { showToast } from "@/ds";
import type { SearchHit } from "../../../../shared/ai/types";
import type { EditorController } from "../controller";
import { runSearch } from "./query";
import { insertHit, pngUrl, readyEmbedder, searchRepo } from "./runtime";

/** Similar components shown under the matches */
export const SIMILAR_LIMIT = 24;

/** A listed asset: its file (the library's key, or this file's) and its node */
export interface ListedAsset {
  fileKey: string;
  nodeId: string;
}

/** The query's similar components (none while it is empty or without the models) */
export function useSimilarComponents(query: string, listed: readonly ListedAsset[], libraryKey?: string): SearchHit[] {
  const [found, setFound] = useState<{ key: string; hits: SearchHit[] }>({ key: "", hits: [] });
  const listedKey = listed.map((a) => `${a.fileKey}/${a.nodeId}`).join(",");
  const key = `${query.trim()}\n${libraryKey ?? ""}\n${listedKey}`;
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let live = true;
    const setHits = (hits: SearchHit[]) => setFound({ key, hits });
    const t = setTimeout(() => {
      void (async () => {
        const embedder = await readyEmbedder();
        if (!embedder || !live) return setHits([]);
        const out = await runSearch(searchRepo(), { text: q, kinds: ["component", "componentSet"], libraryKey, limit: SIMILAR_LIMIT + listed.length }, embedder);
        if (!live) return;
        const skip = new Set(listedKey.split(","));
        setHits(out.hits.filter((h) => !h.exact && !skip.has(`${h.doc.fileKey}/${h.doc.nodeId}`)).slice(0, SIMILAR_LIMIT));
      })().catch(() => live && setHits([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listed by its key
  }, [key]);
  return query.trim() && found.key === key ? found.hits : [];
}

/** The "Similar" group: tiles (or rows) that insert an instance on click */
export function SimilarAssets({ ed, hits, view, styles }: { ed: EditorController; hits: readonly SearchHit[]; view: "grid" | "list"; styles: Record<string, string> }) {
  if (!hits.length) return null;
  const insert = (h: SearchHit) =>
    void insertHit(ed, h).then(
      (made) => (made ? ed.focusCanvas() : showToast({ message: "The instance couldn't be inserted" })),
      () => showToast({ message: "The library component couldn't be loaded", kind: "error" }),
    );
  return (
    <div role="group" aria-label="Similar" data-assets-similar="">
      <div className={styles.heading}>Similar</div>
      <div className={view === "grid" ? styles.grid : styles.list}>
        {hits.map((h) => (
          <button key={`${h.doc.fileKey}/${h.doc.nodeId}`} type="button" role="treeitem" data-similar-asset={h.doc.name} className={view === "grid" ? styles.tile : styles.row} aria-label={h.doc.name} title={`${h.doc.name}\n${h.doc.fileName}`} onClick={() => insert(h)}>
            {view === "grid" ? (
              <>
                <span className={styles.tileBox}>
                  <StoredThumb hit={h} className={styles.remoteThumb} />
                </span>
                <span className={styles.tileName}>{h.doc.name.split("/").pop()}</span>
              </>
            ) : (
              <span className={styles.rowName}>{h.doc.name.split("/").pop()}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The thumbnail the index keeps */
function StoredThumb({ hit, className }: { hit: SearchHit; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void searchRepo()
      .thumb(hit.doc.fileKey, hit.doc.nodeId)
      .then((png) => {
        if (!live || !png) return;
        made = pngUrl(png);
        setUrl(made);
      }, () => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [hit.doc.fileKey, hit.doc.nodeId, hit.doc.version]);
  return url ? <img src={url} alt="" draggable={false} className={className} /> : null;
}
