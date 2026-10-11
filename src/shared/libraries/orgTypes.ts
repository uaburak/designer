/**
 * Libraries in organizations (docs/data.md §16) and library analytics (§17): the value types and the two new store
 * repositories, committed before Phase 7 round 3 so its agents compile against the same shapes.
 */
import type { FileKey, FileMeta, LibraryAsset, LibraryRecord, Redirect } from "../store/types";
import type { EditorType, PersonRef } from "../org/types";

// ---- identity ---------------------------------------------------------------------------------------------

/** A library's key: its file's room key for an org library (FileSpace.key), its FileKey for a local one (§16.2). */
export type LibraryKey = string;
/** Local FileKeys are 22 base62; room keys contain "_" (roomKeyFor), so the forms never collide. */
export const isLocalLibraryKey = (key: string): boolean => /^[0-9A-Za-z]{22}$/.test(key);
/** "This file's library": the room key of an org copy, else the local file key. */
export const libraryKeyOfFile = (meta: Pick<FileMeta, "fileKey" | "space">): LibraryKey => meta.space?.key ?? meta.fileKey;

export type LibraryScope = "team" | "org";
/** Figma's "Design files", "FigJam boards", "Slide decks", "Figma Buzz files" */
export type LibraryEditorType = Extract<EditorType, "design" | "figjam" | "slides" | "buzz">;
export const LIBRARY_EDITOR_TYPES: readonly LibraryEditorType[] = ["design", "figjam", "slides", "buzz"];
export type SettingScope = { type: "org"; id: string } | { type: "workspace"; id: string } | { type: "team"; id: string };

/** A published collection's modes, in order (the first is its default) */
export interface CollectionModes {
  collectionKey: string;
  name: string;
  modes: { id: string; name: string }[];
}
export interface DefaultMode {
  collectionKey: string;
  modeId: string;
}

// ---- consuming ----------------------------------------------------------------------------------------------

/** Where an org library stands, relative to the file asking (listAvailable) or the caller (getRecord). */
export interface OrgLibraryContext {
  orgId: string;
  teamId: string | null;
  teamName: string | null;
  workspaceId: string | null;
  scope: LibraryScope;
  /** The library file's name */
  name: string;
  /** null until a client uploaded a thumbnail (OrgFile.thumbnailUrl) */
  thumbnailUrl: string | null;
  publishedBy: PersonRef | null;
  /** The check mark: approved for the organization, for the file's (caller's) workspace, or not */
  approved: "org" | "workspace" | null;
  /** On by default for this file (its editor type, team, workspace) — §16.5 */
  enabledByDefault: boolean;
  /** Default modes for this file's team or workspace (§16.5) */
  defaultModes: DefaultMode[];
  /** Why the caller can use it (§16.4) */
  via: ("file" | "team" | "org")[];
}
/** What LibraryRegistry.listAvailable / getRecord return for an org library: today's record plus `org`. */
export interface OrgLibraryRecord extends LibraryRecord {
  libraryFileKey: LibraryKey;
  org: OrgLibraryContext;
}
export const isOrgLibrary = (r: LibraryRecord): r is OrgLibraryRecord => (r as Partial<OrgLibraryRecord>).org != null;

/** GET/PUT /files/:key/libraries */
export interface FileLibraries {
  /** Effective: explicit choices over the defaults */
  enabled: LibraryKey[];
  /** On by default for this file */
  defaults: LibraryKey[];
  /** The file's explicit choices */
  overrides: { libraryKey: LibraryKey; enabled: boolean }[];
}

// ---- publishing -----------------------------------------------------------------------------------------------

/** POST /libraries/:key/versions (the store builds it from a PublishRequest, §16.6) */
export interface OrgPublishInput {
  /** The latest version the preview was computed against (0: first publish) */
  baseVersion: number;
  description: string;
  /** "Allow any member of ‹org› to access the file" */
  scope: LibraryScope;
  /** The complete manifest of the new version (thumbnails as sha1; payloads and blobs uploaded before) */
  assets: LibraryAsset[];
  changes: { created: string[]; modified: string[]; removed: string[]; moved: Redirect[] };
  moves: { key: string; fromLibraryFileKey: LibraryKey; fromKey: string; mode: "move" | "copy" }[];
  /** Read by the store from the VARIABLE_COLLECTION payloads */
  collections: CollectionModes[];
}
/** POST /libraries/:key/missing, both ways */
export interface LibraryMissing {
  payloads: { key: string; versionHash: string }[];
  blobs: string[];
}

