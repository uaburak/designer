import { forcedOffOf, type ReachCapability } from "../../../shared/agents/reach";
import type { OrgSummary } from "../../../shared/org/types";
import { storeClient } from "../../storeHost";

/**
 * The capabilities organizations forced off for this person (Admin › Settings › AI › agent access, docs/agents-reach.md
 * §3): read through the store as ledger.ts reads the AI policy, kept for a minute. Signed out or no store: none.
 */
const TTL_MS = 60_000;
let cached: { at: number; off: ReachCapability[] } | null = null;

export async function orgForcedOff(): Promise<ReachCapability[]> {
  const store = storeClient();
  if (!store) return [];
  if (cached && Date.now() - cached.at < TTL_MS) return cached.off;
  const orgs = await store.orgs.list().catch(() => [] as OrgSummary[]);
  const infos = await Promise.all(orgs.filter((o) => o.role !== "guest").map((o) => store.orgs.get(o.id).then((i) => ({ role: o.role, settings: i.settings }), () => null)));
  const off = forcedOffOf(infos.filter((x): x is NonNullable<typeof x> => x !== null));
  cached = { at: Date.now(), off };
  return off;
}

export function forgetOrgAccess() {
  cached = null;
}
