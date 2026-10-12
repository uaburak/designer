/**
 * `StoreApi.cloud` for a store that keeps its files locally (the browser's dev store): no account's Drafts, no cache
 * to bound — Home shows the local workspace as before 1.1 (docs/cloud.md §2).
 */
import { DEFAULT_CACHE_LIMIT_BYTES, type CloudRepository, type CloudStatus } from "../../shared/store/cloud";

export function localOnlyCloud(): CloudRepository {
  const status = (): CloudStatus => ({ uid: null, online: false, checked: false, syncedAt: null, migration: null });
  const cache = () => ({ usedBytes: 0, limitBytes: DEFAULT_CACHE_LIMIT_BYTES, files: 0, pinned: 0 });
  return {
    status: async () => status(),
    refresh: async () => status(),
    cacheInfo: async () => cache(),
    setCacheLimit: async () => cache(),
    clearCache: async () => cache(),
    watch: () => () => {},
  };
}
