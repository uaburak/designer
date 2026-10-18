/**
 * The manager's tools (docs/studio.md §2.2, §5.1, §5.4, §6), answered in the view: tasks handed to workers and the
 * image model (tasks.ts), the cards that wait for the owner (choice, brand / product forms, the review), make_posts'
 * pipeline (an image task and a frame task per format × variation, the picture put into its frame's "Picture" layer,
 * a review task after all of them) and the fixes a review asks for (§6.2). Everything the editor does for them comes
 * through `ManagerEnv` (AgentsService builds it), so the tests run them on fakes.
 */
import type { ToolContent, ToolResult } from "@shared/agents/tools";
import { MANAGER_TOOL_NAMES, textResult } from "@shared/agents/tools";
import type { ProviderInfo } from "@shared/agents/types";
import type { AiRoute, ImageRouteInfo } from "@shared/ai/types";
import { DEFAULT_FORMATS, IMAGE_TASKS_AT_ONCE, type AgentRoute, type Brand, type BrandsRepository, type ChatCard, type ImagePrompt, type ManagerSettings, type Product, type ProblemKind, type ReviewItem, type ReviewProblem, type ReviewReport, type SocialFormat, type StudioBrief, type StudioTask, type TaskKind } from "@shared/studio/types";
import { missingFor } from "@shared/studio/library";
import { buildFixLabelPrompt, buildImagePrompt, nearestAspectRatio } from "@shared/studio/prompt";
import { LIBRARY_TOOLS } from "../studio/libraryTools";
import type { StudioImage, StudioImageRequest } from "../studio/images";
import type { TaskQueue, TaskResult, TaskRun } from "./tasks";
import { imageRouteOptions, routeOfOption } from "./imageRoutes";
import { t } from "@/i18n";

export { imageRouteOptions, routeOfOption };

/** A card in the chat: the shared shape, plus the choice options it greys out (an image route that can't run now). */
export type ViewCard = ChatCard & { disabled?: string[] };

/** The answer a card resolves with; `cancelled` when the turn ended (or was stopped) before the owner answered. */
export type CardAnswer = NonNullable<ChatCard["answer"]> | { cancelled: true };

/** A post make_posts started: which brief, format and variation its frame is, and its layers once made (§5.1). */
export interface PostRecord {
  frameName: string;
  briefId: string;
  formatId: string;
  variation: number;
  pageId: string | null;
  frameTaskId: string;
  imageTaskId: string;
  frameNodeId?: string;
  pictureNodeId?: string;
  /** The image prompt it was made with (a task card can run it again edited) */
  prompt?: string;
}

/** What the manager's tools keep on the chat. */
export interface StudioChatData {
  imageRoute?: AiRoute;
  briefs?: StudioBrief[];
  posts?: PostRecord[];
  /** Where the next request's row of frames goes (one row per request, §5.1) */
  rows?: { pageId: string; x: number; nextY: number };
}

/** Extra about a task the card shows: its prompt (§5.2: open, edit, run again). */
export interface TaskExtra {
  prompt?: string;
  /** An image task of a post: the frame it fills */
  post?: string;
}

export interface ManagerEnv {
  chatId: string;
  /** The manager's answer its tasks and cards sit in */
  messageId: string;
  /** Aborts when the manager's turn is stopped (or the file closes) */
  signal: AbortSignal;
  settings(): ManagerSettings;
  providers(): ProviderInfo[];
  queue: TaskQueue;
  data(): StudioChatData;
  setData(fn: (d: StudioChatData) => StudioChatData): void;
  /** Puts a card in the manager's answer and waits for the owner */
  ask(card: ViewCard): Promise<CardAnswer>;
  /** Notes what the card shows about a task (its prompt) */
  noteTask(taskId: string, extra: TaskExtra): void;
  /** A worker's turn for an agent task (its own actor and folder): resolves with its last answer, rejects on failure */
  runWorker(task: StudioTask, prompt: string, signal: AbortSignal, attachments?: { path: string; name: string; mime: string }[]): Promise<TaskResult>;
  brands: BrandsRepository;
  library(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  runImage(req: StudioImageRequest, signal: AbortSignal): Promise<StudioImage>;
  blur(nodeId: string, boxes: { x: number; y: number; width: number; height: number }[]): Promise<void>;
  imageRoutes(): Promise<ImageRouteInfo[]>;
  /** Copies files into the chat's folder (a logo for a worker): their paths for the worker's turn */
  attach(files: { name: string; bytes: Uint8Array }[]): Promise<{ path: string; name: string; mime: string }[]>;
  /** A canvas tool run by the studio itself (the picture into its frame, a screenshot for the review): one undo step each */
  tool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** The page the owner is on */
  page(): string | null;
  /** Layers' names, sizes and places (top-level frames of a page, a frame's children) */
  read(id: string): { name: string; type: string; x: number; y: number; width: number; height: number; children: string[] } | null;
  /** The picture filling a layer, as base64 (Fix label edits it) */
  pictureOf(nodeId: string): Promise<string | null>;
}

export const LIBRARY_TOOL_NAMES = (): Set<string> => new Set(LIBRARY_TOOLS.map((t) => t.name));

/** Is `name` one of the manager's own tools (its MANAGER_TOOLS or the library's)? */
export const isManagerTool = (name: string) => MANAGER_TOOL_NAMES.has(name) || LIBRARY_TOOL_NAMES().has(name);

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const routeLabel = (r: AgentRoute) => `${r.providerId}${r.model ? ` · ${r.model}` : ""}`;

/** A manager tool call: its result, or an error result (never throws). */
export async function runManagerTool(env: ManagerEnv, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "delegate_task":
        return delegateTask(env, args);
      case "wait_tasks":
        return await waitTasks(env, args);
      case "stop_task": {
        const id = str(args.taskId);
        if (!env.queue.get(id)) return textResult(`No task ${id}.`, true);
        env.queue.stop(id);
        return textResult({ taskId: id, state: env.queue.get(id)!.state });
      }
      case "ask_choice":
        return await askChoice(env, args);
      case "show_form":
        return await showForm(env, args);
      case "make_posts":
        return await makePosts(env, args);
      case "review":
        return await review(env, args);
      case "report_review":
        return await reportReview(env, args);
      default:
        if (LIBRARY_TOOL_NAMES().has(name)) return await env.library(name, args);
        return textResult(`Unknown tool ${name}`, true);
    }
  } catch (err) {
    return textResult(errorText(err), true);
  }
}

