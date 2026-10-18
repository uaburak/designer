/**
 * Every message between main and the views: channel names, who may use
 * them, and their payloads — the single source of truth (docs/desktop.md
 * §10, docs/desktop-impl.md). Main (src/main/ipc.ts) and the preloads
 * (src/preload/*) import these maps, so a channel can't drift.
 *
 * Kinds: `IpcInvoke` request/response from a view; `IpcSend` fire-and-forget
 * from a view; `IpcEvents` from main to a view.
 */
import type { AgentSettings, AuthState, ConnectResult, McpClientId, McpClientInfo, McpState, ProviderInfo, ToolCall, ToolCallResult, TurnEvent, TurnRequest, UsageInfo } from "./agents/types";
import type { AttachResult } from "./agents/attachments";
import type { AccessLogEntry, ReachPatch, ReachView } from "./agents/reach";
import type { AiImageRequest, AiModelId, AiModelInfo, AiModelState, AiRunEventMsg, AiRunRequest, AiSettings, Connector, ConnectorConsent, ConnectorToolPolicy, ImageRouteInfo } from "./ai/types";
import type { AccountMethod, AccountResponse, AccountState, SignInMethod, SignInResult } from "./account";
import type { CommandId, MenuStatePatch } from "./commands";
import type { SharedFontFace, SharedFontsChannels } from "./fonts/sharedTypes";
import type { PluginBundle, PluginManifest } from "./plugins/types";
import type { ShortcutSettings } from "./shortcuts";
import type { TabGroup, TabKind, TabReport, TabStatus } from "./tabs";
import type { Locale } from "./i18n";
import type { FigmaImage, FigmaResult, FigmaUser } from "./figmaApi";

/** What a view is (each its own WebContentsView, renderer process and preload). */
/** `welcome`: the signed-out window's one view (docs/desktop.md §18.6) — the splash, then the welcome page */
export type Role = "tabbar" | "home" | "editor" | "welcome";

export type ThemePreference = "system" | "light" | "dark";

export interface InitInfo {
  version: string;
  platform: string;
  role: Role;
  /** The file tab this view shows (editor), else null */
  tabId: string | null;
  /** The workspace file this view shows (editor), else null */
  fileKey: string | null;
  windowId: string;
  theme: ThemeState;
}

/** The theme: the preference main keeps (settings.json) and what it resolves to now (nativeTheme). */
export interface ThemeState {
  preference: ThemePreference;
  resolved: "light" | "dark";
  /** Settings › Account › "Enhance contrast" (docs/design-system.md §2.5): the high-contrast tokens on every view — as set,
   *  else the system's (atlas 21 §4.1) */
  contrast: boolean;
  /** Preferences › Accessibility settings › Underline links: `data-underline-links` on every view's body */
  underlineLinks: boolean;
}

/** A native menu's item, as a view asks for it (`menu:popup`): plain data, built into an Electron menu by main. */
export interface NativeMenuItem {
  id?: string;
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "submenu";
  checked?: boolean;
  enabled?: boolean;
  accelerator?: string;
  submenu?: NativeMenuItem[];
}

/** A tab as the tab bar and Home see it — Home first (`id: "home"`, no fileKey). */
export interface TabInfo {
  id: string;
  kind: TabKind | "home";
  fileKey?: string;
  title: string;
  status: TabStatus;
  pinned?: boolean;
  groupId?: string;
  /** A split tab (atlas 01 §2.3): the tab shown beside it */
  splitWith?: string;
}

/**
 * The card under a hovered tab (atlas 01 §2.2), drawn by the window's preview view (`?tabpreview`): the file's
 * thumbnail, its name, when it was edited (or last viewed) and its memory — or what offloading it freed.
 */
export interface TabPreview {
  tabId: string;
  title: string;
  kind: "design" | "prototype";
  /** The thumbnail's address (app://designer/_thumb/…), when the file has one */
  image: string | null;
  time: { kind: "edited" | "viewed"; at: number } | null;
  /** Its renderer's working set, or what offloading it freed, in MB */
  memory: { kind: "usage" | "freed"; mb: number } | null;
  /** Shown at once (the bar has keyboard focus, or a card was showing already) instead of after the hover delay */
  immediate: boolean;
}

export interface TabsSnapshot {
  windowId: string;
  tabs: TabInfo[];
  activeTabId: string;
  canReopen: boolean;
  fullScreen: boolean;
  /** The tab groups (atlas 01 §2.3), in the bar's order of their tabs */
  groups: TabGroup[];
}

export interface WindowState {
  fullScreen: boolean;
  focused: boolean;
}

/** Home's side of the tabs: whether it is in front, which files are open. */
export interface HomeState {
  visible: boolean;
  openFileKeys: string[];
}

export interface MenuCommandEvent {
  id: CommandId;
  /** A menu click, or an accelerator the page left unhandled (it saw the key already) */
  source: "menu" | "accelerator";
}

