import type { AccessConsent } from "../agents/reach";

/** Figma AI in DesignerV2 (docs/ai.md). Shared by main (src/main/ai), the store (src/store/ai, src/store/search), the editor (editor/ai, imageTools, search) and the server (server/src/ai). */

export type AiAction =
  | "rename-layers" | "rewrite" | "translate" | "shorten" | "replace-content" | "add-interactions" | "first-draft"
  | "make-image" | "edit-image" | "remove-background" | "boost-resolution" | "expand-image" | "erase-object" | "isolate-object" | "vectorize"
  | "visual-search" | "search" | "agent";

/** A provider of the Agents tab (ProviderInfo.id), an image API ("openai-images" | "gemini-images"), "antigravity", or "local". */
export interface AiRoute { providerId: string; model?: string; effort?: string }

export interface AiSettings {
  enabled: boolean;
  text: AiRoute | null;
  image: AiRoute | null;
  actions: Partial<Record<AiAction, AiRoute>>;
  monthlyCredits: number;
  stopAtLimit: boolean;
  indexForSearch: boolean;
  /** Keys kept in the keychain; only whether one is set */
  imageKeys: { openai: boolean; gemini: boolean };
}
export const DEFAULT_AI_SETTINGS: AiSettings = { enabled: true, text: null, image: null, actions: {}, monthlyCredits: 4250, stopAtLimit: true, indexForSearch: true, imageKeys: { openai: false, gemini: false } };
export const AI_TEXT_DEFAULT_ORDER = ["claude-code", "codex", "antigravity", "cursor-agent", "ollama", "lmstudio"] as const;

export type AiErrorCode = "no-provider" | "signed-out" | "rate-limited" | "refused" | "bad-output" | "network" | "timeout" | "cancelled" | "disabled" | "over-limit" | "too-large" | "unsupported" | "no-model";

export interface AiRunRequest {
  runId: string;
  action: AiAction;
  route?: AiRoute;
  system: string;
  prompt: string;
  /** PNG base64, ≤ 8, ≤ 1024 px, for vision-capable routes */
  images?: { name: string; data: string }[];
  /** JSON Schema of the answer */
  schema?: Record<string, unknown>;
  maxOutputTokens?: number;
  /** Each attempt's limit when shorter than main's (Add interactions: Figma's 60 s, atlas 18 §6) */
  timeoutMs?: number;
}

export interface AiImageRequest {
  runId: string;
  action: Extract<AiAction, "make-image" | "edit-image" | "expand-image" | "erase-object">;
  route?: AiRoute;
  prompt?: string;
  /** PNG base64 */
  image?: string;
  /** PNG base64, transparent = to change */
  mask?: string;
  reference?: string;
  size?: { width: number; height: number };
  /** Studio (docs/studio.md §5): reference pictures in the order the prompt names them ("Image 1: …"), at most 8; PNG, JPEG or WebP base64 */
  references?: { data: string; role: string }[];
  /** "4:5", "9:16", "1:1", … — the nearest the model takes */
  aspectRatio?: string;
}

/** An image route the chat's model choice card offers (docs/studio.md §2.4): `ai:image-routes`. */
export interface ImageRouteInfo {
  /** "gemini-images" | "gemini-cli" | "antigravity" | "openai-images" */
  providerId: string;
  /** "Gemini API", "Gemini CLI", "Antigravity", "OpenAI Images" */
  label: string;
  models: { id: string; label: string; detail?: string }[];
  available: boolean;
  /** Why not ("Add a Gemini API key in Settings › AI") */
  reason?: string;
  /** Takes reference pictures and edits (fix label, §6.2) */
  references: boolean;
}

export interface AiUsage {
  input: number;
  output: number;
  images: number;
  credits: number;
  /** Who answered (main fills them: with "Automatic" only main knows the provider it picked) */
  providerId?: string;
  model?: string;
}

export type AiRunEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "result"; text: string; json?: unknown }
  | { type: "image"; data: string; mime: string; width: number; height: number }
  | { type: "usage"; usage: AiUsage }
  | { type: "error"; code: AiErrorCode; message: string }
  | { type: "done"; cancelled?: boolean };
export interface AiRunEventMsg { runId: string; event: AiRunEvent }

export interface AiUsageEntry {
  id: string;
  at: number;
  action: AiAction;
  providerId: string;
  model?: string;
  input: number;
  output: number;
  images: number;
  credits: number;
  fileKey: string | null;
  orgId: string | null;
  local: boolean;
  ok: boolean;
}
export interface AiBalance { month: string; used: number; allowance: number; remaining: number; resetsAt: number; byAction: Partial<Record<AiAction, number>> }