// ---- Tasks ------------------------------------------------------------------------------------------------------------

function addTask(env: ManagerEnv, kind: TaskKind, title: string, route: AgentRoute, dependsOn: string[], run: TaskRun): StudioTask {
  return env.queue.add({ id: `task-${uid()}`, chatId: env.chatId, messageId: env.messageId, kind, title: title.slice(0, 200), route, dependsOn }, run);
}

/** The agents the manager may hand work to: connected, and in the settings' list when it has one. */
function usableAgent(env: ManagerEnv, providerId: string): ProviderInfo | string {
  const p = env.providers().find((x) => x.id === providerId);
  if (!p) return `No agent “${providerId}” on this computer.`;
  if (!p.available) return `${p.label} isn't connected (Agent settings).`;
  const allowed = env.settings().allowed;
  if (allowed.length && !allowed.includes(p.id)) return `${p.label} isn't among the agents the manager may use (Agent settings › Manager).`;
  return p;
}

const WORKER_NOTE =
  "[You are a worker of this chat's manager. Do exactly this task on the open file with the design tools — no questions, decide sensibly — then answer in one or two sentences what you made (names, not ids).]";

function delegateTask(env: ManagerEnv, args: Record<string, unknown>): ToolResult {
  const title = str(args.title).trim();
  const prompt = str(args.prompt).trim();
  if (!title || !prompt) return textResult("delegate_task needs a title and a prompt.", true);
  if (args.kind !== undefined && args.kind !== "agent") return textResult('Only kind "agent" can be delegated; pictures go through make_posts.', true);
  const general = env.settings().general;
  const route: AgentRoute = args.agent ? { providerId: str(args.agent), ...(str(args.model) ? { model: str(args.model) } : {}) } : { ...general, ...(str(args.model) ? { model: str(args.model) } : {}) };
  const agent = usableAgent(env, route.providerId);
  if (typeof agent === "string") return textResult(agent, true);
  const dependsOn = strs(args.dependsOn);
  const unknown = dependsOn.filter((id) => !env.queue.get(id));
  if (unknown.length) return textResult(`No task ${unknown.join(", ")} to depend on.`, true);
  const task = addTask(env, "agent", title, route, dependsOn, (signal) => env.runWorker(env.queue.get(task.id)!, `${WORKER_NOTE}\n\n${prompt}`, signal));
  env.noteTask(task.id, { prompt });
  return textResult({ taskId: task.id, state: task.state, agent: routeLabel(route) });
}

/** A task as wait_tasks reports it. */
const taskReport = (t: StudioTask) => ({ taskId: t.id, title: t.title, state: t.state, ...(t.summary ? { summary: t.summary } : {}), ...(t.error ? { error: t.error } : {}), ...(t.nodeIds?.length ? { nodeIds: t.nodeIds } : {}) });

async function waitTasks(env: ManagerEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const ids = strs(args.taskIds);
  if (!ids.length) return textResult("wait_tasks needs taskIds.", true);
  const sec = typeof args.timeoutSec === "number" && args.timeoutSec > 0 ? Math.min(1700, args.timeoutSec) : 600;
  const tasks = await env.queue.wait(ids, sec * 1000, env.signal);
  const unknown = ids.filter((id) => !tasks.some((t) => t.id === id));
  const open = tasks.filter((t) => t.state === "queued" || t.state === "running").length;
  return textResult({ tasks: tasks.map(taskReport), ...(unknown.length ? { unknown } : {}), ...(open ? { note: `${open} still running after ${sec} s: wait_tasks again.` } : {}) });
}

