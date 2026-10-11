/**
 * `identity` on StoreApi before round 4c (docs/multiplayer.md §15.12): every method refuses, so the views and the
 * Admin app compile against IdentityRepository. 4c replaces it with src/store/org/identity.ts in both stores.
 */
import type { IdentityRepository } from "../../shared/org/repositories";
import { StoreError } from "../../shared/store/protocol";

const notImplemented = (method: string) => (): Promise<never> =>
  Promise.reject(new StoreError("invalid", `identity.${method} isn't implemented yet (Phase 7 round 4c)`));

export function notImplementedIdentity(): IdentityRepository {
  return {
    overview: notImplemented("overview"),
    saveIdp: notImplemented("saveIdp"),
    refreshIdpMetadata: notImplemented("refreshIdpMetadata"),
    deleteIdp: notImplemented("deleteIdp"),
    generateScimToken: notImplemented("generateScimToken"),
    revokeScimToken: notImplemented("revokeScimToken"),
    addDomain: notImplemented("addDomain"),
    verifyDomain: notImplemented("verifyDomain"),
    removeDomain: notImplemented("removeDomain"),
    domainAccounts: notImplemented("domainAccounts"),
    dataRegion: notImplemented("dataRegion"),
    setDataRegion: notImplemented("setDataRegion"),
    moveNext: notImplemented("moveNext"),
  };
}