export type { MenuStatePatch };

/**
 * Why main asks a file tab to flush (docs/desktop.md §6): the tab or window
 * closes, the app quits, the view is dropped or reloaded — or it was hidden
 * (another tab came in front, the Mac sleeps or locks), when nothing waits
 * for the answer.
 */
export type FlushReason = "close" | "quit" | "discard" | "reload" | "hide";

/** `tab:flush`: every change handed to the store, and the store's flush (fsync) awaited. */
export interface TabFlush {
  reqId: number;
  reason: FlushReason;
}
export interface TabFlushed {
  reqId: number;
  ok: boolean;
  error?: string;
}

/** A workspace file in a tab (`nav:open-file`). */
export interface OpenWorkspaceFile {
  fileKey: string;
  /** The file's name, shown at once (main reads it from the store otherwise) */
  title?: string;
  /** Open without bringing it in front (Home's "Open in new tab") */
  background?: boolean;
  /** Where to land in the file (deep links; passed on as `tab:navigate` later) */
  pageId?: string;
  nodeId?: string;
}

/** A file's presentation view in a tab of its own (`nav:open-prototype`, Present). */
export interface OpenPrototype {
  fileKey: string;
  /** The page presented */
  pageId: string;
  /** The frame it starts at (none: the page's first flow) */
  startNodeId?: string;
  /** The file's name, for the tab */
  title?: string;
}

/** `nav:open-file`'s answer: the tab, and whether the file already had one (it was brought in front instead). */
export interface OpenFileResult {
  tabId: string;
  existing: boolean;
}

/**
 * `tab:attach` (docs/desktop.md §3.1, §10.2): an editor view told which tab
 * and file it is. A view made for a tab has them in its URL already; the
 * spare editor — pre-warmed with no file — learns them from this message
 * when a file opens and main adopts it.
 */
export interface TabAttach {
  tabId: string;
  fileKey: string;
  mode: "edit" | "prototype";
  pageId?: string;
  nodeId?: string;
  startNodeId?: string;
}

/** `nav:new-file`: a new design file in a folder (null: Drafts), opened in a tab. */
export interface NewFileRequest {
  folderId?: string | null;
  name?: string;
}
export interface NewFileResult {
  fileKey: string;
  tabId: string;
}

/** `file:import`: .fig files read into the workspace. */
export interface ImportResult {
  files: { fileKey: string; name: string }[];
  failed: { path: string; error: string }[];
}

/** One face of an installed font file (docs/desktop.md §14). Paths never reach a view. */
export interface FontFaceInfo {
  /** First 16 hex of sha1(path + "#" + collectionIndex) */
  id: string;
  /** Typographic family (name 16, else 1) */
  family: string;
  /** Typographic subfamily (name 17, else 2), e.g. "Semi Bold Italic" */
  style: string;
  postscriptName: string;
  /** 100–900 */
  weight: number;
  italic: boolean;
  /** 1–9 */
  stretch: number;
  source: "system" | "user";
  collectionIndex: number;
  /** A variable font (`fvar`): its styles are named instances */
  variable?: boolean;
}

/** The Figma connection (docs/desktop.md §13 "Images from Figma"): the token itself never leaves main. */
export interface FigmaConnection {
  connected: boolean;
  /** The token's account; null when unknown (a token without the "Current user" scope) */
  user: FigmaUser | null;
}

export type FigmaImagesResult = FigmaResult<{ images: FigmaImage[]; missing: string[] }>;

/** Settings › Account › "Your uploaded fonts" (docs/desktop.md §14.2): a face of a font file the user uploaded. */
export interface UploadedFont {
  /** The face's id in the font index (`fonts:read` gives its bytes) */
  id: string;
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  /** The file it is in (one file may hold several faces: a TTC) */
  file: string;
}

/** One style of a Google Fonts family (docs/desktop.md §14.1): its id is what `fonts:read` downloads. */
export interface GoogleFontStyle {
  /** Google's name: "Regular", "SemiBold Italic" … (the variable font's named instance) */
  style: string;
  weight: number;
  italic: boolean;
  id: string;
}
/** A family of the Google Fonts catalog (fonts.google.com/metadata/fonts, reduced). */
export interface GoogleFontFamily {
  family: string;
  /** "Sans Serif", "Serif", "Display", "Handwriting", "Monospace" */
  category: string;
  /** Google's popularity rank (1 = most used) */
  popularity: number;
  /** Variable axes (none: static files) */
  axes: { tag: string; min: number; max: number; default: number }[];
  styles: GoogleFontStyle[];
}

export interface FontIndex {
  version: number;
  /** The installed fonts (system and user) */
  faces: FontFaceInfo[];
  /** The Google Fonts catalog (empty offline before it was first fetched) */
  google?: GoogleFontFamily[];
  /**
   * Organization and team fonts the signed-in person may use (docs/desktop.md §14.3; `GET /me/fonts`, cached for
   * offline): every org and team of theirs — the editor keeps those of the open file's org and team. Ids "s:" + id.
   */
  shared?: SharedFontFace[];
}

