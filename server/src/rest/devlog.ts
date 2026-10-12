/**
 * Developer logs (docs/governance.md §2.12). STUB committed before round 14; 14d fills it and calls it from `restRoute`
 * for every `/v1` and `/v2` call on a Governance+ org's resource.
 */
import type { Deps } from "../api";

export interface DeveloperLogEntry {
  orgId: string;
  eventName: string;
  eventSource: "rest_api" | "mcp_server";
  userId: string | null;
  tokenId: string | null;
  tokenName: string | null;
  tokenType: "plan_access_token" | "personal_access_token" | "oauth_token" | "session";
  resource: { type: string | null; id: string | null; name: string | null };
  /** `CF-Connecting-IP` and `request.cf`'s place */
  ip: string;
  city: string | null;
  countryRegion: string | null;
  country: string | null;
}

export async function logDeveloperCall(_deps: Deps, _entry: DeveloperLogEntry): Promise<void> {}