// ---- Cards --------------------------------------------------------------------------------------------------------------

/** The chat's image model: kept for the chat, else the settings', else the choice card (and kept when the owner says so). */
async function imageRouteFor(env: ManagerEnv): Promise<AiRoute | null> {
  const known = env.data().imageRoute ?? env.settings().image;
  if (known) return known;
  return askImageRoute(env);
}

async function askImageRoute(env: ManagerEnv): Promise<AiRoute | null> {
  const routes = await env.imageRoutes().catch(() => [] as ImageRouteInfo[]);
  const { options, disabled } = imageRouteOptions(routes);
  if (!options.length || options.every((o) => disabled.includes(o.id))) throw new Error("No image model can run: add a Gemini API key in Settings › AI, or install the Gemini CLI or Antigravity.");
  const answer = await env.ask({ kind: "choice", id: `card-${uid()}`, question: t("Which image model should make the pictures?"), options, remember: true, disabled });
  if ("cancelled" in answer || !("optionId" in answer)) return null;
  const route = routeOfOption(answer.optionId);
  if (answer.remember) env.setData((d) => ({ ...d, imageRoute: route }));
  return route;
}

async function askChoice(env: ManagerEnv, args: Record<string, unknown>): Promise<ToolResult> {
  if (args.imageRoute === true) {
    const route = await askImageRoute(env);
    return route ? textResult({ imageRoute: route, keptForChat: !!env.data().imageRoute }) : textResult("cancelled");
  }
  const question = str(args.question).trim();
  const options = (Array.isArray(args.options) ? args.options : [])
    .map((o) => ({ id: str((o as { id?: unknown })?.id) || str((o as { label?: unknown })?.label), label: str((o as { label?: unknown })?.label), detail: str((o as { detail?: unknown })?.detail) || undefined }))
    .filter((o) => o.id && o.label)
    .slice(0, 12);
  if (!question || options.length < 1) return textResult("ask_choice needs a question and options [{id, label}].", true);
  const answer = await env.ask({ kind: "choice", id: `card-${uid()}`, question, options, ...(args.remember === true ? { remember: true } : {}) });
  if ("cancelled" in answer || !("optionId" in answer)) return textResult("cancelled");
  const picked = options.find((o) => o.id === answer.optionId);
  return textResult({ optionId: answer.optionId, label: picked?.label ?? answer.optionId, ...(answer.remember ? { remember: true } : {}) });
}

async function showForm(env: ManagerEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const prefill = args.prefill && typeof args.prefill === "object" && !Array.isArray(args.prefill) ? (args.prefill as Record<string, unknown>) : undefined;
  if (args.form === "brand") {
    const answer = await env.ask({ kind: "brand-form", id: `card-${uid()}`, ...(str(args.brandId) ? { brandId: str(args.brandId) } : {}), ...(prefill ? { prefill } : {}) });
    return "brandId" in answer ? textResult({ brandId: answer.brandId }) : textResult("cancelled");
  }
  if (args.form === "product") {
    const brandId = str(args.brandId);
    if (!brandId) return textResult("show_form product needs the brandId.", true);
    const answer = await env.ask({ kind: "product-form", id: `card-${uid()}`, brandId, ...(str(args.productId) ? { productId: str(args.productId) } : {}), ...(prefill ? { prefill: { ...prefill, brandId } as never } : {}) });
    return "productId" in answer ? textResult({ productId: answer.productId }) : textResult("cancelled");
  }
  return textResult('show_form: form is "brand" or "product".', true);
}

// ---- make_posts (§5.1, §5.4) --------------------------------------------------------------------------------------------

/** The brief's products in its order (a product removed since is left out). */
const productsOf = (brand: Brand, ids: readonly string[]) => ids.map((id) => brand.products.find((p) => p.id === id)).filter((p): p is Product => !!p);

/** "Liq Humus — Post v1" (§5.1). */
export const frameName = (products: readonly Product[], format: SocialFormat, variation: number) => `${products.map((p) => p.name).join(" + ")} — ${format.name} v${variation}`;

/** The formats asked for (the brand's, by id), default its Post and Story (§4.2). */
function formatsFor(brand: Brand, ids: readonly string[]): SocialFormat[] {
  const all = brand.formats.length ? brand.formats : [...DEFAULT_FORMATS];
  if (ids.length) {
    const found = ids.map((id) => all.find((f) => f.id === id || f.name.toLowerCase() === id.toLowerCase()) ?? DEFAULT_FORMATS.find((f) => f.id === id)).filter((f): f is SocialFormat => !!f);
    if (found.length) return found;
  }
  const pick = all.filter((f) => f.id === "post" || f.id === "story");
  return pick.length ? pick : all.slice(0, 2);
}

