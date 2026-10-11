/**
 * `plugins` on StoreApi before round 5g (docs/plugins.md §10.4): every method refuses, so the views compile against
 * PluginsRepository. 5g replaces it with the real repository in both stores.
 */
import type { PluginsRepository } from "../../shared/plugins/types";
import { StoreError } from "../../shared/store/protocol";

const notImplemented = (method: string) => (): Promise<never> =>
  Promise.reject(new StoreError("invalid", `plugins.${method} isn't implemented yet (Phase 7 round 5g)`));

export function notImplementedPlugins(): PluginsRepository {
  return {
    local: notImplemented("local"),
    setSaved: notImplemented("setSaved"),
    ranRecently: notImplemented("ranRecently"),
    listPrivate: notImplemented("listPrivate"),
    bundle: notImplemented("bundle"),
    publish: notImplemented("publish"),
    removePrivate: notImplemented("removePrivate"),
    allowed: notImplemented("allowed"),
    request: notImplemented("request"),
    admin: notImplemented("admin"),
    approve: notImplemented("approve"),
    unapprove: notImplemented("unapprove"),
    answer: notImplemented("answer"),
  };
}
