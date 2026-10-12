/** Figma's REST API on our Worker (docs/multiplayer.md §16). Wire shapes are Figma's; field names snake_case where Figma's are. */
export type RestTier = 1 | 2 | 3;
export type RestScope =
  | "current_user:read" | "file_content:read" | "file_metadata:read" | "file_versions:read"
  | "file_comments:read" | "file_comments:write" | "file_dev_resources:read" | "file_dev_resources:write"
  | "file_variables:read" | "file_variables:write" | "file_code_connect:write"
  | "library_assets:read" | "library_content:read" | "team_library_content:read" | "library_analytics:read"
  | "folders:read" | "folder_metadata:read" | "projects:read" | "project_metadata:read"
  | "webhooks:read" | "webhooks:write" | "org:activity_log_read" | "org:ai_metering_usage_read"
  // Round 14 (docs/governance.md §4)
  | "org:discovery_read" | "org:developer_log_read";
/** Scopes a plan access token may hold (§16.3) */
export const PLAN_TOKEN_SCOPES: readonly RestScope[] = ["org:activity_log_read", "org:ai_metering_usage_read", "library_analytics:read", "webhooks:read", "webhooks:write", "org:discovery_read", "org:developer_log_read"];
/** Per-minute limits by tier (§16.2 decision 4): Figma's Organization numbers; low seats' Tier 1 is per day (ours) */
export const RATE_LIMITS = { high: { 1: 20, 2: 100, 3: 150 }, low: { 1: 20, 2: 5, 3: 10 }, lowTier1PerDay: true, dailyCap: 5000 } as const;

// ---- render jobs (§16.6) ----
export interface ImagesParams { ids: string[]; scale: number; format: "jpg" | "png" | "svg" | "pdf"; svg_outline_text: boolean; svg_include_id: boolean; svg_include_node_id: boolean; svg_simplify_stroke: boolean; contents_only: boolean; use_absolute_bounds: boolean }
export interface FileParams { ids?: string[]; depth?: number; geometry?: "paths"; plugin_data?: string[]; branch_data?: boolean }
export type RestJob =
  | { kind: "file"; params: FileParams; version?: string }
  | { kind: "nodes"; params: FileParams & { ids: string[] }; version?: string }
  | { kind: "images"; params: ImagesParams; version?: string }
  | { kind: "variables_local"; version?: string }
  | { kind: "variables_post"; body: VariablesPostBody; actorUserId: string }
  /** Round 14 Discovery (docs/governance.md §2.11): every text-bearing node; one part "json" = DiscoveryTextItem[] */
  | { kind: "discovery_text"; version?: undefined };
export interface RestJobPart { name: string; sha1: string; size: number; contentType: string }
/** images: one part per id (name = the node id), absent = null; file / nodes / variables_*: one part "json" (gzip) */
export type RestJobResult = { ok: true; parts: RestJobPart[] } | { ok: false; status: number; err: string };

// ---- variables (§16.7, §16.8) ----
export type VariableAction = "CREATE" | "UPDATE" | "DELETE";
export type RestResolvedType = "BOOLEAN" | "FLOAT" | "STRING" | "COLOR";
export interface RestColor { r: number; g: number; b: number; a: number }
export interface RestVariableAlias { type: "VARIABLE_ALIAS"; id: string }
export type RestVariableValue = boolean | number | string | RestColor | RestVariableAlias | null;
export interface VariablesPostBody {
  variableCollections?: { action: VariableAction; id: string; name?: string; initialModeId?: string; parentVariableCollectionId?: string; initialModeIdToParentModeIdMapping?: Record<string, string>; hiddenFromPublishing?: boolean }[];
  variableModes?: { action: VariableAction; id: string; name?: string; variableCollectionId: string }[];
  variables?: { action: VariableAction; id: string; name?: string; variableCollectionId?: string; resolvedType?: RestResolvedType; description?: string; hiddenFromPublishing?: boolean; scopes?: string[]; codeSyntax?: { WEB?: string; ANDROID?: string; iOS?: string } }[];
  variableModeValues?: { variableId: string; modeId: string; value: RestVariableValue }[];
}

// ---- dev resources (§16.7) ----
export interface DevResource { id: string; name: string; url: string; file_key: string; node_id: string }
export interface DevResourceCreate { name: string; url: string; file_key: string; node_id: string }
export interface DevResourceUpdate { id: string; name?: string; url?: string }
export const DEV_RESOURCES_PER_NODE = 10;

// ---- webhooks (§16.9) ----
export type WebhookEventType = "PING" | "FILE_UPDATE" | "FILE_VERSION_UPDATE" | "FILE_DELETE" | "LIBRARY_PUBLISH" | "FILE_COMMENT" | "DEV_MODE_STATUS_UPDATE";
export type WebhookContext = "team" | "project" | "file";
export interface WebhookV2 { id: number; event_type: Exclude<WebhookEventType, "PING">; context: "TEAM" | "PROJECT" | "FILE"; context_id: string; team_id: string; plan_api_id: string; status: "ACTIVE" | "PAUSED"; client_id: null; passcode: string; endpoint: string; description: string | null }
export interface RestUser { id: string; handle: string; img_url: string | null }
export interface LibraryItemData { key: string; name: string }
export type CommentFragment = { text: string } | { mention: string };
export type WebhookEvent =
  | { event_type: "PING" }
  | { event_type: "FILE_UPDATE"; file_key: string; file_name: string }
  | { event_type: "FILE_DELETE"; file_key: string; file_name: string; triggered_by: RestUser }
  | { event_type: "FILE_VERSION_UPDATE"; file_key: string; file_name: string; created_at: string; version_id: string; label: string; description: string; triggered_by: RestUser }
  | { event_type: "LIBRARY_PUBLISH"; file_key: string; file_name: string; description: string; created_components: LibraryItemData[]; modified_components: LibraryItemData[]; deleted_components: LibraryItemData[]; created_styles: LibraryItemData[]; modified_styles: LibraryItemData[]; deleted_styles: LibraryItemData[]; created_variables: LibraryItemData[]; modified_variables: LibraryItemData[]; deleted_variables: LibraryItemData[]; triggered_by: RestUser }
  | { event_type: "FILE_COMMENT"; file_key: string; file_name: string; comment: CommentFragment[]; comment_id: string; mentions: RestUser[]; order_id: string | null; parent_id: string | null; created_at: string; resolved_at: string | null; triggered_by: RestUser }
  | { event_type: "DEV_MODE_STATUS_UPDATE"; file_key: string; node_id: string; status: "NONE" | "READY_FOR_DEV" | "COMPLETED"; change_message: string; related_links: DevResource[]; triggered_by: RestUser };
/** What is sent: the event plus Figma's common fields */
export type WebhookPayload = WebhookEvent & { passcode: string; timestamp: string; webhook_id: string };
export const WEBHOOK_RETRY_MINUTES = [5, 30, 180] as const;
export const WEBHOOK_LIMITS = { team: 20, project: 5, file: 3, orgFileWebhooks: 600, personOutsideOrgs: 20 } as const;

// ---- Code Connect (docs/editor.md D-1) ----
export interface CodeConnectDoc {
  /** The node link the template's `// url=` names: <server>/f/<key>?node-id=1-2 or a Figma-style /design/<key>/…?node-id= */
  url: string;
  label: string; language: string;
  source?: string; component?: string;
  /** The template file's JavaScript after the CLI strips TypeScript; null: a UI mapping */
  template: string | null;
  imports?: string[]; nestable?: boolean; instructions?: string;
}