/** One exported file: its name (relative, "/" for folders) and bytes. */
export interface ExportAsset {
  name: string;
  bytes: Uint8Array;
}

/** `file:export-preview`'s request (the options as the Share dialog chose them). */
export interface ExportPreviewRequest {
  fileKey: string;
  snapshot: Uint8Array;
  options: { pageIds: string[] | "all"; inspect: boolean; export: boolean };
}

/** Vector artwork on the system clipboard as SVG (docs/desktop.md §13 "Vector paste"). */
export interface VectorClipboard {
  svg: string;
  /** The pasteboard type it came from (`com.adobe.illustrator.svg`, `public.svg-image`, `com.adobe.pdf`…). */
  source: string;
  /** Left out by the PDF conversion: text objects and images. */
  skipped: { text: number; images: number };
}

/**
 * The app's updates (docs/desktop.md §12.6; electron-updater over the GitHub releases): where the updater is.
 * `upToDate` and `error` are what the last check found; `ready` is a downloaded update, installed on quit or by
 * "Restart to update".
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; percent: number; version: string | null }
  | { kind: "ready"; version: string }
  | { kind: "upToDate"; version: string }
  | { kind: "error"; message: string };

export interface UpdaterStatus {
  /** False in development, under `DisableUpdater`, for an MSI install or the portable zip: no menu item, no checks */
  enabled: boolean;
  state: UpdateState;
  /** The state comes from "Check for Updates…" (the tab bar shows its progress), not the daily check (which stays quiet) */
  manual: boolean;
  /** The running app's version */
  current: string;
}