const GAP = 100;
const ROW_GAP = 200;

/**
 * Where a request's row of frames starts (§5.1): right of the page's content, its top — the chat's next row under the
 * last one when it made one on this page.
 */
function rowStart(env: ManagerEnv, pageId: string | null): { x: number; y: number } {
  const rows = env.data().rows;
  if (rows && rows.pageId === pageId) return { x: rows.x, y: rows.nextY };
  let right = -Infinity;
  let top = Infinity;
  for (const id of pageId ? (env.read(pageId)?.children ?? []) : []) {
    const n = env.read(id);
    if (!n) continue;
    right = Math.max(right, n.x + n.width);
    top = Math.min(top, n.y);
  }
  return right === -Infinity ? { x: 0, y: 0 } : { x: Math.round(right + ROW_GAP), y: Math.round(top) };
}

/** The frame task's prompt (§5.1): the frame, its "Picture" layer at the bottom, the brand's text and logo. */
export function framePrompt(o: { brand: Brand; products: readonly Product[]; format: SocialFormat; name: string; x: number; y: number; pageId: string | null; request: string; logo?: string }): string {
  const { brand, format } = o;
  const story = format.height / format.width > 1.6;
  const safe = story ? "keep text and logo 250 px from the top and bottom and 64 px from the sides (the story's safe area)" : "keep text and logo 64 px inside every edge";
  const colors = brand.colors.length ? brand.colors.map((c) => `${c.name} ${c.hex}`).join(", ") : "none given: pick from the logo";
  const fonts = brand.fonts.length ? brand.fonts.join(", ") : "Inter";
  const logo = brand.libraryFileKey
    ? `Use the brand library's components and styles (the library file ${brand.libraryFileKey} enabled in this file): its logo component, colour variables and text styles.`
    : o.logo
      ? `The logo is the attached file ${o.logo}: put it in with place_image {path} into a frame or rectangle sized for it (keep its aspect ratio; don't redraw it).`
      : "There is no logo picture: write the brand name as a wordmark in the brand's font.";
  return [
    `Make one social post frame for ${brand.name}${o.request ? ` (the owner asked: “${o.request}”)` : ""}.`,
    `1. A top-level FRAME named exactly “${o.name}”, ${format.width} × ${format.height}, at x ${o.x}, y ${o.y}${o.pageId ? ` on the page ${o.pageId}` : ""}, clipping its content.`,
    `2. Its bottom layer (the first child): a RECTANGLE named exactly “Picture”, x 0, y 0, ${format.width} × ${format.height}, fill #D9D9D9 — the product picture goes there later. Don't put anything else at the bottom.`,
    `3. Over it, the brand's text and logo: a short headline with ${o.products.map((p) => p.name).join(" and ")} (and a line in the brand's tone if it fits), ${safe}. Leave the middle of the frame free for the product. Colours: ${colors}. Fonts: ${fonts}.${brand.tone ? ` Tone: ${brand.tone}.` : ""}`,
    `4. ${logo}`,
    "Don't add any other picture, product or logo. Don't change other layers of the file.",
  ].join("\n");
}

/** The top-level frame named `name` on the page (the last one when there are several). */
function findFrame(env: ManagerEnv, pageId: string | null, name: string): string | null {
  const kids = pageId ? (env.read(pageId)?.children ?? []) : [];
  for (let i = kids.length - 1; i >= 0; i--) if (env.read(kids[i])?.name === name) return kids[i];
  return null;
}

/** A frame's "Picture" layer (§5.1), made at its bottom when the worker didn't. */
async function pictureLayer(env: ManagerEnv, frameId: string): Promise<string> {
  const frame = env.read(frameId);
  if (!frame) throw new Error("The frame isn't there any more.");
  const found = frame.children.find((id) => env.read(id)?.name === "Picture");
  if (found) return found;
  const made = await env.tool("create_nodes", { parentId: frameId, nodes: [{ type: "RECTANGLE", name: "Picture", x: 0, y: 0, width: frame.width, height: frame.height }] });
  const id = made.touched?.[0];
  if (made.isError || !id) throw new Error("Couldn't make the frame's Picture layer.");
  await env.tool("reparent_nodes", { nodeIds: [id], parentId: frameId, index: 0 });
  return id;
}

