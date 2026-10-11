/** Dev Mode's round 5 records (docs/editor.md "Dev Mode — round 5"). Wire names camelCase; REST shapes are in src/shared/rest/types.ts. */
export interface CodeConnectMapping {
  /** The library file (room key, or the local file key for local mappings) and the main component / set node in it */
  fileKey: string; nodeId: string;
  label: string; language: string;
  origin: "cli" | "ui";
  source: string | null; component: string | null;
  /** The template's JavaScript (CLI); null for UI mappings */
  template: string | null;
  imports: string[]; nestable: boolean; instructions: string;
  updatedBy: string | null; updatedAt: number;
}
export interface CodeConnectSnippet { label: string; language: string; code: string; imports: string[]; origin: "cli" | "ui" | "generated"; error: { type: "PROPERTY_NOT_FOUND" | "CHILD_LAYER_NOT_FOUND" | "PROPERTY_TYPE_MISMATCH" | "TEMPLATE_EXECUTION_ERROR"; message: string } | null; source: string | null; component: string | null }

export interface DevResourceRecord { id: string; fileKey: string; nodeId: string; name: string; url: string; createdBy: string | null; createdAt: number; updatedAt: number }
export const DEV_RESOURCE_LIMIT = 10;

export type DevStatus = "READY_FOR_DEV" | "COMPLETED" | "NONE";
export interface DevStatusReport { nodeId: string; nodeName: string; status: DevStatus; kind: "ready" | "completed" | "changed_done" | "removed"; changeMessage?: string }

/** The store's devMode repository (both stores; events on topic "devmode": {fileKey, what: "resources" | "codeConnect"}) */
export interface DevModeRepository {
  devResources(fileKey: string, nodeIds?: string[]): Promise<DevResourceRecord[]>;
  addDevResource(fileKey: string, input: { nodeId: string; name: string; url: string }): Promise<DevResourceRecord>;
  editDevResource(fileKey: string, id: string, patch: { name?: string; url?: string }): Promise<DevResourceRecord>;
  removeDevResource(fileKey: string, id: string): Promise<void>;
  codeConnect(fileKey: string): Promise<CodeConnectMapping[]>;
  setCodeConnect(fileKey: string, mapping: Omit<CodeConnectMapping, "fileKey" | "origin" | "template" | "updatedBy" | "updatedAt">): Promise<CodeConnectMapping>;
  removeCodeConnect(fileKey: string, nodeId: string, label: string): Promise<void>;
  /** Shared files only; local files resolve at once */
  reportStatus(fileKey: string, report: DevStatusReport): Promise<void>;
  viewed(fileKey: string): Promise<void>;
  setStatusNotifications(fileKey: string, notify: boolean): Promise<void>;
  /** Prototype-only members (D-6) */
  prototypeMembers(fileKey: string): Promise<{ email: string; userId: string | null; name: string | null }[]>;
  invitePrototype(fileKey: string, email: string): Promise<void>;
  removePrototype(fileKey: string, email: string): Promise<void>;
}