// ---- managing (Admin › Resources › Libraries, team settings, Home's Libraries) ----------------------------------

export interface LibraryScopeSetting {
  scope: SettingScope;
  scopeName: string;
  /** org and workspace rows only */
  approved: boolean;
  /** true on, false off (an override), null inherit */
  defaults: Record<LibraryEditorType, boolean | null>;
  defaultModes: DefaultMode[];
  updatedAt: number;
  updatedBy: PersonRef | null;
}
export interface OrgLibrarySummary {
  key: LibraryKey;
  name: string;
  orgId: string;
  teamId: string | null;
  teamName: string | null;
  workspaceId: string | null;
  scope: LibraryScope;
  status: LibraryRecord["status"];
  latestVersion: number;
  lastPublishedAt: number;
  counts: { components: number; styles: number; variables: number };
  thumbnailUrl: string | null;
  approved: { org: boolean; workspaceIds: string[] };
  /** Where it is on by default (any editor type) */
  defaultIn: { org: LibraryEditorType[]; workspaceIds: string[]; teamIds: string[] };
  /** From the daily roll-up (§17.5) */
  insertsLastWeek: number;
}
export interface OrgLibraryInfo extends OrgLibrarySummary {
  collections: CollectionModes[];
  /** Every scope row the caller may see */
  settings: LibraryScopeSetting[];
  /** What the caller may change */
  canManage: { org: boolean; workspaceIds: string[]; teamIds: string[] };
}
export interface TeamLibraryRow extends OrgLibrarySummary {
  /** The team's own row (defaults null when never set) */
  setting: LibraryScopeSetting;
}
export interface LibrarySettingsInput {
  scope: SettingScope;
  approved?: boolean;
  defaults?: Partial<Record<LibraryEditorType, boolean | null>>;
  /** modeId null: back to the collection's default */
  defaultModes?: { collectionKey: string; modeId: string | null }[];
}
export interface OrgLibrariesQuery {
  text?: string;
  workspaceId?: string;
  teamId?: string;
  approved?: boolean;
  enabledByDefault?: boolean;
}

export interface OrgLibrariesRepository {
  list(orgId: string, query?: OrgLibrariesQuery): Promise<OrgLibrarySummary[]>;
  get(orgId: string, key: LibraryKey): Promise<OrgLibraryInfo>;
  updateSettings(orgId: string, key: LibraryKey, input: LibrarySettingsInput): Promise<OrgLibraryInfo>;
  /** "Allow any member of ‹org› to access the file" after publishing (PATCH /libraries/:key) */
  setScope(key: LibraryKey, scope: LibraryScope): Promise<OrgLibraryInfo>;
  /** Team › View settings › "View team's libraries" */
  teamLibraries(teamId: string): Promise<TeamLibraryRow[]>;
}

// ---- library analytics (§17) ------------------------------------------------------------------------------------

export type AnalyticsAssetType = "component" | "style" | "variable";
export type UsageAction = "insert" | "detach";
/** Figma's ranges: 30, 60, 90 days, "last year" (rolling 12 months) */
export type AnalyticsRange = 30 | 60 | 90 | 365;

/** What the editor reports (§17.3); the store maps fileKey to the room key and `at` to a UTC day. */
export interface LibraryUsageEvent {
  fileKey: FileKey;
  libraryKey: LibraryKey;
  assetKey: string;
  assetType: AnalyticsAssetType;
  action: UsageAction;
  count: number;
  at: number;
}
/** POST /analytics/library-events — pre-aggregated per (day, file, library, asset, action) */
export interface WireUsageEvent {
  day: string;
  file: string;
  library: LibraryKey;
  asset: string;
  type: AnalyticsAssetType;
  action: UsageAction;
  count: number;
}
/** PUT /files/:key/library-usage — the file's current instances of org-library assets (§17.4) */
export interface FileUsageSnapshot {
  /** sha1 of the canonical rows: unchanged → the server does nothing */
  hash: string;
  assets: { library: LibraryKey; asset: string; type: AnalyticsAssetType; instances: number }[];
  modes: { library: LibraryKey; collection: string; mode: string; instances: number }[];
}

