/**
 * Discovery (docs/governance.md §2.11). STUBS committed before round 14; 14d fills them. Writers (comments, reactions,
 * dev resources, cursor chat, AI prompts) call `recordDiscovery`; it drops events of orgs without Governance+ or with
 * `discovery` off.
 */
import type { Deps } from "../api";
import type { DiscoveryEvent } from "../../../src/shared/org/governance";

export interface DiscoveryRecord extends DiscoveryEvent { org_id: string }

export async function recordDiscovery(_deps: Deps, _events: DiscoveryRecord[]): Promise<void> {}

/** What the room's hourly alarm needs (the file room implements it) */
export interface DiscoveryRoom {
  fileKey: string;
  /** Last frame's time and author in the window */
  lastWrite(): { at: number; userId: string } | null;
}

/** The room's hourly alarm: when Discovery is on and the file changed, runs the `discovery_text` job and diffs it */
export async function discoveryAlarm(_room: DiscoveryRoom): Promise<void> {}
