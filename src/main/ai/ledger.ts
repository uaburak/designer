import type { AiBalance } from "../../shared/ai/types";
import { allowanceOf, policyOf, type OrgAiPolicy } from "../../shared/ai/orgPolicy";
import type { OrgSummary } from "../../shared/org/types";
import { storeClient } from "../storeHost";

export { policyOf };

/**
 * The usage ledger as main reads it (docs/ai.md §2.9, §2.12): the month's balance from the store's `ai` repository
 * (src/store/ai), against the allowance of Settings › AI — lowered to the smallest `aiCreditLimit` of the
 * organizations the person is a member of, and 0 when one of them turned AI off (Admin › Settings › AI), so the
 * credits stop refuses (`run.ts overLimitMessage`: no credits this month). Guests aren't governed by an org's limits
 * (src/shared/ai/orgPolicy.ts). The orgs' settings are read through the store and kept here for a minute. Null when
 * the store can't answer — the credits stop then never refuses.
 */
export async function ledgerBalance(allowance: number): Promise<AiBalance | null> {
  const store = storeClient();
  if (!store) return null;
  try {
    return await store.ai.balance(allowanceOf(allowance, await orgPolicy()));
  } catch {
    return null;
  }
}

const POLICY_TTL_MS = 60_000;
let cached: { at: number; policy: OrgAiPolicy } | null = null;

async function orgPolicy(): Promise<OrgAiPolicy> {
  const store = storeClient();
  if (!store) return { disabled: false, limit: null };
  if (cached && Date.now() - cached.at < POLICY_TTL_MS) return cached.policy;
  const orgs = await store.orgs.list().catch(() => [] as OrgSummary[]);
  const infos = await Promise.all(orgs.filter((o) => o.role !== "guest").map((o) => store.orgs.get(o.id).then((i) => ({ role: o.role, settings: i.settings }), () => null)));
  const policy = policyOf(infos.filter((x): x is NonNullable<typeof x> => x !== null));
  cached = { at: Date.now(), policy };
  return policy;
}

/** Forgets the cached org policy (tests; an org's settings changed) */
export function forgetOrgPolicy(): void {
  cached = null;
}