/** The picture into its frame's "Picture" layer (FILL), one undo step. */
async function placePicture(env: ManagerEnv, frameId: string, image: StudioImage): Promise<string> {
  const pic = await pictureLayer(env, frameId);
  const r = await env.tool("place_image", { nodeId: pic, data: toBase64(image.data), scaleMode: "FILL" });
  if (r.isError) throw new Error(r.content.map((c) => (c.type === "text" ? c.text : "")).join(" ") || "The picture couldn't be placed.");
  return pic;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** An image run with the prompt's references read from the library (runStudioImage records it in the ledger itself). */
async function runPicture(env: ManagerEnv, route: AiRoute, p: ImagePrompt, size: { width: number; height: number }, signal: AbortSignal, image?: string): Promise<StudioImage> {
  const references = await Promise.all(p.references.map(async (r) => ({ data: (await env.brands.image(r.brandId, r.imageId)).data, role: r.role })));
  return env.runImage({ route, prompt: p.prompt, references, aspectRatio: p.aspectRatio, size, ...(image ? { image } : {}) }, signal);
}

const imageTaskRoute = (r: AiRoute): AgentRoute => ({ providerId: r.providerId, ...(r.model ? { model: r.model } : {}) });

/** The brand's first logo as a file in the chat's folder, for the frame workers (none: they write a wordmark). */
async function logoFile(env: ManagerEnv, brand: Brand): Promise<{ path: string; name: string; mime: string } | undefined> {
  // Logos and style pictures share Brand.logos: the role tells them apart.
  const logo = brand.logos.find((l) => l.role === "logo");
  if (!logo || brand.libraryFileKey) return undefined;
  try {
    const { data, mime } = await env.brands.image(brand.id, logo.id);
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return (await env.attach([{ name: `${brand.name.replace(/[^\w-]+/g, "-")}-logo.${ext}`, bytes }]))[0];
  } catch {
    return undefined;
  }
}

async function makePosts(env: ManagerEnv, args: Record<string, unknown>): Promise<ToolResult> {
  let brief = str(args.briefId) ? env.data().briefs?.find((b) => b.id === str(args.briefId)) : undefined;
  if (str(args.briefId) && !brief) return textResult(`No brief ${str(args.briefId)} in this chat.`, true);
  const brand = await env.brands.get(brief?.brandId ?? str(args.brand));
  if (!brand) return textResult(`No brand ${brief?.brandId ?? str(args.brand)} in the library: library_find it, or show_form {form: "brand"}.`, true);
  const wanted = brief?.productIds ?? strs(args.products);
  const products = productsOf(brand, wanted);
  if (!products.length || products.length < wanted.length) return textResult(`Products not in ${brand.name}: ${wanted.filter((id) => !products.some((p) => p.id === id)).join(", ") || "(none given)"}. library_get lists them.`, true);
  const missing = missingFor(brand, products);
  if (missing.length && args.anyway !== true) return textResult({ error: "Something is still missing: ask the owner for it first (or pass anyway: true when he said go anyway).", missing: missing.map((m) => m.message) }, true);
  if (!brief) {
    const route = await imageRouteFor(env);
    if (!route) return textResult("The owner didn't pick an image model: nothing was started.");
    const variations = Math.min(4, Math.max(1, Math.round(Number(args.variations) || 2)));
    brief = { id: `brief-${uid()}`, request: str(args.request), brandId: brand.id, productIds: products.map((p) => p.id), formats: formatsFor(brand, strs(args.formats)), scene: str(args.scene), variations, imageRoute: route };
    const made = brief;
    env.setData((d) => ({ ...d, briefs: [...(d.briefs ?? []), made] }));
  }
  const b = brief;
  const pageId = env.page();
  const start = rowStart(env, pageId);
  const general = env.settings().general;
  const agent = usableAgent(env, general.providerId);
  if (typeof agent === "string") return textResult(`The general agent can't run: ${agent}`, true);
  const logo = await logoFile(env, brand);
  const posts: PostRecord[] = [];
  const placements: Promise<unknown>[] = [];
  const started: StudioTask[] = [];
  let x = start.x;
  let rowHeight = 0;
  for (const format of b.formats) {
    for (let v = 1; v <= b.variations; v++) {
      const name = frameName(products, format, v);
      const at = { x, y: start.y };
      x += format.width + GAP;
      rowHeight = Math.max(rowHeight, format.height);
      const prompt = buildImagePrompt(b, brand, products, format, v);
      const frameTask = addTask(env, "agent", t("Frame: {name}", { name }), general, [], async (signal) => {
        const r = await env.runWorker(env.queue.get(frameTask.id)!, `${WORKER_NOTE}\n\n${framePrompt({ brand, products, format, name, ...at, pageId, request: b.request, logo: logo?.path })}`, signal, logo ? [logo] : undefined);
        const id = findFrame(env, pageId, name);
        if (!id) throw new Error(`The frame “${name}” wasn't made.`);
        setPost(env, name, b.id, { frameNodeId: id });
        return { ...r, nodeIds: [id] };
      });
      let picture: StudioImage | null = null;
      const imageTask = addTask(env, "image", t("Picture: {name}", { name }), imageTaskRoute(b.imageRoute), [], async (signal) => {
        picture = await runPicture(env, b.imageRoute, prompt, { width: format.width, height: format.height }, signal);
        return { summary: t("A {width} × {height} picture", { width: picture.width, height: picture.height }), credits: picture.credits };
      });
      env.noteTask(frameTask.id, { prompt: framePrompt({ brand, products, format, name, ...at, pageId, request: b.request, logo: logo?.path }) });
      env.noteTask(imageTask.id, { prompt: prompt.prompt, post: name });
      posts.push({ frameName: name, briefId: b.id, formatId: format.id, variation: v, pageId, frameTaskId: frameTask.id, imageTaskId: imageTask.id, prompt: prompt.prompt });
      // When both are done, the picture goes into the frame (§5.4 step 2).
      placements.push(
        Promise.all([env.queue.ended(frameTask.id), env.queue.ended(imageTask.id)]).then(async ([f, i]) => {
          const frameId = f.nodeIds?.[0];
          if (f.state !== "done" || i.state !== "done" || !frameId || !picture) return;
          const pic = await placePicture(env, frameId, picture);
          setPost(env, name, b.id, { pictureNodeId: pic });
        })
      );
      started.push(frameTask, imageTask);
    }
  }
  env.setData((d) => ({ ...d, posts: [...(d.posts ?? []), ...posts], rows: { pageId: pageId ?? "", x: start.x, nextY: start.y + rowHeight + ROW_GAP } }));
  // The last task: the review, once every frame has its picture (§5.4 step 3).
  const reviewTask = addTask(env, "review", t("Review: {names}", { names: products.map((p) => p.name).join(" + ") }), env.settings().manager, started.map((t) => t.id), async () => {
    const results = await Promise.allSettled(placements);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) throw new Error(`A picture couldn't go into its frame: ${errorText(failed[0].reason)}`);
    const nodeIds = posts.map((p) => postOf(env, p.frameName, b.id)?.frameNodeId).filter((id): id is string => !!id);
    return { nodeIds, summary: `${nodeIds.length} frames ready for review` };
  });
  return textResult({
    briefId: b.id,
    imageRoute: b.imageRoute,
    tasks: [...started, reviewTask].map((t) => ({ taskId: t.id, title: t.title, kind: t.kind })),
    reviewTaskId: reviewTask.id,
    ...(missing.length ? { missing: missing.map((m) => m.message) } : {}),
    next: `wait_tasks {taskIds: ["${reviewTask.id}"]}, then review {nodeIds: its nodeIds, briefId: "${b.id}"}.`,
    limits: { agentsAtOnce: env.settings().parallel, imagesAtOnce: IMAGE_TASKS_AT_ONCE },
  });
}

