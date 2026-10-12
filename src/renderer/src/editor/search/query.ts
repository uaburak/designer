/**
 * A visual search (docs/ai.md §6, Figma's help 24037716110615): text — keywords or a description — becomes CLIP's
 * text vector and MiniLM's; a selected frame or an uploaded / pasted image becomes CLIP's image vector. The store ranks
 * (`0.6·clip + 0.4·text`, exact names first). Without the models a text search is the keyword search ("Without AI, it
 * matches only the exact keywords in names").
 */
import type { SearchHit, SearchKind, SearchQuery, SearchRepository } from "../../../../shared/ai/types";
import type { Embedder, RgbaImage } from "./embedder";
import { squareOnWhite } from "./indexer";

export interface SearchInput {
  text?: string;
  /** A selection's pixels or an image's */
  image?: RgbaImage;
  sort?: SearchQuery["sort"];
  kinds?: SearchKind[];
  libraryKey?: string;
  fileKey?: string;
  limit?: number;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** The models took part (false: names only) */
  semantic: boolean;
}

export class NoModelsError extends Error {
  constructor() {
    super("Visual search needs its models on this computer.");
  }
}

/** The query the store gets for `input` */
export async function searchQuery(input: SearchInput, embedder: Embedder | null): Promise<{ query: SearchQuery; semantic: boolean }> {
  const text = input.text?.trim() || undefined;
  const base: SearchQuery = { sort: input.sort ?? "relevance", ...(input.kinds ? { kinds: input.kinds } : {}), ...(input.libraryKey ? { libraryKey: input.libraryKey } : {}), ...(input.fileKey ? { fileKey: input.fileKey } : {}), ...(input.limit ? { limit: input.limit } : {}) };
  if (input.image) {
    if (!embedder) throw new NoModelsError();
    return { query: { ...base, clip: await embedder.image(squareOnWhite(input.image)) }, semantic: true };
  }
  if (!text) return { query: base, semantic: false };
  if (!embedder) return { query: { ...base, text }, semantic: false };
  const [clip, textVec] = await Promise.all([embedder.clipText(text), embedder.text(text)]);
  return { query: { ...base, text, clip, textVec }, semantic: true };
}

export async function runSearch(repo: Pick<SearchRepository, "query">, input: SearchInput, embedder: Embedder | null): Promise<SearchOutcome> {
  if (!input.image && !input.text?.trim()) return { hits: [], semantic: false };
  const { query, semantic } = await searchQuery(input, embedder);
  return { hits: await repo.query(query), semantic };
}

/** Components and sets first ("Figma tab shows components and designs"), then "Other designs" (frames) */
export function splitHits(hits: readonly SearchHit[]): { components: SearchHit[]; designs: SearchHit[] } {
  return { components: hits.filter((h) => h.doc.kind !== "frame"), designs: hits.filter((h) => h.doc.kind === "frame") };
}
