# Governance+ (contract, Phase 7 round 14; written 2026-10-12, finalized the same day)

**Status: final.** The owner's answer to the open questions (2026-10-12): "do what makes most sense — we are free-tier and performance first". So the defaults hold, except key management, which is **managed only** (no AWS KMS path: it needs a paid AWS account and can't be tested). The shared types are committed as `src/shared/org/governance.ts` (§6) and the migration as `server/migrations/0018_governance.sql` (§7), checked on local D1.

Governance+ is Figma's paid Enterprise add-on (`docs/research/figma/R18-enterprise.md` A-8). It sits on top of `docs/multiplayer.md` §14 (orgs), §15 (identity and security) and §16 (REST). **(ours)** marks a choice Figma doesn't document, or a place where we differ on purpose. **(unverified)** marks a Figma fact we couldn't open.

Sources, read 2026-10-12:
- **[G+]** Governance+ for Figma Enterprise — https://help.figma.com/hc/en-us/articles/31825370509591 (13 features, read through a fetch summary)
- **[2FA]** Enable two-factor authentication — https://help.figma.com/hc/en-us/articles/360039817634
- **[copy]** Restrict copying and sharing on files — https://help.figma.com/hc/en-us/articles/360040045574
- **[disc]** Discovery — https://developers.figma.com/docs/rest-api/discovery/ , `/discovery-endpoints/` , `/discovery-schema/` , `/discovery-text-types/`
- **[devlog]** Developer logs — https://developers.figma.com/docs/rest-api/developer-logs/ , `/developer-logs-endpoints/`
- **[F-log]** Activity log action types and entity types — https://developers.figma.com/docs/rest-api/activity-logs-action-types/ , `/activity-logs-entity-types/`

## 1. What Figma does

- **Add-on gate** [G+]: Enterprise only. Every row below exists only with the add-on.
- **Restrict file exporting** [G+]:
  - Path: Admin › Settings › **External access** › **File exporting**.
  - Options: "Allow exporting by all viewers" (default), "Prevent exporting by guest viewers", "Prevent exporting for all viewers".
  - Editors always export. Workspace settings override the org's. Blocked actions are hidden or disabled.
  - The file-level setting is a separate thing [copy]: "Viewers can copy, share, and export from this file" (Share settings › Advanced). For viewers it blocks copying layers off the canvas, duplicating the file, downloading assets, and Save local copy.
- **IP allowlist** [G+]:
  - Path: Admin › Settings › Login and provisioning › **IP allowlist**.
  - Format: a comma-separated list of IPv4 addresses and IPv4 CIDR blocks. No hyphenated ranges; IPv6 isn't mentioned.
  - Prerequisite: every org domain is verified.
  - Applies to members; guests and org admins are exempt.
  - Requests from outside the list are denied, and the member is prompted to switch networks or accounts.
- **Network access restrictions** [G+]:
  - The setting is "Restrict external account access on this network". It is set up through Support: the admin gives IP ranges and proof of ownership, and Figma runs a shadow-mode test first.
  - Allowed on the network: accounts on the org's domain, the org's guests, and the accounts and guests of co-owning orgs.
  - Everyone else is prompted to switch to their work account. Pending invites can't be accepted on the network.
- **Extended idle session timeout** [G+]:
  - Path: Login and provisioning › **Session timeout** › Custom timeout, down to **15 minutes**.
  - Everything else is as §15.8 describes: members only, all platforms, a prompt at one minute, the shortest timeout wins, a change resets everyone's counters, and changes are logged.
- **Enforced 2FA for guests** [G+]:
  - Path: Admin › Settings › **Guest Membership** › **2FA for Guests**. Before saving, the admin sees how many guests will be blocked, then clicks Save.
  - Guests without 2FA get a "Blocked" badge. The members CSV gains a `2FA_enabled` column ("guests who use username/password").
  - Blocked guests lose access to all content at once. Open sessions continue. The guests are emailed, and admins are emailed when the setting is turned on.
  - Blocked guests can accept invites but can't open anything until they enable 2FA.
  - Figma's 2FA [2FA] lives in Settings › Security › "Enable two-factor authentication". It uses an authenticator app (6 digits) or SMS (7 digits), plus recovery codes. **Google SSO and SAML accounts can't enable 2FA in Figma.** Whether Google-SSO guests are blocked is **unverified**.
- **Multiple IdPs** [G+]:
  - Path: Login and provisioning › **Manage identity providers (IdP)** › **+ Add IDP** › **Edit configuration** (provider, metadata or entity ID / certificate, domains, then a test sign-in).
  - An "Identity providers" table lists each IdP with its domains. More › **Remove**.
  - Each domain maps to exactly one IdP; an IdP serves several domains.
  - Unmapped domains can't use SSO, but on Enterprise those people can still use other allowed methods.
  - A SCIM token per IdP is **unverified**.
- **Internal policies** [G+]:
  - Enabled through Support with an audience (members / guests / everyone), a cadence (once a year / once per user), a title and the full text.
  - The next time someone opens any content or page in the org, a modal shows the policy and they must agree. The button labels are unverified.
  - Admin › Settings › **Other** shows whether policies are enabled. Admins are emailed on enable and disable.
- **Enterprise Key Management** [G+]:
  - Uses the customer's AWS KMS key: a primary ARN plus a replica ARN for disaster recovery, one key per org, set up through a request form.
  - Encrypts file checkpoints and uploaded images and video. Not encrypted: metadata, comments, component definitions in databases.
  - New files are encrypted at once; existing files gradually.
  - If Figma loses the key, **all users are logged out and Figma is inaccessible** until it is restored.
  - Offboarding isn't supported. Localized hosting has to be set up first.
- **Discovery API** [disc]:
  - `GET /v1/discovery?start_date&end_date&file_ttl_in_seconds`. `start_date` must be at least 1 h in the past; at most 24 h per call; link lifetime 60–86400 s (default 86400).
  - Answer: `{error, status, meta: {urls: {"YYYY/MM/DD/HH": [url]}}, i18n}`.
  - Scope `org:discovery_read`, OAuth, org admins only, Tier 2.
  - Each hourly file is a JSON array of flat objects: `file_key, text, timestamp (s), action_type (insert|update|delete|transient), file_name, file_workspace_id, node_id, text_type, resource_id, parent_comment_id, user_id, user_email, user_billing_group_id, feature_entrypoint, moderation_failure_flags`.
  - `text_type` values: `in_file`, `file_comments`, `file_comment_reactions`, `developer_related_links`, `dev_mode_annotation`, `component_documentation_link`, `component_documentation_description`, `cursor_chat`, `user_ai_prompts`.
  - Retention is **unverified** (R18 said 30 days).
- **Developer Logs API** [devlog]:
  - `POST /v1/developer_logs`, plan access token only, scope `org:developer_log_read`, Tier 3, the last 30 days. A UI also exists at figma.com/developers/log.
  - Body: `token, token_name, user_email, ip_address` (prefixes; commas mean OR), `token_type (PLAN_ACCESS_TOKEN|PERSONAL_ACCESS_TOKEN|OAUTH_TOKEN)`, `event_source (REST_API|MCP_SERVER)`, `date_range (LAST_24H|LAST_7D|LAST_30D)`, `limit` (25, max 100), `cursor`.
  - Answer: `{status, error, meta: {items, cursor, has_more}}`. Each item: `{uuid, timestamp (ISO ms Z), action {event_name ("/v1/…" or an MCP tool name), event_source ("rest_api"|"mcp_server")}, actor {user_id, user_name, token_name, token_type (lower case), user_email}, resource {id_or_key, name, type, org_id}, context {ip_address, city, country_region, country}}`.
- **Also in Governance+, not in this round:**
  - **AI hosting controls** ("Restrict AI traffic to Figma's AWS environment"): our AI already runs on the owner's own providers (docs/ai.md).
  - **Figma Support visibility**: the owner is the support.
  - Both are listed so the inventory is whole. Not built.
- **Activity actions** [F-log], verified names:
  - 2FA: `mfa_required_setting_change`.
  - IP allowlist: `ip_allowlist_setting_change`, `ip_allowlist_range_create`, `ip_allowlist_range_delete`, `ip_allowlist_rejected`.
  - Network restrictions: `ip_restriction_change`, `network_access_restriction_range_create`, `network_access_restriction_range_update`, `network_access_restriction_range_delete`.
  - IdPs: `org_domain_idp_mapping_change`, `idp_config_create` / `_update` / `_delete`.
  - Policies: `policy_create`, `policy_update`, `policy_acknowledge`, with entity `policy_acknowledgement_config {id, title, audience, cadence, enabled_at, enabled_status}`.
  - Exporting: `file_export_controls_setting_change`, `workspace_file_export_controls_setting_change`.
  - Idle: `idle_timeout_setting_change`, `user_idle_session_timeout`.
  - **Figma publishes no names for** guest expiration, 2FA enrolment, EKM, Discovery or developer logs: ours below.
- **Guest expiration** [G+]:
  - Admin › Settings › External access › Guest membership › **Set default duration for guest access** (days; applies to guests who join afterwards).
  - Per guest, in People: **Guest access expiration date** › Change, or **Remove expiration date**. In bulk: **Set guest expiration date**. Workspace admins do the same in their Members tab.
  - A banner shows from two weeks before expiry. At expiry the guest is removed and the seat is freed. Everything is logged.

## 2. Decisions

1. **The add-on is a switch (ours).**
   - `orgs.governance_plus`, turned on and off by org admins in Admin › Billing › **Governance+** (Add / Remove). There's no payment, as with seats.
   - When it's off, every G+ route answers 403 `governance_plus_required`, and Admin shows the rows disabled with "Requires Governance+".
   - Turning it off keeps the stored values but stops enforcing them. The idle timeout is clamped to ≥ 12 h.
   - Turning it off is refused (409) while EKM is on, because Figma doesn't support offboarding.
2. **Self-serve where Figma needs Support (ours, as with the data region).** Network ranges, internal policies and EKM are set by org admins. There's no proof of ownership; network ranges must be IPv4 /16 or narrower and IPv6 /32 or narrower, so an admin can't block the internet.
3. **IP allowlist accepts IPv6 too (ours).** workers.dev reaches people over IPv6, so an IPv4-only list would block them. `CF-Connecting-IP` is the address. Members means `org_members.role = 'member'`; admins and guests are exempt (Figma).
4. **Guest 2FA is our own TOTP (ours; open question 1).**
   - Every account is Google, SAML or dev, and Figma doesn't let those accounts enable 2FA, so a literal copy would never block anyone.
   - Ours: any account can turn on TOTP in Settings › Security › **Enable two-factor authentication**: RFC 6238, SHA-1, 6 digits, 30 s, ±1 step, a QR code plus the key as text, and 10 recovery codes `xxxx-xxxx`.
   - Once it's on, every sign-in (Google or SAML) passes a server page "Enter the 6-digit code from your authenticator app" before the code reaches the loopback. The desktop app is unchanged.
   - Guests of an org with **2FA for Guests** on are blocked until they enable it.
   - No SMS (we send none).
5. **Gates.** Org-scoped blocks (guest without 2FA, an internal policy to acknowledge, an IP outside the allowlist) answer 403 with `{error, code, gate: OrgGate}` on every org route, file route of an org file, socket upgrade and `/v1` call on org resources. `GET /orgs` carries `OrgSummary.gate` so Home can prompt before opening a space. The network restriction is account-wide: 403 `network_restricted` on every authenticated route except `GET /me`, sign-out and `/me/sessions/current`, and `error=network_restricted` at sign-in.
6. **Internal policies.**
   - A policy can't be edited. Editing means disabling it and creating a new one, so people agree again.
   - "Once a year" means 365 days after the last agreement. Admins are members.
   - The modal is titled with the policy's title and shows its text; its buttons **Cancel** and **Agree** are ours (Figma's labels are unpublished). Cancel goes back to Drafts.
7. **Export restriction.**
   - `OrgSettings.fileExporting` and `WorkspaceSharingSettings.fileExporting` feed `FilePolicy.fileExporting`.
   - `resolveAccess`: `canExport = canEdit || (viewersCanCopy && !(fileExporting == "viewers_blocked" || (fileExporting == "guests_blocked" && viewer is not a member or admin of the file's org)))`. People who reach a file through a link and aren't in the org count as guests (ours).
   - **Also fixed in this round (base plan):** clients read `access.canExport`. Today the editor's `canExport` only checks the engine (R18's finding). Gated: Export…, Export frames to PDF, the Export panel, Copy as PNG / SVG / code, ⌘C of layers and Duplicate for viewers, and Save local copy.
   - Server: `POST /files/:key/activity {fig_file_export}`, REST `/v1/images` and image fills answer 403 `export_restricted` when `!canExport`.