const postOf = (env: ManagerEnv, frameName: string, briefId: string) => env.data().posts?.find((p) => p.frameName === frameName && p.briefId === briefId);

function setPost(env: ManagerEnv, frameName: string, briefId: string, patch: Partial<PostRecord>) {
  env.setData((d) => ({ ...d, posts: (d.posts ?? []).map((p) => (p.frameName === frameName && p.briefId === briefId ? { ...p, ...patch } : p)) }));
}

// ---- Review (§6.1) --------------------------------------------------------------------------------------------------------

const briefOf = (env: ManagerEnv, id: string): StudioBrief | undefined => {
  const briefs = env.data().briefs ?? [];
  return (id ? briefs.find((b) => b.id === id) : undefined) ?? briefs[briefs.length - 1];
};

async function review(env: ManagerEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const ids = strs(args.nodeIds).slice(0, 12);
  if (!ids.length) return textResult("review needs nodeIds (the frames).", true);
  const brief = briefOf(env, str(args.briefId));
  const brand = brief ? await env.brands.get(brief.brandId) : null;
  const products = brand && brief ? productsOf(brand, brief.productIds) : [];
  const content: ToolContent[] = [];
  const frames: unknown[] = [];
  for (const id of ids) {
    const n = env.read(id);
    if (!n) {
      frames.push({ nodeId: id, error: "not on the canvas any more" });
      continue;
    }
    frames.push({ nodeId: id, name: n.name, width: n.width, height: n.height });
    // 2× at most 2048 px on the long side (§6.1).
    const shot = await env.tool("get_screenshot", { nodeId: id, maxSize: Math.min(2048, 2 * Math.max(n.width, n.height)) });
    content.push({ type: "text", text: `Frame “${n.name}” (${id}), ${n.width} × ${n.height}:` });
    content.push(...shot.content.filter((c) => c.type === "image"));
  }
  const facts = {
    briefId: brief?.id ?? null,
    request: brief?.request,
    brand: brand ? { id: brand.id, name: brand.name, colors: brand.colors, fonts: brand.fonts } : null,
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      shape: p.shape,
      sharpTexts: p.labels.filter((l) => l.tier === "sharp").map((l) => l.text),
      softTexts: p.labels.filter((l) => l.tier === "soft").map((l) => l.text),
      references: p.images.map((i) => ({ imageId: i.id, role: i.role })),
    })),
    frames,
    check: "Every sharp text reads exactly; shapes and colours as the references (library_image); nothing extra (another product, another logo, added text); nothing missing or cropped; soft small print illegible, not readable wrong words; the frame's text and logo inside the safe area. Then report_review (boxes in each frame's own coordinates).",
  };
  return { content: [{ type: "text", text: JSON.stringify(facts, null, 1) }, ...content] };
}

