/**
 * What organizations' Admin › Settings › AI (docs/ai.md §2.12) mean for one person: AI off when an org they are a
 * member of turned it off, and their monthly allowance lowered to the smallest `aiCreditLimit` of those orgs. Guests
 * aren't governed by an org's limits. Main's credits stop (src/main/ai/ledger.ts) and Settings › AI's balance use it.
 */
import type { OrgRole, OrgSettings } from "../org/types";

export interface OrgAiPolicy {
  /** An org the person is a member of turned AI off */
  disabled: boolean;
  /** The smallest monthly credit limit of those orgs, or null */
  limit: number | null;
}

export function policyOf(orgs: { role: OrgRole; settings: Pick<OrgSettings, "aiEnabled" | "aiCreditLimit"> }[]): OrgAiPolicy {
  let disabled = false;
  let limit: number | null = null;
  for (const o of orgs) {
    if (o.role === "guest") continue;
    if (o.settings.aiEnabled === false) disabled = true;
    const l = o.settings.aiCreditLimit;
    if (typeof l === "number" && Number.isFinite(l) && l >= 0) limit = limit === null ? l : Math.min(limit, l);
  }
  return { disabled, limit };
}

/** The allowance the credits stop counts against: 0 when AI is off for an org, else the smaller of the two */
export const allowanceOf = (own: number, p: OrgAiPolicy): number => (p.disabled ? 0 : p.limit === null ? own : Math.min(own, p.limit));