8. **Idle timeout 15 min.** `idleSessionTimeoutHours` stays (in hours). With G+ it takes any multiple of 0.25 from 0.25 to 336; without, whole numbers from 12 to 336. 4a's hook range moves to the shared `validIdleHours`. Admin's row becomes "Session timeout", with minutes, hours or days.
9. **Multiple IdPs.**
   - `idp_configs` is rebuilt keyed by `tenant_id`, with `name`. Each IdP has its own tenant id, SP URLs and SCIM token.
   - `org_domains.idp_tenant_id` maps a domain. With exactly one IdP, unmapped verified domains use it (today's behaviour).
   - `authMethod: "saml"` applies to members whose domain is mapped; members on unmapped domains may use Google [G+]. Every IdP with a mapped domain must be tested first.
   - The round-4 single-IdP routes keep working on the oldest IdP.
10. **EKM on the free plan — managed keys only (owner, 2026-10-12).**
    - Cloudflare offers no KMS, and Figma's cross-account role needs an AWS identity of ours; we have none. An AWS KMS path would need a paid AWS account and couldn't be tested, so it is **not built**.
    - **Envelope encryption, `managed`:** the org's DEK (32 random bytes) is wrapped (AES-KW or AES-GCM) under the Worker secret `EKM_ROOT_KEY`. The UI says plainly that this protects stored bytes, not against the operator. Cloudflare already encrypts DO storage at rest. `KeySource` stays a type (`"managed"`) so another source can be added later without a migration of the API.
    - **Performance:** WebCrypto AES-GCM runs natively; one unwrap per room wake (cached in memory, re-checked hourly), no subrequests.
    - **Data:** AES-256-GCM per 1 MB row, with a header `"DV2E" | v1 | iv(12)`. Encrypted: the room's `snapshot`, `history_snapshots`, `history_frames`, `base_chunks`, `blobs`, `rest_blobs` (Figma's checkpoints and media). Plain: the live `frames` journal until compaction, `meta`, version metadata, libraries (component definitions; Figma doesn't encrypt them), D1.
    - **The room** unwraps the DEK on wake (it reads D1 itself), keeps it in memory, and re-unwraps every hour. A failure (the secret rotated or missing) sets `org_keys.state = 'unavailable'` and the org's files answer 503 `key_unavailable` (sockets and REST).
    - **Ours, differing from Figma:** we don't log everyone out, because an account spans orgs.
    - **Existing files:** each is encrypted on its next wake, plus an Admin loop `POST admin/key-management/encrypt-next` with progress (as the data-region move).
    - EKM can't be turned off.
11. **Discovery on the free plan.**
    - The Worker and the room can't decode kiwi within the CPU budget (§16.2 decision 6), so `in_file`, `dev_mode_annotation` and `component_documentation_*` come from a **room job** `discovery_text`.
    - When discovery is on and the file changed in the last hour, the room's hourly alarm asks a connected client or the helper (round 5's machinery) for every text-bearing node's `{nodeId, textType, text}`. The room diffs them against its own table `discovery_text (node_id, text_type, hash)` into insert / update / delete events.
    - Those events are stamped at the job's time (late jobs land in a later hour, so past hours never change) and attributed to the user who wrote the last frame in the window. That attribution is ours and approximate.
    - Comments, reactions and dev resources are written by their routes. Cursor chat: the room reads the presence `chat` text and records the final text of each message as `transient`.
    - AI prompts are **client-reported** by main's AI path (`POST /orgs/:org/discovery/ai-prompt`). This is weaker; it is marked `feature_entrypoint` and noted.
    - **Discovery is an org setting `discovery`, off by default (ours)**, because it captures everyone's text.
    - Rows live in D1 `discovery_events`, kept 30 days (unverified at Figma). Hourly files are generated at fetch time behind signed URLs `/v1/discovery/files/:org/:YYYY/:MM/:DD/:HH.json`.
    - Auth: a plan access token, or an org admin's PAT, with `org:discovery_read`. OAuth isn't built (§16.2).
12. **Developer logs.**
    - Every `/v1` and `/v2` call that touches an org's resource in a G+ org writes one `developer_logs` row in `restRoute`: city, country and region from `request.cf`; `event_name` = the path pattern.
    - MCP calls are local (`src/main/agents/mcpServer.ts`): main reports tool calls on org files in batches (`POST /orgs/:org/developer-logs/mcp`, client-reported, `event_source: "mcp_server"`).
    - `token_type` gains `"session"` (ours) for session Bearers.
    - Kept 30 days. The `token` filter hashes the secret and matches `access_tokens.token_hash`.
    - UI: Admin › Activity › **Developer logs** (ours; Figma uses figma.com/developers/log).
13. **Guest expiration.**
    - `org_members.expires_at`, set when a guest joins: now + `guestExpiryDays` (1–3650, ours).
    - Enforced lazily: an expired guest counts as not a member in `Access.rowsFor`. The daily cron at 03:17 removes them (§14.7 removal) and logs `org_user_delete {reason: "guest_expired"}`.
    - The banner text "Your guest access to ‹org› ends in ‹N› days." is ours.
14. **No new cron, no new Durable Object class.** Two of the free plan's five crons are used. Retention, guest expiry and network shadow counts ride the daily cron.

## 3. Activity log (ours where Figma publishes none)

- **Figma's names** are §1's list. `ip_allowlist_rejected` is written at most once per person per hour.
- **Ours:**
  - `governance_plus_enable` / `governance_plus_disable`
  - `org_guest_expiration_setting_change`, `org_user_guest_expiration_change`
  - `user_two_factor_enable` / `user_two_factor_disable`, written in each of the person's orgs
  - `ekm_enable`, `ekm_key_change`, `ekm_key_unavailable`, `fig_file_encrypt`
  - `discovery_setting_change`

## 4. Routes (sketch; JSON as §14.12)

- **Account:**
  - `GET /me/two-factor` → `TwoFactorStatus`
  - `POST /me/two-factor/setup` → `{secret, otpauthUrl}` (pending for 10 min)
  - `POST /me/two-factor/enable {code}` → `{recoveryCodes}`
  - `POST /me/two-factor/recovery-codes {code}` → `{recoveryCodes}`
  - `DELETE /me/two-factor {code}` → 204
  - Sign-in: `GET|POST /auth/2fa` (the page; form `{mt, code}`). `auth_codes.mfa_pending` blocks `/auth/token` until passed. 5 failures in 10 min → 429.
- **Org (members):**
  - `GET /orgs/:org/policies/pending` → `{policies: PolicyPrompt[]}`
  - `POST /orgs/:org/policies/:id/acknowledge` → 204
  - `POST /orgs/:org/discovery/ai-prompt`
  - `POST /orgs/:org/developer-logs/mcp`
- **Admin (`/orgs/:org/admin/…`):**
  - `GET governance` → `GovernanceOverview`
  - `PUT governance {governancePlus}`
  - `PUT ip-allowlist {enabled, ranges: string[]}` → the list is diffed, one log per range
  - `POST network-ranges {cidr}`, `PATCH network-ranges/:id {state: testing|enforced|disabled}`, `DELETE network-ranges/:id`
  - `GET|POST policies`, `PATCH policies/:id {enabled}`
  - `PUT guests/expiration {userIds, expiresAt | null}`
  - `GET key-management`, `PUT key-management EkmInput`, `POST key-management/encrypt-next`
  - `GET developer-logs?…` (the same filters as REST)
  - `GET|POST|PUT|DELETE identity/idps[/:tenantId]`, `POST identity/idps/:tenantId/refresh`, `POST|DELETE identity/idps/:tenantId/scim-token`, `PUT domains/:domain/idp {tenantId | null}`
  - `PATCH settings` gains `twoFactorForGuests`, `guestExpiryDays`, `fileExporting`, `discovery`, and quarter-hour `idleSessionTimeoutHours`.
  - `PATCH workspaces/:id {sharing.fileExporting}`.
- **REST:**
  - `GET /v1/discovery` (Tier 2), `GET /v1/discovery/files/…` (signed)
  - `POST /v1/developer_logs` (Tier 3, plan tokens only)
  - `TOKEN_SCOPES` gains `org:discovery_read`, `org:developer_log_read`.
- **New error codes:** `governance_plus_required`, `two_factor_required`, `two_factor_invalid`, `policy_acknowledgement_required`, `ip_not_allowed`, `network_restricted`, `key_unavailable`, `export_restricted`.

## 5. Chrome