const PROBLEM_KINDS: ProblemKind[] = ["sharp-text", "soft-text", "shape", "extra", "missing", "layout", "brand"];
const FIX_OF: Record<ProblemKind, ReviewProblem["fix"]> = { "sharp-text": "fix-label", "soft-text": "blur", shape: "regenerate", extra: "regenerate", missing: "regenerate", layout: "relayout", brand: "relayout", "safe-area": "relayout", caption: "rewrite", contrast: "relayout", logo: "relayout", video: "retime" };

/** The report as the manager sent it, checked: known kinds, each problem's fix as §6.2 says, ids unique. */
export function cleanReport(v: unknown, fallbackBrief = ""): ReviewReport {
  const r = (v ?? {}) as { briefId?: unknown; items?: unknown };
  const seen = new Set<string>();
  const items: ReviewItem[] = (Array.isArray(r.items) ? r.items : []).slice(0, 24).flatMap((it): ReviewItem[] => {
    const item = (it ?? {}) as Record<string, unknown>;
    const nodeId = str(item.nodeId);
    if (!nodeId) return [];
    const problems: ReviewProblem[] = (Array.isArray(item.problems) ? item.problems : []).slice(0, 20).flatMap((pp): ReviewProblem[] => {
      const p = (pp ?? {}) as Record<string, unknown>;
      const kind = PROBLEM_KINDS.find((k) => k === p.kind);
      if (!kind) return [];
      let id = str(p.id) || `p-${uid()}`;
      while (seen.has(id)) id = `${id}-${uid().slice(0, 3)}`;
      seen.add(id);
      const b = (p.box ?? null) as Record<string, unknown> | null;
      const box = b && [b.x, b.y, b.width, b.height].every((n) => typeof n === "number" && Number.isFinite(n)) && (b.width as number) > 0 && (b.height as number) > 0 ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } : undefined;
      return [{ id, kind, detail: str(p.detail).slice(0, 500) || kind, ...(box ? { box } : {}), fix: FIX_OF[kind] }];
    });
    return [{ nodeId, name: str(item.name), ok: problems.length === 0 && item.ok !== false, problems }];
  });
  return { briefId: str(r.briefId) || fallbackBrief, items };
}

async function reportReview(env: ManagerEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const brief = briefOf(env, str((args.report as { briefId?: unknown } | undefined)?.briefId));
  const report = cleanReport(args.report, brief?.id ?? "");
  if (!report.items.length) return textResult("report_review needs report.items (each frame with ok or its problems).", true);
  // Names as the canvas has them.
  for (const it of report.items) it.name ||= env.read(it.nodeId)?.name ?? it.nodeId;
  const answer = await env.ask({ kind: "review", id: `card-${uid()}`, report });
  if ("cancelled" in answer || !("fix" in answer)) return textResult({ answer: "Leave as is", note: "The owner left the frames as they are: the loop ends." });
  if (!answer.fix.length) return textResult({ answer: "Nothing to fix" });
  const started = await dispatchFixes(env, report, new Set(answer.fix));
  return textResult({ answer: "Fix selected", ...started, next: started.tasks.length ? `wait_tasks on these, then review the changed frames again: ${started.changed.join(", ")}.` : `Blurred; review the changed frames again: ${started.changed.join(", ")}.` });
}

/** The format and variation a frame was made with (else the brand's format nearest its size, variation 1). */
function postFor(env: ManagerEnv, nodeId: string, brief: StudioBrief): { format: SocialFormat; variation: number } {
  const post = env.data().posts?.find((p) => p.frameNodeId === nodeId);
  const format = post ? brief.formats.find((f) => f.id === post.formatId) : undefined;
  if (format && post) return { format, variation: post.variation };
  const n = env.read(nodeId);
  const ratio = n ? n.width / Math.max(1, n.height) : 1;
  const nearest = [...brief.formats].sort((a, c) => Math.abs(a.width / a.height - ratio) - Math.abs(c.width / c.height - ratio))[0] ?? DEFAULT_FORMATS[0];
  return { format: nearest, variation: 1 };
}

/**
 * The fixes the owner picked (§6.2), per frame: sharp texts → one Fix label image task (the picture edited); soft texts →
 * Blur on their boxes, here and now; shape / extra / missing → one image task again with the problems named
 * (it covers Fix label too); layout / brand → one agent task on the frame.
 */
