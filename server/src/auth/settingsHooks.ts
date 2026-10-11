/**
 * The identity settings' hooks (docs/multiplayer.md §15.6–§15.8), called by `patchSettings` (round 4b) for
 * `authMethod`, `idleSessionTimeoutHours` and `domainCapture`:
 *
 * - `validateIdentitySettings` (before saving; throws `HttpError`): the values' shapes; `authMethod: "saml"` needs an
 *   IdP configuration with a successful sign-in (`tested_at`, decision 7 — 409 `invalid` "Test SAML SSO first");
 *   `domainCapture: true` needs ≥ 1 domain, every one verified (409 `domain_unverified`).
 * - `onIdentitySettingsChanged` (after saving): logs `google_sso_auth_change` / `saml_sso_auth_change`,
 *   `idle_timeout_setting_change`, `org_domain_capture_change` — so `patchSettings` must **not** log these three keys
 *   itself — resets the org's people's sessions on an idle change (§15.8) and captures existing accounts when capture
 *   turns on (§15.7).
 */
import { IDLE_MAX_HOURS, IDLE_MIN_HOURS } from "../../../src/shared/org/identity";
import type { OrgSettings } from "../../../src/shared/org/types";
import { logActivity, orgEntity } from "../activity";
import type { Deps } from "../api";
import type { User } from "../db";
import { HttpError } from "../org/http";
import { captureExisting } from "./capture";
import { resetOrgSessions } from "./idle";
import { idpByOrg } from "./saml/config";

/** Refuses a patch the org can't take yet (throws `HttpError`) */
export async function validateIdentitySettings(deps: Deps, orgId: string, patch: Partial<OrgSettings>): Promise<void> {
  const d1 = deps.db.d1;
  if (patch.authMethod !== undefined) {
    if (patch.authMethod !== "any" && patch.authMethod !== "google" && patch.authMethod !== "saml") throw new HttpError(400, "authMethod", "invalid", { field: "authMethod" });
    if (patch.authMethod === "saml") {
      const idp = await idpByOrg(d1, orgId);
      if (!idp || idp.tested_at === null) throw new HttpError(409, "Test SAML SSO first", "invalid", { field: "authMethod" });
    }
  }
  if (patch.idleSessionTimeoutHours !== undefined) {
    const h = patch.idleSessionTimeoutHours;
    if (h !== null && (typeof h !== "number" || !Number.isInteger(h) || h < IDLE_MIN_HOURS || h > IDLE_MAX_HOURS))
      throw new HttpError(400, `The idle session timeout is ${IDLE_MIN_HOURS} hours to ${IDLE_MAX_HOURS / 24} days`, "invalid", { field: "idleSessionTimeoutHours" });
  }
  if (patch.domainCapture !== undefined) {
    if (typeof patch.domainCapture !== "boolean") throw new HttpError(400, "domainCapture", "invalid", { field: "domainCapture" });
    if (patch.domainCapture) {
      const r = await d1.prepare(`SELECT COUNT(*) AS n, COUNT(verified_at) AS v FROM org_domains WHERE org_id = ?1`).bind(orgId).first<{ n: number; v: number }>();
      if (!r?.n || r.v !== r.n) throw new HttpError(409, "Verify every domain before turning on domain capture", "domain_unverified", { field: "domainCapture" });
    }
  }
}

/** After the settings were saved: what the change sets off */
export async function onIdentitySettingsChanged(deps: Deps, orgId: string, before: OrgSettings, next: OrgSettings, actor: User, req: Request): Promise<void> {
  const org = await deps.db.d1.prepare(`SELECT id, name FROM orgs WHERE id = ?1`).bind(orgId).first<{ id: string; name: string }>();
  if (!org) return;
  const log = (action: "google_sso_auth_change" | "saml_sso_auth_change" | "idle_timeout_setting_change" | "org_domain_capture_change", details: Record<string, unknown>) =>
    logActivity(deps, { orgId, action, actor, entity: orgEntity(org), details, req });
  if (before.authMethod !== next.authMethod) {
    // Figma's two actions: SAML's when SAML is turned on or off, Google's otherwise
    const action = before.authMethod === "saml" || next.authMethod === "saml" ? "saml_sso_auth_change" : "google_sso_auth_change";
    await log(action, { from: before.authMethod, to: next.authMethod });
  }
  if (before.idleSessionTimeoutHours !== next.idleSessionTimeoutHours) {
    await resetOrgSessions(deps, orgId);
    await log("idle_timeout_setting_change", { from: before.idleSessionTimeoutHours, to: next.idleSessionTimeoutHours });
  }
  if (before.domainCapture !== next.domainCapture) {
    await log("org_domain_capture_change", { from: before.domainCapture, to: next.domainCapture });
    if (next.domainCapture) await captureExisting(deps, orgId, actor, req);
  }
}
