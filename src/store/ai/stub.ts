/**
 * `ai` and `search` on StoreApi before round 6g / 6d (docs/ai.md §8): every method refuses, so the views compile against
 * AiRepository and SearchRepository. 6g (src/store/ai) and 6d (src/store/search) replace them in both stores.
 */
import type { AiRepository, SearchRepository } from "../../shared/ai/types";
import { StoreError } from "../../shared/store/protocol";

const notImplemented = (repo: string, method: string, round: string) => (): Promise<never> =>
  Promise.reject(new StoreError("invalid", `${repo}.${method} isn't implemented yet (Phase 7 round ${round})`));

export function notImplementedAi(): AiRepository {
  const n = (m: string) => notImplemented("ai", m, "6g");
  return { record: n("record"), balance: n("balance"), history: n("history"), skills: n("skills"), saveSkill: n("saveSkill"), removeSkill: n("removeSkill") };
}

export function notImplementedSearch(): SearchRepository {
  const n = (m: string) => notImplemented("search", m, "6d");
  return { upsert: n("upsert"), remove: n("remove"), versions: n("versions"), query: n("query"), thumb: n("thumb"), stats: n("stats"), clear: n("clear") };
}
