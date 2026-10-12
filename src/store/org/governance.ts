/**
 * Governance+ in the store (docs/governance.md §4; Phase 7 round 14). STUB committed before the round: every method
 * rejects with "not implemented" until round 14e fills it over the server's routes (14a–14d).
 */
import type { GovernanceRepository } from "../../shared/org/repositories";

export function governanceRepository(): GovernanceRepository {
  const notImplemented = (): Promise<never> => Promise.reject(new Error("governance: not implemented (round 14e)"));
  return {
    overview: notImplemented, setGovernancePlus: notImplemented, setIpAllowlist: notImplemented,
    addNetworkRange: notImplemented, setNetworkRange: notImplemented, removeNetworkRange: notImplemented,
    policies: notImplemented, createPolicy: notImplemented, setPolicyEnabled: notImplemented,
    setGuestExpiration: notImplemented, ekm: notImplemented, enableEkm: notImplemented, encryptNext: notImplemented,
    developerLogs: notImplemented, idps: notImplemented, saveIdp: notImplemented, refreshIdp: notImplemented,
    removeIdp: notImplemented, generateIdpScimToken: notImplemented, revokeIdpScimToken: notImplemented,
    mapDomain: notImplemented, pendingPolicies: notImplemented, acknowledgePolicy: notImplemented,
    twoFactor: notImplemented, setupTwoFactor: notImplemented, enableTwoFactor: notImplemented,
    regenerateRecoveryCodes: notImplemented, disableTwoFactor: notImplemented,
  };
}