/** One week of actions, Figma's REST names; `week` is its Sunday 'YYYY-MM-DD' (UTC) */
export interface WeeklyActions {
  week: string;
  insertions: number;
  detachments: number;
}
export interface AssetStatsRow {
  key: string;
  name: string;
  type: AnalyticsAssetType;
  description: string;
  componentSetKey?: string;
  componentSetName?: string;
  /** Component sets: their variants */
  variants?: number;
  styleType?: string;
  variableType?: string;
  collectionKey?: string;
  collectionName?: string;
  /** A current snapshot */
  instances: number;
  /** In the last 30 days */
  insertions: number;
  detachments: number;
  teamsUsing: number;
  filesUsing: number;
}
/** Library analytics › Overview */
export interface LibraryOverview {
  libraryKey: LibraryKey;
  teamsUsing: number;
  counts: { components: number; styles: number; variables: number };
  /** "Activity this week": the last seven days */
  thisWeek: { insertions: number; detachments: number };
  rows: AssetStatsRow[];
  /** The last day included ('YYYY-MM-DD') */
  throughDay: string;
}
export interface TeamActionsRow {
  teamId: string | null;
  teamName: string;
  workspaceName: string | null;
  insertions: number;
  detachments: number;
  /** Share of all insertions, 0–1 */
  share: number;
}
/** Library analytics › Analytics, for one Type and one Duration */
export interface LibraryActions {
  type: AnalyticsAssetType;
  range: AnalyticsRange;
  series: WeeklyActions[];
  /** "Compare with" */
  compare: { libraryKey: LibraryKey; name: string; series: WeeklyActions[] } | null;
  topTeams: TeamActionsRow[];
  teamsUsing: number;
  rows: AssetStatsRow[];
  throughDay: string;
}
export interface FileUsageRow {
  /** null: "File not visible" (the caller can't see that file or its team) */
  fileKey: string | null;
  fileName: string;
  teamName: string | null;
  workspaceName: string | null;
  instances: number;
  lastModified: number | null;
}
/** One asset's usage view: "Used by" teams, "Used in" files */
export interface AssetUsage {
  row: AssetStatsRow;
  teams: TeamActionsRow[];
  files: FileUsageRow[];
}
export interface ModeUsageRow {
  collectionKey: string;
  collectionName: string;
  modeId: string;
  modeName: string;
  instances: number;
}
/** File browser › All teams (All workspaces) › Libraries */
export interface OrgLibrariesAnalytics {
  totals: { teams: number; teamsWithLibraries: number; libraries: number; components: number; styles: number; variables: number };
  libraries: { key: LibraryKey; name: string; teamName: string | null; components: number; styles: number; variables: number; insertsLastWeek: number }[];
  throughDay: string;
}

export interface LibraryAnalyticsRepository {
  /** The editor's events; queued and batched by the store, never fails (dropped for local files) */
  record(events: LibraryUsageEvent[]): Promise<void>;
  orgOverview(orgId: string, query?: { workspaceId?: string; text?: string }): Promise<OrgLibrariesAnalytics>;
  overview(key: LibraryKey): Promise<LibraryOverview>;
  actions(key: LibraryKey, query: { type: AnalyticsAssetType; range: AnalyticsRange; compareWith?: LibraryKey }): Promise<LibraryActions>;
  usage(key: LibraryKey, assetKey: string): Promise<AssetUsage>;
  modes(key: LibraryKey, collectionKey?: string): Promise<ModeUsageRow[]>;
  /** "Download CSV" (the view offers it above five teams, Figma's rule; the view saves the text through main) */
  csv(key: LibraryKey, query: { type: AnalyticsAssetType; range: AnalyticsRange }): Promise<string>;
}

// StoreApi gains: orgLibraries: OrgLibrariesRepository; analytics: LibraryAnalyticsRepository;
