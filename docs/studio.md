# Studio (contract, round 15 [ours]; written 2026-10-13)

The owner runs the social accounts of two brands (Partner Agro and another). For each one he makes posts and stories with product pictures from an image model (Nano Banana), then adds text and logo. This round brings that work into the app. A **manager agent** reads the owner's words, finds the brand and products in a **library**, and hands the work to other agents that run **at the same time in one chat**. Pictures come from an image route the owner picks: Gemini API (Nano Banana / Nano Banana Pro), Gemini CLI with its nanobanana extension, or Antigravity. The manager then **reviews** what landed on the canvas and offers fixes. Figma has none of this, so every name here is [ours]. The UI is English.

Shared types: `src/shared/studio/types.ts`. Committed before the agents, and it decides.

## 1. The owner's flow (2026-10-13, his words, kept as the spec)

1. The library holds each brand's pictures and details. When something is missing, the manager says so in the chat ("Partner Agro isn't in the library — shall I create it?") and opens a form there. The owner answers and the manager saves it.
2. The owner writes, for example: "Partner Agro's Liq Humus needs a post and a story". The manager reads the library and asks for whatever is still missing.
3. General work goes to Claude by default, or to another agent if the owner changes it. Pictures go to the image route **the owner picks**.
4. Once everything is ready, the manager reads all of it, product pictures and label texts included, and hands out the work.
5. Results go onto the canvas. The manager checks the texts and anything outside the request, lists what failed, and asks "Shall I fix this?". A yes starts new tasks with the same information, and the loop goes on.

**Product fidelity is the prompt's job, not ours** (owner, 2026-10-13). No compositing, cut-outs, homography or pasting of the original label. The image model draws the whole picture from the references and a strict prompt (§5). The only pixel work we do is **Blur** on small texts that came out wrong (§6.2), so they read as a low-resolution print.

## 2. The manager

### 2.1 Settings

Agent settings gets a **Manager** item (`ManagerSettings`, kept in `AgentSettings.manager`, main's `userData/agents/settings.json`):
- **Manager:** a provider, model and effort. Default: Claude Code, `claude-haiku-5-5`, low.
- **General work:** default Claude Code, `claude-sonnet-5-5`.
- **Images:** an image route, or "Ask each time" (`null`, the default).
- **Agents it may use:** a checkbox per connected provider. Empty = all.
- **At once:** CLI tasks running together, 1–4, default 3 (the 16 GB rule). Image API calls run up to `IMAGE_TASKS_AT_ONCE` (4).
- An **On** switch. With it off, the chat works as before round 15: the composer's picked agent answers directly.

### 2.2 A turn

With the manager on, the composer sends every message to the manager's provider, as an ordinary turn on the chat. The manager has its own system prompt (`src/shared/studio/managerPrompt.ts`): the flow in §1, the tools below, and "answer simple questions yourself, without tasks".

Its tools are **manager-only**: they are listed for the manager's turns and refused for workers.
- `delegate_task {kind: "agent", title, prompt, agent?: providerId, model?, dependsOn?: taskId[]}` → `{taskId}`, returned at once. The task runs as a **worker turn**, on its own CLI process or server call, its own working folder and its own `TurnLog` actor. A worker has the usual canvas tools, but not the manager's.
- `wait_tasks {taskIds, timeoutSec?}` → each task's state and summary, once all of them have ended (or at the timeout).
- `stop_task {taskId}`.
- `ask_choice {question, options, remember?}` → the option the owner picked. It shows a choice card and **waits** for the click.
- `show_form {form: "brand" | "product", brandId?, productId?, prefill?}` → the saved id, or `cancelled`.
- The library tools of §3.3 (`LIBRARY_TOOLS`, answered by `runLibraryTool`).
- `make_posts {briefId?, brand, products, formats, scene, variations}`: the studio pipeline of §5.4, as image and agent tasks.
- `review {nodeIds, briefId}` → the frames' pictures plus the brief's texts, for the manager to look at.
- `report_review {report: ReviewReport}` → shows the review card and waits for the owner's answer (§6).

Tool calls already reach the view (`runToolInView`). The manager's tools are answered by the view's `AgentsService`, which owns the chats and starts the worker turns through `agents:turn`. Main only needs:
- **several turns at once per chat** (today: one), keyed by turnId;
- a **long timeout** for `wait_tasks` / `ask_choice` / `show_form` / `report_review` (30 min);
- `manager-only` checked on the turn: a worker's turn carries `role: "worker"`, and a manager tool from it is refused.

### 2.3 Task cards

A manager answer shows one **task card** per `StudioTask` it started. The card shows the title, the agent and model ("Claude Code · Sonnet 5.5", "Gemini API · Nano Banana Pro"), the state (Queued / Running with elapsed time / Done / Failed / Stopped), its credits, a **Stop** button, and a disclosure with the worker's messages and tool steps, drawn the way an answer is drawn today.
- Tasks queue when `parallel` CLI tasks are already running (`IMAGE_TASKS_AT_ONCE` for image tasks), or until their `dependsOn` tasks are done. A failed dependency fails the task.
- Stopping the manager's turn stops its tasks.
- Every task is recorded in the ledger like any agent turn (`"agent"`) or image run (`"make-image"` / `"edit-image"`).
- Tasks persist with the chat's messages (in `AgentsService`'s chat storage). Running ones become Stopped when the file closes, as turns do today.

