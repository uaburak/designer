import type { AiBalance } from "../../shared/ai/types";
import { storeClient } from "../storeHost";

/**
 * The usage ledger as main reads it (docs/ai.md §2.9): the month's balance from the store's `ai` repository (6g's
 * src/store/ai). Until 6g merges the store's stub refuses, and this answers null — the credits stop then never
 * refuses. 6g may replace the body (e.g. the org's `aiCreditLimit` as the allowance); callers keep this signature.
 */
export async function ledgerBalance(allowance: number): Promise<AiBalance | null> {
  const store = storeClient();
  if (!store) return null;
  try {
    return await store.ai.balance(allowance);
  } catch {
    return null;
  }
}
