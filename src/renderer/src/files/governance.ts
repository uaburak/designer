/**
 * Home's Governance+ gates (docs/governance.md §2.5): what blocks the person in an org, read from data Home already
 * has — `OrgSummary.gate` from the org list, or the gate a refused read carried (403 `{error, code, gate}`, handed on
 * by the store as StoreError "forbidden" with that body as `detail`) — and the account-wide network restriction
 * (403 `network_restricted`). No store calls: the components are in src/renderer/src/account/.
 */
import type { OrgGate } from "@shared/org/governance";
import type { OrgSummary } from "@shared/org/types";
import { isStoreError } from "@shared/store/protocol";

const GATE_CODES = new Set(["two_factor_required", "policy_acknowledgement_required", "ip_not_allowed"]);

const detailOf = (e: unknown): { code?: string; gate?: OrgGate } | null => (isStoreError(e) && e.detail && typeof e.detail === "object" ? (e.detail as { code?: string; gate?: OrgGate }) : null);

/** The gate a refusal carries (an org route, a file of the org), or null */
export function gateOfError(e: unknown): OrgGate | null {
  const d = detailOf(e);
  if (!d?.code || !GATE_CODES.has(d.code)) return null;
  if (d.gate) return d.gate;
  // A body without its gate (an older server): the kind from the code
  if (d.code === "two_factor_required") return { kind: "two_factor" };
  if (d.code === "ip_not_allowed") return { kind: "ip", ip: "" };
  return null;
}

/** The account-wide network restriction (§2.5): every route but a few answers it */
export const isNetworkRestricted = (e: unknown): boolean => detailOf(e)?.code === "network_restricted";

/** The gate in force: a policy gate without the policies agreed to in this session (the list may still be cached). */
export function effectiveGate(gate: OrgGate | null | undefined, agreed: ReadonlySet<string>): OrgGate | null {
  if (!gate) return null;
  if (gate.kind !== "policy") return gate;
  const policies = gate.policies.filter((p) => !agreed.has(p.id));
  return policies.length ? { kind: "policy", policies } : null;
}

/** The org's gate: the list's, else the one the last refused read carried */
export function orgGateOf(summary: Pick<OrgSummary, "gate"> | undefined, fromError: OrgGate | null | undefined, agreed: ReadonlySet<string>): OrgGate | null {
  return effectiveGate(summary?.gate ?? fromError ?? null, agreed);
}

// ---- File exporting (§2.7) ----

/** What `exportAllowedFor` reads: the store's `multiplayer` (the file's share state, then the server's file info). */
export interface ExportAccessStore {
  fileState(key: string): Promise<{ shared: boolean; role: string | null }>;
  fileInfo(key: string): Promise<{ access?: { canExport?: boolean } | null }>;
}

/**
 * Whether the person may export, duplicate or save a local copy of a file: local files, owners and editors may (one
 * local read); a shared file's viewer asks the server once (`access.canExport`; absent, an older server: allowed).
 * The editor's `loadExportAllowed` and Home's Duplicate / Save local copy… both read this.
 */
export async function exportAllowedFor(store: ExportAccessStore, fileKey: string): Promise<boolean> {
  const st = await store.fileState(fileKey).catch(() => null);
  if (!st?.shared || st.role !== "viewer") return true;
  const info = await store.fileInfo(fileKey).catch(() => null);
  return info?.access?.canExport !== false;
}