/** The shared fonts' four channels (docs/desktop.md §14.3) are `SharedFontsChannels` (src/shared/fonts/sharedTypes.ts). */
export interface IpcInvoke extends SharedFontsChannels {
  "desktop:init": { args: []; result: InitInfo };
  "tabs:get": { args: []; result: TabsSnapshot };
  "nav:open-file": { args: [OpenWorkspaceFile]; result: OpenFileResult };
  "nav:open-prototype": { args: [OpenPrototype]; result: OpenFileResult };
  "nav:new-file": { args: [NewFileRequest]; result: NewFileResult };
  /** .fig files into a folder (null: Drafts): the given paths, or the ones picked in the system's Open dialog */
  "file:import": { args: [{ folderId: string | null; paths?: string[] }]; result: ImportResult };
  /** A file written out as a .fig where the system's Save dialog says */
  "file:save-local-copy": { args: [{ fileKey: string; partial?: boolean }]; result: { path: string } | { cancelled: true } };
  /**
   * Exported files (File › Export…, the Design panel's Export section, Export frames to PDF): one through the system's
   * Save dialog, more into a folder picked in its Open dialog; names with "/" make folders, a name already taken
   * becomes "name 2.png" (shared/exportFiles.ts)
   */
  "file:export-assets": { args: [{ files: ExportAsset[] }]; result: { paths: string[] } | { cancelled: true } };
  /**
   * A developer preview as one self-contained HTML file where the system's Save dialog says (docs/data.md §13):
   * `snapshot` is the editor's derived kiwi Message; the store adds the images and the viewer and writes the file
   */
  "file:export-preview": { args: [ExportPreviewRequest]; result: { path: string; bytes: number } | { cancelled: true } };
  /** The theme preference set: main keeps it, tells every view (`theme:changed`) and answers what it resolves to */
  "theme:set": { args: [ThemePreference]; result: ThemeState };
  /** "Enhance contrast" on or off: main keeps it (settings.json) and tells every view (`theme:changed`) */
  "theme:set-contrast": { args: [boolean]; result: ThemeState };
  /** Accessibility settings › Underline links on or off: kept and told the same way */
  "theme:set-underline-links": { args: [boolean]; result: ThemeState };
  /** The UI's language (Settings › Account › Language): main keeps it (settings.json), tells every view (`locale:changed`) and rebuilds the menu bar */
  "locale:set": { args: [Locale]; result: Locale };
  /** The updater's state (docs/desktop.md §12.6), for the tab bar */
  "updater:get": { args: []; result: UpdaterStatus };
  /** The user's keyboard shortcuts (settings.json; src/shared/shortcuts.ts) */
  "shortcuts:get": { args: []; result: ShortcutSettings };
  /** Bindings, shortcuts used or the layout changed (only the fields given): main keeps them, rebuilds the menu bar's accelerators, tells every editor */
  "shortcuts:set": { args: [Partial<ShortcutSettings>]; result: ShortcutSettings };
  /** A native menu at a point of the view (`at` in the view's CSS pixels): the picked item's id, or null */
  "menu:popup": { args: [{ template: NativeMenuItem[]; x: number; y: number }]; result: string | null };
  /** The system's and the user's fonts (scanned once, cached in userData/cache/fonts-v1.json) */
  "fonts:list": { args: []; result: FontIndex };
  /** A face's whole font file (the engine parses it), by its index id; a Google face is downloaded on first use */
  "fonts:read": { args: [{ id: string }]; result: Uint8Array };
  /** A Google family's Regular subset to `text` (its name), for the font picker's row in its own face */
  "fonts:preview": { args: [{ family: string; text: string }]; result: Uint8Array };
  /** "Your uploaded fonts": the faces of the font files the user uploaded (userData/fonts/uploaded) */
  "fonts:uploaded": { args: []; result: UploadedFont[] };
  /** "Upload font": main's Open dialog (TTF, OTF, TTC, OTC); the files are checked, copied and every file's font picker gets them */
  "fonts:upload": { args: []; result: { fonts: UploadedFont[]; failed: string[] } | { cancelled: true } };
  /** The trash button: the uploaded file holding that face is removed (with its other faces) */
  "fonts:remove-uploaded": { args: [{ id: string }]; result: UploadedFont[] };
  /** Paste: the pasteboard's vector artwork (Illustrator's SVG, any SVG, Illustrator's PDF as SVG), read by main (§13) */
  "clipboard:read-vector": { args: []; result: VectorClipboard | null };
  /** Settings › Account › Figma connection: whether a Figma token is kept (sealed in main) and whose it is */
  "figma:status": { args: []; result: FigmaConnection };
  /** Connect: the token checked with Figma (GET /v1/me), then kept sealed; Figma's refusal as an error */
  "figma:connect": { args: [{ token: string }]; result: FigmaResult<FigmaConnection> };
  "figma:disconnect": { args: []; result: FigmaConnection };
  /** Paste from Figma: the images (by imageRef) a paste needs, downloaded from the file it came from (§13) */
  "figma:images": { args: [{ fileKey: string; hashes: string[] }]; result: FigmaImagesResult };
  // ── Agents (src/main/agents; docs/research/figma/R12-agents-mcp.md) ──
  /** The AI tools on this computer (CLIs found, local model servers that answer) */
  "agents:providers": { args: []; result: ProviderInfo[] };
  "agents:settings": { args: []; result: AgentSettings };
  "agents:set-settings": { args: [Partial<Pick<AgentSettings, "providerId" | "models" | "manager">>]; result: AgentSettings };
  /** An OpenAI-compatible server by base URL; its key (if any) goes to the OS keychain (safeStorage), never to disk in clear */
  "agents:add-server": { args: [{ label: string; baseUrl: string; apiKey?: string }]; result: AgentSettings };
  "agents:remove-server": { args: [{ id: string }]; result: AgentSettings };
  /** Test connection: the provider's models, or why it can't be reached */
  "agents:test": { args: [{ providerId: string }]; result: { ok: boolean; models: string[]; error?: string; version?: string } };
  /** A CLI agent's sign-in state; Sign in / Sign out with its own commands (the browser does the sign-in) */
  "agents:auth": { args: [{ providerId: string }]; result: AuthState };
  "agents:sign-in": { args: [{ providerId: string }]; result: AuthState };
  "agents:sign-out": { args: [{ providerId: string }]; result: AuthState };
  /** Install: the tool's documented command (run here, its output kept for the error) or its download page */
  "agents:install": { args: [{ providerId: string }]; result: { ok: boolean; opened?: "installed" | "page"; error?: string } };
  /** A chat turn on this view's file: its events come as `agents:event` */
  "agents:turn": { args: [TurnRequest]; result: { turnId: string } };
  "agents:stop": { args: [{ turnId: string }]; result: void };
  /** The composer's files (a drop, a paste: their bytes) copied into the chat's folder */
  "agents:attach": { args: [{ chatId: string; files: { name: string; bytes: Uint8Array }[] }]; result: AttachResult };
  /** The composer's "+": main's file dialog, the picked files copied into the chat's folder */
  "agents:pick-attachments": { args: [{ chatId: string }]; result: AttachResult };
  /** ⌘V in the composer: the clipboard's files (Finder) or picture, read by main */
  "agents:attach-clipboard": { args: [{ chatId: string }]; result: AttachResult };
  /** The plan's limits from the agent's own CLI (`/usage`, no model call), cached a minute unless `fresh` */
  "agents:usage": { args: [{ providerId: string; fresh?: boolean }]; result: UsageInfo | null };
  /** The MCP server: its URL and connections */
  "agents:mcp": { args: []; result: McpState };
  /** MCP clients on this computer and whether they are connected */
  "agents:clients": { args: []; result: McpClientInfo[] };
  /** Connect: our server written into the client's config after main's confirmation (cancelled: ok false, no error) */
  "agents:connect": { args: [{ client: McpClientId }]; result: ConnectResult };
  "agents:disconnect": { args: [{ client: McpClientId }]; result: ConnectResult };
  /** Copy config: the client's entry as text (HTTP with the token), and the stdio command form */
  "agents:client-config": { args: [{ client: McpClientId }]; result: { path: string; text: string; stdio: string } };
  /** The signed-in account (docs/multiplayer.md §2); the session token stays in main */
  "account:get": { args: []; result: AccountState };
  /** Sign in in the system browser (Google or the org's SAML SSO); resolves when the browser comes back (or is
   *  cancelled / times out). `tenant`: straight to that org's IdP (docs/desktop.md §18.1) */
  /** `method` (docs/desktop.md §18.6): the welcome page's Log in with Google / Log in with SSO */
  "account:sign-in": { args: [opts?: { tenant?: string; method?: SignInMethod }]; result: SignInResult };
  "account:cancel-sign-in": { args: []; result: AccountState };
  "account:sign-out": { args: []; result: AccountState };
  /** Several accounts (docs/desktop.md §18.7): the app moves to another signed-in account (by its user id) */
  "account:switch": { args: [userId: string]; result: AccountState };
  /** Log out of all accounts */
  "account:sign-out-all": { args: []; result: AccountState };
  /** Settings: the caller's own account on the server (`/me…`, and the operator's `/operator/…` — shared/account.ts
   *  ACCOUNT_PATH); main adds the session */
  "account:request": { args: [{ method: AccountMethod; path: string; body?: unknown }]; result: AccountResponse };
  /** The idle prompt's "Stay logged in" (docs/desktop.md §18.2) */
  "account:stay-signed-in": { args: []; result: AccountState };
  // ── Plugins (docs/plugins.md §3.3; main's side is src/main/plugins, round 5e) ──
  /** Development plugins of this installation (userData/plugins/development.json) */
  "plugins:list-development": { args: []; result: DevelopmentPlugin[] };
  /** "Import new plugin from manifest…": main's file dialog, the manifest read and validated */
  "plugins:import-manifest": { args: []; result: { plugin: DevelopmentPlugin; manifest: PluginManifest } | { cancelled: true } };
  "plugins:remove-development": { args: [{ id: string }]; result: DevelopmentPlugin[] };
  /** A development plugin's manifest, code and UI, read by main from its folder (paths inside it only) */
  "plugins:read": { args: [{ id: string }]; result: PluginBundle };
  /** "New plugin…": the template's files written into a new folder main's Save dialog names, then imported */
  "plugins:new-plugin": { args: [{ name: string; template: "default" | "run-once" | "custom-ui" | "inspect" | "codegen" }]; result: { plugin: DevelopmentPlugin; manifest: PluginManifest; editorType: "figma" | "dev" } | { cancelled: true } };
  /** A run starts: its network rules (the manifest's `allowedDomains`; `devAllowedDomains` count when `dev`, a development
   *  plugin). `runId`: lower-case letters, digits, hyphens (≤ 63; it is the host of `plugin://<runId>/`). The view that
   *  registers a run owns it; a reload or close of the view ends its runs. */
  "plugins:begin-run": { args: [{ runId: string; allowedDomains: string[]; devAllowedDomains?: string[]; dev: boolean }]; result: void };
  "plugins:end-run": { args: [{ runId: string }]; result: void };
  /** Registers a run's UI document on the `plugin:` scheme (and the run, when `begin-run` wasn't called); answers the iframe's URL */
  "plugins:open-ui": { args: [{ runId: string; html: string; allowedDomains: string[]; devAllowedDomains?: string[]; dev: boolean }]; result: { url: string } };
  "plugins:close-ui": { args: [{ runId: string }]; result: void };
  /** `fetch` from a plugin's code, checked against its run's networkAccess (begin-run / open-ui), redirects included */
  "plugins:fetch": { args: [{ runId: string; url: string; init?: PluginFetchInit }]; result: PluginFetchResponse };
  /** `figma.clientStorage` (5 MB per plugin) */
  "plugins:storage": { args: [PluginStorageCall]; result: unknown };
  /** "Open console": the view's devtools (development plugins only) */
  "plugins:open-console": { args: []; result: void };
  // ── Dev Mode (docs/editor.md D-3) ──
  /** A dev resource link's page title (`https:` only, 5 s, ≤ 512 kB read, no local hosts); null when there is none */
  "devmode:link-title": { args: [{ url: string }]; result: { title: string | null } };
  // ── AI (docs/ai.md §8; main's side is src/main/ai, round 6f / 6b) ──
  /** The AI settings (route choices, allowance, flags); image keys only as set / not set */
  "ai:settings": { args: []; result: AiSettings };
  "ai:set-settings": { args: [Partial<Omit<AiSettings, "imageKeys">>]; result: AiSettings };
  /** An image API's key, kept in the keychain (null removes it) */
  "ai:set-image-key": { args: [{ provider: "openai" | "gemini"; key: string | null }]; result: AiSettings };
  /** A one-shot text run: its events come as `ai:event` with this runId */
  "ai:run": { args: [AiRunRequest]; result: void };
  /** An image run (Make, Edit, Expand, Erase): events as `ai:event` */
  "ai:image": { args: [AiImageRequest]; result: void };
  /** The image routes for the chat's model choice card (docs/studio.md §2.4) */
  "ai:image-routes": { args: []; result: ImageRouteInfo[] };
  "ai:cancel": { args: [{ runId: string }]; result: void };
  /** The local models and what is on disk; downloads need the confirmation the Settings / tool shows with the size */
  "ai:models": { args: []; result: { info: AiModelInfo[]; state: AiModelState[] } };
  "ai:model-download": { args: [{ id: AiModelId }]; result: AiModelState };
  "ai:model-remove": { args: [{ id: AiModelId }]; result: AiModelState };
  // ── Connectors (docs/ai.md §2.11) ──
  "agents:connectors": { args: []; result: Connector[] };
  "agents:add-connector": { args: [{ name: string; transport: { kind: "http"; url: string; key?: string } | { kind: "stdio"; command: string; args: string[] } }]; result: Connector[] };
  "agents:update-connector": { args: [{ id: string; enabled?: boolean; policies?: Record<string, ConnectorToolPolicy> }]; result: Connector[] };
  "agents:remove-connector": { args: [{ id: string }]; result: Connector[] };
  "agents:test-connector": { args: [{ id: string }]; result: Connector };
  // ── Agents' reach (docs/agents-reach.md): Agent settings › Access ──
  "agents:access": { args: []; result: ReachView };
  "agents:set-access": { args: [ReachPatch]; result: ReachView };
  /** Main's folder picker: the picked folder (its real path) becomes a grant of Local files */
  "agents:access-add-folder": { args: []; result: ReachView };
  "agents:access-log": { args: []; result: AccessLogEntry[] };
  "agents:clear-access-log": { args: []; result: void };
  /** GitHub (docs/agents-reach.md §6.1): the token goes to main once and is sealed there */
  "agents:github-token": { args: [{ token: string }]; result: ReachView };
  "agents:github-device-start": { args: []; result: { userCode: string; verificationUri: string; expiresIn: number } };
  "agents:github-device-poll": { args: []; result: { state: "pending" | "connected" | "expired" | "denied" } };
  "agents:github-disconnect": { args: []; result: ReachView };
  "agents:github-repos": { args: []; result: { fullName: string; private: boolean; description: string }[] };
  /** Local apps (docs/agents-reach.md §9): macOS System Settings › Privacy & Security › Screen Recording */
  "agents:screen-settings": { args: []; result: void };
}