### 2.4 The image model choice card

When a request needs a picture and `ManagerSettings.image` is null, the manager calls `ask_choice` with the routes from `ai:image-routes` (`ImageRouteInfo[]`). The card lists each route with its models:
- Gemini API › **Nano Banana Pro** (`gemini-3-pro-image-preview`: the best text and detail, the default for labelled products) and **Nano Banana** (`gemini-2.5-flash-image`: quick);
- Gemini CLI (nanobanana extension);
- Antigravity;
- OpenAI Images.

Model ids are checked against Google's docs by 15c and come from settings, never hard-coded in the views. Unavailable routes are greyed out with their reason. The card has **"Use this for this chat"**, which keeps the choice on the chat (`Chat.imageRoute`) so the card doesn't ask again.

## 3. The library

### 3.1 Storage

The store's new `brands` repository (`BrandsRepository`) is the only writer.
- Desktop: `Workspace/spaces/brands/<brandId>/brand.json` (the brand with its products, minus pixels) and `images/<imageId>.<png|jpg|webp>`.
- Browser dev store: keys.
- Pictures are checked by their bytes (PNG, JPEG, WebP; ≤ 20 MB), and their size is read from the header.
- Every change emits the `brands` event topic with the brand id.
- `find` matches names with case and accents folded ("liq humus" finds "LIQ HUMUS"), brands and products both.

### 3.2 Brands panel

The left nav rail gets **Brands** (after Assets); Home's sidebar has **Brands** too (after Shared, location `{ kind: "brands" }`). Both show the same full-size view (`editor/studio/brands/`, the owner's wireframes I, J, K in "Sosyal Medya" › wireframe): in the editor it lies edge to edge over the panels and the canvas with the rail left visible (`BrandsWindow`, as the Variables view; another tab, Close or Esc on the list ends it), in Home it is the main area. Without an editor (Home) the agent and text-model buttons aren't there.
- **The list (I)**: header Brands with Search brands and products, Create / Update brands library and New brand; a card per brand (its logo, name and ⋯ Edit / Delete, "72 products · 6 series · 3 logos · Inter", its colours, the bars Product photos n/N and Label texts confirmed n/N, a hint for its gaps — no logo, colours, font or products) and a dashed New brand card.
- **A brand (J)**: its logo, name and tone's first sentence with Edit, Ask agent and Design posts; tabs Products (n) · Identity (logos, colours, fonts, tone, style pictures) · Formats. Products: a filter column (Series with counts — All, each series, No series; Readiness — Labels not confirmed, No product photo), search in the brand, sort by name / series, Add product (in the series shown), and product cards (photo, name, series chip, its first gap or Ready). A card's box picks it; with picks, the dark bulk bar: "n products selected · Ask the agent to design… · Read labels · ×".
- **A product (K)**: Brands / brand / series / product, previous / next (in the brand page's filter and order), Edit, ⋯ Delete. Left: the pictures by role (Product photo n, Label close-up n), the picked one large, thumbnails and a tile to drop, paste or pick more (written at once). Right: Readiness (missingFor's eight steps ticked, Complete with the agent), Shape, Notes (long ones fold), and the **label texts table** (text, Sharp / Soft, delete, add; "Read label from photos" fills it, §4.1; These texts are checked).
- The agent's buttons go to Social's agent (the right panel): Design posts switches to Social with the board on the brand and "Design posts for ‹brand› [with ‹products›]: " in the composer; Ask agent and Complete with the agent put their text there.

