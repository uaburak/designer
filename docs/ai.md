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
   | `isnet` | ISNet general use (`imgly/isnet-general-onnx`; weights from xuebinqin/DIS) | Apache-2.0 upstream (the ONNX repo is tagged MIT) | `onnx/model_fp16.onnx` | 88.2 MB |
   | `swin2sr-x4` | Swin2SR compressed x4 (`Xenova/swin2SR-compressed-sr-x4-48`) | Apache-2.0 (mv-lab/swin2sr, verified 2026-10-12) | `onnx/model.onnx` (fp32) | 55.0 MB |
   | `lama` | LaMa inpainting (`opencv/inpainting_lama`) | Apache-2.0 (page) | `inpainting_lama_2025jan.onnx` | 92.6 MB |
   | `clip-vit-b32` | CLIP ViT-B/32 (`Xenova/clip-vit-base-patch32`) | MIT (OpenAI) | `onnx/vision_model_quantized.onnx` + `onnx/text_model_quantized.onnx` | 89.1 + 64.5 MB |
   | `minilm-l6` | all-MiniLM-L6-v2 (`Xenova/all-MiniLM-L6-v2`) | Apache-2.0 | `onnx/model_quantized.onnx` | 23.0 MB |

   - Rejected: `onnx-community/ISNet-ONNX` (tagged AGPL-3.0; ISNet general use is taken from `imgly/isnet-general-onnx` instead, tagged MIT, its weights Apache-2.0 at xuebinqin/DIS), RMBG (non-commercial), the `@imgly/background-removal` package (AGPL), **BiRefNet lite** (dropped 2026-10-12 after running it: its deformable-conv decoder needs more than wasm's 4 GB at 1024² — `std::bad_alloc` — and a Concat of up to 64 inputs that Apple's WebGPU (10 storage buffers a stage) can't build).
   - Sizes are from the Hugging Face API on 2026-10-12. Revisions and SHA-256: pinned by 6b (§4 "As built").
5. **Image APIs** (keys in the OS keychain through safeStorage, like custom servers):
   - **OpenAI Images**: `POST /v1/images/generations`, and `/v1/images/edits` (multipart: `image[]`, `mask` with transparent = change, `prompt`).
   - **Gemini API**: `models/{model}:generateContent` with `inlineData` parts and image output.
   - **Antigravity** (the owner's Google AI plan, its `generate_image`, no key): Make an image and Edit with prompt only.
   - Model ids come from settings, not hard-coded.
6. **Which image tools run where:**
   - Remove background: local (`isnet`, 1024² input, the matte resized and applied as alpha).
   - Boost resolution: local (`swin2sr-x4`, 128 px tiles with 16 px overlap; the output's long side is capped at 4096).
   - Erase: local (`lama`, 512² crop around the lasso, composited inside a feathered mask). With no model it falls back to the image API with a mask.
   - Isolate: local. The lasso crop goes through `isnet`, the result is intersected with the lasso and becomes a **new image layer above**, with the original kept [unverified].
   - Expand: the image route, Antigravity by default (owner, §10.1): the original goes on the padded canvas, the new area transparent, sent as an Edit asking to fill it; the untouched original is re-composited over the result. With an OpenAI / Gemini key it can use their masked edit instead. The layer grows in the dragged directions.
   - Make an image / Edit with prompt: the image route.
   - Results are new image hashes through the editor's images import, set as the layer's IMAGE fill (or a new layer), each action one `writeAction` step. Several selected images are one step.
7. **Vectorize** is a tracer in the engine (C++, our code). §5.
8. **Search.** The editor's worker computes CLIP image vectors of frames and components and MiniLM text vectors of their names and text. The store keeps the index and answers queries. §6.
9. **Credits = a usage ledger.** No billing.
   - Every run records `AiUsageEntry` through `store.ai.record`. Agent chat turns are recorded from their existing `usage` events.
   - `creditsFor` (§8) maps tokens, megapixels or a fixed cost to Figma-like numbers.
   - "AI balance" shows the month against `monthlyCredits` (default 4,250). With `stopAtLimit` on (the default, owner §10.3) AI actions stop with `over-limit` until the next month; off, it only warns.
   - For files in an org, the store reports daily totals to the server (`POST /me/ai-usage`, absolute totals for each (org, day, editor_type) → upsert into `ai_usage_daily.seat_credits`). That fills `GET /v1/ai_usage/daily` (multiplayer.md §16.7). No new migration.
10. **Skills** are personal this round. The store writes `Workspace/spaces/ai/skills/<id>.md` (frontmatter `name`, `description`, then the instructions).
    - The Agents composer's "+" becomes a menu: Add files and photos, Skills ▸, Connectors ▸. `/name` invokes a skill.
    - A turn carries the enabled skills' names and descriptions, plus the invoked skill's instructions in full. Agents fetch any other skill with a new MCP tool `get_skill {name}`.
    - Publishing to a team, org or Community: later (open question 4).
11. **Connectors** are MCP servers the owner adds: Streamable HTTP with an optional bearer key, or a stdio command. They are kept in main's `userData/agents/connectors.json`.
    - Every provider reaches them **through our MCP server as a proxy** (tools named `‹connector›__‹tool›`), so consent works the same for every CLI.
    - Each tool has a policy, Allow / Ask / Off. Ask shows a consent card in the chat: "Allow once", "Always allow", "Deny".
    - Connectors are enabled per chat. The MCP client is hand-written, like `mcpServer.ts`. No OAuth this round (open question 5).
    - Agents' own reach — the web, GitHub, local files and local apps, with the same Allow / Ask / Off consent per capability — is `docs/agents-reach.md` (round 16 [ours]).
12. **Org policy.** `OrgSettings` gains `aiEnabled` (default true) and `aiCreditLimit` (per person per month, null = none), set in Admin › Settings › AI. When AI is off for the file's org, the AI rows are disabled.
13. **Agents as collaborators** (ours, 2026-10-15; Figma's multiplayer presence and observation mode, docs/multiplayer.md §6, for agents). Ephemeral: nothing is in the document, `NODE_CHANGES`, the journal or undo, and the owner's selection is never touched.
    - Who: every MCP session bound to the open file (an outside client by its `clientInfo` name, `prettyClient`), each chat turn of the Agents tab (its provider's name), Studio's manager (the name the owner gives it in Agent settings › Manager › Name, `ManagerSettings.name`, default "Manager" shown translated) and each of its workers ("‹name› · 2", "· 3"… in the order the chat's tasks were made). Outside clients come from main's `agents:mcp-state` connections (`fileKey` = this file, not a chat's own session) and leave when their session ends or idles out (`SESSION_IDLE_MS`); turns join when they start and leave a moment after `done`. Tool calls carry their MCP `session` id (`ToolCall.session`) so a call is matched to its client.
    - Where: each finished tool call's layers — a write's `touched`, else the layers its arguments name (`nodeId`, `nodeIds`, `parentId`) — give the agent's page and bounds; its cursor (name chip, its colour) glides to the top-left of their union and they are outlined in its colour for 1.6 s, drawn by the engine's presence (`Engine.setPresence`) through `multiplayer/presenceSink.ts`, which merges them with the people of a shared file. Only on the owner's page; the facepile's tooltip says "on ‹page›" otherwise (the avatar dimmed).
    - Facepile: the agents before the people (or the account avatar) in the right panel's header — initials on the agent's colour with the agent badge, tooltip "‹name› · Agent"; clicking one follows it.
    - Following (observation mode): the view framed in its colour with "Following ‹name›" · Stop; its page, then its latest layers framed with a 64 px margin, never above 100% nor past the canvas's edge (`kCanvasBound`), animated (450 ms), at most one move every 600 ms. A click or wheel on the canvas, any key outside a text field, Esc, or a camera or page change the editor didn't make stops it; the UI is not minimized (the chat stays usable).
    - Code: `editor/multiplayer/agentPresence.ts` (the model, tested in `__tests__/agentPresence.test.ts`), `agentsOnCanvas.ts` (the engine, the canvas, the owner's input), `Multiplayer.tsx` (`AgentFaces`, the frame); the service calls `join` / `activity` / `leave` (`AgentsService.actorOf`).

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

### As built (6a, 2026-10-12)

**Shared**: `src/shared/ai/schemas.ts` — `RENAME_SCHEMA`, `TEXTS_SCHEMA`, `INTERACTIONS_SCHEMA`, `draftSchema(blockIds)` (blocks an enum of the kit's), and readers that refuse what a schema can't say (`AnswerError` → `bad-output`): `readRename` (known ids only, one line, ≤ 60), `readTexts` (a Replace content group's values must differ), `readInteractions` (sources and destinations among the request's, never to the source's own frame, one per source), `readDraft` (unknown blocks dropped, props as strings / numbers / string lists). `prompts.ts` — `SYSTEM_PREFIX`, `formatOutline` (one line per layer `id TYPE "name" W×H text="…" [mark]`, depth ≤ 6, text ≤ 200), the five prompt builders, `TRANSLATE_LANGUAGES` (ours, 27), `FIRST_DRAFT_SUGGESTIONS`. `kits/` — `types.ts`, `blocks.ts` (`WEB_BLOCKS` 12, `APP_BLOCKS` 14, each with its props described for the model), `themes.ts` (4 wireframe and 4 design themes: light / dark palettes, radius, spacing, title / body / label fonts — Inter, DM Sans, Space Grotesk, Lora, all OFL; `COLOR_PRESETS`, `FONT_CHOICES`), `index.ts` (`KITS`, `LIBRARY_CHOICES`: Auto, App wireframe, Website wireframe, App design, Website design; `autoKit` picks web / wireframe from the prompt's words).

**Editor (`src/renderer/src/editor/ai/`)**:
- `service.ts` — `AiActions` per file (`aiOf(ed)`; tests `setAiBackend(ed, {api, record, policy})`). One run at a time; each action reads the selection, asks with `runOnce` (6f), reads the answer, applies with **`AgentTurns.writeAction(label, fn, refs)`** (new in `agents/turns.ts`: its own actor, `undoTo: 0` → one step of the user's history; the ai.md name `TurnLog` is this class). Errors: `AiRunError` codes, `AiActionError` (`nothing-selected`, `missing-fonts`, `apply`), `AnswerError` → `bad-output`, `EngineBusy` → `busy`; messages in `messages.ts` (main's own sentence for over-limit, which also opens the AI balance). A run from Actions keeps its error in the panel; one from elsewhere shows a toast. **Every run is recorded** (`store.ai.record`, `orgId: null` + the file key; the provider and model from Settings › AI's route for the action, else the text route, else `"auto"`; failures and cancels with `ok: false`). `refresh()` reads Settings › AI's `enabled` and the orgs' policy (`policyOf`): off → the rows are disabled and a run refuses with `disabled`.
- `layers.ts` — `readLayers` (subtrees, Layers-panel order, hidden / locked / inside an instance / image fill / main's name / top-level frame and path / fonts), `flatten`, `outlineBatches` (≤ 400 layers a batch; a tree too big or deeper than 6 goes in as its root, then its children).
- `rename.ts` — Figma's rules (`renamable`, `hasDefaultName`: "Frame N", "Group N", "Rectangle N" / "Image N" with an image fill, texts named by their text or auto-renamed, instances named as their main; `renameCandidates`: hidden and locked subtrees, layers inside instances and vectors skipped, instances renamed alone; `matchGroups`: the same path in different top-level frames is asked once and named alike). Nothing selected: the page's layers [unverified]. None: the toast "No layers need renaming" with "Rename anyway" (lifts only the default-name rule). Texts renamed get `autoRename: false`. Free (0 credits, still recorded).
- Texts (Rewrite this… / Shorten / Translate to… / Replace content): visible, unlocked texts of the selection (instance texts included — text fields are overridable); a missing font (`fonts.missing()`, base or a run's) refuses before asking. Written whole by `textDataFor`: every character in the first run's style (a single style keeps it), `lines` following the paragraphs. Replace content's groups are repeated siblings (same types and names all the way down): their texts at each place must differ. After a ⌘D of something holding text, a pill offers "Replace content" on the copies [ours / unverified].
- Add interactions: two or more selected top-level frames; likely buttons marked `[button?]`; each answer through `addInteractionTool` (ON_CLICK → NAVIGATE with an Instant transition, or BACK) in one step labelled "Add interactions". The banner (`panels/prototype/AddInteractions.tsx`): "Added N interactions", "Preview" (the inline preview from the first frame), "Keep it", ✕ (undoes the step) [wording beyond the buttons ours].
- First Draft: `draft/build.ts` turns the plan into one FRAME spec (390 / 1440 wide, vertical auto layout hugging its height, plain FRAME / TEXT / RECTANGLE layers, image placeholders as rectangles named "Image: …"), applied through `createNodes` (now exported from `agents/mcpTools.ts`) and selected. The session (`draft`: plan, kit, theme, style, frame) lets a theme thumbnail or a style control (Color Light / Dark, the presets or a custom hex, Border radius, Spacing, Typography title / body / label) rebuild it in place — one step each, the old frame deleted and the new one at its place — and "Make changes" with a prompt send the current plan back to the model. Closing Actions ends the session (Figma: the libraries can't be used after Actions closes).
- `actionRows.ts` — the All tab's AI rows and sections. **`registerAiImageRow(action, {run, enabled?})`** is the seam for 6b: Make an image, Remove background, Boost resolution and Edit image with prompt are listed and disabled until registered.
- `AiPanel.tsx` (+css) — the views inside Actions: the header (back, the action's name, AI), Rewrite this…'s prompt (⌘↵), Translate to…'s searchable languages, Replace content's optional prompt, First Draft (prompt, suggestions, Library, "Make it"; then Theme, Make changes and the style controls, Done), progress with Stop, the error with "Try again" (and "AI balance" for over-limit). `AiHost.tsx` (+css; one line in `EditorApp.tsx`) — a run started outside Actions as a pill with Stop, and the banners.

**Chrome edits**: `panels/ActionsPanel.tsx` — the AI sections after Recents with the AI badge ("AI, Learn more"), AI rows in the search and Recents, Esc stops a run / leaves a form, the Visual search (AI beta) button calls `openVisualSearch` (6d). `panels/prototype/PrototypePanel.tsx` — "Add interactions" (with the AI badge) in Interactions when two or more top-level frames are selected. `commands.ts` — `canvas.rename-layers-ai` runs Rename layers on the selection (the Layers row's menu, AI badge); `file.ai-balance` "AI balance" → `openAiBalance()`, in the main menu after Libraries [placement unverified].

**Tests**: `src/shared/ai/schemas.test.ts` (readers, prompts, kits), `editor/__tests__/aiRules.test.ts` (rename eligibility, matching, batches, Replace content groups, the text write, the builder over every block of every kit, styles), `editor/__tests__/aiActions.wasm.test.ts` (on the engine with a fake `ai` API: each action's request and schema, one undo step each, cancel mid-run, bad-output, over-limit, missing fonts, Replace content's distinct values, Add interactions with its banner ✕ undoing, First Draft building and restyling, the ledger), `editor/__tests__/aiPanels.dom.test.ts` (the panel's sections and badges, a form's run with Stop, over-limit's message with AI balance, the Prototype tab's button).

**Not built / unverified**: Figma's exact error strings and banner wording; Translate's language list; First Draft's place in the All tab (it isn't in the live capture); the "Find more like" / duplicate suggestion timing; Antigravity, Codex and Cursor as the text provider (only Claude Code ran for real, below).

**Run for real (2026-10-12)**, the built app, Settings › AI's text provider on Automatic (→ Claude Code, `claude` 2.1.292, signed in), every answer schema-checked on the first try, each one undo step (⌘Z / redo checked for Rename layers): First Draft "a login screen" 17 s (a 390 × 456 frame; a theme click restyled it), Rename layers on the draft with "Frame N" / "Rectangle N" names 33 s (frames named "Status bar", "Header", "Input field"…; rectangles kept — Figma's rule), Rewrite this... 14 s, Translate to... Turkish on the frame 22 s, Replace content with a prompt 29 s (Turkish banking copy, the two inputs' texts differing), a second First Draft "a sign up screen" 18 s, Add interactions on the two 21 s ("Added 4 interactions", Preview / Keep it). The ledger recorded every run with its tokens and credits; with Monthly credits at 1, Shorten stopped at once with "You've used all 1 AI credits for this month. They reset on November 1." and AI balance (the image tools too) while Rename stays free. Fixed: the ledger's provider (see §4 "Run for real").

## 4. Image tools UI (6b)

- An image layer selected shows the secondary toolbar 8 px above the bottom toolbar (as vector edit's does): "Edit with prompt", "Remove background", "Select area", More ▾ (Expand, Boost resolution, Vectorize) [layout unverified — capture live].
- "Select area": a lasso overlay with "Erase" / "Isolate".
- Expand: blue handles around the layer, an aspect ratio dropdown, ✓.
- Vectorize: Full color / Grayscale / Black and white with the setting's slider, a live preview from the engine, ✓ / ✕.
- Make an image: the Actions row and the fill picker's "Make an image" open the prompt card (model dropdown, + reference, Send). The canvas placeholder and reveal (`AgentImagePlaceholders`) are reused.
- Progress: the placeholder sweep over the layer. Errors appear as a toast in readable form (`readableError`).

### As built (6b, 2026-10-12)

Figma's wording checked on help 24004542669463 (2026-10-12): secondary toolbar › "Edit with prompt", "Remove background", "Select area" (lasso, then "Erase" / "Isolate" — "The area becomes a new image layer"), More › "Expand" (blue handles, an aspect ratio dropdown whose options aren't published, the blue check) and "Boost resolution"; Actions › "Make an image"; references by "+", paste or drop; "Send" / ⌘↵.

**Main**:
- `src/main/ai/models.ts` — `AI_MODELS` (the pins below) and `ModelStore` (Electron-free: folder, fetch, base URL injected). `download(id)` fetches `https://huggingface.co/<repo>/resolve/<revision>/<path>` for every file into `userData/models/<id>.partial/`, hashing as it streams; a size or SHA-256 mismatch, an HTTP error or no network fails the whole model (nothing kept; "Couldn't reach Hugging Face. Check your connection and try again."); all checked → `manifest.json` (the revision) and the folder renamed into place. One download per model at a time (a second call shares it). Progress as `ai:model-state` to every view (≤ every 1 % or 250 ms). Ready = the manifest names the pinned revision and every file has its size (a new pin makes a model absent again). `remove(id)`.
- `src/main/ai/protocol.ts` — `aimodel://<id>/<path>`: only a catalogue file of a ready model, GET / HEAD (OPTIONS answered), CORS `*` and CORP `cross-origin` (the editor is COEP require-corp). `AIMODEL_SCHEME_PRIVILEGES` joins `registerScheme()`'s one call; `handleAimodelScheme()` in `index.ts`; `connect-src … aimodel:` in the CSP. `modelStore()` is the app's.
- `src/main/ai/images/` — `run.ts` `runImage` (Electron-free): AI on → the credits stop (`overLimit` of run.ts) → the route (the request's, `actions[action]`, `image`, else `antigravity`) → the client → `status`, `image {data, mime, width, height}`, `usage {images: 1, credits: creditsFor(action, {model, megapixels})}`, `done`; a 240 s timeout; cancel through `aiRuns().track` (so `ai:cancel` and a closed view stop it). `cleanImageRequest` checks the IPC's data (≤ 20 MB pictures, Make needs a prompt, the others a picture). Clients:
  - `antigravity.ts` — `agy -p <prompt> --output-format stream-json --model <m> --project designerv2-images --disable-slash-commands` in the run's folder (`image.png`, `mask.png`, `reference.png` written there); the project denies `mcp(*)`, commands, unsandboxed commands and the web, leaving reading its workspace and its own `generate_image`. The prompt asks for one generate_image call, the framing kept, the size / aspect, and the saved path as the answer. The picture: the newest image file in `~/.gemini/antigravity-cli/brain/<conversation>/` made during the run, else an existing path named in the tool output or the answer. Quota and other failures go through `friendlyApiError` / `classify`. [unverified against the real agy: the stub CLI only — that its generate_image honours "edit this file" and saves into the brain folder is from 6f's chat turns.]
  - `openai.ts` — generations (JSON, `b64_json`), edits (multipart `image[]` picture then reference, `mask`, `prompt`, `size` 1024² / 1536×1024 / 1024×1536 by aspect); model = the route's, else `gpt-image-1`.
  - `gemini.ts` — `models/{model}:generateContent` with `x-goog-api-key`, text + `inlineData` parts (the mask and reference explained in the text), `responseModalities ["TEXT","IMAGE"]`, `imageConfig.aspectRatio` nearest; model = the route's, else `gemini-2.5-flash-image`.
  - The view records every image run in the ledger (main only emits `usage`).
- `ipc.ts`: `ai:image` → `startImageRun`, `ai:models` → `{info, state}`, `ai:model-download` (resolves when done), `ai:model-remove`.

**Pins** (Hugging Face API, 2026-10-12; LFS files' SHA-256 from the API, small files' computed from the bytes at the revision; all recorded in `AI_MODELS`):

| id | repo @ revision | files (bytes) | total |
|---|---|---|---|
| `isnet` | `imgly/isnet-general-onnx` @ `440dea96dd4a3b06bbbf5abec3e26569dd7ec49f` | `onnx/model_fp16.onnx` (88,152,708; `2eb4b5dd…04f20`), `config.json`, `preprocessor_config.json` | 88.2 MB |
| `swin2sr-x4` | `Xenova/swin2SR-compressed-sr-x4-48` @ `7d3f2242026e00cbd998056c2a11e200fce198a7` | `onnx/model.onnx` (55,046,351; `2038700d…b02f7`; the fp16 export was dropped, see below), `config.json`, `preprocessor_config.json` | 55.0 MB |
| `lama` | `opencv/inpainting_lama` @ `aee6d22f0a13e5e35af1c9a1c3afd62841fc6f3f` | `inpainting_lama_2025jan.onnx` (92,591,623; `7df918ac…fdf2`) — the folder's LICENSE is Apache-2.0 | 92.6 MB |
| `clip-vit-b32` | `Xenova/clip-vit-base-patch32` @ `d15189d7028b43f1d3e65039190477f6af591c2a` | `onnx/vision_model_quantized.onnx`, `onnx/text_model_quantized.onnx`, `config.json`, `preprocessor_config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json` (6d's `SEARCH_MODEL_FILES` and one more) | 155.9 MB |
| `minilm-l6` | `Xenova/all-MiniLM-L6-v2` @ `751bff37182d3f1213fa05d7196b954e230abad9` | `onnx/model_quantized.onnx`, `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json` | 23.7 MB |

Swin2SR's licence, verified 2026-10-12: Apache-2.0 — mv-lab/swin2sr's LICENSE and README ("This project is released under the Apache 2.0 license", commit `6f25d76`) and the base model's card (`caidas/swin2SR-compressed-sr-x4-48`, `license: apache-2.0`). Pinned file changed to the fp32 `onnx/model.onnx` (55,046,351; `2038700d…b02f7`), see "Run for real" below.

**Packages**: `onnxruntime-web` **1.31.0-dev.20260914-8d85527a0** exact (devDependencies; the build `@huggingface/transformers` 4.3.0 pins, so one copy; published 2026-09-14). `@huggingface/transformers` 4.3.0 is 6d's (dependencies).

**Editor (`src/renderer/src/editor/imageTools/`)**:
- `worker.ts` — `runModel(id, {kind: "onnx", file, inputs})` → the outputs, in a module Worker (`modelWorker.ts`: `onnxruntime-web/webgpu` — WebGPU when an adapter exists, else wasm; its wasm from the package by `?url`; one live session, a call for another model releases it; fp16 inputs when the session's metadata asks; fp16 outputs back as float32). The worker ends 60 s after its last call. `setModelRunner` replaces it (tests). Embeddings are 6d's own worker (`editor/search/embed.worker.ts`) over the same `aimodel:` files.
- `runners.ts` — Remove background (ISNet 1024², (v − 128) / 256 as its preprocessor says, its probabilities as the matte, resized back, applied as alpha), Boost (per tile: padded to a multiple of 8 by mirroring, 0…1 in, ×4 out, cropped), Erase (a square region twice the lasso's size around it, 512² in, the mask dilated 4 px as 0/1, LaMa's 0…255 out — 0…1 detected — resized back, blended in a 3 px feathered mask, alpha kept), Isolate (the lasso's bounds + 2 px through ISNet, the matte ∩ the lasso feathered 1 px).
- `tiles.ts` — 128 px tiles, 16 px overlap, the last flush with the edge; linear ramps over the overlaps; alpha resized on its own; the output's long side ≤ 4096 (the input scaled first).
- `pixels.ts` — resize (alpha-weighted bilinear, box average when shrinking ≥ 2×), crop / paste, CHW tensors, mattes, lasso rasterising (even-odd, pixel centres), dilate / feather, Expand's padded canvas + OpenAI mask (transparent = change) and `recomposite` (the answer stretched to the canvas, made opaque, the original pasted back exactly), aspect insets, fp16.
- `tools.ts` — image layers = the topmost visible IMAGE fill. The picture as the layer shows it is drawn from the image with the engine's own `imageMatrix` (render/Renderer.cpp: Fill, Fit, Crop/Stretch with its transform, Tile, 90° rotations) at the image's density (1–4 px per unit, ≤ 4096) — not `exportNodes`, which would bake strokes, effects and children in. Results:
  - Remove background, Boost resolution, Edit with prompt: the paint's picture swapped (`withPicture`: hash, original size, progressive copies; scale mode, crop, adjustments kept); several images one step.
  - Erase, Expand: a Fill-mode paint of the layer's picture (opacity, blend mode and adjustments kept); Expand also grows `size` and moves `transform` by the left / top growth along the layer's axes.
  - Isolate: a new rectangle just above (fractional index between the layer and its next sibling), at the cut's place in the layer's units, selected; the image kept.
  - Make an image: the one selected layer that takes fills (frames, shapes, components, instances, vectors) gets `[image]`; else a new rectangle the picture's size, centred in the view, at the top of the page, selected.
  - Each is `txnBegin(label) … txnCommit()` — one undo step: "Remove background", "Boost resolution", "Erase", "Isolate", "Expand", "Edit image", "Make an image" (6a's `writeAction` is for actor writes; these are the user's own).
  - Erase without LaMa (the download declined) goes to the image route with a mask, keeping every pixel outside the lasso.
  - Credits: `checkCredits` before a run (Settings › AI on, and with "Stop when credits run out" the ledger's balance through `loadAiBalance`); every run recorded (`store.ai.record`, the file's key, `orgId: null`): local runs as `providerId "local"`, the model and `creditsFor(action, {megapixels})`; API runs with main's `usage.credits`; failures with `ok: false`, 0 credits (not cancels).
  - Models: `ensureModel` reads `ai:models`; absent → the confirmation (the dialog "Download AI model?", "‹use› runs on this computer with ‹label› (‹licence›). It downloads once (‹size›) …", Cancel / Download (‹size›)) → `ai:model-download`; declining cancels.
- `vectorize.ts` — `VectorizeSession`: the credits checked, `exportNodes` contents only (long side ≤ 1024, tried again while images load) → `vectorizeBegin` → a first trace with the defaults; `set()` re-traces 120 ms after the last change; `apply()` (a waiting update done first) → `vectorizeEnd(true)`, recorded (`creditsFor("vectorize", {colors})`); `cancel()`. Modes "Full color" (Number of colors 1 … the first trace's count, asked for up to 16), "Grayscale" (Number of grays, the same rule, ≤ 16), "Black and white" (Threshold 0–1 by 0.01, 0.5) — Figma's Recolor ranges (atlas 18 §7.7, wave 7); Enter applies.
- `controller.ts` — `imageToolsOf(ed)`: the shared state (open tool and its layer, the run in progress with progress, the confirmation, the download's share, the lasso, Expand's growth and aspect, the Vectorize session), the runs (one at a time; Cancel / Esc aborts), errors as toasts — provider failures in 6a's words (`ai/messages.ts aiMessage`), over-limit opening AI balance with an "AI balance" action; the tools' own refusals in their words.
- `ImageToolbar.tsx` — the secondary toolbar (`Toolbar floating secondary`, as vector edit's; mounted by one line in `BottomToolbar.tsx`, not in Dev Mode): Edit with prompt, Remove background, Select area │ More ▾ (Expand, Boost resolution, Vectorize). With several images only Remove background and Boost resolution are enabled. Per tool: the prompt card (Make an image / Edit with prompt: Prompt "Describe the image you want" / "Describe your edit" [ours], "+" reference, paste or drop, Model — Antigravity, and OpenAI Images / Gemini API when their keys are set — Send ⌘↵); Select area ("Draw around an area" → "Area selected", Erase, Isolate, Close); Expand (Aspect ratio: Freeform, 1:1, 4:3, 3:4, 16:9, 9:16 [ours], the check, Cancel); Vectorize (the three modes, the setting's slider and value, "Too detailed to preview" when over the budget, Apply ✓, Cancel ✕); a run ("Removing background…" etc. or "Downloading ‹model›… n%", Cancel). A tool closes when its image is deselected. `openMakeImage(ed, target?)` for other entry points. Actions' rows registered through 6a's `registerAiImageRow`: Make an image, Remove background, Boost resolution, Edit image with prompt, and **"Find more like"** (a row added to `AI_ROWS`, running 6d's `findMoreLike()`; placed with the image rows [our placement]).
- `CanvasOverlays.tsx` (+ `geometry.ts`) — portalled into the canvas's box, from the camera: the sweep over the run's layers with a progress bar; the lasso (kept in the layer's units, drawn as a dashed path); Expand's frame with eight blue handles (dragging along the layer's axes, rotation undone; dragging sets Freeform).
- The fill picker's "Make an image" (ds `ColorPicker` gains `onMakeImage`; `Paints.tsx` passes it for one layer): enabled on an image fill without a picture yet, opening the prompt card for that layer; with a picture it still "only says why" ("Current selection has a fill"), as live showed.

**Tests**: `src/main/ai/images/images.test.ts` (the pins' shape; downloads from a local HTTP server: progress, one fetch for two calls, a wrong checksum / a short file / no network leave nothing and serve nothing, a new revision is absent; `aimodel:` answers with CORS / CORP, 404 for unlisted files, traversal, other models; requests checked; routes; Expand / Erase wording; the credits stop, AI off, no key, no agy; OpenAI generations and edits (multipart parts, mask, refusals) and Gemini (parts, no picture, a bad key) on fake HTTP; a stub `agy` saving into its brain folder: the project's denials, the files in its workspace, quota, no picture, timeout, cancel), `src/renderer/src/editor/imageTools/__tests__/pixels.test.ts` (lasso masks, feathering, blending, Expand's canvas / mask / re-composite, aspect insets, the tile plan's coverage, the 4096 cap, a seamless tiled upscale, each model's pre / post-processing on a fake runner, fp16), `imageTools.wasm.test.ts` (each tool on the real engine with fixture pictures and a fake runner / fake `ai:image`: its picture, its one undo step and label, ⌘Z; the download confirmation; Erase's API fallback; Isolate's new layer; Expand's growth and untouched original; Make an image both ways; the ledger; Vectorize's debounce, apply, cancel, and its start from real `exportNodes`), `imageToolbar.dom.test.ts` (the toolbar for an image only; More › Vectorize → Grayscale → the debounced update → Apply as one step and ⌘Z; Cancel; Select area waiting for a lasso, Esc; Actions' rows registered).

**Not built / open**: OpenAI Images and the Gemini API haven't run for real (no keys); Erase / Isolate and Expand work on the picture as drawn, so a cropped image becomes a Fill-mode picture of what showed; Figma's Expand aspect options, prompt placeholders and the toolbar's exact layout are [unverified]; no cancel inside a single ONNX call (between tiles / steps only); Settings › AI's per-model Remove doesn't stop a live worker (it ends within 60 s).

### Run for real (2026-10-12, the built app on the owner's M3 / 16 GB, a temp userData)

Every Round 6 feature ran in the desktop app through `playwright-core` (Settings › AI, the image toolbar, Actions, Visual search), on a procedural test photo (a shaded ball and a box on a table, sensor noise) and a flat logo. What broke, each fixed with a regression test:
- **BiRefNet lite ran nowhere** → replaced by **ISNet** (`isnet`, above). On WebGPU its first run failed ("Too many storage buffers in shader. Current: 11, Max is 10"; the JSEP build: a Concat needing 17–65 where Apple allows 8–10); on wasm `std::bad_alloc` (its deformable convolutions make 822 MB tensors at 1024², several live at once; the fp32 export too). ISNet: 2.1 s on wasm (Node, 4 threads), ≈ 0.5 s warm in the app.
- **A model failing on WebGPU at its first run** wasn't retried: only session creation fell back. `imageTools/sessions.ts` `SessionCache` (tested without onnxruntime): a failed creation or run on WebGPU drops the session and redoes the call on wasm, and the model stays on wasm in that worker; `wasmOnly` for models that run without an error but answer wrong pixels on WebGPU — **LaMa** (white and magenta noise on the M3; right on wasm, 4–5 s for 512²). The worker logs `[ai models] <model> on WebGPU | wasm` and fallbacks (devtools).
- **Swin2SR's fp16 export fails its first wasm run** ("Shape mismatch attempting to re-use buffer {1,3,128,128} != {1,3,512,512}", with or without the memory pattern) → pinned the fp32 `onnx/model.onnx` (55 MB). Sessions are made with `enableMemPattern: false` (tiles vary in size).
- **Vectorize's Full color traced a 1024² picture as one layer of its mean colour**: the k-means sample index `s × count` overflowed wasm's 32-bit `size_t` (native tests are 64-bit) → computed in 64 bits (`Quantize.cpp`; `vectorize.wasm.test.ts` traces a 1024² three-colour logo).
- **The prompt card's Send stayed disabled** whatever was typed (the ds TextArea keeps a draft and calls only `onCommit` when given one — and leaving the field would have sent the prompt) → `onChange` + `onExit("enter")` for ⌘↵ (`imageToolbar.dom.test.ts`).
- **The ledger said `auto` / `image`** for runs on "Automatic" or without a route (Expand) → main's `usage` event carries `providerId` and `model` (`AiUsage`), the views record those first.
- **Expand left a hard seam** where Antigravity's fill met the pasted original (another tone) → the new area fades into the original's edge colours over a band outside it (4 % of the short side, 4–64 px); the original stays exact.
- **"Find more like" listed the layer itself first** (score 1) → `runSearch`'s `exclude`.
- **transformers.js pre-loading onnxruntime's wasm through our `env.fetch`** was refused ("Failed to pre-load WASM binary", then loaded again) → the bundled runtime URLs are let through.

Timings: the five downloads (Settings › AI › Download, SHA-256 checked) 4–26 s each, ≈ 67 s for all; Remove background 16 s with ISNet's first download, 0.55 s warm; Boost 768 × 512 → 3072 × 2048 (35 tiles) 72 s with its download, 724 × 644 → 2896 × 2576 73 s; Erase ≈ 10 s (LaMa on wasm); Isolate 0.3 s warm; Vectorize preview ≈ 0.15 s to open; Make an image (Antigravity, 1024²) 51 s, Edit with prompt 63 s, Expand 112 s. The renderer peaked at ≈ 1.1 GB (Boost) and 1.7 GB (Boost from a 724 px picture).

Not tested in the app: a machine without WebGPU — `--disable-gpu` also takes WebGL2 away, so the editor doesn't open; the wasm path ran for real through the fallback (above) and LaMa, and in Node on the same onnxruntime-web build (ISNet 2.1 s, Swin2SR ≈ 4 s a 128 px tile, LaMa 4–5 s).

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
6. **Output**: a FRAME with the image's name, transform and size (no fill, no clip). It holds one VECTOR per colour, named by hex and filled with that solid colour. It takes the image layer's place, named "<name> [Vectorized]", and **the image layer is hidden, kept** (Figma's, atlas 18 §7.7; wave 7) in one USER step labelled "Vectorize".

**API**:
- `engine_trace(rgbaPtr, len, w, h, optsJson)` → JSON `TraceResult` (pure; tests and MCP).
- `engine_vectorize_begin(h, refs, rgbaPtr, len, w, h)` opens a transaction like a scrub's.
- `engine_vectorize_update(h, optsJson)` re-traces into the preview and returns JSON stats.
- `engine_vectorize_end(h, commit)` commits one step or cancels.
- E_BUSY as for other gestures.

**Options**: `{mode, colors 1–32 (8), grays 1–16 (4), threshold 0–100 (50), speckle (4), alphaMax (1.0), optTolerance (0.2)}`. The ranges and defaults are ours.

**Budget**: ≤ 250 ms per update for 1024² with 8 colours in release wasm (bench case). TS debounces updates by 120 ms.

**Tests** (`engine/tests/unit/trace.test.cpp`):
- a square, a disk and a ring (a hole) come out within 0.5 px of the analytic outlines;
- k-means is deterministic;
- stacking leaves no uncovered opaque pixel (rasterise the result and compare: coverage ≥ 99.5 %);
- the threshold extremes;
- speckle merging;
- begin, update, end with commit and cancel (undo restores the image layer).

Wasm: `vectorize.wasm.test.ts`.

### As built (6e, 2026-10-12)

**Code**: `engine/src/trace/` — `Bitmap.h` (the input brought to the pixel budget, masks), `Quantize.{h,cpp}` (the three modes, despeckle, ranking), `Potrace.{h,cpp}` (Selinger's method, written from the paper), `Trace.{h,cpp}` (options, stacking, the budget, SVG path data). ABI in `engine/src/api/TraceApi.inc` (one `#include` at the end of `Api.cpp`), `exports.txt`, `EngineExports.ts`, `Engine.ts`.

**ABI** (what 6b's image toolbar calls; all through `Engine`):

| C | `Engine` (TS) | Result |
|---|---|---|
| `engine_trace(rgbaPtr, len, w, h, optsPtr, optsLen)` | `trace(pixels, options): TraceResult \| null` | pure; `TraceResult` of `src/shared/ai/types.ts`: layers bottom first, `color` `"#RRGGBB"`, `area` in input pixels, `d` absolute SVG path data in the input's pixels (fill rule evenodd). E_INVALID (null) on bad sizes or over the budget; E_DECODE on an unknown mode. |
| `engine_vectorize_begin(h, refsPtr, refsLen, rgbaPtr, len, w, h)` | `vectorizeBegin(ref, pixels)` | `{status: "ok", frame}` / `"busy"` / `"error"`. Opens the USER step "Vectorize" and puts an empty FRAME (the layer's name, transform, size, constraints and auto-layout child fields; no fill, no clip) just above the layer. The layer stays as it is underneath while previewing; in an auto-layout parent the frame is absolute until commit, so nothing reflows. |
| `engine_vectorize_update(h, optsPtr, optsLen)` | `vectorizeUpdate(options): VectorizeStats \| null` | `{layers, segments, ms, width, height, exceeded}`; re-traces into the frame, reusing its vectors by index (one VECTOR per colour, bottom first, named by its hex without "#", e.g. `C81E1E` [unverified], a solid fill, no stroke, a vector network with fill rule ODD, scaled from the image's pixels to the layer's size). `exceeded`: the preview keeps what it showed. Nothing is emitted while previewing. |
| `engine_vectorize_end(h, commit)` | `vectorizeEnd(commit): Guid \| null` | commit: the layer (and anything it holds) is removed, the frame takes its auto-layout positioning and is selected — one DOCUMENT_CHANGED "Vectorize", one undo step (⌘Z brings the image layer back). A commit without an update traces with the defaults. Cancel: rolled back, nothing emitted, no history. |

The pixels for begin are the layer's contents as drawn (`exportNodes([id], {imageType: "PNG", contentsOnly: true, …})`). The caller debounces updates (120 ms) and calls them on the main thread: they are synchronous.

**Algorithm, as built** (where it departs from or settles §5):
- Pixel budget: inputs over 1024 px on the long side are box-filtered (premultiplied) down at begin; paths come back in the input's pixels.
- FULL_COLOR: k-means in OKLab as specified (k-means++ with SplitMix64 seeded 1, ≤ 65,536 evenly strided samples, ≤ 16 Lloyd iterations); every pixel is then labelled through a 5-6-5 colour cache (each cell takes its middle colour's centre). A layer's colour is the mean sRGB of its pixels. GRAYSCALE: 1-D k-means over the luminance histogram, started at the quantiles. Unused colours are dropped, so a layer count can be below `colors`.
- Ranking: by area, ties darker first.
- Despeckle: 4-connected regions (union-find) under `speckle` px take the label of their largest neighbouring region, smallest first.
- Path decomposition: an edge-marking walk with the set pixels on the right (each boundary edge walked once, linear time) rather than the paper's invert-and-repeat; the minority turn policy at diagonals (majority over 4×4 … 8×8 around the corner).
- Optimal polygon: a segment (i, j) is possible when i … j is straight (the paper's §2.2.1 test: not all four directions, every point within ½ in L∞ of the line, points within 1 of the start unconstraining). The paper's i − 1 … j + 1 form leaves no segment out of a point next to a sharp corner, so it is not used. Each point's reach is made non-decreasing; the fewest segments then bound each vertex to a range and the least penalty is found over those ranges only. The cyclic problem is solved from up to 24 starts within the narrowest point's reach (any polygon has a vertex there).
- Vertex adjustment, smoothing (α from the unit square; a corner when α > alphaMax, else α clamped to 0.55–1) and curve optimisation as specified; a joined curve keeps the run's ends, end tangents and area, every joint and segment middle within optTolerance, and every point within optTolerance + 0.5 px of the run (no overshoot); runs ≤ 32 segments and < 179°. The midpoint between two corners is dropped (a square is four points).
- Budget: an update stops past 1.5 s (engine_trace 2 s) or 200,000 segments and reports `exceeded`. Measured: 1024², 8 colours, release wasm in Node on the owner's Mac (under load): 117–162 ms the trace, 126–177 ms the whole update — inside the 250 ms budget. Run for real (2026-10-12): Full color on a 1024² picture had traced one layer of the mean colour in wasm — the k-means sample index overflowed the 32-bit `size_t`; fixed (64-bit), the logo now traces as its colours and the photo as eight.

**Tests**: `engine/tests/unit/trace.test.cpp` (12 cases: a square, a disk and a ring within 0.5 px of their outlines with the hole kept; decomposition orientation and the minority policy; stripes and a quantized gradient stacked with ≥ 99.5 % coverage; k-means determinism; the threshold's extremes; speckle merging; the pixel budget, the segment cap and layer counts; engine_trace's JSON; begin / update / end with commit, undo and cancel), `src/renderer/src/engine/__tests__/vectorize.wasm.test.ts` (trace, preview, the undo step, cancel, the 1024² bench; `VECTORIZE_BENCH=1` prints the times).

**Not built here**: the image toolbar's Vectorize UI and its debounce (6b); an MCP tool over `engine_trace`; running the trace in a Worker (not needed within the budget).

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

### As built (6d, 2026-10-12)

Figma's words are from help 24037716110615 ("Search for assets and designs using AI", read 2026-10-12): "Find more like", "Search with image or selection", "Upload", "Search", tabs "Figma" / "Community", "Other designs", "See more", "Filter by file owner", "Filter by space", "Sort by relevance", "Sort by last modified", "Open the file", "Preview", "Insert"; Assets' keyword search "uses AI to return exact name matches plus visually or functionally similar components" and without AI "matches only the exact keywords".

**Store (`src/store/search/`, no Node / DOM imports; both stores run it through `SearchStoreHost`)**:
- `format.ts` — one file per file, `Workspace/spaces/search/<fileKey>.idx` (the dev store: key `designer.devStore.v1.search.<fileKey>.idx`, base64): `"DVSI"`, u32 format 1, u32 header length, the header JSON `{v, fileKey, dims: {clip: 512, text: 384}, docs: [{doc, thumb: [offset, length]}]}`, padding to 4, each doc's CLIP then text vector as unit-length IEEE half floats (little-endian), then the PNG thumbnails. Another format, other dimensions or a cut file is dropped and indexed again.
- `rank.ts` — brute-force dot products of unit vectors; score `0.6·clip + 0.4·text` when the query has both, else the one it has. Name tiers first: 2 = the name or its last "/" part is the query (case- and space-folded), 1 = the name holds every word of it; then by score. A non-matching name needs a score ≥ 0.12 (`MIN_SCORE`). `sort: "modified"` reorders the relevance top-N newest first. Filters: `kinds`, `fileKey`, `libraryKey` (that file's components and sets, never its frames); `limit` default 50, ≤ 500.
- `service.ts` — `SearchService.repository()` (the `SearchRepository` of §8): `upsert` (checked: kinds, key, dims, thumbnails ≤ 2 MB, text cut to 2,000; the file must exist — `not-found`), `remove(fileKey, nodeIds?)` (the last node gone removes the file), `versions`, `query` (loads every index once; trashed files are left out until restored; a file gone from the workspace drops its index; hits carry the file's current name), `thumb`, `stats`, `clear`. Writes go through one queue; indexes stay in memory once read. `fileDeleted(fileKey)` is called by both stores' Delete forever / Empty trash (`deleteItems`). `src/store/ai/stub.ts` is gone (both repositories are real now).

**Editor (`src/renderer/src/editor/search/`)**:
- `embedder.ts` — the `Embedder` interface (`image` → CLIP 512, `clipText` → CLIP 512, `text` → MiniLM 384) and `WorkerEmbedder`, the client of `embed.worker.ts` (one worker per view, made on the first call, terminated 60 s after the last — the models' memory goes with it). `SEARCH_MODEL_FILES` lists what the worker reads under `aimodel://<id>/` — **6b's download must hold these**: CLIP `config.json`, `preprocessor_config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/vision_model_quantized.onnx`, `onnx/text_model_quantized.onnx`; MiniLM `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx`.
- `embed.worker.ts` — `@huggingface/transformers` **4.3.0** (pinned exact, published 2026-09-16; Apache-2.0; it brings `onnxruntime-web` 1.31.0-dev.20260914): `CLIPVisionModelWithProjection` + `AutoProcessor`, `CLIPTextModelWithProjection` + `AutoTokenizer`, and a `feature-extraction` pipeline (mean pooling, normalized), all `dtype: "q8"` (the `_quantized` files), WebGPU when there is an adapter else Wasm (a WebGPU failure falls back for good). transformers.js asks `https://aimodel.invalid/<id>/<file>`; its `env.fetch` turns that into `aimodel://<id>/<file>` and refuses anything else; no browser cache; onnxruntime's Wasm (`ort-wasm-simd-threaded.asyncify.{mjs,wasm}`) is bundled through Vite `?url`, not fetched from its CDN.
- `models.ts` — the two models through `window.designer.ai` (`aiSetupBridge`): `searchModels()` → `unavailable` (no bridge, or `ai:models` doesn't list them — the state until 6b lands), `absent` (with both sizes for the confirmation), `downloading` (received / total), `ready`, `error`; `downloadSearchModels` (one after the other, progress from `ai:model-state`); `indexingOn()` = AI on and "Index files for visual search".
- `source.ts` — what is indexed, read from the engine: each page's top-level frames (frames in a section count; groups, shapes and hidden layers don't), and every component and set (`ed.components.assets()`, wherever they sit). Version: FNV-1a 64 of the subtree's `readNodes(…, {subtree})`. Text: name, description, the texts (≤ 2,000). Pixels: `exportNodes` PNG with `CONTENT_WIDTH`/`HEIGHT` 224 ("busy" while fonts or images load).
- `indexer.ts` — `SearchIndexer`: the first pass 30 s after the editor opens, then 30 s after the last `NODES_CHANGED` (local and remote edits), in `requestIdleCallback`; ≤ 20 embeddings a pass, the rest 2 s later. A pass maps changed refs to the targets above them (`chain`), removes stored nodes that are gone, hashes every target once per session and afterwards only touched ones, and re-embeds a target only when its hash differs from the store's version. Images are padded to a white square for CLIP (its processor would crop a wide frame). A node still "busy" after two passes is drawn as it is. Nothing runs while indexing is off or the models aren't here.
- `query.ts` — text → CLIP text + MiniLM (both in the query; the store does exact-first); image (a selection, an upload, a paste) → CLIP only; without the models a text search is names only and an image search refuses (`NoModelsError`). Results split into components and "Other designs" (frames).
- `runtime.ts` — the shared embedder, `attachSearchIndexer(ed)` (store files only), PNG encode / image decode, and a result's actions: **Open the file** (`nav.openFile({fileKey, pageId, nodeId})`, a browser tab else); **Insert**: this file's component or set → an instance (`insertInstance`); an enabled library's component → `insertLibraryComponent`; anything else → the node encoded as clipboard kiwi (`encodeSelectionKiwi` — this file's with the selection put back; another file's from its stored document `localSnapshot` loaded into a headless engine) and pasted (`pasteKiwi`), one undo step.
- `VisualSearch.tsx` (+ css) — a large Dialog "Visual search": "Search by keywords" (searched as you type), the image button → "Search with image or selection" ("Upload", "Find more like" with a selection, "Search"; a pasted picture searches at once); the models' banner (Download with the size, progress, Try again; "Local models aren't available in this version yet. Search matches names only."; indexing off); tab "Figma" (Community left out) and a library filter ("All libraries", "Created in this file", the workspace's libraries); "Components" [ours], then "Other designs" (6) with "See more" → "Filter by file owner" (Anyone / You / Others [ours: shared org files are others']), "Filter by space" (Drafts, folders, Organization), "Sort by relevance" / "Sort by last modified". A tile: hover "Insert", click → "Preview" (larger, with "Open the file" and "Insert"), right click → all three. "No results for “x”".
- `index.ts` — `openVisualSearch(opts?)` (`{selection: true}` = Find more like; `{image}` = bytes handed in), `findMoreLike()`, `VisualSearchHost` (the view, and the file's indexer for the editor's life).
- `Similar.tsx` — Assets' **Similar**: under a search's exact matches, the index's components and sets for the query (`kinds` component / set; in an open library only its own), leaving out those listed; nothing without the models.

**Shared edits** (one line each, reported): `editor/EditorApp.tsx` mounts `<VisualSearchHost />` in `Overlays` (+ its import); `editor/panels/ActionsPanel.tsx` — the "Visual search (AI beta)" button calls `openVisualSearch()` instead of being disabled (+ its import). `editor/panels/Assets.tsx` (owned) computes the search's matches before the body and renders `SimilarAssets`. `package.json` / lock: `@huggingface/transformers` 4.3.0 exact (6b pins the same package — keep one version on merge).

**Tests**: `src/store/search/search.test.ts` (half floats; the format round trip and refusals; name tiers; 0.6/0.4 scores; image-only ranking and the floor; exact first over vectors; names only; sort by modified, kinds, file, library, limit; versions and incremental upserts across a restart; removed nodes and files; deleted, trashed and renamed files; another version's index; checks; LocalStore's `spaces/search/<key>.idx` through a restart, Trash and Delete forever), `src/renderer/src/store/memory/search.test.ts` (the dev store's keys), `src/renderer/src/editor/search/__tests__/search.wasm.test.ts` (on the wasm engine with a fake embedder: targets, text, 224 px sizes, hashes, chains, white padding; a pass, nothing again, a touched frame alone, a reopened file, a deleted frame; indexing off / no models; 20 a pass; busy fonts; the query with text, an image and no models; the models' states and download; the worker client's routing and failure).

**Not built / for later**: model downloads themselves and the `aimodel:` scheme (6b; until then the view says local models aren't available and searches names only); the Actions panel's "Find more like" row (6a's list — it calls `findMoreLike()`); Community; CLIP and MiniLM ran for real on 2026-10-12 (four frames indexed; "login form with password" → Sign Up, Login; "blue circle with a yellow star" → the vectorized logo; "green cube on a table" → the photo; Find more like on Sign Up; each query well under 2.5 s); headless exports draw no pixels in Node, so the tests feed pixels for ranking; Insert of another file's frame loads that whole file in a headless engine (fine for normal files, slow for very large ones).

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

export interface AiUsage { input: number; output: number; images: number; credits: number; providerId?: string; model?: string } // who answered: main fills them (2026-10-12)

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

**Checked against `ipc.ts` and `protocol.ts` (main session, 2026-10-12), as committed:**
- IPC: the list above holds with these fits to the existing conventions. `agents:consent-answer` is a one-way send (`IpcSend`, `["editor"]`), like `agents:tool-result`, not an invoke. `ai:run` and `ai:image` answer `void` (their events carry the `runId`). `ai:set-settings` takes `Partial<Omit<AiSettings, "imageKeys">>`; `ai:set-image-key` takes `{ provider: "openai" | "gemini"; key: string | null }`. `ai:models` answers `{ info, state }`. Events (`ai:event`, `ai:model-state`, `agents:consent`) have no role list in `IpcEvents`, like the others. Main-side stubs are in `src/main/ipc.ts`; 6f / 6b replace them.
- The `aimodel:` scheme (6b) follows the `plugin:` pattern: a `src/main/ai/protocol.ts` exporting `AIMODEL_SCHEME_PRIVILEGES` (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`) that joins the array in `registerScheme()` in `src/main/protocol.ts` (one call registers all schemes), and a handler beside `handleScheme`. The app's CSP needs `aimodel:` added to `connect-src` (the worker fetches the model files and runs onnxruntime's Wasm; `script-src` already has `'wasm-unsafe-eval'`, `worker-src` already has `'self' blob:`). Nothing else changes in the CSP.
- The two stubs are in place; `src/store/ai/stub.ts` holds `notImplementedAi()` and `notImplementedSearch()`.

**Reviewed 2026-10-12 (before the agents):** the block above matches `src/shared/ai/types.ts` exactly, and every addition listed is in. The fits above are kept: a one-way `agents:consent-answer` is how `agents:tool-result` answers main; `ai:run` / `ai:image` take a caller-chosen `runId`, so there is nothing to return (unlike `agents:turn`, whose id main makes); `ai:set-image-key`'s `"openai" | "gemini"` matches `AiSettings.imageKeys` — with Antigravity the default for Make, Edit and Expand (§10.1) the keys are optional providers, and nothing needs one; `ai:models` answers both lists in one call so Settings shows sizes and states together; the `aimodel:` scheme stays with 6b, which owns `src/main/protocol.ts`'s one line. One change from the owner's answers: `DEFAULT_AI_SETTINGS.stopAtLimit` is `true` (§10.3), in the block and in the code.

### 8.1 As built — round 6f, the AI host (2026-10-12)

**Main (`src/main/ai/`)**:
- `run.ts` — `AiRuns` (Electron-free; settings, routes, the ledger, spawn and fetch injected). `start(owner, req, emit)`: AI off → `disabled`; the credits stop (`overLimit`: `stopAtLimit` and the ledger's `remaining ≤ 0` → `over-limit` "You've used all 4,250 AI credits for this month. They reset on November 1."; free actions — `creditsFor(...) === 0` — always run; a ledger that can't answer never refuses) → the route → one attempt (status, deltas) → the answer (the CLI's structured output, else the last JSON object) checked → on a mismatch **one repair attempt** (the previous answer, the errors and the schema) → `bad-output`. Events end `usage` (both attempts' tokens; credits by `creditsFor`), `result`, `done`; a failure ends `usage` (if tokens were spent), `error`, `done`. **Cancel** (`cancel(owner, runId)`, only the view that started it) ends with `done {cancelled: true}` and nothing else. Each attempt has a **timeout** (180 s; `timeout`). `track(owner, runId, emit)` lets 6b's image runs share `ai:cancel`. `cancelAll(owner)` when a view is destroyed.
- `oneShot.ts` — one attempt: `runCliOneShot` (the adapter's `oneShot` plan, its own empty folder under `userData/ai/work/`, removed after; NDJSON lines through the plan's `line()`; SIGINT then SIGKILL on abort) and `runServerOneShot` (`POST /chat/completions`, streamed, `stream_options.include_usage`, `response_format` json_schema → json_object → none on a 400/422 that names the format, remembered per base URL; images as `image_url` data URLs; `refusal` → `refused`). `classify` maps a message to `signed-out` / `rate-limited` / `network` / `refused` / `no-model` / `too-large` (unknown failures: `network` with the provider's own words).
- `json.ts` — `lastJsonObject`, `schemaErrors` (type, properties, required, additionalProperties, items, enum, const, anyOf/oneOf, lengths, bounds), `readAnswer`.
- `settings.ts` — `AiSettings` in `userData/ai/settings.json` (cleaned on read and write), image keys sealed with safeStorage in `userData/ai/keys.json`; `imageKey("openai" | "gemini")` for 6b; `AI_ACTIONS`, `cleanRoute`.
- `host.ts` — the app's `aiRuns()`; `resolveRoute(action, route?)`: the request's route, else `actions[action]`, else `text`, else the first available of `AI_TEXT_DEFAULT_ORDER` (`no-provider`); a CLI needs a `oneShot` (`unsupported`) and its binary (`no-provider`); a server's model is the route's, else Agent settings', else its first listed (`no-model`); `"local"` is `unsupported` for text. `--json-schema` is passed only when the CLI's `--help` lists it (cached per path). `startRun` / `cancelRun` for the IPC.
- `ledger.ts` — **the ledger interface for 6g**: `ledgerBalance(allowance): Promise<AiBalance | null>` reads `store.ai.balance` through main's store client; null while the store's stub refuses. 6g may change its body (the org's `aiCreditLimit`), not its signature.

**Providers' `oneShot` plans** (`CliSpec.oneShot(input) → { args, stdin?, env?, files?, line(l) }` in `providers/turns.ts`):
- Claude Code: `-p --output-format stream-json --verbose --include-partial-messages --tools "" --strict-mcp-config --no-session-persistence --permission-mode dontAsk --system-prompt <system> [--json-schema <schema>] [--model] [--effort]`; pictures inline as image blocks with `--input-format stream-json`; the answer is the result's `structured_output` (verified: with `--json-schema` the run's only tool is `StructuredOutput`), else `result`. `--json-schema` and `--system-prompt` are in `claude --help` (checked 2026-10-12).
- Antigravity: `agy -p <system + prompt> --output-format stream-json --model <m> --project designerv2-ai --disable-slash-commands [--json-schema]` (both flags in `agy --help`, 2026-10-12); the project `designerv2-ai` (written to `~/.gemini/config/projects/`) denies `mcp(*)`, commands, unsandboxed commands and the web; pictures are files in the run's folder (its workspace). Answer: `result.structured_output` [unverified field], else `result.response`.
- Codex: `codex exec --json --skip-git-repo-check --sandbox read-only -c mcp_servers={} [--output-schema schema.json] [-m] [--image=…] -` [`--output-schema` unverified — not installed here]; the answer is the last `agent_message`.
- Cursor: `-p --output-format stream-json --stream-partial-output <system + prompt>` with `.cursor/cli.json` denying the shell and writes; no schema flag (the run checks and repairs).
- OpenAI-compatible servers (Ollama, LM Studio, added servers): `oneShot.ts` above.

**IPC** (`src/main/ipc.ts`): `ai:settings` / `ai:set-settings` / `ai:set-image-key` (settings.ts), `ai:run` (the request checked: action in `AI_ACTIONS`, ≤ 8 images, schema ≤ 200 KB of plain JSON, prompt ≤ 400 K chars) → events `ai:event {runId, event}` to the sender, `ai:cancel`. `ai:image`, `ai:models`, `ai:model-download`, `ai:model-remove` stay stubs for 6b. Connectors: `agents:connectors` / `add-connector` / `update-connector` / `remove-connector` / `test-connector`, `agents:consent` → `agents:consent-answer` (only the view the card went to may answer; 5 minutes unanswered = Deny; a stopped turn or a closed view denies its cards). `agents:turn` now carries `skill`, `skills`, `connectors` (checked).

**Views' API** (preload; shared edits): `window.designer.ai: AiApi` in the editor (`src/shared/ai/api.ts`: `settings`, `setSettings`, `setImageKey`, `run`, `image`, `cancel`, `onEvent`, `models`, `modelDownload`, `modelRemove`, `onModelState`), `AiSetupApi` in Home (no runs). **`runOnce(api, request, {onEvent?, signal?})`** resolves `{text, json?, usage?}` or rejects with `AiRunError {code}` (`cancelled` on abort) — what 6a swaps its fake runner for. `AgentsApi` gains optional `connectors`, `addConnector`, `updateConnector`, `removeConnector`, `testConnector`, `onConsent`, `answerConsent` (optional so browser stand-ins compile).

**Connectors** (`src/main/agents/connectors.ts`): `ConnectorHub` (storage, secrets, spawn, fetch and the consent prompt injected); `userData/agents/connectors.json` (keys sealed in `keys.json` as `connector:<id>`). Hand-written MCP clients: `HttpMcpClient` (Streamable HTTP; JSON or SSE answers; `Mcp-Session-Id`, `MCP-Protocol-Version`; DELETE on close) and `StdioMcpClient` (newline-delimited JSON-RPC). Test connection lists tools; **new tools start at Ask**. Tools are `‹slug›__‹tool›` (the name lowercased with hyphens; a clash gets the id's last 4). Off: not listed, refused. Ask: the consent card; Deny → an error result telling the agent not to call it again; Always allow → the policy becomes Allow. A disabled connector offers nothing.
- **The proxy** (`mcpServer.ts`): `ChatGrant.connectors`; `McpHost.extraTools(session)` lists a chat session's connectors' tools after ours (outside clients never see them; their calls are refused as unknown tools); calls go through `runTool` → `host.ts runAnyTool`: `get_skill` answered in main, a turn's connector tool through the hub, the rest in the view. The OpenAI bridge offers the same tools (`OpenAiTurn.extraTools`).

**Skills and turns** (`host.ts`, `providers/turns.ts`): `skillsNote` adds to every turn's prompt the enabled skills (name: description) for `get_skill`, and the invoked one's instructions in full (`<skill name="…">`). `get_skill {name}` (`src/shared/agents/tools.ts`, `MAIN_TOOLS`) reads `store.ai.skills()` (6g) — an error result until the store has them. Chat turns get the credits stop too (`over-limit` as the turn's error) and "AI is turned off in Settings › AI." when AI is off.

**The Agents panel** (`src/renderer/src/editor/panels/agents/`): the composer's "+" is a menu — "Add files and photos", "Skills ▸" (the enabled skills as `/name`, "Add skill", "Manage skills"), "Connectors ▸" (checkable per chat, "Add connector", "Manage connectors"); typing `/` lists matching skills (↑↓, ↩ / Tab, Esc); the chat's connectors show as chips. A consent card in the running chat ("‹Connector› wants to use ‹tool›", its arguments, "Allow once" / "Always allow" / "Deny"). A finished reply shows the AI credits icon (hover: "N AI credits · T tokens"). Agent settings gain **Skills** (rows; Add skill: "Upload a file" or "Start from scratch"; a skill's page: Save, Export, Disable skill, Delete) and **Connectors** (rows; Add connector: Server URL + optional key, or a command; a connector's page: status, Test connection, on/off, each tool's Allow / Ask / Off, Remove connector). `aiData.ts` keeps one copy of both lists per page; `src/shared/ai/skillFile.ts` reads and writes the `.md` (frontmatter `name`, `description`) — 6g's store can use it for `skills/<id>.md`.
- The service (`editor/agents/service.ts`, shared edit): `send(prompt, context, attachments, skills)` runs the first enabled `/name` (its token out of the prompt), lists the others; per-chat `connectors`; `consents`; each reply's `usage`; a finished turn is recorded with `store.ai.record({action: "agent", …, orgId: null})` (ignored until 6g).

**Not built / for later**: the org's `aiCreditLimit` as the allowance (6g, in `ledger.ts`); 6a's actions record their own runs (`store.ai.record` with their file and org) — main only emits `usage`; OAuth connectors and shared Skills (§10.4–5); Codex's `--output-schema` and Antigravity's `structured_output` are unverified (a missing one only means the repair path does the work). Claude Code one-shots ran for real (§3 "Run for real"); the other CLIs and local servers only against stubs; `editorShotAgents.mjs` clicks `[data-attach]`, which now opens the "+" menu.

**Tests**: `src/main/ai/ai.test.ts` (the JSON and schema check; each adapter's plan; runs on a local OpenAI-compatible server: streaming, json_schema → json_object fallback, the repair retry, bad-output, timeout, cancel, another view's cancel; the credits stop and `disabled`; runs on a stub CLI speaking Claude Code's stream-json: structured answer, repair, signed-out, cancel kills it, timeout; connectors: SSE answers, a keyed HTTP server — Allow / Ask (Deny, Allow once, Always allow) / Off, a wrong key, a stdio server, and the consent round trip through our MCP server with an outside client kept out), `src/shared/ai/skillFile.test.ts`, `src/shared/ai/api.test.ts`.

**As built — leftovers (2026-10-18).** **OAuth connectors** (open question 5; Figma's connectors are added with OAuth): an HTTP connector without a key whose server answers with a Bearer challenge is in the state `sign-in` ("Sign in needed"); its page has **Account** (Not signed in / You're signed in), **Sign in** and **Sign out** (`agents:sign-in-connector` / `agents:sign-out-connector`). `src/main/agents/connectorAuth.ts` does MCP's authorization (2025-06-18): the challenge's `resource_metadata` (else RFC 9728's well-known place under the server's path, then its root) → the authorization server's metadata (RFC 8414, OpenID's as a fallback; 2025-03-26's `/authorize` `/token` `/register` when the server names none), Wecra registered for the sign-in's own loopback redirect (RFC 7591, `token_endpoint_auth_method: "none"`), the owner's browser (`shell.openExternal`) on the authorization page with PKCE S256, the state, `resource` (RFC 8707) and the challenge's scope, the code back on `http://127.0.0.1:‹port›/callback` (one answer, the state checked — a stray one is ignored, `error=` cancels; 5 minutes), exchanged for tokens. Endpoints are https (or http to this computer); no answer of the token endpoint is ever repeated in an error. The tokens are sealed beside the keys (`keys.json` `connector:‹id›:oauth`) and only ever the server's Authorization header (notifications and the session's DELETE too); a refused one is refreshed once and the message sent again, one running out within a minute is refreshed before it is used; no refresh token → Sign in needed again. Discovery checked against `mcp.notion.com`, `mcp.linear.app` and `mcp.asana.com` (their public metadata, no sign-in): each names its own `/authorize`, `/token` and `/register`. Tests: `src/main/agents/connectorAuth.test.ts` (a local MCP server with its own authorization server: sign in, tokens apart and sent, refresh on a refused token and before expiry, no refresh token, Sign out, a cancelled sign-in, a stray callback, the challenge's parameters, secure endpoints, PKCE, no token in an error). **editor-shot's Agents section** is current again (177 checks): its stand-in has the manager off (on by default since round 15), "+" is the menu (Add files and photos), the settings groups include Studio and Skills, and an agent's turn is checked as staying out of the user's history (r17 agent isolation). Still open from this list: shared Skills (a server table — the organization's), Codex's `--output-schema` (Codex isn't installed here) and Antigravity's `structured_output` field (`agy --help` lists `--json-schema`; the field needs a real run).

### 8.2 As built — round 6g, the ledger and the chrome (2026-10-12)

**Store (`src/store/ai/service.ts`, `AiService`; no Node / DOM imports — both stores run it through `AiStoreHost`)**. `StoreApi.ai` is `AiService.repository()` in `localStore.ts` (files under `Workspace/spaces/ai/`) and in the browser's dev store (`memoryStore.ts`, one key per file: `designer.devStore.v1.ai.<name>`). The protocol's `ai` method list was already right; nothing changed in `protocol.ts` / `server.ts`.
- `record(e)` → the entry with `id` / `at`. Checked: a known action, a provider id, numbers ≥ 0 (`invalid` otherwise); credits rounded to hundredths; **`orgId: null` with a `fileKey` takes the file's `space.orgId`** (so 6a and the Agents panel may pass `orgId: null`). Written to `usage/YYYY-MM.json` — **the local calendar month** (credits reset at local midnight on the 1st): `{v, month, used, runs, byAction, entries}`, entries oldest first, the oldest dropped past 5,000 (the totals keep counting).
- `balance(allowance, now?)` → `AiBalance` for `now`'s month: `used`, `allowance` (rounded, ≥ 0), `remaining = max(0, allowance − used)`, `resetsAt` (the next 1st, local), `byAction` (credits only). Over the allowance never goes negative.
- `history({month?, limit ≤ 500 (50), cursor?})` → entries newest first; without `month` it walks every month with a file, newest first; the cursor is `"YYYY-MM:offset"` (a page ending at a month's end continues in the month before); `null` at the end.
- `skills()` / `saveSkill` / `removeSkill`: `skills/<id>.md` written with `skillFileText` and read with `parseSkillFile`; `skills.json` keeps `enabled`, `createdAt`, `updatedAt` per id. A valid `.md` dropped in the folder by hand is a skill (enabled); an unreadable one is skipped with a warning. Names are unique (`conflict`), `skillProblem` decides validity (`invalid`), an unknown `id` is `not-found`. Sorted by name.
- **Org reports**: an entry with credits whose org is known adds to `reports.json`'s row (account, org, UTC day, editor type `design`). One minute after the last record, on every session change and at the quit (2 s at most), rows whose total changed since last sent go to `POST /me/ai-usage` in chunks of 200 — **absolute totals**, so a resend is harmless; 5xx / 429 / offline keep them; a 4xx counts as sent (logged). Rows of another account are dropped, never sent as the new one; rows older than 35 days are dropped. `flush()` and `pendingReports()` for tests.

**Server**: `server/src/ai/usage.ts` — `POST /me/ai-usage {rows: {orgId, day, editorType, credits}[]}` → `{accepted, dropped}` (shared shape `src/shared/ai/usageReport.ts`). Sessions only (a personal access token falls through to the account routes). ≤ 200 rows (413); kept: orgs the caller is in (members and guests), days in [today − 35, today + 1] UTC, Figma's editor types, credits 0…10,000,000; the same key twice — the last wins. Upsert into `ai_usage_daily` replacing `seat_credits` (`plan_credits` stays 0), with the member's `workspace_id` and `billing_group_id`. 60 calls an hour per person per isolate (429 `rate_limited`). One dispatch line in `api.ts` before the account routes. `GET /v1/ai_usage/daily` (unchanged) returns the rows. **`PATCH /orgs/:org/admin/settings`** takes `aiEnabled` (boolean) and `aiCreditLimit` (null or an integer 0…10,000,000) and logs `org_ai_setting_change` (**ours** — Figma's action name is unpublished; added to `ActivityAction` and the Activity labels: "Turned AI features off", "Set the AI credit limit to 1,000 credits a month", "Removed the AI credit limit").

**Main**: `ledgerBalance(allowance)` (signature kept) reads the person's orgs through the store (`orgs.list` / `orgs.get`, kept a minute) and asks `store.ai.balance` with `allowanceOf(allowance, policyOf(orgs))` (`src/shared/ai/orgPolicy.ts`): the smallest `aiCreditLimit` of the orgs they are a **member** of (guests aren't governed), **0 when one of them turned AI off**. `run.ts overLimitMessage` says "You don't have any AI credits this month. They reset on …" for an allowance of 0. Limits: AI off in an org stops runs only while "Stop when credits run out" is on (the credits stop is the one check), and it applies to every file, not only that org's (main doesn't know the file of a run — 6a disables its rows per file, §2.12).

**Chrome**:
- **Settings › AI** (`src/renderer/src/settings/AiTab.tsx` + `AiTab.module.css`; a tab between Security and Agents, `SettingsTab` `"ai"`): Use AI features; **AI balance** — the meter "X of 4,250 credits used this month", "N credits remaining · Resets ‹date›", the org's word when it limits ("Your organization allows 1,000 credits a month." / "…has turned off AI features."), See usage; **Monthly credits** (editable, 0…10,000,000), **Stop when credits run out** (on by default); **Providers** — Text (Automatic or an agent, its model) and Images (Antigravity default, OpenAI Images, Gemini API), "Provider for each feature" overrides; **Image API keys** (OpenAI, Gemini through `ai:set-image-key`; "Saved in your keychain" / "Not set", Remove key); **Local models** from `ai:models` (label, use, size, licence, Downloaded / Not downloaded / Downloading… n% / the error, Download / Remove — the downloads are 6b's; while `ai:models` refuses: "Local models aren't available in this version yet."); Index files for visual search. Every change goes to `ai:set-settings` at once. In a browser: "AI runs in the desktop app." The bridge: `aiSetupBridge()` (`window.designer.ai`, or `window.__designerAi` in tests).
- **AI balance** (`src/renderer/src/settings/AiBalance.tsx`): `openAiBalance()` opens the modal in the calling view (`SettingsHost` renders `AiBalanceHost`, so every view that has Settings has it) — "Credits used", "Credits remaining", "Resets ‹date›" with the allowance, the meter, credits by feature, and the usage history (date, feature, model, credits; Show more). **6a**: the main menu's "AI balance" entry calls `openAiBalance()` from `@/settings/AiBalance` (or `../settings/AiBalance`). `loadAiBalance(own?)` / `BalanceMeter` for anyone else showing the balance. Feature names: `src/shared/ai/labels.ts` (`AI_ACTION_LABEL`, the text / image / local action lists, `formatCredits`).
- **Admin › Settings › AI** (`src/renderer/src/admin/SettingsAi.tsx`, a group before Plan access tokens): "AI features" (switch) and "AI credit limit" (No limit / Limit each member's credits a month; disabled while AI is off). The fake admin store logs the same action.

**Not built**: Admin › Dashboard's AI usage table (needs an admin route over `ai_usage_daily` for sessions — `/v1/ai_usage/daily` takes plan tokens only); the Agents composer's credits hover was 6f's; image runs' and 6a's actions' `record` calls are theirs; editor types other than `design` (FileMeta has only design).

**Tests**: `src/store/ai/ai.test.ts` (ledger math, fractions, month rollover at local midnight, Dec → Jan reset, over-limit, checks, the org from the file, history across months, the 5,000-entry cap; Skills round trip with a hand-made file, unique names, the index; reports: absolute totals, debounce, resend only on change, 503 kept, another account dropped; through LocalStore against the real server handler on node:sqlite: files under `spaces/ai`, `ai_usage_daily` filled, read back after a restart), `server/src/ai/usage.test.ts` (idempotent upserts, drops, guests and outsiders, `/v1/ai_usage/daily` returns them, bad bodies, PATs, the rate limit; the two settings keys with their checks and activity rows), `src/main/ai/ledger.test.ts` (org limits, AI off, guests, a store that can't answer), `src/renderer/src/settings/__tests__/ai.dom.test.ts` (the meter and saving, an org's limit, image keys, models, the unavailable states, the AI balance modal), `src/renderer/src/admin/__tests__/settings.dom.test.ts` (+ Settings › AI with its activity sentences).

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
2. **Local model downloads**: ≈ 88 MB (remove background; was 115 MB with BiRefNet), 55 MB (boost), 93 MB (erase), 154 MB (visual search) and 23 MB (text search), ≈ 415 MB in all, each downloaded on first use after a confirmation. OK, or bundle some with the app?
3. **Credits**: warn only (default), or stop at the monthly allowance (4,250)?
4. **Skills publishing** to a team or org (needs a server table and a migration). Default: later.
5. **Connectors with OAuth** (Notion, Linear, Asana's hosted MCP servers need it). Default: keys and stdio only this round.
6. ~~**Vectorize replaces the image layer**, and Isolate keeps the original.~~ Settled by atlas 18 (REA, wave 7): Vectorize hides the original; Isolate turns it into the "Background".