/** A development plugin imported from its manifest (docs/plugins.md §3.3) */
export interface DevelopmentPlugin {
  path: string;
  id: string;
  name: string;
  addedAt: number;
}
export interface PluginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}
export interface PluginFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}
export type PluginStorageCall = { op: "get" | "set" | "delete" | "keys"; pluginId: string; key?: string; value?: unknown };

export interface IpcSend {
  "shell:ready": void;
  "tabs:activate": { tabId: string };
  "tabs:close": { tabId: string };
  "tabs:move": { tabId: string; toIndex: number };
  "tabs:context-menu": { tabId: string; x: number; y: number };
  /** Windows: the tab bar's main menu button — the app's menu, popped up at (x, y) in the bar */
  "tabs:main-menu": { x: number; y: number };
  "tabs:reopen": void;
  /** "+" (⌘T): the new-tab page in a new tab (atlas 01 §3) */
  "tabs:new-tab": void;
  /** A tab group's header pressed with the right button: its native menu (Edit group name, Group color, Ungroup, Delete group) */
  "tabs:group-menu": { groupId: string; x: number; y: number };
  /** The group's name typed in the bar (after Edit group name) */
  "tabs:group-rename": { groupId: string; name: string };
  /** The tabs menu at the bar's right end ("Open and recently closed tabs"), popped up at (x, y) */
  "tabs:list-menu": { x: number; y: number };
  /** The pointer (or the keyboard's focus) on a tab: its preview card under the bar from x; null: none */
  "tabs:hover": { tabId: string | null; x: number; keyboard?: boolean };
  /** "Check for Updates…" from the tab bar (docs/desktop.md §12.6) */
  "updater:check": void;
  /** "Restart to update": the app's normal quit (every file flushed, the store shut down), then the update installs and the app opens again */
  "updater:restart": void;
  /** Home in front ("Back to files"), the file shown there when given */
  "nav:go-home": { revealFileKey?: string } | undefined;
  "tab:report": TabReport;
  "tab:flushed": TabFlushed;
  /** What the view says about the menu bar's items (enabled, checked): only what changed */
  "menu:state": MenuStatePatch;
  /** The workspace folder in Finder */
  "file:reveal-data-folder": void;
  "shell:open-external": { url: string };
  /** A tool call's answer from the view that ran it */
  "agents:tool-result": ToolCallResult;
  /** The answer to a connector's consent card (`agents:consent`) */
  "agents:consent-answer": { reqId: number; allow: boolean; remember?: boolean; windowId?: string };
  /** A step of a scrub: the trackpad's haptic tick (macOS; main throttles it to one a frame — src/main/haptics.ts) */
  "haptics:tick": void;
}

