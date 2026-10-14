/**
 * Studio (docs/studio.md, round 15 [ours]): the manager agent that hands a chat's work to other agents, the brand and
 * product library, and social posts with product pictures made by an image model. Shared by main, the store and the
 * editor; the store's `brands` repository is the only writer of the library on disk.
 */
import type { AiRoute } from "../ai/types";
import { StoreError } from "../store/protocol";

// ── The library (§3) ──────────────────────────────────────────────────────────────────────────────────────────────

/** What a picture is for: a product photo, a close-up of its label, a brand logo, or a look to follow. */
export type BrandImageRole = "packshot" | "label" | "logo" | "style";

export interface BrandImage {
  id: string;
  role: BrandImageRole;
  name: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

/** "sharp": written exactly in the picture (name, brand, volume); "soft": left illegible, as a low-resolution print (§5). */
export type LabelTier = "sharp" | "soft";

export interface LabelText {
  id: string;
  text: string;
  tier: LabelTier;
}

export interface Product {
  id: string;
  brandId: string;
  name: string;
  /** "20 L white translucent jerrycan, handle top left, blue hexagon seal on the cap" */
  shape: string;
  images: BrandImage[];
  labels: LabelText[];
  /** The owner checked the label texts and their tiers (the manager reads them off the pictures first, §4.1) */
  labelsConfirmed: boolean;
  notes: string;
  created: number;
  updated: number;
}

export interface BrandColor {
  name: string;
  /** "#1BA37A" */
  hex: string;
}

export interface SocialFormat {
  id: string;
  name: string;
  width: number;
  height: number;
}

export const DEFAULT_FORMATS: readonly SocialFormat[] = [
  { id: "post", name: "Post", width: 1080, height: 1350 },
  { id: "story", name: "Story", width: 1080, height: 1920 },
  { id: "square", name: "Square post", width: 1080, height: 1080 },
];

export interface Brand {
  id: string;
  name: string;
  colors: BrandColor[];
  fonts: string[];
  /** Voice and look, in the owner's words */
  tone: string;
  logos: BrandImage[];
  formats: SocialFormat[];
  /** A file published as this brand's library (logo components, colour variables, text styles), when there is one */
  libraryFileKey: string | null;
  products: Product[];
  created: number;
  updated: number;
}

export interface BrandSave {
  id?: string;
  name: string;
  colors?: BrandColor[];
  fonts?: string[];
  tone?: string;
  formats?: SocialFormat[];
  libraryFileKey?: string | null;
}

export interface ProductSave {
  id?: string;
  brandId: string;
  name: string;
  shape?: string;
  labels?: { id?: string; text: string; tier: LabelTier }[];
  labelsConfirmed?: boolean;
  notes?: string;
}

export interface BrandImageAdd {
  brandId: string;
  /** null: a brand picture (logo, style) */
  productId: string | null;
  role: BrandImageRole;
  name: string;
  /** base64 (PNG, JPEG or WebP; at most 20 MB) */
  data: string;
}

/** `Workspace/spaces/brands/` in the desktop store; keys in the browser's dev store. */
export interface BrandsRepository {
  list(): Promise<Brand[]>;
  get(id: string): Promise<Brand | null>;
  /** Brands and products whose names match (case and accents ignored), best first */
  find(query: string): Promise<{ brands: Brand[]; products: Product[] }>;
  saveBrand(b: BrandSave): Promise<Brand>;
  removeBrand(id: string): Promise<void>;
  saveProduct(p: ProductSave): Promise<Product>;
  removeProduct(brandId: string, productId: string): Promise<void>;
  addImage(a: BrandImageAdd): Promise<BrandImage>;
  removeImage(brandId: string, imageId: string): Promise<void>;
  /** A picture's bytes as base64 */
  image(brandId: string, imageId: string): Promise<{ data: string; mime: BrandImage["mime"] }>;
  /** Called with the brand's id after any change to it (or its removal) */
  watch(listener: (brandId: string) => void): () => void;
}

/** The stub both stores carry until 6s2 lands (round 15's first commit). */
export function brandsUnavailable(): BrandsRepository {
  const no = () => Promise.reject(new StoreError("invalid", "The brand library isn't built yet"));
  return { list: async () => [], get: async () => null, find: async () => ({ brands: [], products: [] }), saveBrand: no, removeBrand: no, saveProduct: no, removeProduct: no, addImage: no, removeImage: no, image: no, watch: () => () => {} };
}

/** What a request still needs before work starts (§4.2): each item names the brand / product field the form asks for. */
export interface Missing {
  brandId: string | null;
  productId: string | null;
  field: "brand" | "product" | "logo" | "packshot" | "labels" | "labels-confirmed" | "shape" | "colors";
  /** "Liq Humus has no product photo" */
  message: string;
}

// ── The manager (§2) ──────────────────────────────────────────────────────────────────────────────────────────────

/** A provider of the Agents tab and its model / effort. */
export interface AgentRoute {
  providerId: string;
  model?: string;
  effort?: string;
}

/** Agent settings › Manager (kept with AgentSettings in main's userData/agents/settings.json). */
export interface ManagerSettings {
  /** Off: the chat talks to the picked agent directly, as before round 15 */
  enabled: boolean;
  /** What the owner calls the manager: its chat answers, its avatar and cursor in the file, "Following <name>"; its
   *  workers show as "<name> · 2"… (docs/ai.md §2.13) */
  name: string;
  manager: AgentRoute;
  /** Who does general work (layout, text, layers) */
  general: AgentRoute;
  /** Who makes pictures; null: ask in the chat each time (§2.4) */
  image: AiRoute | null;
  /** Providers the manager may hand work to (ids); empty: every connected one */
  allowed: string[];
  /** CLI tasks at once (the 16 GB rule); image API calls run up to IMAGE_TASKS_AT_ONCE */
  parallel: number;
}

export const IMAGE_TASKS_AT_ONCE = 4;

/** The manager's name until the owner gives it one (shown translated: managerName) */
export const DEFAULT_MANAGER_NAME = "Manager";
/** Longest manager name kept */
export const MANAGER_NAME_MAX = 40;

export const DEFAULT_MANAGER_SETTINGS: ManagerSettings = {
  enabled: true,
  name: DEFAULT_MANAGER_NAME,
  manager: { providerId: "claude-code", model: "claude-haiku-5-5", effort: "low" },
  general: { providerId: "claude-code", model: "claude-sonnet-5-5" },
  image: null,
  allowed: [],
  parallel: 3,
};

export type TaskKind = "agent" | "image" | "review";
export type TaskState = "queued" | "running" | "done" | "failed" | "stopped";

/** One piece of work the manager handed out, shown as a task card in the chat (§2.3). */
export interface StudioTask {
  id: string;
  chatId: string;
  /** The manager's answer the card sits in */
  messageId: string;
  kind: TaskKind;
  /** "Post background, variation 2" */
  title: string;
  /** Who runs it: a provider (agent) or an image route */
  route: AgentRoute;
  state: TaskState;
  dependsOn: string[];
  startedAt?: number;
  endedAt?: number;
  /** What the worker said it did (its last answer, shortened), or why it failed */
  summary?: string;
  error?: string;
  /** What it made on the canvas */
  nodeIds?: string[];
  credits?: number;
}

/** A card the manager puts in the chat and waits on (ask_choice / show_form, §2.4, §4.1). */
export type ChatCard =
  | { kind: "choice"; id: string; question: string; options: { id: string; label: string; detail?: string }[]; remember?: boolean; answer?: { optionId: string; remember: boolean } }
  | { kind: "brand-form"; id: string; brandId?: string; prefill?: Partial<BrandSave>; answer?: { brandId: string } | { cancelled: true } }
  | { kind: "product-form"; id: string; brandId: string; productId?: string; prefill?: Partial<ProductSave>; answer?: { productId: string } | { cancelled: true } }
  | { kind: "review"; id: string; report: ReviewReport; answer?: { fix: string[] } | { cancelled: true } };

// ── Briefs and pictures (§5) ──────────────────────────────────────────────────────────────────────────────────────

/** Everything a request needs, read from the library once (§4.3): every worker gets the same brief. */
export interface StudioBrief {
  id: string;
  /** The owner's words */
  request: string;
  brandId: string;
  productIds: string[];
  formats: SocialFormat[];
  /** The scene asked for ("in a greenhouse, morning light"); empty: the manager's pick from the brand's tone */
  scene: string;
  variations: number;
  imageRoute: AiRoute;
}

/** A reference picture sent with the prompt, in the order the prompt names them ("Image 1: …"). */
export interface PromptReference {
  brandId: string;
  imageId: string;
  /** "Product reference: Liq Humus, front" */
  role: string;
}

export interface ImagePrompt {
  prompt: string;
  references: PromptReference[];
  /** "4:5", "9:16", "1:1" — the nearest the models take */
  aspectRatio: string;
}

// ── Review (§6) ───────────────────────────────────────────────────────────────────────────────────────────────────

export type ProblemKind = "sharp-text" | "soft-text" | "shape" | "extra" | "missing" | "layout" | "brand";

export interface ReviewProblem {
  id: string;
  kind: ProblemKind;
  /** "“Net 1 Litre” reads “Not 1 Litre”" */
  detail: string;
  /** Where, in the frame's coordinates (soft-text: the area to blur) */
  box?: { x: number; y: number; width: number; height: number };
  /** How it gets fixed (§6.2) */
  fix: "fix-label" | "blur" | "regenerate" | "relayout";
}

export interface ReviewItem {
  nodeId: string;
  name: string;
  ok: boolean;
  problems: ReviewProblem[];
}

export interface ReviewReport {
  briefId: string;
  items: ReviewItem[];
}