A product may name its **series** (`Product.series`, the distributor's line: Venta, Seipasa…; the store keeps the brand's spelling of a series it has, "" / null clears it). Add / edit use `BrandForm` / `ProductForm` (`editor/studio/forms.tsx`, the product form with Series and the brand's series as suggestions), the same components the chat's form cards use. Pictures go in by drop, paste or a file picker.

### 3.3 Library tools (manager-only)

- `library_find {query}`
- `library_get {brandId}` → the brand, its products, their image ids and roles, label texts and tiers.
- `library_missing {brandId, productIds}` → `Missing[]` (`missingFor`).
- `library_save_brand` / `library_save_product`: from what the owner said in the chat.
- `library_add_image {brandId, productId?, role, path | data}`: a file the owner attached.
- `library_read_labels {brandId, productId}`: the product's photos go through the text route (`ai:run` with images) and come back as suggested `LabelText[]` with tiers (name, brand, volume → sharp; ingredients, small print → soft). They are saved with `labelsConfirmed: false`, and the manager asks the owner to confirm them (a choice card: "Looks right" / "Edit").
- `library_image {brandId, imageId}` → the picture as an image content, so the manager can look at it.

## 4. Requests

### 4.1 Something missing

`missingFor(brand, products)` lists, in this order:
1. the brand itself;
2. a logo;
3. colours;
4. the product;
5. at least one product photo;
6. the shape;
7. label texts;
8. labels confirmed.

The manager asks for each item, by form card (`show_form`) or by a question, and saves the answer through the library tools. Work starts only with an empty list. The owner can say "go anyway", and the manager notes what is missing in its answer.

### 4.2 A brief

When nothing is missing, the manager writes a `StudioBrief`: the request, the brand, the products, the formats (default Post + Story from the brand's formats), the scene, the variations (default 2) and the image route. The brief is kept on the chat, so every task, the review and the fixes read the same one.

## 5. Making posts

### 5.1 Frames

For each format and variation, the general agent (a worker task) makes a frame named "‹Product› — ‹Format› v‹n›" at the format's size, with the brand's text and logo: the brand library's components and styles when `libraryFileKey` is set, otherwise the logo picture and the brand's colours and fonts. Frames are placed in a row to the right of the page's content, one row per request. The picture goes in as the frame's bottom layer, named "Picture".

### 5.2 The prompt (`src/shared/studio/prompt.ts`, deterministic)

`buildImagePrompt(brief, brand, products, format, variation)` returns `ImagePrompt`:
- **References, numbered:** for each product, its photos (role packshot, up to 2) and label close-ups (up to 1), then any brand style pictures. Up to 8 in all. The prompt names each one: "Image 1: product reference — Liq Humus, front".
- **Product rules:** keep each product's shape, proportions, colours, cap, label layout and logo exactly as in its references. Do not redraw or restyle the logo. Show the whole product, uncropped, not hidden, not transparent. The relative sizes follow the shapes (a 20 L jerrycan is about twice the height of a 1 L bottle).
- **Sharp texts:** "The label must read exactly:", with each sharp text quoted, Turkish letters included.
- **Soft texts (owner, 2026-10-13):** they are not quoted. "All other small print on the labels: leave it illegible, softly blurred like a low-resolution print — keep the lines' places, lengths and colours from the reference, write no real letters. Everything else — the products' shapes, edges, logo, large text and the whole scene — stays fully sharp."
- **The scene:** the brief's scene, plus the brand's tone, plus a variation hint. Variations differ in camera angle, light or arrangement, chosen in order from a fixed list, so v1 and v2 differ every time.
- **No text added:** no captions, watermarks or extra logos (the frame adds them).
- **aspectRatio:** the nearest of 1:1, 4:5, 3:4, 9:16, 16:9 to the format.

`buildFixLabelPrompt(brand, products, problems)`: the picture made before is the image to edit. The prompt says: keep the scene, light, composition and everything else unchanged; only correct the named texts on the label to read exactly, using the label close-up.

The owner can open a task's prompt in its card, edit it and run it again.

### 5.3 Pictures (`editor/studio/images.ts`, `ai:image`)

`runStudioImage(ed, req, signal)` sends `ai:image` with `action: "make-image"` (`"edit-image"` for Fix label), `references` and `aspectRatio`, and waits for its events.
- Main's clients take references:
  - **Gemini API:** `inlineData` parts, in order, after the text; `imageConfig.aspectRatio`.
  - **Gemini CLI:** a headless `gemini -p` run in the run's folder, with the references written there and the nanobanana extension's generate / edit tools as its only tools. The picture is the file it saved.
  - **Antigravity:** files in its workspace, as today.
  - **OpenAI:** `image[]`.
- The result fills the frame's "Picture" layer (FILL). Each picture is one undo step.

### 5.4 `make_posts`

`make_posts` runs the pipeline as tasks under the manager's answer:
1. For each format × variation: one image task (the route, the prompt), and one agent task for the frame, with no dependency between them.
2. When both are done, the picture goes into the frame.
3. A last **review** task (§6) depends on all of them.

## 6. Review and fixes

### 6.1 The review

The manager (`review`) gets each frame's picture (2× at most 2048 px on the long side) and the brief's sharp and soft texts, and checks:
- every sharp text reads exactly;
- product shapes and colours match the references (`library_image` lets it compare);
- nothing extra appeared (a second product, another logo, added text);
- nothing is missing or cropped;
- soft areas that came out as readable but wrong text;
- the frame's text and logo sit inside the format's safe area.

It reports through `report_review`, and the **review card** lists each frame with ✓ or its problems. Each problem shows its kind, its detail and a box on the frame's thumbnail. The card has **"Fix selected"** (checkboxes, all checked) and **"Leave as is"**.

### 6.2 Fixes

| Problem | Fix | How |
|---|---|---|
| `sharp-text` | `fix-label` | An image task: `buildFixLabelPrompt` on the frame's picture, the same route, replacing the picture (one undo step) |
| `soft-text` | `blur` | `blurRegions(ed, pictureNodeId, boxes)`, local: a soft-edged mask; Gaussian (σ ≈ 1.5 % of the box's short side) mixed with a 4× pixelation; nothing outside the boxes changes; one undo step. |
| `shape`, `extra`, `missing` | `regenerate` | A new image task with the same prompt plus a sentence naming what went wrong |
| `layout`, `brand` | `relayout` | An agent task on the frame |

After the fixes, a new review runs on the frames that changed. The loop ends when everything passes, or when the owner says Leave as is.

Image tools get **Blur** under Select area (next to Erase and Isolate). It runs on the lasso with the same function.

## 7. Ownership (round 15)

The main session committed the shared types, the store's `brands` stub and event topic, `ai:image-routes` (stub), `AiImageRequest.references` / `aspectRatio`, `AgentSettings.manager`, and the stubs of `shared/studio/library.ts`, `prompt.ts` and `editor/studio/libraryTools.ts`, `images.ts`, `forms.tsx`.

| Agent | Owns | Delivers |
|---|---|---|
| 15a manager | `src/renderer/src/editor/agents/` (service, turns, new `tasks.ts`, `managerTools.ts`), `src/renderer/src/editor/panels/agents/` (except `aiSettings.tsx`), `src/shared/agents/` (types, tools: manager-only list), `src/shared/studio/managerPrompt.ts` (new), `src/main/agents/host.ts` + `mcpServer.ts` (parallel turns per chat, worker role, long timeouts, manager settings persistence), `src/preload/common.ts` (`agents.setSettings` passes `manager`), `src/main/ipc.ts` (the `agents:set-settings` line only) | §2, §4, §5.1, §5.4, §6.1, and the §6.2 dispatch: settings, task cards, choice / form / review cards, `make_posts`, review. Tests: the task queue (parallel limits, dependencies, failure propagation, stop), manager-only refusal, the cards' answers, `make_posts` on fakes for the library and images |
| 15b library | `src/store/brands/` (new: service + tests), store wiring (`src/store/localStore.ts`, `src/store/server.ts` event, `src/renderer/src/store/memory/memoryStore.ts`: replacing `brandsUnavailable()`), `src/shared/studio/library.ts`, `src/shared/studio/prompt.ts`, `src/renderer/src/editor/studio/libraryTools.ts`, `forms.tsx`, new `editor/studio/BrandsPanel.tsx` (+ css), `editor/panels/Rail.tsx` / `LeftPanel.tsx` (the Brands item: a few lines) | §3, §4.1, §5.2. Tests: the repository (pictures checked by bytes, find with folding, events, removal), `missingFor`, the prompt builder (reference order and cap, sharp texts quoted, soft not, aspect ratio, variations differ), the forms (dom) |
| 15c images | `src/main/ai/images/` (references and aspect for Gemini, OpenAI and Antigravity; new `geminiCli.ts`; routes), `src/main/ai/settings.ts` (the Gemini CLI route), the `ai:image-routes` handler in `src/main/ipc.ts` (that line only), `src/renderer/src/editor/panels/agents/aiSettings.tsx` (image route choices), `src/renderer/src/editor/studio/images.ts`, `src/renderer/src/editor/imageTools/` (Blur) | §2.4 routes, §5.3, §6.2 Blur. Tests: request shapes on fake HTTP (parts in order, aspect), a stub `gemini` CLI saving a picture, routes' availability, Blur's pixels (inside changed, outside identical, feathered edge), one undo step |

**Merge order:** 15b, then 15c, then 15a (15a's tests use fakes for the other two; after the merge they run on the real ones).

**After the merge** (main session): a real run with the owner's two pictures. Partner Agro is created in the chat, then "Liq Humus post and story" is made with Nano Banana Pro through the Gemini CLI (or the API if a key is set), then a review and a fix.

## 8. As built (2026-10-18, leftovers)

The round's open items (handoff 2026-10-13) that need no image model, paid key or the owner's Mac, closed on one branch.

- **Run again (§5.2).** A task card's prompt opens with **Edit** once the task has ended: a text box, **Run again**, **Cancel**. Run again starts a new task in the same manager's answer, beside the old one (`AgentsService.runTaskAgain` → `runAgain` in `editor/agents/managerTools.ts`). How a task runs again is noted with it (`TaskExtra.again`, kept with the chat, so restored tasks run again too): a worker's turn with the edited words, Social's line and its files (the logo) as before; or a picture — made again with the brief's references, or its label fixed again on the frame's picture as it is now — into its frame (`pictureTask`, shared with the review's fixes). A review task has nothing to run again.
- **Fixes on one frame, in order.** Blur runs first, so a Fix label on the same frame edits the blurred picture (before, the edit could read the picture while the blur was being written and drop it). A template post's fixes (Fix label, Picture again, Blur) go to its unlocked picture slot (`ManagerEnv.pictureSlot`, `postSlots`), never a second "Picture" under the template; the blur's boxes are taken to the slot's place in the frame (`offsetIn`).
- **No unhandled rejection** when a picture can't go into its frame while another task failed (the review then never runs to read it); `wait_tasks` leaves no listener on the manager's turn signal.
- **Looked at on screen**: `EDITOR_ONLY=studio` in editor-shot (`editor/tools/editorShotStudio.mjs`; a stand-in manager calling its real tools — two tasks, the choice card, the brand form saved, the review with boxes, Run again — and the Brands tab: the saved brand, its page, a product with label texts; 23 checks in both themes). Fixed from the shots: a task's title on two lines and its agent · model · state wrapping (the state was cut off at the panel's width); the tasks above the cards that wait on the owner (nearest the composer); a worker's last words not shown twice (its summary only when its words aren't in the log); the picked option keeping its text; the review's answered problems wrapping; the forms in a chat card without the panel's padding, each row's name on its own line over its fields (`BrandForm` / `ProductForm` `inCard`).
- **Tests**: `agentsManager.test.ts` (Blur before Fix label, the template slot, the placement while another task failed, Run again of a worker, a picture and a Fix label, the refusals), `agentsManagerService.wasm.test.ts` (Run again through the service: only once ended, a worker's turn with the edited prompt, the card in the same answer), `studioLibrary.dom.test.ts` (waits for reads and saves instead of one 10 ms tick — it flaked under the full suite).
- **Still open**: a real run (an image model: the owner's Gemini key was out of credits, the Gemini CLI's Google login is retired — Antigravity is the free route); the Gemini CLI's nanobanana extension takes one input picture (read from its 1.0.12 source: `edit_image {file}`), so only Image 1 is sent there.