- **Admin › Settings**, in Figma's sections:
  - **Login and provisioning:** Manage identity providers (IdP) — the table, + Add IDP, Edit configuration with domains, More › Remove; SCIM per IdP; **Session timeout** (Default 21 days / Custom timeout in minutes, hours or days); **IP allowlist** (a toggle plus the comma-separated field, with the caller's own IP shown).
  - **External access** (renames today's "Access"): Guest membership with **2FA for Guests** (a confirm: "‹N› guests will be blocked") and **Set default duration for guest access**; **File exporting** (the three radios; workspace overrides in Custom settings for workspaces); **Network access restrictions** (ranges with Testing / Enforced / Disabled and "‹N› accounts would have been blocked in the last 7 days").
  - **Other:** **Internal policies** (list, New policy with title, text, audience and cadence, Enable / Disable, acknowledged count); **Discovery** (toggle, ours).
  - **Data:** **Key management** (Turn on, with the managed-key note; state; "Encrypting files… N of M").
  - **Billing:** Governance+ Add / Remove.
- **People:** the guests' "Guest access expiration date" column, a "Blocked" badge, the Change / Remove expiration date actions, the bulk "Set guest expiration date", and the CSV's `2FA_enabled`.
- **Activity:** a **Developer logs** tab with filters (Token name, User email, IP address, Token type, Source, Date range) and Load more.
- **Clients:**
  - Settings › Security: Enable two-factor authentication (QR via `qrcode-generator` 1.4.4 exact, the key as text, code, recovery codes with Copy / Download), Regenerate recovery codes, Turn off.
  - `src/renderer/src/account/`: `PolicyModal`, `TwoFactorRequired` ("‹org› requires two-factor authentication for guests." + Set up two-factor authentication), `IpBlocked` ("‹org› only allows access from approved networks."), `NetworkRestricted` (full window, Log out), `GuestExpiryBanner`. All wording ours, marked unverified.
  - Home and the editor mount them from `OrgSummary.gate` and from 403 codes. The editor gates exporting by `access.canExport`, and the Share dialog's Advanced label becomes Figma's "Viewers can copy, share, and export from this file".
  - The idle option at 15 minutes needs no client change beyond Admin; main's `IdleTimer` already prompts at −60 s.

## 6. Shared types — `src/shared/org/governance.ts` (committed; the file is the contract)

They exist, with these names:
- `FileExporting = "all" | "guests_blocked" | "viewers_blocked"` and `FILE_EXPORTING_LABEL` (§1 labels); `viewerMayExport(p, isOrgMember)`.
- `IDLE_GOVERNANCE_MIN_HOURS = 0.25`; `validIdleHours(h, governancePlus)`.
- `GUEST_EXPIRY_WARNING_MS = 14 d`, `GUEST_EXPIRY_MAX_DAYS = 3650`.
- `IpRange {id, cidr, createdAt, createdBy}`; `NetworkRange extends IpRange {state, wouldBlock7d}`; `IpAllowlist`; `parseIp`; `normalizeCidr(s, kind)`: string | null (v4 and v6, `NETWORK_MIN_PREFIX` for network ranges); `ipInCidr(ip, cidr)` (IPv4-mapped v6 matches v4 ranges).
- `TOTP = {digits: 6, periodS: 30, window: 1}`; `base32Encode` / `base32Decode`; `totpCode(secret, counter): Promise<string>` (WebCrypto HMAC-SHA1, RFC 4226 truncation); `totpStep`, `verifyTotp(secret, code, now, lastStep)` (no replay); `otpauthUrl(secretB32, email, "DesignerV2")`; `generateRecoveryCode`; `TwoFactorStatus`, `TwoFactorSetup`, `TwoFactorEnabled`.
- `PolicyAudience = "members" | "guests" | "everyone"`, `PolicyCadence = "yearly" | "once"`; `InternalPolicy`, `InternalPolicyInput`, `PolicyPrompt`; `policyApplies(p, role)`; `needsAcknowledgement(p, lastAt, now)`; limits: title ≤ 200, text ≤ 20,000.
- `OrgGate = {kind: "two_factor"} | {kind: "policy", policies: PolicyPrompt[]} | {kind: "ip", ip: string}`.
- `KeySource = "managed"`; `EkmStatus`; `EkmInput`; `ENC_MAGIC = "DV2E"`, `ENC_VERSION`, `ENC_HEADER_BYTES`, `EKM_RECHECK_MS`.
- `DiscoveryTextType` (Figma's 9), `DiscoveryActionType`, `DiscoveryEvent` (§1 fields, snake_case), `DiscoveryResponse`; `discoveryHourKey(ms)`; `DiscoveryTextItem {nodeId, textType, text}`.
- `DeveloperLogItem`, `DeveloperLogsQuery`, `DeveloperLogsResponse` (§1 shapes, plus `token_type` `"session"`); `McpLogReport`.
- `GovernanceOverview`; `GovernanceErrorCode`; `GovernanceActivityAction` (§1 and §3); `GovernanceSignInError = "network_restricted" | "two_factor_failed"` with texts.
- `GovernanceRepository` is in `src/shared/org/repositories.ts` (admin calls, the members' policy calls, the caller's own 2FA); `StoreApi.governance`, the protocol's method list and the client are wired; both stores use the stub `src/store/org/governance.ts` until 14e.

Additions elsewhere:
- `OrgSettings` gains `twoFactorForGuests: false`, `guestExpiryDays: null`, `fileExporting: "all"`, `discovery: false`.
- `OrgInfo.governancePlus?`; `OrgSummary.gate?`, `OrgSummary.guestExpiresAt?`; `AdminPerson.twoFactor?`, `AdminPerson.guestExpiresAt?`.
- `FilePolicy.fileExporting?`, `WorkspaceSharingSettings.fileExporting?`, `RoomPolicy.discovery?`.
- `SignInError | GovernanceSignInError`; `IdentityOverview.idps?` and `IdpConfig.name? / domains?`, `IdpConfigInput.name?`.
- `RestScope` and `TOKEN_SCOPES` gain `org:discovery_read`, `org:developer_log_read` (also plan-token scopes); Admin's `ACTION_LABEL` has a first sentence per new action (14h refines).
- Server stubs: `server/src/governance/gate.ts` (`orgGate`, `networkCheck`: let everything through), `server/src/discovery/record.ts` (`recordDiscovery`, `discoveryAlarm`, `DiscoveryRoom`), `server/src/rest/devlog.ts` (`logDeveloperCall`, `DeveloperLogEntry`), `server/src/ekm/cipher.ts` (`RoomCipher`, `PLAIN_CIPHER`).
- `RestJob | {kind: "discovery_text"}`; `ActivityAction | GovernanceActivityAction`; `ErrorCode | GovernanceErrorCode`.

## 7. D1: migration `server/migrations/0018_governance.sql` (0017 is reserved for time-stamped comments)

```sql
-- Governance+ (docs/governance.md). Times are ms since the epoch.
ALTER TABLE orgs ADD COLUMN governance_plus INTEGER NOT NULL DEFAULT 0;

-- Multiple IdPs (§2.9): idp_configs keyed by tenant_id
PRAGMA defer_foreign_keys = true;
CREATE TABLE idp_configs_new (
  tenant_id     TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL CHECK (provider IN ('okta', 'entra', 'onelogin', 'google', 'custom')),
  idp_entity_id TEXT NOT NULL,
  sso_url       TEXT NOT NULL,
  certificates  TEXT NOT NULL,
  metadata_url  TEXT,
  signing       TEXT NOT NULL DEFAULT 'assertion' CHECK (signing IN ('assertion', 'assertion_or_response')),
  tested_at     INTEGER,
  created_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
INSERT INTO idp_configs_new (tenant_id, org_id, provider, idp_entity_id, sso_url, certificates, metadata_url, signing, tested_at, created_by, created_at, updated_at)
  SELECT tenant_id, org_id, provider, idp_entity_id, sso_url, certificates, metadata_url, signing, tested_at, created_by, created_at, updated_at FROM idp_configs;
DROP TABLE idp_configs;
ALTER TABLE idp_configs_new RENAME TO idp_configs;
CREATE INDEX idp_configs_org ON idp_configs (org_id, created_at);
CREATE UNIQUE INDEX idp_configs_entity ON idp_configs (org_id, idp_entity_id);
ALTER TABLE org_domains ADD COLUMN idp_tenant_id TEXT;
ALTER TABLE scim_tokens ADD COLUMN tenant_id TEXT;
UPDATE scim_tokens SET tenant_id = (SELECT tenant_id FROM idp_configs i WHERE i.org_id = scim_tokens.org_id);

-- Two-factor authentication (§2.4). secret: sealed base64 under a key derived from SESSION_SECRET.
CREATE TABLE user_two_factor (
  user_id            TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret             TEXT NOT NULL,
  enabled_at         INTEGER,
  pending_expires_at INTEGER,
  last_step          INTEGER NOT NULL DEFAULT 0,
  failed_count       INTEGER NOT NULL DEFAULT 0,
  failed_since       INTEGER,
  created_at         INTEGER NOT NULL
);
CREATE TABLE user_recovery_codes (
  user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   INTEGER,
  PRIMARY KEY (user_id, code_hash)
);
ALTER TABLE auth_codes ADD COLUMN mfa_pending INTEGER NOT NULL DEFAULT 0;

-- Guest expiration (§2.13)
ALTER TABLE org_members ADD COLUMN expires_at INTEGER;
CREATE INDEX org_members_expiry ON org_members (expires_at) WHERE expires_at IS NOT NULL;

-- IP allowlist and network access restrictions (§2.3, §2.2)
CREATE TABLE org_ip_ranges (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('allowlist', 'network')),
  cidr       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'enforced' CHECK (state IN ('testing', 'enforced', 'disabled')),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX org_ip_ranges_cidr ON org_ip_ranges (org_id, kind, cidr);
CREATE INDEX org_ip_ranges_kind ON org_ip_ranges (kind, state);
CREATE TABLE network_shadow_hits (
  range_id TEXT NOT NULL REFERENCES org_ip_ranges (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  day      INTEGER NOT NULL,
  PRIMARY KEY (range_id, user_id, day)
);

-- Internal policies (§2.6)
CREATE TABLE org_policies (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  text        TEXT NOT NULL,
  audience    TEXT NOT NULL CHECK (audience IN ('members', 'guests', 'everyone')),
  cadence     TEXT NOT NULL CHECK (cadence IN ('yearly', 'once')),
  enabled_at  INTEGER,
  disabled_at INTEGER,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX org_policies_org ON org_policies (org_id, enabled_at);
CREATE TABLE policy_acknowledgements (
  policy_id TEXT NOT NULL REFERENCES org_policies (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  at        INTEGER NOT NULL,
  PRIMARY KEY (policy_id, user_id)
);

-- Encryption key management (§2.10): managed keys only (the org's DEK wrapped under the Worker secret EKM_ROOT_KEY)
CREATE TABLE org_keys (
  org_id      TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'managed' CHECK (source IN ('managed')),
  wrapped_dek TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'unavailable')),
  checked_at  INTEGER,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
ALTER TABLE files ADD COLUMN encrypted_at INTEGER;

-- Discovery (§2.11): Figma's fields; hour = floor(timestamp / 3600)
CREATE TABLE discovery_events (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                   TEXT NOT NULL,
  hour                     INTEGER NOT NULL,
  file_key                 TEXT NOT NULL,
  text                     TEXT NOT NULL,
  timestamp                INTEGER NOT NULL,
  action_type              TEXT NOT NULL CHECK (action_type IN ('insert', 'update', 'delete', 'transient')),
  file_name                TEXT NOT NULL,
  file_workspace_id        TEXT,
  node_id                  TEXT,
  text_type                TEXT NOT NULL,
  resource_id              TEXT,
  parent_comment_id        TEXT,
  user_id                  TEXT NOT NULL,
  user_email               TEXT NOT NULL,
  user_billing_group_id    TEXT,
  feature_entrypoint       TEXT,
  moderation_failure_flags TEXT
);
CREATE INDEX discovery_events_hour ON discovery_events (org_id, hour, id);
CREATE INDEX discovery_events_age ON discovery_events (timestamp);

-- Developer logs (§2.12)
CREATE TABLE developer_logs (
  uuid           TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  at             INTEGER NOT NULL,
  event_name     TEXT NOT NULL,
  event_source   TEXT NOT NULL CHECK (event_source IN ('rest_api', 'mcp_server')),
  user_id        TEXT,
  user_name      TEXT,
  user_email     TEXT,
  token_id       TEXT,
  token_name     TEXT,
  token_type     TEXT NOT NULL,
  resource_type  TEXT,
  resource_id    TEXT,
  resource_name  TEXT,
  ip_address     TEXT NOT NULL,
  city           TEXT,
  country_region TEXT,
  country        TEXT
);
CREATE INDEX developer_logs_org ON developer_logs (org_id, at);
```

Checked 2026-10-12 on local D1 (`wrangler d1 migrations apply --local` over 0001–0016 with an IdP and a SCIM token, then 0018): the rebuild keeps the rows, `scim_tokens.tenant_id` is filled, `PRAGMA foreign_key_check` is empty. No view, trigger or foreign key references `idp_configs`.

## 8. The owner's answers (2026-10-12: "free-tier and performance first; decide")

1. **Guest 2FA:** our TOTP (§2.4). Free (no SMS), and the only form that can block anyone here.
2. **Key management:** managed only (§2.10). No AWS path.
3. **Discovery:** off by default, an admin switch (§2.11). When off, nothing is recorded and the room's hourly job doesn't run — no cost.
4. **Network restrictions and policies:** self-serve by org admins (§2.2), as the data region.
5. **IP allowlist:** IPv4 and IPv6 (§2.3).

## §9 As built — 14b, server org policy (2026-10-12)

Files: `server/src/governance/gate.ts` (filled; the `networkCheck` stub removed — 14a's `network.ts`), `ip.ts`, `policies.ts`, `guests.ts`, `routes.ts`, `governance.test.ts`; `server/src/org/` (`db.ts`, `orgs.ts`, `admin.ts`, `projects.ts`, `groups.ts`); `server/src/policy/sharing.ts`, `roomPolicy.ts`; `server/src/activity.ts`; `server/src/api.ts` (the `/files` routes, the socket, and `orgCtx` passing the request to `Access`); `server/src/index.ts`; `src/shared/org/access.ts` + test.

- **Gates (§2.5).** `Access` takes the request (`new Access(deps, user, req)`); `Access.gate(orgId)` is cached per request and runs **no query** when the org row it already read has `governance_plus = 0` or the caller isn't in the org, otherwise **one**: `gate.ts gateCols` — scalar subqueries behind `CASE WHEN o.governance_plus = 1` (the 2FA row, the enforced allowlist ranges as `json_group_array`, the enabled policies with the caller's last agreement). A second query runs only when a gate blocks (the policies' texts; the hourly `ip_allowlist_rejected` check). Order: `two_factor` (a guest, "2FA for Guests" on, no enabled `user_two_factor`), `policy` (pending prompts), `ip` (role `member`, `CF-Connecting-IP` outside every enforced range; no header → not checked). Thrown as 403 `{error, code, gate}` with `two_factor_required` / `policy_acknowledgement_required` / `ip_not_allowed` from `Access.requireMember` (every org route; `{gate: false}` for `GET /orgs/:org`, `DELETE /orgs/:org/me` and the policies routes), `requireTeam`, the folder and group routes, and every `/files/:key/…` route of an org file once access resolved (the socket upgrade included). Link visitors not in the org aren't gated. `GET /orgs` computes every org's gate in its one listing query (`OrgSummary.gate`); `GET /orgs/:org` carries it in `OrgInfo`. `orgGate(deps, user, orgId, req)` is the standalone form (one query) for other callers (REST, the room).
- **The add-on (§2.1).** `GET admin/governance` → `GovernanceOverview` (`ekm` is a placeholder read from `org_keys` / `files.encrypted_at`, `encrypting: null`); `PUT admin/governance {governancePlus}` → the overview; logged `governance_plus_enable` / `_disable`; removal refused 409 `conflict` while an `org_keys` row exists; removal clamps the idle timeout to `min(336, max(12, ceil(h)))` and then calls 4a's `onIdentitySettingsChanged` (sessions reset, `idle_timeout_setting_change`); Discovery's room policy is re-broadcast when the setting is on. Every other G+ route answers 403 `governance_plus_required` when off (org admins only, except `guests/expiration`); `PATCH admin/settings` refuses a change to `twoFactorForGuests`, `guestExpiryDays`, `fileExporting`, `discovery` without it (403, `field`), and the idle timeout takes `validIdleHours(h, governancePlus)` there (so 4a's hook no longer validates that key; it still logs it).
- **IP allowlist (§2.3).** No switch column: on = its `org_ip_ranges` rows are `enforced`, off (kept) = `disabled`. `PUT admin/ip-allowlist {enabled, ranges}` → `IpAllowlist`; each entry `normalizeCidr(s, "allowlist")` (400 `invalid` with `field`, `value`), ≤ 200, deduplicated; `enabled` with an empty list → 400; turning it on with an unverified org domain → 409 `domain_unverified` (Figma's prerequisite). Diffed: `ip_allowlist_range_create` / `_delete` per range, `ip_allowlist_setting_change` when on/off changed. No reauth of open sockets (Figma: requests are denied; open sessions continue — and free-plan cheap).
- **Network ranges (§2.2).** `GET|POST admin/network-ranges` → `{ranges}` / `{range}` (201), `PATCH network-ranges/:id {state}` → `{range}`, `DELETE` → 204. `normalizeCidr(s, "network")` (v4 ≥ /16, v6 ≥ /32), 409 on a duplicate; new ranges start in `testing`. `wouldBlock7d` = distinct `network_shadow_hits.user_id` with `day > today − 7` (`day = floor(ms / 86 400 000)`, `ip.ts dayOf`, for 14a's writer). Logs `network_access_restriction_range_create` / `_update` / `_delete`, plus `ip_restriction_change` when the org goes from no enforced range to some or back.
- **Internal policies (§2.6).** `GET|POST admin/policies` → `{policies}` / `{policy}` (201; created **enabled**); `PATCH admin/policies/:id {enabled}` → `{policy}` (re-enabling allowed; any other key → 400). Members: `GET /orgs/:org/policies/pending` → `{policies: PolicyPrompt[]}` (empty without the add-on), `POST /orgs/:org/policies/:id/acknowledge` → 204 (404 for a disabled policy or one whose audience excludes the caller; upsert of `at`). Entity `policy_acknowledgement_config` (`activity.ts policyEntity`); `policy_create`, `policy_update {enabled}`, `policy_acknowledge`. Admins are members: a members' policy gates Admin too until the admin agrees.
- **Guest expiration (§2.13).** `addPerson` sets `expires_at` for guests from `guestExpiryDays` (with the add-on); a role change to guest sets it the same way, to member/admin clears it. `PUT admin/guests/expiration {userIds, expiresAt | null}` → 204 (guests only; future times ≤ 3650 days; org admins, workspace admins for guests in their workspaces); `org_user_guest_expiration_change {from, to}`. Lazy: `Access.membership` and `GET /orgs` leave out a guest past `expires_at` in a G+ org. Cron: `index.ts` (deps now built by `depsOf(env)`) calls `sweepExpiredGuests` (≤ 500 a day) → `removeFromOrg(…, {reason: "guest_expired"})` (`removeFromOrg` gained a `details` argument); pending invites past expiry are deleted and logged the same way. People: `AdminPerson.twoFactor`, `guestExpiresAt` (guests), CSV column `2FA_enabled`; `OrgSummary.guestExpiresAt` / `OrgInfo.guestExpiresAt` for guests in G+ orgs.
- **File exporting (§2.7).** `policyOfFile` adds `fileExporting` (the workspace's `sharing.fileExporting`, else the org's) only with the add-on. `resolveAccess`: `canExport = canEdit || (viewersCanCopy && viewerMayExport(policy, membership is admin/member))`, in the org and prototype paths. `PATCH admin/workspaces/:id {sharing: {fileExporting}}` (403 without the add-on); logs `workspace_file_export_controls_setting_change` (and `workspace_public_link_setting_change` only when a link key changed); the org's key logs `file_export_controls_setting_change`. `POST /files/:key/activity {fig_file_export | fig_file_save_as}` and `GET /files/:key/snapshot?purpose=export` answer 403 `export_restricted` when `!canExport`.
- **Discovery's room policy.** `roomPolicyOf(policy, discovery)`; `x-policy` / `POST /room/policy` carry `discovery: true` only when on (the add-on and `settings.discovery`); `parseRoomPolicy` reads it. A change to `discovery` logs `discovery_setting_change` and broadcasts.
- **Tests:** `server/src/governance/governance.test.ts` (13 flows on node:sqlite); `src/shared/org/access.test.ts` +5 (48). Server, shared and store suites: 80 files, 631 tests green.
- **Deviations / for the main session:** (1) `src/shared/org/types.ts` put `governancePlus?` on `OrgFile`, not `OrgInfo` as §6 says — the server sends `OrgInfo.governancePlus` anyway (typed locally as `OrgInfo & {governancePlus}`); move the field. (2) The gate is not inside `Access.rowsFor` (listings use it too, where a 403 would be wrong): it is at the routes listed above; `rowsFor` gets the expired-guest rule through `membership`. (3) `api.ts`'s `orgCtx` line passes `req` to `Access` (outside the `/files` block, one argument). (4) `admin/key-management` isn't dispatched from `admin.ts` yet (14c's module didn't exist here): add `case "key-management"` there when it lands.

## 9. As built — 14a (server identity, 2026-10-12)

**Two-factor authentication** (`server/src/governance/twoFactor.ts`, routes as §4):
- The secret is 20 random bytes, sealed AES-256-GCM (iv 12 | ciphertext, base64url) under a key HKDF-derived from `SESSION_SECRET` (salt `designer/two-factor`), with the user id as additional data, so a row can't be moved to another account. Recovery codes are stored as `SHA-256(userId:code)`; input is case- and space-insensitive, the dash optional.
- `POST setup` overwrites a pending (never an enabled) row; `enable` refuses an expired setup with 409. `recovery-codes` and `DELETE` take a TOTP code or an unused recovery code; `enable` takes TOTP only.
- Replay: `last_step` moves with `UPDATE … WHERE last_step < step`, so a step (or an older one inside the ±1 window) is accepted once, even across two concurrent posts.
- Rate limit, ours in detail: one counter per account for every check (sign-in page and the `/me` routes). The 5th failure in the window already answers 429 (`rate_limited`), and so does every check until 10 minutes after the first failure, the right code included.
- Sign-in: `backWithCode` (auth/sso.ts), shared by Google's callback and the SAML ACS, now takes the user and the request. It checks the network restriction first (→ `error=network_restricted`), then, with 2FA on, stores the code with `mfa_pending = 1` for 10 minutes and redirects to `/auth/2fa?mt=`. `mt` is a signed token naming the pending code's hash and the app's state (no raw code in a URL). A right code takes the pending row atomically and hands the loopback a **fresh** 2-minute code. A used or expired challenge goes back with `error=two_factor_failed`; a forged `mt` gets "This sign-in link has expired". `/auth/token` (`Db.takeAuthCode`) never takes a pending code. `POST /auth/dev` has no second step.
- Page text: "Two-factor authentication", "Enter the 6-digit code from your authenticator app", button **Verify**, "Lost your device? Enter one of your recovery codes instead." (ours). Wrong code: "That code didn't work. Try again." (400 `two_factor_invalid` on the JSON routes).
- `user_two_factor_enable` / `_disable` are written with `logForUserOrgs` (every org the person is in, guests included).

**Network access restrictions, sign-in side** (`server/src/governance/network.ts`):
- `networkCheck(deps, user, req)`: the live ranges (kind 'network', state testing/enforced, orgs with `governance_plus = 1`) are one query on `org_ip_ranges_kind`. They are cached per isolate per D1 binding for `RANGES_TTL_MS` = 60 s, so an address outside every range costs no D1 read. A request from inside a range asks once, cached 60 s, whether the account is the org's (a member or guest of any role, or its email on a verified domain).
- Enforced → blocked. Testing → `INSERT … ON CONFLICT DO NOTHING` into `network_shadow_hits` (day = floor(ms / 86 400 000)), deduplicated in memory, written through `waitUntil`.
- **For 14b:** the range admin routes should call `forgetNetworkRanges(d1)` after a change, so this isolate sees it at once (other isolates within 60 s). Co-owning orgs aren't modelled.
- `authenticate` (session and PAT, also `/v1`, socket upgrades and previews) answers 403 `network_restricted` except `GET /me`, `/me/sessions/current` (any method), `DELETE /me/sessions` and `POST /auth/signout-everywhere` (`networkExempt`). The address is `CF-Connecting-IP`; without it there is no check.

**Multiple IdPs:**
- `idpByOrg` is now the oldest IdP (`ORDER BY created_at, tenant_id`); `idpsByOrg` lists them all.
- `idpForDomain(d1, org, domain)`: the mapped IdP. An unmapped verified domain uses the org's IdP when it has exactly one, and gets none otherwise. `POST /auth/sso` routes with it.
- The ACS also refuses (`sso_domain`) an email whose domain this IdP doesn't serve. `tested_at` is set per tenant.
- With `authMethod: "saml"`, Google's callback sends a member to the IdP serving their email's domain. With one IdP, off-domain members still go to it (round 4). With several, members on unmapped domains continue with Google.
- `validateIdentitySettings` for `saml`: with one IdP, it must be tested. With several, every IdP with a mapped domain must be tested, and at least one domain must be mapped.
- Routes as §4. They are G+ only (403 `governance_plus_required`); round 4's `identity/saml…` and `identity/scim-token` stay ungated on the oldest IdP. `PUT identity/saml` also accepts `name`.
- `POST idps` → 201; a second configuration of the same IdP entity → 409. `PUT idps/:t` with `{name}` alone renames.
- Changing or deleting an IdP that is in use (the only one, or one with mapped domains) while SAML is required → 409. Deleting is also refused when it would leave a sole untested IdP while SAML is required.
- Delete revokes the IdP's SCIM tokens (all of the org's when it was the last one), unmaps its domains (each logged `org_domain_idp_mapping_change {domain, from, to: null}`), and clears `saml_requests` only when it was the last IdP.
- `PUT domains/:domain/idp {tenantId | null}` → `{domain, tenantId}`. It returns 404 for another org's tenant, and 409 "Test SAML SSO first" when mapping to an untested IdP while SAML is required. A change is logged `{domain, from, to}`.
- `GET identity/idps` → `{idps}`: each `IdpConfig` with `name`, `domains` and **`scim: {baseUrl, token}`** (ours, not in the shared type — the per-IdP SCIM row of Admin). `IdentityOverview.idps` carries the same and is present only when the org has an IdP (round 4's shape stays exact without one). `idp` is the oldest IdP, with `name` and `domains`.
- SCIM: one live token per IdP (`scim_tokens.tenant_id`). A token authenticates only at its own tenant's `/scim/v2/:tenantId`; a token without a tenant serves the oldest IdP. Round 4's token routes are the oldest IdP's.
- SSO routing by mapping doesn't look at `governance_plus`: with the add-on removed, stored mappings keep routing (they restrict nothing). Only the admin routes are gated.

**Idle timeout:** `validateIdentitySettings` uses the shared `validIdleHours(h, orgs.governance_plus)`. **Open, for 14b:** `server/src/org/admin.ts` `patchSettings` still pre-checks `idleSessionTimeoutHours` as whole hours 12–336 (`pick(...)`) before the hook runs, so `PATCH admin/settings` refuses quarter hours until that line defers to the hook (or to `validIdleHours`). `idleLimitSql` already multiplies fractional hours correctly.

**Tests** (node:sqlite):
- `server/src/governance/twoFactor.test.ts` (8): RFC 6238 vectors through the shared helper and the sealed secret, setup/enable/regenerate/disable with activity in two orgs, step replay, the 429 lockout, PAT refused, the Google challenge (pending code refused by `/auth/token`, single use), recovery codes at sign-in, the SAML challenge.
- `server/src/governance/network.test.ts` (4): enforce (IPv4 and IPv6, exempt routes, members, guests and domain accounts pass, PAT refused, sign-out), `error=network_restricted` at sign-in, no G+ or disabled → open, the cache TTL, shadow hits once per day.
- `server/src/auth/idps.test.ts` (6): the G+ gate, add/list/rename/duplicate, mapping and its log, SSO and ACS routing, unmapped domains with one IdP and with several, SAML required only on mapped domains, removal, SCIM per IdP, quarter-hour idle validation.

## 9. As built — 14c (server key management)

- **Files:** `server/src/ekm/` — `cipher.ts` (the AES-256-GCM `RoomCipher`: `"DV2E" | 1 | iv(12) | ciphertext + tag`, the 5-byte prefix as associated data; `isSealed`, `SealError`), `keys.ts` (managed wrapping: `org_keys.wrapped_dek = "v1." + base64(iv | AES-GCM(DEK))` under `EKM_ROOT_KEY`, the org id as associated data; the root key imported once per isolate), `rows.ts` (sealing 1 MB rows before a transaction, sealing what's plain after one, sweeps, the move's plain-row check), `roomKey.ts` (the room's key: one D1 read per wake and per `EKM_RECHECK_MS`), `room.ts` (`RoomEkm`: the gate, `POST /room/ekm/encrypt`, `rest_blobs`), `routes.ts` (`keyManagementRoute`), `ekm.test.ts`. Changed: `server/src/roomBox.ts`, `server/src/fileRoom.ts`. `policy/dump.ts` unchanged.
- **Dispatch (api.ts, one line, before the `parts[0] === "orgs"` line):** `if (parts[0] === "orgs" && parts[2] === "admin" && parts[3] === "key-management") return (await import("./ekm/routes")).keyManagementRoute(orgCtx());`
- **Env:** `EKM_ROOT_KEY` is declared on `fileRoom.ts`'s `RoomEnv` and read in the routes as `(env as EkmEnv)`; api.ts's `Env` isn't changed.
- **Writes are sealed before the synchronous transaction** (snapshot, base, blobs, a version's snapshot). A version copies the journal's frames into `history_frames` in plain inside its transaction and seals them right after (meta `ekmDirty` until done; an object stopped in between seals them on its next wake). Copies of rows (a version's snapshot from `snapshot`, the base promoted from `next`, a move's dump) carry the sealed bytes as they are.
- **Meta `ekm` = 1** marks a room whose rows were all sealed; such a room that finds no key in D1 is `unavailable`, not plain. A room's first wake with the org's key (new files at once, existing files on their next wake) sweeps its tables and sets `files.encrypted_at`, logging `fig_file_encrypt` with no actor (`details.trigger: "wake"`); `encrypt-next` logs it with the admin (`trigger: "admin"`). Each sweep UPDATE names the bytes it read, so a row replaced meanwhile is left alone.
- **The gate:** every room call but the keyless ones (a move's freeze / dump / load / unfreeze, `DELETE /room`, notices, policy, reauth / revoke) answers 503 `{code: "key_unavailable"}` while the key can't be unwrapped. A room whose hourly re-check fails sends `{t: "error", code: "key_unavailable"}` to every socket and closes them with 4003; frames arriving then get the same. The alarm skips the autosave while the key is unavailable. A row that fails to open answers the same 503.
- **`org_keys.state` / `checked_at`:** written only on a transition (the first room or the Admin GET that sees the key fail sets `unavailable` and logs `ekm_key_unavailable` once; one that unwraps it again sets `ok`). The Admin `GET key-management` tries the root key itself and records `checked_at`.
- **REST tables:** `rest_blobs` is `RestJobs`' (rest/roomJobs.ts, unchanged); `RoomEkm.rest` in front of it reads `GET /room/rest-blob/:sha1` (also the image-fill fallback to `blobs`) and `GET /room/thumbnail` opened, and seals a part / thumbnail right after RestJobs stored it.
- **Region move:** ciphertext is copied as is (same org, same DEK). A page carrying plain rows of the encrypted tables (read from the base64 text, `RFYyRQ[E-H]` is the header) sets `ekmDirty` on the copy, which seals them on its next check. `POST /room/ekm/encrypt` answers 503 `moving` while the room is frozen for a move, and the wake sweep doesn't run then.
- **Not done / ours:** the room learns its file key from `ctx.id.name` (or any call's `?fileKey=`); `roomsOn` doesn't send one on socket calls, so a runtime without `id.name` writes plain until a REST or `encrypt-next` call names the file. Rooms awake when an admin turns EKM on learn it at their hourly re-check (or `encrypt-next`). Version sizes stay the plain sizes.
- **Tests:** `server/src/ekm/ekm.test.ts`, 17 — the cipher and wrapping (wrong / missing / malformed root key, another org's row), the routes (admins only, `governance_plus_required`, no root key → 503, idempotent enable, 405 on DELETE, GET's check), the room round trip, mixed plain and sealed rows, lazy encryption on wake and at the hourly re-check, frames left plain by a stopped object, `rest_blobs`, 503 to calls and sockets with a wrong or missing root key (logged once, recovered), encrypt-next to completion and its 503, and the region move of an encrypted room and of a plain one into a keyed org (through `policy/region.ts moveObject`).

## §9 As built — 14d, server Discovery and developer logs (2026-10-12)

Files: `server/src/discovery/record.ts` (filled), `rest.ts`, `routes.ts`, `discovery.test.ts`; `server/src/rest/devlog.ts` (filled), `index.ts`, `scopes.ts`, `signedUrl.ts`, `roomJobs.ts`; `src/shared/multiplayer/room.ts`; `server/src/comments.ts`, `server/src/devmode/devResources.ts`, `server/src/index.ts`.

- **The cheap check.** `governanceOrgs(d1)`: one query (`SELECT id, json_extract(settings, '$.discovery') FROM orgs WHERE governance_plus = 1`) per isolate per D1 binding per `ORGS_TTL_MS` = 60 s, giving the G+ orgs (developer logs) and those with Discovery on. `recordDiscovery` drops rows of other orgs; `fileTextEvents` reads nothing more when no org has Discovery on. `forgetGovernanceOrgs(d1)` drops the cache (the settings routes may call it; other isolates see a change within 60 s). Rows go in with one `INSERT … SELECT … FROM json_each(?)` per 500.
- **Writers.** Comments (`changed` records the change's texts after the answer): `file_comments` insert / update / delete (a delete's text is empty), `file_comment_reactions` insert / delete with `resource_id` = `‹commentId›:‹emoji›` and `parent_comment_id` = the comment (ours). Dev resources: `developer_related_links`, text "‹name› ‹url›" (ours), insert / update / delete; `editResource` gained an optional `user` (REST edits are attributed to the link's creator). Everything through `afterAnswer` (`waitUntil`; inline where there is none).
- **Cursor chat.** The shared `Room` captures, only for members whose policy has `discovery: true`, the last writer of each accepted frame and each chat message's final text (the bubble closed, emptied, replaced by unrelated text, or the member left; ≤ 200 chars) — `drainDiscovery(): DiscoveryCapture | null`. No I/O in shared code.
- **The room's job.** `DiscoveryRoom {fileKey(), sql, now(), d1, rest}`; `discoveryTake(room, capture)` keeps the last writer in the room's own `discovery_meta` (persisted when the writer changes or at most once a minute) and records chats (`cursor_chat`, `transient`); it returns when the alarm should ring: `max(lastRun + 1 h, firstWrite + 10 min)` (`DISCOVERY_QUIET_MS`, ours: not while someone types). `discoveryAlarm(room)` runs when due: org still on → `discovery_text` job (never cached; its part is read with `RestJobs.partBytes` and dropped with `dropParts`; gzip or plain JSON accepted) → `diffTexts` against `discovery_text (node_id, text_type, hash SHA-1)` → events stamped at the job's time, attributed to the window's last writer. No client → retried in an hour. Off → the pending change is forgotten. The tables exist only in rooms that recorded something; `roomBox.ROOM_TABLES` doesn't copy them (a region move re-inserts every text once).
- **REST.** `GET /v1/discovery` (Tier 2, `org:discovery_read`, plan token or an org admin's PAT/session; `org_id` when the admin has several orgs; 403 without G+): `start_date` / `end_date` Unix seconds (ISO taken), `end_date` default start + 24 h; only **complete** hours that hold events are listed, one signed URL per 5,000 rows (`HH.json`, `HH-1.json`, … — ours). `/v1/discovery/files/…` is a signed route (`signPathFor`, seconds), generated from D1 at fetch time. `POST /v1/developer_logs` (Tier 3, plans only → 403 otherwise, 403 without G+), Figma's body; `date_range` defaults to `LAST_30D` (ours), comma lists ≤ 10 values, newest first, the cursor is base64url `at:uuid`.
- **The log line.** `restRoute`'s `dispatch` computes the line once the caller and the target org are known (`developerLogLine`: null unless the org is G+), and writes it in `finally` through `waitUntil` — failed calls too. `event_name` = `pathPattern` ("/v1/files/:file_key/comments/:comment_id/reactions"); resource file / team / project / webhook / org; names, emails and token names are read by the INSERT itself. PAT calls on routes without a target org (e.g. `/v1/me`) aren't logged.
- **Client reports.** `discovery/routes.ts memberReportRoute`: `POST /orgs/:org/discovery/ai-prompt` (members and guests; `user_ai_prompts`, `transient`, `feature_entrypoint` = feature, stamped at receipt; a file outside the org → no file) and `POST /orgs/:org/developer-logs/mcp` (≤ 100 calls; `mcp_server`, token type `session`; `at` kept when within the last day; files outside the org dropped). 204 either way.
- **Admin.** `adminDeveloperLogs(ctx, orgId)` in `rest/devlog.ts` (query parameters as REST's body; 403 `governance_plus_required`).
- **Retention.** `sweepGovernanceLogs(d1, now)` in the daily cron.
- **Tests:** `server/src/discovery/discovery.test.ts` (12). Server, shared and store suites: 84 files, 661 tests green.
- **For the main session (files 14d may not edit):** the dispatch lines in `api.ts` and `org/admin.ts`, and the `FileRoom` lines (drain after `receive` / `leave`, `discoveryAlarm` in `alarm()`, `forgetDiscoveryRoom` on `DELETE /room`) — given in 14d's report. Until they land, nothing in the room records (the capture waits in memory, at most 100 chat messages).

## §9 As built — 14h, Admin (2026-10-12)

Files (all in `src/renderer/src/admin/`): `SettingsGovernance.tsx` (new), `Settings.tsx`, `SettingsLogin.tsx` (Session timeout), `SettingsContent.tsx` (public sharing keeps a workspace's `fileExporting`), `People.tsx`, `Activity.tsx`, `AdminApp.tsx`, `context.tsx`, `labels.ts`, `Admin.module.css`, `AdminRoute.tsx`; `fake/fakeGovernance.ts` (new), `fake/fakeAdmin.ts`, `fake/fakeIdentity.ts`, `fake/seed.ts`; tests `__tests__/governance.dom.test.ts` (new, 11), `settings.dom.test.ts`, `admin.dom.test.ts`.

- **Wiring.** `AdminStore.governance?: GovernanceRepository`. FileBrowser's `<AdminApp store={…}>` needs `governance: backend.org.governance` (outside the folder; not done here). Without it every Governance+ row reads "Unavailable", Billing has no Governance+ row and Activity has no tabs. `useGovernance()` (one `overview` per view, reloaded by the admin's change counter) gives the add-on state. No polling: the only loop is key management's `encryptNext`, and it runs only while its dialog is open.
- **Settings.**
  - Login and provisioning: **Manage identity providers (IdP)** (the "Identity providers" table — Name over provider, Domains, Tested / Not tested, SCIM; More › Edit configuration · Test · Refresh metadata · SCIM provisioning · Remove; **Add IDP**). Edit configuration takes a name, the provider, the metadata (URL / XML / the three values, or "Keep the current configuration" which sends `{name}` alone — the server's rename) and the verified domains as checkboxes; a domain held by another IdP says so and moves when checked, through `mapDomain`. Round 4's SAML SSO and SCIM rows stay (the oldest IdP). **Session timeout** (renamed from "Idle session timeout"): Minutes / Hours / Days with Governance+, `validIdleHours` decides; without it "With Governance+, the timeout can be as short as 15 minutes." **IP allowlist**: a switch, the comma-separated field, each entry checked with `normalizeCidr` (the bad ones listed), "Your IP address" with whether it's in the list.
  - **External access** (renamed from "Access"; sub-headings Guest membership, File exporting, Network access): **2FA for Guests** (a switch; turning it on confirms with "‹N› guests will be blocked" from `guestsWithout2fa`, button Save), **Set default duration for guest access** (No expiration (default) / Guest access expires after ‹N› days, 1–3650), **File exporting** (the three `FILE_EXPORTING_LABEL` radios plus Custom settings for workspaces — a Select per workspace, "Organization setting (‹label›)" first), **Network access restrictions** (add a range — `normalizeCidr(s, "network")` refuses wider than /16 or /32 —, a Testing / Enforced / Disabled Select per range, "‹N› accounts would have been blocked in the last 7 days", Remove).
  - Data: **Key management** (Turn on → an irreversible confirm → `enableEkm({source: "managed"})` → "Encrypting files… N of M" with the region move's progress bar; "Encrypt existing files" resumes; the managed-key note: "Managed keys protect the organization's stored data, but not against the server's operator, who holds the key that wraps it.").
  - Billing: **Governance+** Add / Remove (Remove disabled with "Key management can't be turned off" while EKM is on; its confirm says settings are kept and a sub-12-hour timeout goes back to 12 hours).
  - Other: **Internal policies** (table Policy · Agreed · Enabled/Disabled badge · Enable/Disable; a row opens its text; **New policy**: Title ≤ 200, Policy text ≤ 20,000, Audience, Ask to agree — "A policy can't be edited once it's created"), **Discovery** (a switch; "While it's on, everyone's text in the organization is recorded").
  - Every G+ row is disabled with `REQUIRES_GOVERNANCE_PLUS` when the add-on is off (switches too).
- **People.** With the add-on: a sortable **Guest access expiration date** column (guests only; a cell button opens the dialog), row menu **Change expiration date…** / **Remove expiration date**, the bulk bar's **Set guest expiration date** (applies to the checked guests only), and a danger **Blocked** badge on guests without 2FA while 2FA for Guests is on. The dialog takes a date (the end of that local day; future, ≤ 10 years) and offers Remove expiration date.
- **Activity.** With `store.governance` the page has tabs **Activity log | Developer logs**. Developer logs: Token name, User email, IP address (prefix fields), Token type, Source, Date range (Last 24 hours / 7 days / 30 days); columns Date (UTC), User, Token (name over type), Event (name over source), Resource, IP address (over city, country); 25 rows and Load more over the cursor. Without the add-on it shows "Requires Governance+".
- **Activity sentences.** `ACTION_LABEL` reworded for round 14 (Figma's [F-log] descriptions where published); `eventText` reads the server's details: "Required guests to use two-factor authentication", "Turned the IP allowlist on", "Added 10.0.0.0/8 to the IP allowlist", "Set 198.51.100.0/24 to Enforced", "Changed file exporting to “…”", "Set the default duration for guest access to 30 days", "Changed a guest's access expiration date to ‹date›", "Disabled an internal policy", "Turned Discovery on". Five new event groups (ours: Figma doesn't publish the groups): Governance+, IP allowlist, Network access, Internal policies, Key management. `formatHours` says minutes below an hour.
- **Fake.** `createFakeAdminStore({ governancePlus })` (off by default; `?admin` turns it on) adds `governance` + `governanceState`: the server's refusals (403 without the add-on, 409 removing it under EKM, the allowlist's verified-domain prerequisite, range width, policy limits, guests-only expiration), one log per change, several IdPs (the identity fake's `idp` is the oldest; `makeIdp` / `newScimToken` are shared), 80 seeded developer-log rows. `updateSettings` refuses G+ keys without the add-on and logs their actions; `updateWorkspace` logs `workspace_file_export_controls_setting_change` separately; the people CSV gains `2FA_enabled` (and our "Guest access expiration date").
- **Deviations.** Developer logs live in Admin › Activity (Figma: figma.com/developers/log). Descriptions, the 2FA confirm's sentence, the managed-key note and the event groups are ours. The fake's people CSV keeps its own columns (the server's differ; only `2FA_enabled` is Figma's). A role change to guest doesn't set the default expiration in the fake (the server does).
- **Tests.** `governance.dom.test.ts` (11): the add-on and the idle clamp, IdPs with domains and SCIM, the IP allowlist, 2FA for Guests and Blocked badges, the guest duration, file exporting with a workspace override, network ranges, policies and Discovery, key management's loop, People's expiration, Developer logs, and no repository. All admin DOM tests: 49 green; `npm run typecheck` and `npm run lint` green.

## §9 As built — 14g, clients (2026-10-12)

Files: `src/renderer/src/settings/SecurityTab.tsx` + `SecurityTab.module.css`; `src/renderer/src/account/Gates.tsx` + `Gates.module.css` (new); `src/renderer/src/files/governance.ts` (new), `useOrgData.ts`, `FileBrowser.tsx`, `OrgMain.tsx`, `storeAccess.ts`; `src/renderer/src/editor/exporting.ts`, `commands.ts`, `objectCommands.ts`, `panels/design/Export.tsx`, `EditorApp.tsx` (one attach line + its import), `ShareDialog.tsx`; `src/renderer/src/editor/rest/discoveryText.ts` (new); `package.json` + lock (`qrcode-generator` 1.4.4 exact, in `dependencies`).

- **Settings › Security (§2.4).** Password keeps Change password (Google's page); signed in, the next row is ours: **Enable two-factor authentication** → a dialog: `setupTwoFactor()` → the QR code of `otpauthUrl` (`qrcode-generator`, error level M, drawn as one SVG path, dark modules on white in both themes), the key as text in groups of four, "Enter the 6-digit code from your authenticator app" (digits only, Verify enabled at six) → `enableTwoFactor(code)` → **Save your recovery codes** (the list, Copy, Download as `designer-recovery-codes.txt` through a download link, Done). On: "Two-factor authentication is on.", "‹N› recovery codes left", **Regenerate recovery codes** and **Turn off two-factor authentication** — each asks for a code from the app or a recovery code (the field takes either). Refusals: `two_factor_invalid` (or StoreError "invalid") → "That code didn't work. Try again."; `rate_limited` → "Too many tries. Try again in 10 minutes."; "conflict" → "This setup expired. Close this and start again.". The store is reached as `getStoreClient().governance`; with the stub (before 14e) the status read fails quietly and the link stays. Wording ours, unverified.
- **Gates (§2.5, §2.6, §2.13).** `files/governance.ts`: `gateOfError` (a StoreError whose `detail.code` is `two_factor_required` / `policy_acknowledgement_required` / `ip_not_allowed` → its `detail.gate`), `isNetworkRestricted`, `effectiveGate` (a policy gate minus the policies agreed to in this session — the org list may still answer from the store's cache). `useOrgData` takes the agreed set, loads **no page** for an org whose list entry carries a gate, keeps the gate or `"network"` a refused page read carried (`OrgPageState.blocked`), and marks `OrgShell.network` when `orgs.list` answers `network_restricted`. Home (`FileBrowser`): the gate is `OrgSummary.gate`, else the refused read's; `policy` → `PolicyModal` (title, the text pre-wrapped and scrolling, **Cancel** → the local space's Drafts, **Agree** → `governance.acknowledgePolicy`, then the next policy; after the last, the shell reloads); `two_factor` → `TwoFactorRequired` in place of the org's content ("‹org› requires two-factor authentication for guests.", **Set up two-factor authentication** → Settings › Security); `ip` → `IpBlocked` ("‹org› only allows access from approved networks.", with the caller's IP when the gate has it); the network restriction → `NetworkRestricted` over the whole window ("Switch to your work account", `GOVERNANCE_SIGN_IN_ERROR_TEXT.network_restricted`, **Log out** → the account bridge's sign-out; hidden for that account afterwards). A gated org's Admin shows the gate too. `GuestExpiryBanner` (a warning Banner above the org's content) from `OrgSummary.guestExpiresAt` within `GUEST_EXPIRY_WARNING_MS`: "Your guest access to ‹org› ends in ‹N› days." (ceil, at least 1). `OrgBackend.governance` (`Pick<GovernanceRepository, "acknowledgePolicy">`) is `client.governance`. All wording ours, unverified.
- **Exporting (§2.7).** `exporting.ts`: `exportAllowed(ed)` — a per-editor cached answer (true until told otherwise), `setExportAllowed`, `useExportAllowed` (useSyncExternalStore), `loadExportAllowed(store, fileKey)` (local files, owners and editors: no further call; a shared file's viewer: one `multiplayer.fileInfo` → `access.canExport !== false`), and `attachExportAccess(ed)` (EditorApp's line): reads it on open and again when the room's role changes (presence), and while off stops the document's `copy` / `cut` events in the capture phase (the canvas's ⌘C / ⌘X of layers; text fields copy as ever). `canExport(ed)` = the engine exports **and** `exportAllowed`; `engineCanExport` is the engine-only check `renderExport` keeps (so previews, plugins and REST jobs are unchanged). Gated: Export… and Export frames to PDF… (via `canExport`), the Export dialog's list, the Design panel's Export section (hidden), Copy as PNG / SVG / code, Copy and Cut, File › Duplicate (`canDuplicateFile`) and Save local copy… (`canSaveLocalCopy`) — `enabled` false, and each entry point returns early. No engine round trip: one store read per open or role change.
- **Share dialog.** Advanced's checkbox label is `VIEWERS_CAN_EXPORT_LABEL` ("Viewers can copy, share, and export from this file").
- **`discovery_text` (§2.11), client side.** `editor/rest/discoveryText.ts` `discoveryText(engine): DiscoveryTextItem[]`: one `readNodes([page], {subtree, fields})` per page; TEXT → `in_file` (characters); each `annotations[]` note → `dev_mode_annotation` (`labelV2`, else `label`); SYMBOL or a state group → `component_documentation_description` (`description`) and one `component_documentation_link` per `symbolLinks[].uri`. Instance sublayers (`I…;…` ids), soft-deleted nodes and empty texts are left out (ours). **Not registered yet** (runner.ts isn't 14g's): in `editor/rest/runner.ts` `runRestJob`'s switch, `case "discovery_text": return { parts: [{ name: "json", bytes: await gzip(json(discoveryText(engine))), contentType: "application/json" }] };` with `import { discoveryText } from "./discoveryText";` — part `json`, the gzipped JSON array, as `variables_local` answers.
- **Tests:** `settings/__tests__/security.dom.test.ts` (3: enable with a refused code, Copy, Download; regenerate and turn off; key grouping), `files/__tests__/governance.dom.test.ts` (7: policies agreed in turn with no page loaded before, Cancel → local Drafts, 2FA for guests → Settings › Security, IP from the list and from a refused read, the network window and Log out, the guest banner, the pure parts), `editor/__tests__/exportAccess.dom.test.ts` (2: who is asked; the commands, Duplicate, Save local copy and the copy event), `editor/rest/__tests__/discoveryText.test.ts` (fake reader) and `discoveryText.wasm.test.ts` (the committed engine reads these fields).
- **Deviations:** the five components live in one file, `account/Gates.tsx`. The export answer is optimistic until the server answers (a viewer's first second); the server refuses `fig_file_export` / `purpose=export` anyway (14b). Copy as text stays (the contract lists PNG / SVG / code). The editor shows no policy / 2FA / IP gate of its own: an org file's room refuses the socket (14b) and the editor's existing offline path shows it; Home is where the gates are mounted.

## §9 As built — 14f, desktop main reports (2026-10-12)

Files: `src/main/account/governanceReports.ts` (Electron-free batching and reporting), `governanceReportsWiring.ts` (the app's session, server and store), `governanceReports.test.ts` (6 tests); `src/main/agents/mcpServer.ts`, `src/main/ai/host.ts`, `src/main/ai/images/index.ts`.

- **MCP calls.** `McpServer.call` calls `reportMcpCall(fileKey, toolName)` (a no-op until wired, never throws, never awaited) on every tool call of a session's file. `GovernanceReports` batches per org in memory and posts `McpLogReport` to `/orgs/:org/developer-logs/mcp`: one POST per org when 50 calls are waiting, else 60 s after the first (one timer, unref'd), ≤ 100 calls per POST; on quit (`app.once("before-quit")` and `McpServer.stop()`) `drain()` lets pending org lookups settle and flushes. A failed POST drops its batch.
- **AI prompts.** `startRun` (text runs, `req.prompt`, feature = the action) and `startImageRun` (`req.prompt`) call `reportAiPrompt(viewOf(sender).fileKey, …)` once per run; `AiPromptReport {fileKey, text, feature, at}` goes at once to `/orgs/:org/discovery/ai-prompt` (text capped at 20,000 characters).
- **How main knows a file's org.** `storeClient().workspace.getFile(fileKey).space?.orgId` (`FileMeta.space`, the linked copy of an org file); cached per file for 60 s, a miss (local file) cached too. Signed out (`sessionToken() === null`) returns before any lookup. A view's file is `viewOf(sender).fileKey`.
- **Requests.** `mainFetch` to `serverUrl()` with the session bearer and the desktop user agent, 10 s timeout, answer ignored.
- **Wiring.** `initGovernanceReports()` runs when `src/main/ai/host.ts` loads (the ai IPC handlers import it at startup); `src/main/index.ts` was not edited.
- **Deviations / not done.** Agents-tab chat prompts (the CLI agents' turns) are not reported — only `ai:run` / `ai:image` prompts; the Agents chat path lives in `src/main/agents/host.ts`, outside this agent's files. MCP calls from an outside client on a file not yet bound are reported only once `activeFileKey` resolves (as the call itself does).

## §9 As built — 14e, the store (2026-10-12)

Files: `src/store/org/governance.ts` (the stub replaced) + `governance.test.ts`; `src/store/multiplayer/service.ts`; `src/store/localStore.ts`, `src/store/server.ts`, `src/renderer/src/store/memory/memoryStore.ts` (wiring); `src/shared/store/protocol.ts` (`StoreErrorCode` gains `"unavailable"`; the seven governance reads in `RETRY_SAFE`); two optional type additions: `OrgEvent` `access.blocked` (`src/shared/org/repositories.ts`) and `FileShareState.blocked` (`src/shared/multiplayer/types.ts`).

- **The repository** (`governanceRepository(host, {changed, retry})`) maps §4's routes as built (14a–14d) to `GovernanceRepository`: envelopes unwrapped (`{range}`, `{policies}`, `{policy}`, `{idps}`, `{idp}`), 204s → void, `developerLogs` → the page's `meta` (filters as query parameters, `limit` clamped 1–100). `saveIdp(org, null, …)` POSTs `identity/idps`, with a tenant PUTs it (`{name}` alone renames). `mapDomain` answers the `OrgDomain` with the server's `tenantId` beside it. Inputs are checked before asking (ids, CIDR present, policy title/text/audience/cadence, range state, guest ids, a 2FA code ≤ 32 chars); the server names everything else. Nothing is cached; signed out → "offline". Writes that change gates the caller or members see (the add-on, the allowlist, a policy, an agreement, an IdP or a mapping, 2FA on/off) answer after the org was read again (`refreshGates`: `org` then `orgs` notices → `org.updated`, `orgs.changed`), as identity.ts does. An agreement or 2FA turned on also lets waiting file links reconnect (`retry` → `MultiplayerService.retryBlocked`).
- **Refusals** (`httpError`): 403/503 with `governance_plus_required`, `two_factor_required`, `policy_acknowledgement_required`, `ip_not_allowed`, `network_restricted`, `export_restricted` → StoreError `"forbidden"`, `key_unavailable` → `"unavailable"`; `detail` keeps `{code, gate}` (and the server's other fields). Messages: "Requires Governance+", "This organization requires two-factor authentication for guests.", "Agree to your organization's policies to continue.", "This organization only allows access from approved networks.", the shared network text, "This file is unavailable because its encryption key can't be reached.", "Exporting is turned off for you in this file." (ours, unverified). `two_factor_invalid` (400) and `rate_limited` (429) stay `"invalid"`.
- **Events.** `MultiplayerService.request` reads a copy of every 403/503 answer only while someone listens (`onGovernance`); gates and restrictions (not `governance_plus_required` / `export_restricted`) become a `GovernanceRefusal {code, gate?, orgId, fileKey?}` — `orgId` from `/orgs/:org/…`, or the shared file's `FileMeta.space`; null for `network_restricted`. `governanceEvents(mp, org)` (one per store, `LocalStore.governanceEvents` / `MemoryStore.governanceEvents`, broadcast by `StoreServer` on topic `org`) re-reads the org for org gates (`org.updated`, `orgs.changed`: Home re-reads `OrgSummary.gate`), then says `{type: "access.blocked", orgId, code, gate?, fileKey?}`. The same refusal is said at most once per 10 s (`GATE_EVENT_GAP_MS`); `network_restricted` and `key_unavailable` re-read nothing (no loop).
- **Shared files.** A room's `{t: "error", code: "key_unavailable"}` (before its 4003) stops the link and sets `FileShareState.blocked = {code}` (the editor's state event), and says the refusal. A socket refused at the upgrade (the browser sees only a failed connection) is asked about through `GET /files/:key` as before (`checkLocked`); a gate there blocks the link with `{code, gate}`. Blocked links don't reconnect on their own backoff: they try again on `retryBlocked(orgId)` (an agreement, 2FA on) and once every 5 min (`BLOCKED_RETRY_MS`, one timer for all); a new session clears them. An upgrade refused 503 by an unavailable key can't be told from an unreachable room and keeps the usual backoff (≤ 30 s) until the room's next socket says it.
- **Tests:** `src/store/org/governance.test.ts` (11) on the real handler (node:sqlite, fake/real.ts): the add-on and `not_admin`, the allowlist and network ranges, policies with the gate (StoreError detail, `org.updated` / `orgs.changed` / `access.blocked`, the gap, `OrgSummary.gate`, Agree), guest expiration, key management (`unavailable` without a root key, enable, encrypt-next, 409 on removing G+), developer logs' query, IdPs (add, rename, map, SCIM per IdP, remove), 2FA with real TOTP codes, the port (StoreClient calls and the `org` topic), `httpError`'s mapping, and a shared file blocked by `key_unavailable` on its socket and by a policy gate on its route, resumed by `retryBlocked`. Server, shared and store suites: 86 files, 689 tests green.
- **For 14g/14h:** read `FileShareState.blocked` in the editor (mount `PolicyModal` / `TwoFactorRequired` / `IpBlocked` from its `gate`, a "file unavailable" state for `key_unavailable`), `access.blocked` on `orgs.watch` in Home (and `network_restricted` → `NetworkRestricted`), and StoreError `detail.code` on any call. `encryptNext` is the Admin loop (call until `encrypting` is null).

## §9 Review fixes (2026-10-12)

- **Gates on `/v1` (§2.5).** `restRoute` builds `Access` with the request; `dispatch` checks the target org's gate (team, folder, library analytics) inside its `try`, so a gated call still writes its developer-log line; file routes are gated in `fileFor` once the file opens (`Access.openFile`). Plan tokens act as the org: never gated. People outside the org (link visitors) have no membership: never gated. An `HttpError` with detail keeps `code` and `gate` in Figma's error shape (`{status, err, code, gate}` on file routes, `{status, error, message, code, gate}` elsewhere). Also gated: `adminOrgOf` (Discovery REST), the org's webhook listing and team / folder webhook contexts, `/v1/files/:key/dev_resources` and `/v1/dev_resources` (per file, 403 with the gate's message).
- **`Access.openFile(f, opts)`** = `file` + the gate when it opens an org file. Used by `/libraries?file=`, `/libraries/:key` (`usableLibrary` gates the library's org), `PATCH /libraries/:key`, `/files/:key/libraries`, `/files/:key/library-usage` and analytics ingest, library analytics, `/branches/:key/…`, REST `fileFor`, REST library and analytics access, webhooks' file context. Listings keep `file` (a gated org's files aren't errors there).
- **Previews of org files.** `PUT /previews/:id/manifest` with a `fileKey` in a Governance+ org answers 403 `{error, code, gate}` for a gated member before the preview goes live (one query for the file's org, then the gate's one).
- **REST export (§2.7).** `GET /v1/images/:key` and `GET /v1/files/:key/images` answer 403 `export_restricted` when `!canExport`, before any render job.
- **2FA attempts (§2.4).** An attempt is reserved atomically before the code is checked (one `UPDATE … WHERE failed_count < 5 OR window passed … RETURNING`); no row → 429; a success resets the count. Parallel guesses can't pass 5 per 10 minutes. New recovery codes replace the old ones in one `d1.batch` (`D1Like.batch?`; the tests' node:sqlite D1 runs it as one transaction).
- **Discovery with key management (§2.10, §2.11).** The room reads its `discovery_text` part through the room's cipher (`RoomEkm.partBytes`; `DiscoveryRoom.rest.partBytes` may be async). A failed run (no client, no helper, an unreadable part) backs off 1 h, 2 h, 4 h, 8 h; after `DISCOVERY_MAX_FAILS` (5) in a row the room stops asking until the next write arms it again (meta `fails`; ours). The room's one alarm is shared: RoomBox's `setAlarm` goes through `sharedAlarm`, never later than Discovery's stored due time, from any path that calls `edited()`; the alarm handler runs Discovery before the box's autosave so it doesn't ring again at once.
- **Network restriction (§2.2).** An expired guest (`org_members.expires_at` passed) no longer counts as the org's account. A range is set to `enforced` only from `testing`, after at least 24 h there (`NETWORK_TESTING_MIN_MS`; `updated_at` is when it entered testing); otherwise 409 `conflict` with `{field: "state", enforceableAt}` (ours), so an admin sees the shadow hits first. Clients should offer "Enforce" from testing only.
- **Developer logs' filters (§2.12).** `date_range`, `token_type`, `event_source` must be strings and own keys (`Object.hasOwn`): `"toString"` is 400, not 500.
- **Row cipher v2 (§2.10).** New seals are `"DV2E" | 2 | iv | ct+tag` with the header **and** `fileKey|table` as associated data (`snapshot` and `history_snapshots` share the name `snapshot`: a version keeps the snapshot's rows as stored). v1 rows (header-only AAD) stay readable. `RoomCipher.seal/open` take the table; `orgCipher` takes the file key. A room's first sweep (meta `ekm` not yet 1) also tries to open rows that merely look sealed; one that doesn't open is a plain row starting with the header and is sealed like the others. Every other read of a row that doesn't open still answers 503 `key_unavailable`.


## §9 Client review fixes (2026-10-12)

Files: `src/renderer/src/editor/` (`exporting.ts`, `devmode/DevPanels.tsx`, `plugins/api/document.ts`, `multiplayer/presence.ts`, `multiplayer/Multiplayer.tsx` + `.module.css`, `multiplayer/FileBlocked.tsx` new), `src/renderer/src/files/` (`governance.ts`, `storeAccess.ts`, `menus.ts`, `FileBrowser.tsx`, `useOrgData.ts`), `src/renderer/src/admin/` (`People.tsx`, `Activity.tsx`, `SettingsGovernance.tsx`, `Admin.module.css`, `fake/fakeGovernance.ts`), `src/renderer/src/settings/SecurityTab.module.css`, `src/main/` (`exportAccess.ts` new, `files.ts`, `window.ts`, `account/governanceReports.ts`, `account/governanceReportsWiring.ts`).

- **Export restriction (§2.7), the rest of it.** Dev Mode's preview takes `options.export = useExportAllowed(ed)`, so a restricted viewer has no Assets or Export section (no `renderEngineExport`, no download). Plugins' `exportAsync` throws "in exportAsync: export is not allowed in this file" when `!exportAllowed(ctx.ed)` — **this replaces 14g's "plugins … unchanged"**: previews and REST jobs still use the engine-only check, plugins don't. Home: `exportAllowedFor(multiplayer, fileKey)` (`files/governance.ts`; the editor's `loadExportAllowed` is the same function) is `FilesBackend.exportAccess`; Home asks it for the selected files (once each, again before Duplicate or Save local copy… runs) — the context menu's Duplicate is disabled and the menu bar's File › Duplicate / Save local copy… are off for a restricted file; a run that slips through toasts "The owner has turned off copying and exporting for viewers of this file" (ours). Main refuses `file:save-local-copy` for such a file too (`src/main/exportAccess.ts mayExportFile`: the store's `multiplayer.fileState`, then `fileInfo` only for a viewer), whichever view or menu asked.
- **Fresh answers.** `attachExportAccess` also reads again when the room's policy object changes (an admin's settings change reaches the room as `{t: "policy"}`; presence now also compares `discovery`) and on window `focus` at most every 30 s (`FOCUS_RELOAD_MS`). The file's own share settings reach no room event, hence the focus read. No polling.
- **Quit.** `finishQuit()` (`src/main/window.ts`) awaits `drainGovernanceReportsWithin()` (≤ 2 s, `QUIT_DRAIN_MS`) before the store stops; the wiring's `before-quit` drain is gone. `drain()` tracks its own flush, so a second drain (McpServer.stop() on before-quit, then finishQuit) waits for the first's POSTs.
- **AI prompts and Discovery.** `ReportDeps.discoveryOn(orgId)`: the store's org cache (`orgs.get` → `OrgInfo.governancePlus` and `settings.discovery`, readable by every member); off → the prompt isn't sent. Unknown (no cache, an error) → sent; the server drops it for orgs without Discovery anyway.
- **Gates from the store (14e).** Home listens for `access.blocked` on `orgs.watch`: `network_restricted` → `NetworkRestricted`; an org's gate → shown as `OrgSummary.gate` is (`useOrgData().eventGate`); both cleared on the next `orgs.changed` (an agreement, 2FA on, another account). A refused page read's gate is cleared when the org changes (no org A gate in org B). The editor reads `FileShareState.blocked` (presence `blocked`) and shows `FileBlocked` over the view: `key_unavailable` → "This file is unavailable because its encryption key can’t be reached."; a policy → `PolicyModal` (Agree → `governance.acknowledgePolicy` for the file's org, `FileMeta.space.orgId`; Cancel leaves "Review policies"); 2FA → `TwoFactorRequired` (Settings › Security); IP → `IpBlocked`; the network → `NetworkRestricted` (Log out). Wording ours.
- **Network ranges.** Enforced is offered only from Testing once `NETWORK_TESTING_MIN_MS` has passed since the range was added (or since it was set to Testing here, or the time a 409 `enforceableAt` named); before that the option is disabled with "Can be enforced after ‹date›" (from Disabled: "Set to Testing first"). A 409 that comes anyway is shown (its message) and its `enforceableAt` kept. The fake applies the server's rule.
- **Smaller.** People's guest expiration dialog stays open when the save fails. Developer logs: the text filters ask 300 ms after the last keystroke; Load more runs one page at a time (disabled while loading). `SecurityTab .status` and `Admin .policyText` use tokens.
- **Tests:** `editor/__tests__/exportAccess.dom.test.ts` (+2: policy push and focus throttle; Dev Mode's export option), `editor/__tests__/fileBlocked.dom.test.ts` (3, new), `plugins/__tests__/plugins.wasm.test.ts` (+1: exportAsync refused), `files/__tests__/fileBrowser.dom.test.ts` (+1: Duplicate / Save local copy… for a restricted file), `files/__tests__/governance.dom.test.ts` (+2: `access.blocked` events; no stale gate in another org), `admin/__tests__/governance.dom.test.ts` (+1 and three extended: Status options, ranges' 24 h and a late 409, the expiration dialog on failure, Load more and the debounced filter), `src/main/exportAccess.test.ts` (1, new), `src/main/account/governanceReports.test.ts` (+2: quit waits ≤ the timeout; no prompt with Discovery off).

## §9 End-to-end run (2026-10-12)

Run like `docs/data.md` §15.9.1 and handoff's "Round 3 end-to-end check": `npm run build:viewer`; local D1 migrated with `wrangler d1 migrations apply designer --local --persist-to <scratch>`; `wrangler dev --test-scheduled --persist-to <scratch>` with `DEV_AUTH`, `WEB_ORIGINS`, `SESSION_SECRET` and a dev-only `EKM_ROOT_KEY` (32 random bytes, base64) passed with `--var`; the browser app (`VITE_DESIGNER_SERVER=http://localhost:8818 vite --config vite.web.config.ts`); one headless Chromium (playwright-core) with a context per account, signed in by writing the web session (`designer.web.session`) from `POST /auth/dev`. Accounts: Alice (org admin), Bob (member; viewer of the test file), Gina (guest; editor of the test file). One org "Acme" with a verified domain (written in D1: DNS can't be reached locally), team "Design", folder "Web", one design file made in the editor (two rectangles, two text layers). Never deployed; no remote D1. State and screenshots: `/private/tmp/claude-501/gplus-e2e/` (`shots/`).

**`CF-Connecting-IP` in wrangler dev is `::1`** (Settings › Security's session row says "Login · ::1"; the IP allowlist dialog shows "Your IP address ::1"). wrangler dev also passes a client-sent `CF-Connecting-IP` through (a request with `10.1.2.3` was let in under a `10.0.0.0/8` allowlist); on Cloudflare the edge sets it, so this is local only.

| Check | Result | Evidence |
|---|---|---|
| Admin › Settings › Billing › Governance+ **Add**; rows enable | Pass | Before: every G+ row "Requires Governance+"; after: "Added · Remove", rows show values ("0 identity providers", "Off", "No expiration", "Allow exporting by all viewers") |
| 2FA for Guests: Admin switch → confirm "1 guest will be blocked…" → Save | Pass | Row switch `aria-checked=true`; activity `mfa_required_setting_change` |
| Guest without 2FA: Home shows TwoFactorRequired; org routes and `/v1` (PAT) refused | Pass | Home: "Acme requires two-factor authentication for guests." + Set up two-factor authentication; `GET /orgs` → `gate {kind: two_factor}`; `GET /orgs/:org/teams`, `GET /files/:key`, PAT `GET /v1/files/:key/comments` → 403 `two_factor_required` with the gate; PAT `GET /v1/me` 200 (no org resource); Bob's PAT 200 |
| Guest enables TOTP in Settings › Security (codes from `totpCode`), recovery codes | Pass | QR + key in groups of four; "000000" → "That code didn't work. Try again." (400); the right code → "Save your recovery codes" with 10 `xxxx-xxxx`; "Two-factor authentication is on. 10 recovery codes left"; every refusal above → 200 |
| Sign-in challenge `/auth/2fa` | Pass (simulated start) | `POST /auth/dev` has no second step and Google can't be reached locally, so `backWithCode`'s write was reproduced as it does it (an `auth_codes` row with `mfa_pending = 1`, `mt` signed with `SESSION_SECRET`); the rest on the Worker: pending code at `/auth/token` → 400; `GET /auth/2fa?mt=` → the page ("Enter the 6-digit code…", Verify, recovery note); wrong code → 400 page; right code → 302 to the web page with `auth_code`, which `/auth/token` takes (200); forged `mt` → 400; the challenge again → `auth_error=two_factor_failed` |
| Internal policy: create (Members, once a year) → Bob sees PolicyModal; Cancel → Drafts; Agree → content | Pass | Alice (admin = member) was gated at once and agreed; Bob: modal "Acceptable use" with the text, Cancel → his local Drafts, Acme again → modal, Agree → Acme Drafts; `policy_acknowledge` ×2 |
| IP allowlist `10.0.0.0/8, 2001:db8::/32`: member blocked, admin not; removed → access | Pass | Dialog: "Your IP address isn't in the list. You're an admin, so you can still reach the organization from here."; Bob: Home "Acme only allows access from approved networks. … Your IP address: ::1", `GET /orgs` gate `{kind: ip, ip: "::1"}`, org / file / PAT `/v1` → 403 `ip_not_allowed`; Alice 200; Gina (guest) 200; turned off and emptied → Bob 200, All teams loads; `ip_allowlist_rejected` logged once |
| File exporting "Prevent exporting for all viewers" | Pass | Bob (viewer) in the editor: Design panel without Export; File › Export… / Export frames to PDF… / Duplicate / Save local copy… disabled; Copy/Paste as › Copy as PNG / SVG / code disabled; Copy disabled; `GET /files/:key` `access.canExport: false`; PAT `/v1/images/:key` and `/v1/files/:key/images` → 403 `export_restricted`; `POST /files/:key/activity {fig_file_export}` → 403; Alice (editor) `/v1/images` 200 with a PNG URL |
| Key management: Turn on, encrypt existing files to completion | Pass (server) / **Fail (Admin dialog)** | `PUT key-management` then one `encrypt-next`: `files {total: 1, encrypted: 1}`, `fig_file_encrypt` logged; the dialog stayed on "1 file isn't encrypted yet" after Turn on and on "Encrypting files… 0 of 1" after Encrypt existing files (bug below); reopened: "Every file is encrypted." |
| Encrypted file opened in the editor, edits persist after reload | Pass | A rectangle added, page reloaded → there; a fresh browser context for Bob (no local copy) opened the file with "Rectangle 2" |
| Wrong `EKM_ROOT_KEY` → unavailable (503 `key_unavailable`); restored | Pass (server, after a fix) / **Fail (clients)** | `GET /files/:key/snapshot` → 503 `key_unavailable`; `GET admin/key-management` → `state: unavailable`, `ekm_key_unavailable` once; REST `GET /v1/files/:key` answered **502** "The file's room couldn't take the job" → fixed, now 503 `key_unavailable`. The editor showed no unavailable state (Alice: her local copy with the offline warning; Bob, fresh: double-click on the file in Shared files did nothing visible). Restored key: snapshot 200, `/v1/files` 200, `state: ok` |
| Discovery on → comment, cursor chat, text edits → `/v1/discovery` with a plan token | Pass | Comment (Bob, `/v1`) and cursor chat ("hello from cursor chat", `transient`) recorded at once; the room's alarm ran 10 min after the first write (`DISCOVERY_QUIET_MS`) and recorded `in_file` inserts for both text layers (node ids, Alice) through the editor's `discovery_text` job (with EKM on). Only complete hours list: no hook moves the Worker's clock, so the hour's rows were moved back one hour in D1 (`UPDATE discovery_events SET hour = hour - 1, timestamp = timestamp - 3600`); then `GET /v1/discovery?start_date=…` (plan token, `org:discovery_read`) → `urls["2026/10/12/07"]`, the signed file → the four events (`shots/discovery-07.json`); a bad signature → 403; Bob's PAT → 403 |
| Developer logs | Pass | Every PAT `/v1` call on the org's file is a row (event `/v1/files/:file_key/comments`, token name and type, `::1`, Antakya TR); `POST /v1/developer_logs` with the plan token → 200 newest first; with a PAT → 403; Admin › Activity › Developer logs lists them |
| Guest expiration: a date within 14 days → banner; a past date → access lost | Pass (after a fix), with a gap | People › Gina › date Oct 17 → "Oct 17, 2026", `org_user_guest_expiration_change`; Home's banner "Your guest access to Acme ends in 6 days." only after the store fix below. Past date (the route and the dialog take future dates only, so written in D1): `GET /orgs` → `[]`, `GET /orgs/:org` → 404 at once, but the directly shared file still opened (`/files/:key` 200, PAT `/v1` 200) until the daily cron (`/__scheduled?cron=17+3+*+*+*`) removed her: `org_user_delete {reason: guest_expired}`, file 404 |
| Session timeout 15 min with G+; refused without | Pass | Admin › Session timeout › Custom › Minutes 15 → "15 minutes", `settings.idleSessionTimeoutHours = 0.25`, Bob's `/me` `session.idleLimitMs = 900000`; org "Beta" without G+: 0.25 → 400 "idleSessionTimeoutHours is null or 12–336 hours", 12 → 200; Acme 0.3 → 400 |

**Fixed here** (each with a test):
- `server/src/rest/jobs.ts` (`askRoom`, `partBytes`): a room's 503 `key_unavailable` became 502 "The file's room couldn't take the job" (jobs) or a missing part; now a `RestError(503, …, {code: "key_unavailable"})` as §2.10 says. Test: `server/src/rest/jobs.test.ts`.
- `src/store/org/service.ts` (`orgInfoSpec.set`, `orgs.create`): reading an org (`orgs.get`) rewrote its cached list entry with five fields, dropping `gate` and `guestExpiresAt` — Home never showed the guest banner, and a gate could vanish from the list once the org was read. `summaryOf(info)` keeps them. Test: `src/store/org/governance.test.ts` "the guest's list entry keeps guestExpiresAt (and the gate)…".

**Found, for the owners of other folders:**
- `src/renderer/src/admin/SettingsGovernance.tsx:559` — `useEffect(() => () => void (alive.current = false), [])` never sets `alive` back to true, so under React StrictMode (the app's `main.tsx`) it is false after the dev double mount: Turn on returns before `encryptAll`, and Encrypt existing files stops after one `encrypt-next` with the dialog stuck on "Encrypting files… 0 of N". Fix: `useEffect(() => { alive.current = true; return () => void (alive.current = false); }, [])`.
- The editor shows no unavailable state for `key_unavailable` (14e's `FileShareState.blocked` isn't read by the editor). Also the socket upgrade answers 503, which the browser can't read, so the store keeps its offline backoff; the room could accept the socket, send `{t: "error", code: "key_unavailable"}` and close 4003, as the hourly re-check does (`server/src/fileRoom.ts` `GET /room/ws`).
- Home: after a guest is removed (expired), the space switcher keeps the removed org selected with an empty name and "Enterprise" (`shots/gx-4-guest-removed-home.png`); it should fall back to the person's own space.
- A guest past `expires_at` keeps files shared with them directly until the daily sweep (§2.13 is lazy only through `Access.rowsFor`); `resolveAccess` for an org file could treat an expired guest's file grants as gone too.
- Editor, seen not investigated: "/" didn't open Cursor chat in headless Chromium (the `Slash` keydown reached the page; `ui.cursorChat` stayed null; opened with `ui.set` instead); `RelaunchButtons` threw "Cannot read properties of undefined (reading 'length')" once after a reload; a viewer's context menu offers Rename / Rename layers / Paste to replace and File › Place image/video… / Create branch… enabled.
- Checks: `npm run typecheck`, `npm run lint`, server typecheck green; `server/src`, `src/store`, `src/renderer/src/files` suites green except `files/__tests__/editorUrl.dom.test.ts`, which can't load QuickJS's wasm from the worktree's symlinked `node_modules` (Vite's fs deny; environment only).