export async function dispatchFixes(env: ManagerEnv, report: ReviewReport, picked: ReadonlySet<string>): Promise<{ tasks: { taskId: string; title: string; kind: TaskKind }[]; blurred: string[]; changed: string[] }> {
  const brief = briefOf(env, report.briefId);
  const brand = brief ? await env.brands.get(brief.brandId) : null;
  const products = brand && brief ? productsOf(brand, brief.productIds) : [];
  const tasks: StudioTask[] = [];
  const blurred: string[] = [];
  const changed = new Set<string>();
  for (const item of report.items) {
    const chosen = item.problems.filter((p) => picked.has(p.id));
    if (!chosen.length) continue;
    const by = (fix: ReviewProblem["fix"]) => chosen.filter((p) => p.fix === fix);
    const frame = env.read(item.nodeId);
    const name = frame?.name ?? item.name;
    const regenerate = by("regenerate");
    const fixLabel = by("fix-label");
    const blur = by("blur").filter((p) => p.box);
    if ((regenerate.length || fixLabel.length) && (!brief || !brand)) throw new Error("The brief of these frames isn't in this chat: make_posts again.");
    const replace = (title: string, kind: "make-image" | "edit-image", prompt: ImagePrompt, size: { width: number; height: number }) => {
      const task = addTask(env, "image", title, imageTaskRoute(brief!.imageRoute), [], async (signal) => {
        const image = kind === "edit-image" ? await env.pictureOf(await pictureLayer(env, item.nodeId)) : undefined;
        if (kind === "edit-image" && !image) throw new Error("The frame's picture isn't there to fix.");
        const out = await runPicture(env, brief!.imageRoute, prompt, size, signal, image ?? undefined);
        const pic = await placePicture(env, item.nodeId, out);
        return { summary: kind === "edit-image" ? t("Fixed the label ({width} × {height})", { width: out.width, height: out.height }) : t("Made the picture again ({width} × {height})", { width: out.width, height: out.height }), credits: out.credits, nodeIds: [pic] };
      });
      env.noteTask(task.id, { prompt: prompt.prompt, post: name });
      tasks.push(task);
      changed.add(item.nodeId);
    };
    if (regenerate.length) {
      const { format, variation } = postFor(env, item.nodeId, brief!);
      const p = buildImagePrompt(brief!, brand!, products, format, variation);
      const wrong = [...regenerate, ...fixLabel].map((x) => x.detail).join("; ");
      replace(t("Picture again: {name}", { name }), "make-image", { ...p, prompt: `${p.prompt}\n\nThe last picture went wrong: ${wrong}. Make sure that doesn't happen again.` }, { width: format.width, height: format.height });
    } else if (fixLabel.length) {
      const size = { width: frame?.width ?? 1080, height: frame?.height ?? 1080 };
      // The prompt doesn't know the picture's size: the edit keeps the frame's own ratio.
      const p = { ...buildFixLabelPrompt(brand!, products, fixLabel), aspectRatio: nearestAspectRatio(size.width, size.height) };
      replace(t("Fix label: {name}", { name }), "edit-image", p, size);
    }
    if (blur.length && !regenerate.length) {
      const pic = await pictureLayer(env, item.nodeId);
      const at = env.read(pic);
      // The boxes are in the frame's coordinates; the Picture layer's own start at its place in the frame.
      await env.blur(pic, blur.map((p) => ({ x: p.box!.x - (at?.x ?? 0), y: p.box!.y - (at?.y ?? 0), width: p.box!.width, height: p.box!.height })));
      blurred.push(item.nodeId);
      changed.add(item.nodeId);
    }
    const relayout = by("relayout");
    if (relayout.length) {
      const general = env.settings().general;
      const prompt = `Fix the frame “${name}” (${item.nodeId}): ${relayout.map((p) => `${p.detail}${p.box ? ` (around x ${Math.round(p.box.x)}, y ${Math.round(p.box.y)}, ${Math.round(p.box.width)} × ${Math.round(p.box.height)})` : ""}`).join("; ")}.${brand ? ` The brand: ${brand.name}; colours ${brand.colors.map((c) => c.hex).join(", ") || "as on the frame"}; fonts ${brand.fonts.join(", ") || "as on the frame"}.` : ""} Keep the “Picture” layer as it is; move or restyle only the text and logo, inside the format's safe area.`;
      const task = addTask(env, "agent", t("Relayout: {name}", { name }), general, [], (signal) => env.runWorker(env.queue.get(task.id)!, `${WORKER_NOTE}\n\n${prompt}`, signal));
      env.noteTask(task.id, { prompt });
      tasks.push(task);
      changed.add(item.nodeId);
    }
  }
  return { tasks: tasks.map((t) => ({ taskId: t.id, title: t.title, kind: t.kind })), blurred, changed: [...changed] };
}