export interface IpcEvents {
  "tabs:state": TabsSnapshot;
  /** To the tab bar: Edit group name was chosen — the group's name becomes a field */
  "tabs:edit-group": { groupId: string };
  /** To the window's tab preview view: the card to draw, or none */
  "tabs:preview": TabPreview | null;
  /** To the tab bar: the updater's state changed (docs/desktop.md §12.6) */
  "updater:state": UpdaterStatus;
  "window:state": WindowState;
  "menu:command": MenuCommandEvent;
  /** An editor view's tab and file (the spare editor adopted for a file that opens) */
  "tab:attach": TabAttach;
  "tab:visibility": { visible: boolean };
  /** A file tab: send every change to the store and flush it, then answer `tab:flushed` */
  "tab:flush": TabFlush;
  "home:state": HomeState;
  /** To Home: show this file (Show in File Browser, Back to files from it) */
  "home:reveal": { fileKey: string };
  /** To Home: a shared file's link was opened (designer://open?key=…, docs/multiplayer.md §3) */
  "home:open-shared": { key: string; link?: string };
  /** A new store port is on its way (with the event, as a transferred MessagePort): one per page load and per store start */
  "store:port": { generation: number };
  /** The theme changed (a choice, or the system's appearance while the preference is "system") */
  "theme:changed": ThemeState;
  /** The UI's language changed (src/shared/i18n) */
  "locale:changed": Locale;
  /** The keyboard shortcuts changed (in this or another editor) */
  "shortcuts:changed": ShortcutSettings;
  /** Fonts were installed or removed (or the Google Fonts catalog changed): read `fonts:list` again */
  "fonts:changed": { version: number };
  /** A chat turn's stream */
  "agents:event": TurnEvent;
  /** A tool to run on this view's file (answer `agents:tool-result`) */
  "agents:tool-call": ToolCall;
  /** The MCP server's connections changed */
  "agents:mcp-state": McpState;
  /** Signed in or out, or a sign-in started / ended */
  "account:changed": AccountState;
  /** The idle timeout's prompt, to "home" and "editor" views (docs/desktop.md §18.2) */
  "account:idle": IdleNotice;
  /** A development plugin's files changed (Hot reload plugin, docs/plugins.md §3.3) */
  "plugins:changed": { id: string };
  /** An AI run's stream (answers `ai:run` / `ai:image`) */
  "ai:event": AiRunEventMsg;
  /** A local model's download progress or state */
  "ai:model-state": AiModelState;
  /** A connector wants to run a tool: show the consent card (answer `agents:consent-answer`) */
  "agents:consent": ConnectorConsent;
}

