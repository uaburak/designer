/**
 * The identity settings' hooks (docs/multiplayer.md §15.6–§15.8), called by `patchSettings` (round 4b) for
 * `authMethod`, `idleSessionTimeoutHours` and `domainCapture`. A stub both server agents compile against; round 4a
 * fills it (the `tested_at` / verified-domain checks, capture of existing accounts, the sessions' reset, their log
 * actions).
 */
import type { Deps } from "../api";
import type { User } from "../db";
import type { OrgSettings } from "../../../src/shared/org/types";

/** Refuses a patch the org can't take yet (throws `HttpError`) */
export async function validateIdentitySettings(_deps: Deps, _orgId: string, _patch: Partial<OrgSettings>): Promise<void> {}

/** After the settings were saved: what the change sets off */
export async function onIdentitySettingsChanged(_deps: Deps, _orgId: string, _before: OrgSettings, _next: OrgSettings, _actor: User, _req: Request): Promise<void> {}
