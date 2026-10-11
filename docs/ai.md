# AI (contract, Phase 7 round 6; written 2026-10-12, docs only)

Figma's AI features on the owner's own providers: one-shot actions, image tools, Vectorize, search, Skills, connectors, and a usage ledger shown as credits. **Weave tools (old 6c) are set aside** (owner, 2026-10-11). This contract was written under a usage limit: items marked **TODO** must be settled by the main session before the agents start, and **[unverified]** marks wording or behaviour not confirmed in live Figma.

## 1. What Figma does (verified on help.figma.com, 2026-10-12)

Sources:
- AI image tools: https://help.figma.com/hc/en-us/articles/24004542669463
- Vectorize: /38031452710807
- First Draft: /23955143044247
- Rename layers: /24004711129879
- Text tools: /24004868368919
- Replace content: /23796390206743
- Add interactions: /24004778051479
- Visual search: /24037716110615
- Credits: /33459875669015
- Custom skills: /40283639496599
- Connectors: Figma Make's /35440096186007 and the blog post "Got skills?"

Live capture: `research/figma/live/toolbar/actions-panel.txt`. The All tab shows Recents, then these sections:
- **Image editing**: "Make an image", "Remove background", "Boost resolution", "Edit image with prompt".
- **Design tools**: "Rename layers", "Replace content", "Add interactions".
- **Riffing and writing**: "Shorten", "Rewrite this...", "Translate to...".

Each AI row has an "AI" badge (Learn more). The "Visual search (AI beta)" button sits at the search field's right.

