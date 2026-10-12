/**
 * Visual search's ranking (docs/ai.md §6): brute-force cosine over unit vectors, `0.6·clip + 0.4·text` when the
 * query has both, exact name matches first (Figma's Assets: "exact name matches plus visually or functionally
 * similar components" — help 24037716110615). Pure: the store's service and the tests use it.
 */
import type { SearchHit, SearchQuery } from "../../shared/ai/types";
import { dot, normalize, type IndexEntry } from "./format";

export const CLIP_WEIGHT = 0.6;
export const TEXT_WEIGHT = 0.4;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
/** Below this a semantic match isn't shown (unit cosines; CLIP text→image lands around 0.2–0.35 for a match) */
export const MIN_SCORE = 0.12;

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * How a name matches the query's words: 2 the name (or its last "/" part — "Button/Primary" for "primary") is the
 * query; 1 the name holds every word of it; 0 neither.
 */
export function nameMatch(name: string, query: string | undefined): 0 | 1 | 2 {
  const q = fold(query ?? "");
  if (!q) return 0;
  const n = fold(name);
  const last = n.split("/").pop()!.trim();
  if (n === q || last === q) return 2;
  return q.split(" ").every((w) => n.includes(w)) ? 1 : 0;
}

/** The query's vectors made unit length (callers may hand them as the model gave them). */
export function prepareQuery(q: SearchQuery): { clip: Float32Array | null; text: Float32Array | null } {
  return { clip: q.clip?.length ? normalize(q.clip) : null, text: q.textVec?.length ? normalize(q.textVec) : null };
}

/** One entry's semantic score against the prepared query; null when the query has no vectors. */
export function scoreOf(e: Pick<IndexEntry, "clip" | "text">, v: { clip: Float32Array | null; text: Float32Array | null }): number | null {
  const c = v.clip && e.clip.length === v.clip.length ? dot(v.clip, e.clip) : null;
  const t = v.text && e.text.length === v.text.length ? dot(v.text, e.text) : null;
  if (c !== null && t !== null) return CLIP_WEIGHT * c + TEXT_WEIGHT * t;
  return c ?? t;
}

/**
 * The hits of `entries` for `q`, best first: exact name matches (the whole name before the words of it), then by
 * score. A non-matching name needs a score ≥ MIN_SCORE. `sort: "modified"` orders the same hits newest first.
 * `keep` filters entries first (kinds, file, library, the files that still exist).
 */
export function rank(entries: Iterable<IndexEntry>, q: SearchQuery, keep: (e: IndexEntry) => boolean = () => true): SearchHit[] {
  const v = prepareQuery(q);
  const kinds = q.kinds?.length ? new Set(q.kinds) : null;
  const hits: (SearchHit & { tier: number })[] = [];
  for (const e of entries) {
    if (kinds && !kinds.has(e.doc.kind)) continue;
    if (q.fileKey && e.doc.fileKey !== q.fileKey) continue;
    if (q.libraryKey && (e.doc.fileKey !== q.libraryKey || e.doc.kind === "frame")) continue;
    if (!keep(e)) continue;
    const tier = nameMatch(e.doc.name, q.text);
    const score = scoreOf(e, v);
    if (!tier && (score === null || score < MIN_SCORE)) continue;
    hits.push({ doc: e.doc, score: score ?? 0, exact: tier > 0, tier });
  }
  hits.sort((a, b) => b.tier - a.tier || b.score - a.score || a.doc.name.localeCompare(b.doc.name) || a.doc.nodeId.localeCompare(b.doc.nodeId));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(q.limit ?? DEFAULT_LIMIT)));
  const top = hits.slice(0, limit);
  if (q.sort === "modified") top.sort((a, b) => b.doc.modifiedAt - a.doc.modifiedAt || b.score - a.score);
  return top.map(({ doc, score, exact }) => ({ doc, score, exact }));
}
