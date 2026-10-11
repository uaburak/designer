/**
 * `devMode` on StoreApi before round 5g (docs/editor.md D-8): every method refuses, so the views compile against
 * DevModeRepository. 5g replaces it with the real repository in both stores.
 */
import type { DevModeRepository } from "../../shared/devmode/types";
import { StoreError } from "../../shared/store/protocol";

const notImplemented = (method: string) => (): Promise<never> =>
  Promise.reject(new StoreError("invalid", `devMode.${method} isn't implemented yet (Phase 7 round 5g)`));

export function notImplementedDevMode(): DevModeRepository {
  return {
    devResources: notImplemented("devResources"),
    addDevResource: notImplemented("addDevResource"),
    editDevResource: notImplemented("editDevResource"),
    removeDevResource: notImplemented("removeDevResource"),
    codeConnect: notImplemented("codeConnect"),
    setCodeConnect: notImplemented("setCodeConnect"),
    removeCodeConnect: notImplemented("removeCodeConnect"),
    reportStatus: notImplemented("reportStatus"),
    viewed: notImplemented("viewed"),
    setStatusNotifications: notImplemented("setStatusNotifications"),
    prototypeMembers: notImplemented("prototypeMembers"),
    invitePrototype: notImplemented("invitePrototype"),
    removePrototype: notImplemented("removePrototype"),
  };
}
