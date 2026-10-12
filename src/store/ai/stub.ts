/**
 * `search` on StoreApi before round 6d (docs/ai.md §8): every method refuses, so the views compile against
 * SearchRepository. 6d (src/store/search) replaces it in both stores. (`ai` is src/store/ai/service.ts since 6g.)
 */
import type { SearchRepository } from "../../shared/ai/types";
import { StoreError } from "../../shared/store/protocol";

const notImplemented = (repo: string, method: string, round: string) => (): Promise<never> =>
  Promise.reject(new StoreError("invalid", `${repo}.${method} isn't implemented yet (Phase 7 round ${round})`));

export function notImplementedSearch(): SearchRepository {
  const n = (m: string) => notImplemented("search", m, "6d");
  return { upsert: n("upsert"), remove: n("remove"), versions: n("versions"), query: n("query"), thumb: n("thumb"), stats: n("stats"), clear: n("clear") };
}