| Feature | Entry points (Figma's words) | Inputs → output | Credits (Figma) |
|---|---|---|---|
| Rename layers | the layer's right-click menu "Rename layers" (with the AI badge), Actions, quick actions | Renames only default-named frames, groups, rectangles with an image fill, texts, and instances still named as their main (the container only). It skips renamed, hidden and locked layers, layers inside instances, and plain vector shapes. Matching layers across top-level frames get the same name. Nothing to do: "No layers need renaming" with "Rename anyway". | free |
| Rewrite this… | Actions › "Rewrite this..." → prompt → "Rewrite" | the selected text layers' text rewritten | tokens |
| Shorten | Actions › "Shorten" | shorter text | tokens |
| Translate to… | Actions › "Translate to..." → a language | translated text (the language list is [unverified]) | tokens |
| Replace content | Actions › "Replace content", optional prompt, "Replace content" | Placeholder text becomes realistic copy, distinct across duplicates. Text only. A banner may suggest it after a duplicate. | tokens |
| Add interactions | Prototype tab › Interactions › "Add interactions" | Connects the selected frames (flows, back / next, nav). A bottom banner offers "Preview" and "Keep it". | 20 |
| First Draft | Actions › "First Draft" | Prompt and suggestions; "Library" (website / app wireframe or basic design libraries, else auto); "Make it"; theme thumbnails; "Make changes" (prompt, or style controls: Color light/dark, presets and custom, Border radius, Spacing, Typography title/body/label). The libraries can't be used after Actions closes. You can't use your own design system. | tokens |
| Make an image | Actions; an image fill's "Make an image" | Prompt, model dropdown, reference image (+, paste, drop), Send / ⌘↵. Fills the selected layer, else makes a new image layer. | 2–16 by model |
| Edit with prompt | the image's secondary toolbar "Edit with prompt" | prompt, model, reference | 2–16 |
| Remove background | secondary toolbar | one or more images | 1–5 |
| Boost resolution | secondary toolbar › More › "Boost resolution" | one or more images | 5–10 |
| Expand | More › "Expand" | Drag the blue handles, an aspect ratio dropdown, confirm with ✓. | 5–10 |
| Erase / Isolate | "Select area" (lasso) → "Erase" / "Isolate" | Isolate turns the area into a new image layer. | 5–10 |
| Vectorize | More › "Vectorize" | "Full color" (Number of colors), "Grayscale" (Number of grays), "Black and white" (Threshold); ✓ saves. Ranges and defaults [unverified]. | 2–5 |
| Visual search | Actions' image button; Actions › "Find more like"; Assets keyword search | Text, a selection, or an image ("Upload", "Search"). Tabs "Figma" / "Community", a library filter, "See more" next to "Other designs", file owner / space filters, sort by relevance or last modified. Results can be opened ("Open the file"), previewed ("Preview") or inserted ("Insert"). | free |
| Credits | Main menu › "AI balance" (used, remaining, reset date); hover the AI credits icon under an agent prompt | Monthly per seat (Enterprise Full 4,250); undo doesn't refund | — |
| Skills | the chat's prompt box › Skills › Add skill (Upload a file / Start from scratch); Add context › Skills › Manage skills (Edit, Export, Disable skill, Delete); Publish (Private team/org, Community) | A single `.md` file (Agent Skills spec): Name (= the slash command), Description, Instructions. `/name` in a prompt; only the first skill named is invoked. | — |
| Connectors | Add context › Add connector (OAuth); enabled per chat | Per-tool on/off; consent asked before a call; @-mention | — |

## 2. Decisions

1. **Providers.**
   - Text actions run on a provider of the Agents tab: a CLI or an OpenAI-compatible server.
   - Settings › AI picks one route for text and one for images, plus optional per-action overrides (`AiSettings`, §8).
   - The default text route is the first connected of `AI_TEXT_DEFAULT_ORDER`.
2. **One-shot run** (`src/main/ai/run.ts`): no MCP tools, the full answer collected, then applied once.
   - CLIs run with no MCP config and no tools. For Claude Code: `-p --output-format json --tools "" --strict-mcp-config --no-session-persistence`, plus `--json-schema` when `claude --help` lists it [unverified flag]. Other adapters: a `oneShot` plan in their own file.
   - OpenAI-compatible servers get `response_format: {type: "json_schema"}`, falling back to `json_object`.
   - The answer is the last JSON object in the text, checked against the action's schema. On a mismatch there is one repair retry, then the error `bad-output`.
3. **Apply = one undo step in the user's history.**
   - A new method `TurnLog.writeAction(label, fn, refs)` in `editor/agents/turns.ts`: an actor write with `undoTo: 0`, one `actorBegin`/`actorEnd`, labelled with the action's name.
   - Nothing is written before the result is complete, so cancelling (Esc, Stop, closing Actions) needs no rollback.
   - First Draft's theme and style changes are each one step that replaces the draft frame.
4. **Local first for pixels.** ONNX models run in a Worker in the editor view with `@huggingface/transformers` (Apache-2.0) over `onnxruntime-web` (MIT): WebGPU, falling back to wasm.
   - Exact versions are pinned at the round (≥ 2 weeks old).
   - Models download on first use after a confirmation that shows the size. Main writes them to `userData/models/<id>/` with SHA-256 checks and serves them read-only at `aimodel://<id>/<path>`.
   - One session is live at a time, released after 60 s idle (the 16 GB rule).

   | id | model (repo) | licence | file | size |
   |---|---|---|---|---|
   | `birefnet-lite` | BiRefNet lite (`onnx-community/BiRefNet_lite-ONNX`) | MIT | `onnx/model_fp16.onnx` | 114.5 MB |
   | `swin2sr-x4` | Swin2SR compressed x4 (`Xenova/swin2SR-compressed-sr-x4-48`) | Apache-2.0 upstream (mv-lab), **verify** | `onnx/model_fp16.onnx` | 32.7 MB |
   | `lama` | LaMa inpainting (`opencv/inpainting_lama`) | Apache-2.0 (page) | `inpainting_lama_2025jan.onnx` | 92.6 MB |
   | `clip-vit-b32` | CLIP ViT-B/32 (`Xenova/clip-vit-base-patch32`) | MIT (OpenAI) | `onnx/vision_model_quantized.onnx` + `onnx/text_model_quantized.onnx` | 89.1 + 64.5 MB |
   | `minilm-l6` | all-MiniLM-L6-v2 (`Xenova/all-MiniLM-L6-v2`) | Apache-2.0 | `onnx/model_quantized.onnx` | 23.0 MB |

   - Rejected: ISNet's ONNX on Hugging Face (tagged AGPL-3.0), RMBG (non-commercial), `@imgly/background-removal` (AGPL).
   - Sizes are from the Hugging Face API on 2026-10-12. Revisions and SHA-256 are filled in by 6b.
5. **Image APIs** (keys in the OS keychain through safeStorage, like custom servers):
   - **OpenAI Images**: `POST /v1/images/generations`, and `/v1/images/edits` (multipart: `image[]`, `mask` with transparent = change, `prompt`).
   - **Gemini API**: `models/{model}:generateContent` with `inlineData` parts and image output.
   - **Antigravity** (the owner's Google AI plan, its `generate_image`, no key): Make an image and Edit with prompt only.
   - Model ids come from settings, not hard-coded.
6. **Which image tools run where:**
   - Remove background: local (`birefnet-lite`, 1024² input, the matte resized and applied as alpha).
   - Boost resolution: local (`swin2sr-x4`, 128 px tiles with 16 px overlap; the output's long side is capped at 4096).
   - Erase: local (`lama`, 512² crop around the lasso, composited inside a feathered mask). With no model it falls back to the image API with a mask.
   - Isolate: local. The lasso crop goes through `birefnet-lite`, the result is intersected with the lasso and becomes a **new image layer above**, with the original kept [unverified].
   - Expand: an image API only. The original goes on the padded canvas, the mask is the new area, the layer grows in the dragged directions.
   - Make an image / Edit with prompt: the image route.
   - Results are new image hashes through the editor's images import, set as the layer's IMAGE fill (or a new layer), each action one `writeAction` step. Several selected images are one step.
7. **Vectorize** is a tracer in the engine (C++, our code). §5.
8. **Search.** The editor's worker computes CLIP image vectors of frames and components and MiniLM text vectors of their names and text. The store keeps the index and answers queries. §6.
9. **Credits = a usage ledger.** No billing.
   - Every run records `AiUsageEntry` through `store.ai.record`. Agent chat turns are recorded from their existing `usage` events.
   - `creditsFor` (§8) maps tokens, megapixels or a fixed cost to Figma-like numbers.
   - "AI balance" shows the month against `monthlyCredits` (default 4,250). It warns only unless `stopAtLimit` is on.
   - For files in an org, the store reports daily totals to the server (`POST /me/ai-usage`, absolute totals for each (org, day, editor_type) → upsert into `ai_usage_daily.seat_credits`). That fills `GET /v1/ai_usage/daily` (multiplayer.md §16.7). No new migration.
10. **Skills** are personal this round. The store writes `Workspace/spaces/ai/skills/<id>.md` (frontmatter `name`, `description`, then the instructions).
    - The Agents composer's "+" becomes a menu: Add files and photos, Skills ▸, Connectors ▸. `/name` invokes a skill.
    - A turn carries the enabled skills' names and descriptions, plus the invoked skill's instructions in full. Agents fetch any other skill with a new MCP tool `get_skill {name}`.
    - Publishing to a team, org or Community: later (open question 4).
11. **Connectors** are MCP servers the owner adds: Streamable HTTP with an optional bearer key, or a stdio command. They are kept in main's `userData/agents/connectors.json`.
    - Every provider reaches them **through our MCP server as a proxy** (tools named `‹connector›__‹tool›`), so consent works the same for every CLI.
    - Each tool has a policy, Allow / Ask / Off. Ask shows a consent card in the chat: "Allow once", "Always allow", "Deny".
    - Connectors are enabled per chat. The MCP client is hand-written, like `mcpServer.ts`. No OAuth this round (open question 5).
12. **Org policy.** `OrgSettings` gains `aiEnabled` (default true) and `aiCreditLimit` (per person per month, null = none), set in Admin › Settings › AI. When AI is off for the file's org, the AI rows are disabled.

## 3. Actions: prompts, schemas, apply (6a)

Prompt templates and schemas live in `src/shared/ai/prompts.ts` and `src/shared/ai/schemas.ts` (6a). Every system prompt starts with "You are Figma AI inside a design editor. Answer with JSON only, matching the schema." Context is a compact layer outline: id, type, name, size, text (≤ 200 chars), and children up to depth 6, capped at 400 layers per call (more calls are batched).

| Action | Prompt input | Schema (answer) | Apply |
|---|---|---|---|
| Rename layers | the eligible layers (Figma's rules above) with their outline and parent chain | `{names: {id: string, name: string}[]}` | names ≤ 60 chars; equal-path layers across top-level frames take one name (computed locally) |
| Rewrite / Shorten / Translate | texts of the selected text layers (and texts inside selected frames); the prompt or the language | `{texts: {id, characters}[]}` | Characters replaced. A single-style text keeps its style; a mixed one takes its first run's [unverified]. Missing fonts refuse with Figma's missing-fonts message. |
| Replace content | texts with their outline position; repeated siblings marked as a group; optional prompt | `{texts: {id, characters}[]}` | as above; values in a group must differ |
| Add interactions | the selected top-level frames' outlines (names and texts of likely buttons) | `{interactions: {sourceId, trigger: "ON_CLICK", action: "NAVIGATE" \| "BACK", destinationId?}[]}` | Through `prototypeTools.ts`. The banner offers "Preview" (the inline preview) and "Keep it". ✕ undoes the step [unverified]. |
| First Draft | the prompt, the kit's block catalogue, the platform | `{name, platform: "app" \| "web", blocks: {block: string, props: Record<string, string \| number \| string[]>}[]}` | A deterministic builder (`editor/ai/draft/build.ts`) turns the plan, the kit and the theme into node specs (`agents/nodeSpec.ts`): one frame (390 wide for app, 1440 for web), auto layout, plain layers (no components). Themes and style controls rebuild it. |

**Kits** (`src/shared/ai/kits/`, ours and licence-safe, Inter, neutral tokens): two block sets, `web` (nav, hero, logo row, feature grid, stats, pricing, testimonial, FAQ, CTA, form, table, footer) and `app` (status bar, top bar, tab bar, search, chips, list rows, card, profile header, settings list, form fields, buttons, empty state, chat, checkout summary). Each set has two styles, giving four "Library" choices: "App wireframe", "Website wireframe", "App design", "Website design" [our names], plus Auto. Each has 4 themes (`KitTheme`: colours light/dark, radius, spacing, title/body/label fonts).

## 4. Image tools UI (6b)

- An image layer selected shows the secondary toolbar 8 px above the bottom toolbar (as vector edit's does): "Edit with prompt", "Remove background", "Select area", More ▾ (Expand, Boost resolution, Vectorize) [layout unverified — capture live].
- "Select area": a lasso overlay with "Erase" / "Isolate".
- Expand: blue handles around the layer, an aspect ratio dropdown, ✓.
- Vectorize: Full color / Grayscale / Black and white with the setting's slider, a live preview from the engine, ✓ / ✕.
- Make an image: the Actions row and the fill picker's "Make an image" open the prompt card (model dropdown, + reference, Send). The canvas placeholder and reveal (`AgentImagePlaceholders`) are reused.
- Progress: the placeholder sweep over the layer. Errors appear as a toast in readable form (`readableError`).

## 5. Vectorize in the engine (6e — the round's only engine work)

**Code**: `engine/src/trace/` (new):
- `Bitmap.h`
- `Quantize.{h,cpp}`
- `Potrace.{h,cpp}`
- `Trace.{h,cpp}`

**ABI**: `engine/src/api/TraceApi.inc`, included at the end of `Api.cpp` (one line), plus `exports.txt`, `EngineExports.ts` and `Engine.ts`.

**Algorithm**:
1. **Input**: straight RGBA, long side ≤ 1024. TS gets it from `engine_export` of the node (contents only), so crop, scale mode and filters are already applied. Pixels with alpha < 128 are left out.
2. **Palette**, by mode:
   - FULL_COLOR: k-means in OKLab, deterministic k-means++ (seed 1), ≤ 16 iterations on ≤ 65,536 sampled pixels, k = colors.
   - GRAYSCALE: 1-D k-means on luminance, k = grays.
   - BLACK_AND_WHITE: Rec.709 luminance < threshold·2.55 → black, else white.
3. **Despeckle**: regions under `speckle` px (default 4) merge into their largest neighbour.
4. **Stacking** (no gaps, as vtracer's "stacked" mode): colours are sorted by area, largest first (bottom). Layer i's mask is every pixel whose colour ranks ≥ i, so the bottom layer is the whole opaque area.
5. **Each mask is traced with Potrace's algorithm**, implemented from Selinger's paper ("Potrace: a polygon-based tracing algorithm", 2003). **No GPL code is read or copied.** The steps: path decomposition (turn policy minority), optimal polygon, vertex adjustment, smoothing (alphamax 1.0), curve optimisation (opttolerance 0.2). Holes are kept, with fill rule EVENODD.
6. **Output**: a FRAME with the image's name, transform and size (no fill, no clip). It holds one VECTOR per colour, named by hex and filled with that solid colour. **It replaces the image layer** [unverified] in one USER step labelled "Vectorize".

**API**:
- `engine_trace(rgbaPtr, len, w, h, optsJson)` → JSON `TraceResult` (pure; tests and MCP).
- `engine_vectorize_begin(h, refs, rgbaPtr, len, w, h)` opens a transaction like a scrub's.
- `engine_vectorize_update(h, optsJson)` re-traces into the preview and returns JSON stats.
- `engine_vectorize_end(h, commit)` commits one step or cancels.
- E_BUSY as for other gestures.

**Options**: `{mode, colors 2–32 (8), grays 2–16 (4), threshold 0–100 (50), speckle (4), alphaMax (1.0), optTolerance (0.2)}`. The ranges and defaults are ours.

**Budget**: ≤ 250 ms per update for 1024² with 8 colours in release wasm (bench case). TS debounces updates by 120 ms.

**Tests** (`engine/tests/unit/trace.test.cpp`):
- a square, a disk and a ring (a hole) come out within 0.5 px of the analytic outlines;
- k-means is deterministic;
- stacking leaves no uncovered opaque pixel (rasterise the result and compare: coverage ≥ 99.5 %);
- the threshold extremes;
- speckle merging;
- begin, update, end with commit and cancel (undo restores the image layer).

Wasm: `vectorize.wasm.test.ts`.

## 6. Search (6d)

- **What is indexed**: each page's top-level frames, components and component sets in files this computer has opened.
  - The editor's indexer (`editor/search/indexer.ts`) runs while idle, debounced 30 s, ≤ 20 nodes per pass.
  - It renders a 224 px PNG through `engine_export`. Its text is the name, the component description and texts (≤ 2,000 chars). Its version is a content hash.
  - It skips nodes whose version the store already has (`search.versions`).
  - The vectors: CLIP image (512 floats) and MiniLM text (384).
- **Index**: the store, `Workspace/spaces/search/<fileKey>.idx` (Float16 vectors + JSON docs + thumbnails). The search is brute-force cosine (thousands of nodes). A file deleted from the workspace drops its index.
- **Query**:
  - text → CLIP text and MiniLM vectors;
  - selection or image → a CLIP image vector;
  - the score: `0.6·clip + 0.4·text`, exact name matches first (Figma's Assets behaviour).
- **UI**:
  - The Actions panel's "Visual search (AI beta)" button opens the search view, the selection's "Find more like" opens it too, and so does "Upload".
  - Tabs: "Figma" (ours: this computer's files); Community hidden.
  - "See more" next to "Other designs", filters by file owner / space, sort Relevance / Last modified.
  - A result can be opened ("Open the file"), previewed ("Preview") or inserted ("Insert", a copy through the clipboard path).
  - In the Assets tab, the keyword search adds "Similar" components after the exact matches.

## 7. Usage, settings, chrome (6g)

- **Settings › AI**:
  - the AI on/off switch;
  - the text and image routes, and per-action overrides;
  - the image API keys (OpenAI, Gemini);
  - local models (each with size, Download / Remove, and a status);
  - Monthly credits, "Stop when credits run out", "Index files for visual search".
- **Main menu › "AI balance"**: a modal with "Credits used", "Credits remaining", "Resets ‹date›", and a usage history (ours).
- **Agents composer**: after a turn, the AI credits icon shows the turn's credits on hover.
- **Admin › Settings › AI**: `aiEnabled`, `aiCreditLimit`. **Admin › Dashboard**: an AI usage table from `/v1/ai_usage/daily`'s rows.

## 8. Shared types — commit verbatim before the round

`src/shared/ai/types.ts`:

```ts
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
export const DEFAULT_AI_SETTINGS: AiSettings = { enabled: true, text: null, image: null, actions: {}, monthlyCredits: 4250, stopAtLimit: false, indexForSearch: true, imageKeys: { openai: false, gemini: false } };
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
}

export interface AiUsage { input: number; output: number; images: number; credits: number }

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
export interface ConnectorConsent { reqId: number; turnId: string; connectorId: string; connector: string; tool: string; args: unknown }

export type AiModelId = "birefnet-lite" | "swin2sr-x4" | "lama" | "clip-vit-b32" | "minilm-l6";
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
```

**Other edits in the same commit:**
- **`src/shared/agents/types.ts`**: `TurnRequest` gains `skill?: { name: string; instructions: string }`, `skills?: { name: string; description: string }[]` and `connectors?: string[]`.
- **`src/shared/org/types.ts`**: `OrgSettings` gains `aiEnabled: boolean` and `aiCreditLimit: number | null` (defaults `true`, `null`).
- **`StoreApi`**: gains `ai: AiRepository` and `search: SearchRepository` (repositories `"ai"` and `"search"` in `protocol.ts`), with `notImplemented` stubs in both stores.
- **IPC** (`src/shared/ipc.ts`, stubs in `src/main/ipc.ts`), with roles `["home", "editor"]` for settings and models and `["editor"]` for runs:
  - `ai:settings`, `ai:set-settings`, `ai:set-image-key`;
  - `ai:run`, `ai:image`, `ai:cancel`, and the event `ai:event`;
  - `ai:models`, `ai:model-download`, `ai:model-remove`, and the event `ai:model-state`;
  - `agents:connectors`, `agents:add-connector`, `agents:update-connector`, `agents:remove-connector`, `agents:test-connector`;
  - `agents:consent-answer`, and the event `agents:consent`.
- **Stubs**:
  - `src/renderer/src/editor/search/index.ts` exports `openVisualSearch(opts?: { selection?: boolean; image?: Uint8Array })`, for 6a's button;
  - `src/renderer/src/editor/imageTools/worker.ts` exports `runModel(id: AiModelId, input: unknown): Promise<unknown>`, which throws "Local models aren't built yet".

**TODO (main session, before the agents)**: check that the IPC payload shapes match `ipc.ts`'s conventions, and check the `aimodel:` scheme registration and the CSP lines against `src/main/protocol.ts`.

## 9. Ownership, merge order — see `docs/roadmap.md` "Round 6"

## 10. Open questions for the owner

**Answered by the owner, 2026-10-12:**
1. **Image provider: Antigravity for all three** — Make and Edit through its `generate_image`, and **Expand through Antigravity too**: the image is placed on the larger canvas (the new area transparent / masked) and sent as an Edit whose prompt asks to fill the empty area to match, keeping the original pixels (6b re-composites the untouched original over the result so it never shifts). No Gemini / OpenAI key needed; those stay optional providers.
2. **Local models download on first use** (with a confirmation and size), not shipped in the app.
3. **Credits stop at the allowance**: when the monthly "AI balance" is used up, AI actions are disabled until the next month (Settings › AI shows the balance; the owner can raise the allowance there). Not a warning only.
4. / 5. **Later**: Skills published to a team / org and OAuth connectors (Notion, Linear, Asana) wait; owner-added MCP servers work this round.

1. **Image provider.**
   - OpenAI (gpt-image models, needs an API key with billing), the Gemini API (a key, billing for image models), or Antigravity on your Google plan (no key, but only make and edit).
   - Expand needs an API.
   - Default: Antigravity for make and edit, the Gemini key for expand.
2. **Local model downloads**: ≈ 115 MB (remove background), 33 MB (boost), 93 MB (erase), 154 MB (visual search) and 23 MB (text search), ≈ 416 MB in all, each downloaded on first use after a confirmation. OK, or bundle some with the app?
3. **Credits**: warn only (default), or stop at the monthly allowance (4,250)?
4. **Skills publishing** to a team or org (needs a server table and a migration). Default: later.
5. **Connectors with OAuth** (Notion, Linear, Asana's hosted MCP servers need it). Default: keys and stdio only this round.
6. **Vectorize replaces the image layer**, and Isolate keeps the original. These are unverified at Figma: one check in live Figma would settle them.