/** Figma-like credits (docs/ai.md §2.9; Figma's table: help 33459875669015). */
export function creditsFor(action: AiAction, m: { input?: number; output?: number; megapixels?: number; colors?: number; model?: string }): number {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const mp = Math.max(0, m.megapixels ?? 0);
  switch (action) {
    case "rename-layers": case "visual-search": case "search": return 0;
    case "add-interactions": return 20;
    case "remove-background": return clamp(Math.ceil(mp), 1, 5);
    case "vectorize": return clamp(1 + Math.ceil((m.colors ?? 2) / 4), 2, 5);
    case "boost-resolution": case "erase-object": case "isolate-object": case "expand-image": return clamp(4 + Math.ceil(mp), 5, 10);
    case "make-image": case "edit-image": {
      const model = m.model ?? "";
      return /^gpt-image/.test(model) ? 2 : /pro|gemini-3/.test(model) ? 16 : 8;
    }
    default: return Math.max(1, Math.ceil((m.input ?? 0) / 4000 + (m.output ?? 0) / 1000));
  }
}

export interface AiSkill { id: string; name: string; description: string; instructions: string; enabled: boolean; createdAt: number; updatedAt: number }
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_LIMITS = { name: 64, description: 1024, instructions: 64 * 1024 } as const;

export type ConnectorToolPolicy = "allow" | "ask" | "off";
export interface Connector {
  id: string;
  name: string;
  transport: { kind: "http"; url: string; hasKey: boolean } | { kind: "stdio"; command: string; args: string[] };
  enabled: boolean;
  tools: { name: string; description?: string; policy: ConnectorToolPolicy }[];
  state: "connected" | "error" | "unknown";
  error?: string;
}
export interface ConnectorConsent {
  reqId: number;
  turnId: string;
  connectorId: string;
  connector: string;
  tool: string;
  args: unknown;
  /** The chat the card shows in (a manager's tasks ask in their chat too); absent: the turn's own chat */
  chatId?: string;
  /** Agents' reach (docs/agents-reach.md §3): the capability's card — or, for Local apps, the window picker */
  access?: AccessConsent;
}

export type AiModelId = "isnet" | "swin2sr-x4" | "lama" | "clip-vit-b32" | "minilm-l6";
export interface AiModelInfo { id: AiModelId; label: string; use: string; license: string; repo: string; revision: string; files: { path: string; bytes: number; sha256: string }[]; bytes: number }
export interface AiModelState { id: AiModelId; state: "absent" | "downloading" | "ready" | "error"; received?: number; bytes: number; error?: string }

export interface TraceOptions { mode: "FULL_COLOR" | "GRAYSCALE" | "BLACK_AND_WHITE"; colors?: number; grays?: number; threshold?: number; speckle?: number; alphaMax?: number; optTolerance?: number }
export interface TraceResult { width: number; height: number; layers: { color: string; area: number; d: string }[] }

export type SearchKind = "frame" | "component" | "componentSet";
export interface SearchDoc { fileKey: string; fileName: string; nodeId: string; kind: SearchKind; name: string; pageId: string; pageName: string; version: string; text: string; width: number; height: number; modifiedAt: number }
export interface SearchVectors { clip: Float32Array; text: Float32Array }
export interface SearchQuery { text?: string; clip?: Float32Array; textVec?: Float32Array; fileKey?: string; libraryKey?: string; kinds?: SearchKind[]; sort: "relevance" | "modified"; limit?: number }
export interface SearchHit { doc: SearchDoc; score: number; exact: boolean }

export interface SearchRepository {
  upsert(entries: { doc: SearchDoc; vectors: SearchVectors; thumb: Uint8Array }[]): Promise<void>;
  remove(fileKey: string, nodeIds?: string[]): Promise<void>;
  versions(fileKey: string): Promise<Record<string, string>>;
  query(q: SearchQuery): Promise<SearchHit[]>;
  thumb(fileKey: string, nodeId: string): Promise<Uint8Array | null>;
  stats(): Promise<{ files: number; docs: number; bytes: number }>;
  clear(): Promise<void>;
}

export interface AiRepository {
  record(e: Omit<AiUsageEntry, "id" | "at">): Promise<AiUsageEntry>;
  balance(allowance: number, now?: number): Promise<AiBalance>;
  history(q: { month?: string; limit?: number; cursor?: string }): Promise<{ entries: AiUsageEntry[]; cursor: string | null }>;
  skills(): Promise<AiSkill[]>;
  saveSkill(s: { id?: string; name: string; description: string; instructions: string; enabled?: boolean }): Promise<AiSkill>;
  removeSkill(id: string): Promise<void>;
}