/** The idle timeout's prompt (docs/desktop.md §18.2) */
export type IdleNotice = { state: "warning"; logoutAt: number } | { state: "cleared" } | { state: "logged-out" };

/** Which roles may use which channel (main drops anything else). */
export const INVOKE_ROLES: { [C in keyof IpcInvoke]: readonly Role[] } = {
  "desktop:init": ["tabbar", "home", "editor", "welcome"],
  "tabs:get": ["tabbar", "home"],
  "nav:open-file": ["home", "editor"],
  "nav:open-prototype": ["editor"],
  "nav:new-file": ["tabbar", "home", "editor"],
  "file:import": ["home", "editor"],
  "file:save-local-copy": ["home", "editor"],
  "file:export-assets": ["editor"],
  "file:export-preview": ["editor"],
  "theme:set": ["tabbar", "home", "editor", "welcome"],
  "theme:set-contrast": ["home", "editor"],
  "theme:set-underline-links": ["home", "editor"],
  "locale:set": ["tabbar", "home", "editor", "welcome"],
  "updater:get": ["tabbar"],
  "shortcuts:get": ["editor"],
  "shortcuts:set": ["editor"],
  "menu:popup": ["tabbar", "home", "editor"],
  "fonts:list": ["editor"],
  "fonts:read": ["home", "editor"],
  "fonts:uploaded": ["home", "editor"],
  "fonts:upload": ["home", "editor"],
  "fonts:remove-uploaded": ["home", "editor"],
  "fonts:preview": ["editor"],
  "figma:status": ["home", "editor"],
  "figma:connect": ["home", "editor"],
  "figma:disconnect": ["home", "editor"],
  "figma:images": ["editor"],
  "fonts:shared-list": ["home", "editor"],
  "fonts:shared-pick": ["home", "editor"],
  "fonts:shared-upload": ["home", "editor"],
  "fonts:shared-remove": ["home", "editor"],
  "clipboard:read-vector": ["editor"],
  // Settings › Agents in Home too: the setup channels (not turns or tools)
  "agents:providers": ["home", "editor"],
  "agents:settings": ["home", "editor"],
  "agents:set-settings": ["home", "editor"],
  "agents:add-server": ["home", "editor"],
  "agents:remove-server": ["home", "editor"],
  "agents:test": ["home", "editor"],
  "agents:auth": ["home", "editor"],
  "agents:sign-in": ["home", "editor"],
  "agents:sign-out": ["home", "editor"],
  "agents:install": ["home", "editor"],
  "agents:turn": ["editor"],
  "agents:stop": ["editor"],
  "agents:attach": ["editor"],
  "agents:pick-attachments": ["editor"],
  "agents:attach-clipboard": ["editor"],
  "agents:usage": ["editor"],
  "agents:mcp": ["home", "editor"],
  "agents:clients": ["home", "editor"],
  "agents:connect": ["home", "editor"],
  "agents:disconnect": ["home", "editor"],
  "agents:client-config": ["home", "editor"],
  "account:get": ["tabbar", "home", "editor", "welcome"],
  "account:sign-in": ["home", "editor", "welcome"],
  "account:cancel-sign-in": ["home", "editor", "welcome"],
  "account:sign-out": ["home", "editor"],
  "account:switch": ["home"],
  "account:sign-out-all": ["home"],
  "account:request": ["home", "editor"],
  "account:stay-signed-in": ["home", "editor"],
  "plugins:list-development": ["editor"],
  "plugins:import-manifest": ["editor"],
  "plugins:remove-development": ["editor"],
  "plugins:read": ["editor"],
  "plugins:new-plugin": ["editor"],
  "plugins:begin-run": ["editor"],
  "plugins:end-run": ["editor"],
  "plugins:open-ui": ["editor"],
  "plugins:close-ui": ["editor"],
  "plugins:fetch": ["editor"],
  "plugins:storage": ["editor"],
  "plugins:open-console": ["editor"],
  "devmode:link-title": ["editor"],
  "ai:settings": ["home", "editor"],
  "ai:set-settings": ["home", "editor"],
  "ai:set-image-key": ["home", "editor"],
  "ai:run": ["editor"],
  "ai:image": ["editor"],
  "ai:image-routes": ["home", "editor"],
  "ai:cancel": ["editor"],
  "ai:models": ["home", "editor"],
  "ai:model-download": ["home", "editor"],
  "ai:model-remove": ["home", "editor"],
  "agents:connectors": ["home", "editor"],
  "agents:add-connector": ["home", "editor"],
  "agents:update-connector": ["home", "editor"],
  "agents:remove-connector": ["home", "editor"],
  "agents:test-connector": ["home", "editor"],
  "agents:access": ["home", "editor"],
  "agents:set-access": ["home", "editor"],
  "agents:access-add-folder": ["home", "editor"],
  "agents:access-log": ["home", "editor"],
  "agents:clear-access-log": ["home", "editor"],
  "agents:github-token": ["home", "editor"],
  "agents:github-device-start": ["home", "editor"],
  "agents:github-device-poll": ["home", "editor"],
  "agents:github-disconnect": ["home", "editor"],
  "agents:github-repos": ["home", "editor"],
  "agents:screen-settings": ["home", "editor"],
};

export const SEND_ROLES: { [C in keyof IpcSend]: readonly Role[] } = {
  "shell:ready": ["tabbar", "home", "editor", "welcome"],
  "tabs:activate": ["tabbar", "home"],
  "tabs:close": ["tabbar", "editor"],
  "tabs:move": ["tabbar"],
  "tabs:context-menu": ["tabbar"],
  "tabs:main-menu": ["tabbar"],
  "tabs:reopen": ["tabbar", "home"],
  "tabs:new-tab": ["tabbar"],
  "tabs:group-menu": ["tabbar"],
  "tabs:group-rename": ["tabbar"],
  "tabs:list-menu": ["tabbar"],
  "tabs:hover": ["tabbar"],
  "updater:check": ["tabbar"],
  "updater:restart": ["tabbar"],
  "nav:go-home": ["editor"],
  "tab:report": ["editor"],
  "tab:flushed": ["editor"],
  "menu:state": ["home", "editor"],
  "file:reveal-data-folder": ["home", "editor"],
  "shell:open-external": ["home", "editor"],
  "agents:tool-result": ["editor"],
  "agents:consent-answer": ["editor"],
  "haptics:tick": ["tabbar", "home", "editor"],
};
