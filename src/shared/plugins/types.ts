/** Plugins (docs/plugins.md). The manifest is Figma's manifest.json. */
export type PluginEditorType = "figma" | "figjam" | "dev" | "slides" | "buzz";
export type PluginKind = "plugin" | "widget";
export interface PluginParameter { name: string; key: string; description?: string; allowFreeform?: boolean; optional?: boolean }
export type PluginMenuItem = { name: string; command: string; parameters?: PluginParameter[]; parameterOnly?: boolean } | { separator: true } | { name: string; menu: PluginMenuItem[] };
export interface CodegenPreference {
  itemType: "unit" | "select" | "action";
  propertyName?: string; label?: string;
  scaledUnit?: string; defaultScaleFactor?: number; default?: boolean;
  options?: { label: string; value: string; isDefault?: boolean }[];
  includedLanguages?: string[];
}
export interface PluginManifest {
  name: string; id: string; api: string; main: string;
  ui?: string | Record<string, string>;
  editorType?: PluginEditorType[];
  documentAccess?: "dynamic-page";
  networkAccess?: { allowedDomains: string[]; reasoning?: string; devAllowedDomains?: string[] };
  parameters?: PluginParameter[]; parameterOnly?: boolean;
  menu?: PluginMenuItem[];
  relaunchButtons?: { command: string; name: string; multipleSelection?: boolean }[];
  enableProposedApi?: boolean; enablePrivatePluginApi?: boolean;
  build?: string;
  permissions?: ("currentuser" | "activeusers" | "fileusers" | "payments" | "teamlibrary" | "clipboardwrite")[];
  capabilities?: ("textreview" | "codegen" | "inspect" | "vscode" | "panel" | "linkpreview" | "lint")[];
  codegenLanguages?: { label: string; value: string }[];
  codegenPreferences?: CodegenPreference[];
  containsWidget?: boolean; widgetApi?: string;
}
/** Where a runnable plugin comes from */
export type PluginSource = { type: "development"; path: string } | { type: "private"; orgId: string; version: number };
export interface PluginRef { id: string; name: string; kind: PluginKind; source: PluginSource; editorTypes: PluginEditorType[] }
export interface PluginBundle { manifest: PluginManifest; code: string; ui: Record<string, string> /* "" = the single ui file */ }

export interface PrivatePlugin { id: string; orgId: string; kind: PluginKind; name: string; description: string; manifest: PluginManifest; version: number; publishedBy: { id: string; name: string | null } | null; createdAt: number; updatedAt: number; canManage: boolean }
export interface PluginApproval { pluginId: string; kind: PluginKind; name: string; scope: { type: "org" } | { type: "workspace"; id: string }; addedBy: string | null; addedAt: number }
export interface PluginRequest { id: string; orgId: string; pluginId: string; kind: PluginKind; name: string; manifest: PluginManifest | null; requestedBy: { id: string; email: string; name: string | null }; workspaceId: string | null; reason: string; state: "pending" | "approved" | "declined"; declineReason: string; createdAt: number; answeredAt: number | null }

/** Topic "plugins" (round 5g): this installation's saved / recents changed, or an org's private plugins, approvals or
 *  requests changed (the Inbox's `{t: "plugins", orgId}`, or a change made here) — read again */
export type PluginsEvent = { what: "local" } | { what: "org"; orgId: string };

/** The plugins repository on StoreApi (both stores; events on topic "plugins") */
export interface PluginsRepository {
  /** Saved and recent plugins of this installation */
  local(): Promise<{ saved: PluginRef[]; recents: PluginRef[] }>;
  setSaved(ref: PluginRef, saved: boolean): Promise<void>;
  ranRecently(ref: PluginRef): Promise<void>;
  /** Private plugins of an org (cached for offline) and their bundles */
  listPrivate(orgId: string): Promise<PrivatePlugin[]>;
  bundle(pluginId: string, version: number): Promise<PluginBundle>;
  publish(orgId: string, bundle: PluginBundle, meta: { name: string; description: string; developmentPath: string }): Promise<PrivatePlugin>;
  removePrivate(pluginId: string): Promise<void>;
  /** May this plugin run in this file? (§10.2) */
  allowed(fileKey: string, ref: PluginRef): Promise<{ ok: true } | { ok: false; reason: "approval"; canRequest: boolean } | { ok: false; reason: "guest" }>;
  request(orgId: string, input: { pluginId: string; kind: PluginKind; name: string; manifest: PluginManifest; reason: string; workspaceId?: string }): Promise<PluginRequest>;
  /** Admin › Resources › Plugins / Widgets */
  admin(orgId: string, kind: PluginKind): Promise<{ approved: PluginApproval[]; requests: PluginRequest[]; private: PrivatePlugin[] }>;
  approve(orgId: string, input: { pluginId: string; kind: PluginKind; name: string; scope: { type: "org" } | { type: "workspace"; ids: string[] } }): Promise<void>;
  unapprove(orgId: string, pluginId: string, workspaceId?: string): Promise<void>;
  answer(orgId: string, requestId: string, input: { approve: boolean; reason?: string; workspaceIds?: string[] }): Promise<PluginRequest>;
  /** Topic "plugins" (not an RPC: the client's own listeners, as `orgs.watch`) */
  watch(listener: (e: PluginsEvent) => void): () => void;
}
