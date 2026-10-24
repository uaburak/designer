# Social (contract, round 18 [ours]; planned 2026-10-17, **contract written 2026-10-18** from the plan, the owner's answers and the code on main `0e0f215c`)

The owner's request (2026-10-17, his words, translated): next to **Design** and **Dev Mode** in the toolbar's mode switch, a **Social** mode — an interface arranged entirely for social media content. Ready **templates** per platform (Instagram, LinkedIn, …) fed from the **Brands** panel; the **agent** works here too; our **drawing modes** work here too; and it makes **videos**, built the way Figma's **Motion** builds them. Motion doesn't exist yet in the app and is added first, "directly as in Figma, with everything".

**Owner's answers, 2026-10-17:** Social is **a mode of the same document** (confirmed). Not Figma Buzz as such, but Buzz's logic (templates, brand assets, bulk create) is fine as the model. **The agent plays the active role**: it will be used very heavily in Social, so entering Social mode must bring up **an interface built around the agent**, not Design's chrome with a chat tucked in a tab.

Motion (round 8) is built: `docs/motion.md` "Motion status" (2026-10-18) — nothing it lists as remaining blocks Social. This file is the contract agents **18a–18d** build from; the shared types of §9 are committed by the main session before them and decide. Figma has no Social mode. Figma's names are used where they exist (Motion, libraries, variables, components, component properties, Dev Mode, Export frames to PDF, the frame tool's **Social Media Presets**); everything else is [ours]. The UI is English, every string through `t` with its Turkish entry (`src/shared/i18n/tr/editor.ts`).

**Status (2026-10-18):** the pre-round commit (§9) and 18a, the shell, are built on §12's proposed defaults (pending the owner's confirmation) — §13 "As built — 18a"; 18c, the agent in Social, is built — §14 "As built — 18c"; 18b, templates and the Brands library, is built on its own branch — §15 "As built — 18b"; 18d, video and export, is built on its own branch — §16 "As built — 18d"; the not-done lists of §13–§16 are closed as far as they go without the owner's Mac — §17 "As built — leftovers" (the owner, 2026-10-18: build on §12's proposed defaults and go on, he reviews the panel himself later). Every row of §10 is built; "Social status" below says what of the whole contract stands and what remains.

## Social status (2026-10-18, after the leftovers) — what is built, what remains

**Built (18a–18d, on §12's proposed defaults, pending the owner's confirmation):** Social as a mode of a Design file (the switch, View › Social, Posts tab, the agent's right panel with Post / Design under it); posts, campaigns, templates, slots and the Brands library marker as `designer.social` plugin data, every write through `editor/social/actions.ts` (one undo step for the chrome, one per turn for the agents); the formats catalogue (§5) with safe areas, caption counting and limits; New post, Resize to / Duplicate for, the Post section, safe areas, review pins, the empty board; the generated Brands library and templates as component sets with role-tagged slots (gallery, Save as template, apply / fill / brand switch, the posts table, CSV import, `LibraryAsset.social`); the twelve Social tools, `check_posts`, the manager forced on in Social with its paragraph, `make_posts` on the board, `make_brand_library`, the review's Social kinds as pins; the export presets' renderer side (Export… / Export campaign…, "auto" per post, the format's limits checked before and the file's size after, JPEG steps, PNG → JPEG, a document's PDF, the campaign zip, `export_posts`), the Animated tab's Preset menu and the timeline's Social header; the canvas menu's post rows and Space playing a post's timeline. **The leftovers (§17):** a renamed brand keeps its mode and logo variant; library templates' slots in the manifest and `list_templates`; Social's export under Motion's one-export lock; Make starter templates sending the manager its brief; Fix without a model where it is mechanical, else a worker's relayout task without a manager turn; direct turns to a picked agent in Social's composer; ⇧ ranges in the Posts list; the gallery's drop preview; the table's sorting and multi-cell paste; the export dialog's Save as and quality fields; a carousel's slides exported together. The logos "not drawing" inside template instances (§15) were the check's own placement, not a bug.

**Remains:** the owner's review of the panel and of §12's four answers (building went on with them, as he said on 2026-10-18); the after-merge run of §10 (Partner Agro's library published, "Make starter templates", the owner's sentence with a real model, a review with a fix, a Reel animated and exported with audio on the desktop app); what §17 leaves for the Mac (a library's logos drawn in another file, Separate files in a picked folder, MP4 / WebM and uploads) and for later (the table's thumbnail cache, XLSX, Save as template's slots on the canvas, drag to reorder posts); clips from a video model (§8, not in round 18).

**Round 18 changes no engine code and no schema.** Everything is chrome, shared TypeScript and the agents' tools over existing engine commands; posts, templates and campaigns are plugin data (schema `pluginData`, 204) under a reserved plugin ID. `npm run engine:test` only has to stay green.

## 1. Decisions

1. **Social is a mode of a Design file.** *(Replaced on 2026-10-24 by §18: Social is its own kind of file, Figma's Buzz; what follows about the mode switch and View › Social no longer holds.)* `EditorMode` (`src/renderer/src/ds/components/EditorToolbar.tsx`) gains `"social"`; `EDITOR_MODES` reads **Draw / Design / Social / Motion / Dev Mode** (Social: icon `24.social` [ours], no shortcut, no badge); `UIState.mode` (`editor/uiStore.ts`) takes `"social"`; `FileMeta.editorType` stays `"design"`. One document, one engine, one undo: Draw's tools, Design's panels, Motion's timeline and the agents act on the same frames with no conversion. Switching modes never changes the document and is not an undo step. A view-only file can enter Social (it reads posts; every write control is disabled, as in Design).
2. **The agent is the primary input; the canvas is where its work lands.** Every Social action has two entry points — a sentence to the agent, and a direct control — and both call **the same function** in `editor/social/actions.ts` (§6). Each action takes a `Writer` (`<T>(label: string, fn: () => T) => T`): the chrome passes `ed.batch`, an agent tool passes its `ToolEnv.write` (`editor/agents/mcpTools.ts`), so a chat turn stays one undo step per worker (`agents/turns.ts`) and a click is one undo step. Parameterless actions are also registered in `COMMANDS` (`editor/commands.ts`) for menus, Actions (⌘K) and keys.
3. **The manager is Social's counterpart.** Studio's machinery is reused, not copied: `AgentsService` (`editor/agents/service.ts`), the manager's tools (`MANAGER_TOOLS` in `src/shared/agents/tools.ts`, answered by `editor/agents/managerTools.ts`), the library tools (`LIBRARY_TOOLS`, `editor/studio/libraryTools.ts`), the task queue (`editor/agents/tasks.ts`), the cards (`panels/agents/StudioCards.tsx`). In Social, a turn sent from the Social right panel goes to the manager even when `ManagerSettings.enabled` is off (the composer's agent picker still sends direct worker turns), and `managerPrompt` (`src/shared/studio/managerPrompt.ts`) appends Social's paragraph (`src/shared/social/managerPrompt.ts`, §7.4).
4. **A post is a top-level frame carrying a `SocialPostData` record** in its `pluginData` under the reserved plugin ID **`designer.social`**, key `post` (JSON, §3.1) — the same mechanism as the owner's frame status (`designer.workflow`, `editor/workflowStatus.ts`). Plugins never see the ID (`plugins/api/nodes.ts`'s `RESERVED_PLUGIN_ID` becomes a set of both). Everything a post is made of is ordinary Design. Promoted to schema fields only if search or multiplayer later needs it (roadmap Phase 6's rules hold: a NODE_CHANGES field like any other).
5. **Templates are components with role-tagged slots** [ours]: one **component set per template**, a `Format` variant per format, the slots tagged in plugin data (§3.3) and wired to Figma's own mechanisms — text slots to **TEXT component properties**, the logo to a variant of the brand library's **Logo** component set, colours to **variables**, fonts to STRING variables bound to the text's font family (schema `fontName @bind(FONT_FAMILY:family)`), the picture to an image fill. A "slot" here is our tagged layer, not Figma's SLOT component property (`ComponentPropType.SLOT`, 7), which a template may also use. Templates live in library files and travel through the existing libraries (publish, enable, review updates).
6. **One Brands library for all brands** (§4.1): a generated file "Brands" with a **Brand** variable collection (one mode per brand), STRING font variables, text styles and a **Logo** component set (a `Brand` variant per brand). Every brand's existing `Brand.libraryFileKey` (`src/shared/studio/types.ts`) points at it. Applying a template to another brand = setting the post frame's explicit mode for the Brand collection and the logo instance's `Brand` variant — no values copied.
7. **Video = Motion.** A post frame is a Motion timeline root (`docs/motion.md` §3.5); animated templates carry their presets. The agent animates through Motion's tools as built (`get_motion`, `set_keyframes`, `remove_keyframes`, `set_timeline`, `add_animation`, `edit_animation`, `remove_animations`, `apply_animation_style`, `detach_animation_style`, `add_audio`, `edit_audio`, `export_animation`; `editor/agents/motionTools.ts`). Export is Motion's Animated export (`editor/motion/export/exportAnimated.ts`, `AnimatedExportSettings`) with platform presets on top (§8). No separate video editor.
8. **Formats are a catalogue in code** (`src/shared/social/formats.ts`, §5), checked against the platforms' help pages (§5.3). A brand's own sizes stay `Brand.formats` (Studio's, edited in the Brands panel); a post's `formatId` names a catalogue entry, or `brand:<brandId>:<formatId>` for a brand's own size (no limits checked for those).
9. **Instagram and LinkedIn first** (proposed answer §12.2): their formats get starter templates, export presets and the review's limit checks; Facebook, X, TikTok, YouTube and Pinterest are catalogue entries — New post, safe areas and limits work, no starter templates.
10. **Export only.** No publishing to the platforms, no scheduling, no platform APIs in round 18 (later, if the owner wants it, through `docs/agents-reach.md`'s consent model).
11. **No new dependencies.** CSV import is ours (RFC 4180, ~80 lines); XLSX waits (it needs a parser library — the owner's free/performance rule says not now). The campaign zip uses `zipStored` (`editor/model/exports.ts`); a LinkedIn document is Figma's **Export frames to PDF** path (`file.export-frames-to-pdf`, `editor/exporting.ts`).

## 2. What exists to build on (main `0e0f215c`, 2026-10-18)

| Piece | Where | Social uses it for |
|---|---|---|
| Mode switch | `ds/components/EditorToolbar.tsx` `EditorMode`, `EDITOR_MODES`; `uiStore.ts` `mode` | the Social segment |
| Panel mounts per mode | `editor/EditorApp.tsx` `LeftSide`, `RightSide`, `CanvasLayers`, `Overlays` (Motion's timeline is `<MotionMode />`) | Social's panels, overlays, the timeline |
| Agents panel | `panels/agents/AgentsPanel.tsx` (today in the left panel's Agents tab, `panels/LeftPanel.tsx`) | the right panel's chat |
| Manager | `MANAGER_TOOLS`, `managerTools.ts` (`make_posts`, `review`, `report_review`, `PostRecord`, `StudioChatData`, `framePrompt`), `ManagerSettings` | campaigns, captions, review |
| Brands | `BrandsRepository` (store `src/store/brands/service.ts`; `Workspace/spaces/brands/`), `editor/studio/BrandsPanel.tsx`, rail tab `brands` | brand picker, library generation |
| Plugin data precedent | `editor/workflowStatus.ts` / `frameStatus.ts` (`designer.workflow`) | `designer.social` |
| Canvas overlays in DOM | `canvas/AgentImagePlaceholders.tsx` (placed from `ed.store.camera`, no React render per camera change), `comments/CommentsLayer.tsx` (pins) | safe areas, review pins |
| Frame presets | `panels/design/Header.tsx` "Social Media Presets" (Figma's list, `docs/research/figma/live/popovers/frame-presets-menu.txt`) | unchanged; Social's catalogue is separate |
| Libraries | `LibraryRegistry` (`shared/store/repositories.ts`), `LibraryAsset`, `PublishDialog.tsx`, `LibrariesDialog.tsx` | Brands library, templates |
| Export | `editor/exporting.ts` (`renderExport`, `renderItems`, `saveFiles`, `exportFramesToPdf`), `motion/export/exportAnimated.ts` (`renderAnimated`) | presets, campaign export |
| Agent file results | `ToolResult.files` + `src/main/agents/toolFiles.ts` (saved in the chat's folder) | `export_posts` |

## 3. The data model

### 3.1 A post

Stored on the top-level FRAME (or INSTANCE of a template's variant, or SYMBOL when the owner made the post a component) in `pluginData`: `{pluginID: "designer.social", key: "post", value: JSON.stringify(SocialPostData)}`. Read with `ed.engine.readNode(id, {fields: ["pluginData"]})`; written with `setProps([id], {pluginData: withSocial(entries, "post", data)})`, keeping every other entry. A frame without the entry is not a post. Duplicating a post copies its record (pluginData travels with the node); `actions.ts` gives the copy a fresh `status: "draft"` and clears `problems` and `exportedAt` (the engine copies the record as it is — Social's duplicate actions fix it; a plain ⌘D in Design leaves a twin record, which `get_board` reports as such).

```ts
interface SocialPostData {
  v: 1;
  /** A catalogue id ("instagram.post") or "brand:<brandId>:<formatId>" */
  formatId: string;
  brandId: string | null;
  productIds: string[];
  campaignId: string | null;
  /** The template it was made from (the component set's key, local or library) and the variant's Format value */
  template: { key: string; variant: string } | null;
  /** Carousels and documents: one frame per slide, all sharing `group.id`; the caption lives on index 0 */
  group: { id: string; index: number } | null;
  caption: string;
  hashtags: string[];          // without "#", in order
  altText: string;
  status: PostStatus;          // "draft" | "reviewed" | "approved" | "exported"
  /** The last review's problems on this post (pins, §6.5); cleared when fixed or left */
  problems: PostProblem[];
  exportedAt: number | null;
}
```

The post's status is ours and separate from the owner's frame status (`designer.workflow`): a post may carry both.

### 3.2 A campaign

A row of posts. Stored on the page (CANVAS node) in `pluginData` `designer.social` / `campaigns`: `SocialCampaign[]` (`{id, name, brandId, created}`). A post's `campaignId` names one; a post without one sits in "No campaign". The board's layout (§6.4) places a campaign's posts in one row; the row is a reading of positions, not stored.

### 3.3 Templates and slots

On the template's **component set** (or a lone component): `designer.social` / `template`:

```ts
interface SocialTemplateData {
  v: 1;
  name: string;
  /** Format variant value → catalogue format id ("Instagram post" → "instagram.post") */
  formats: Record<string, string>;
  animated: boolean;
  /** Platforms it was made for (the gallery's filter) */
  platforms: Platform[];
  /** "starter" (made by the agent's starter brief, §4.2) | "owner" */
  origin: "starter" | "owner";
}
```

On each slot layer inside a variant: `designer.social` / `slot`:

```ts
interface TemplateSlotData {
  v: 1;
  role: SlotRole;   // "logo" | "picture" | "headline" | "body" | "cta" | "label" | "accent" | "background"
  /** The component property that drives it (TEXT slots: its TEXT property's name, "Headline#12:0") */
  property: string | null;
  /** The template's author says this must not change in a post (Buzz's idea of locked content [ours]; enforced by Social's controls and the agent's tools, not by the engine) */
  locked: boolean;
  /** Text slots: the most characters that fit, for the agent's copy */
  maxChars: number | null;
}
```

How each role is wired (checked by `save_as_template` / "Save as template", §4.4, which refuses with the role's message when the wiring is missing):

| Role | Layer | Wired to | Filled by |
|---|---|---|---|
| `headline`, `body`, `cta`, `label` | TEXT | a TEXT component property (`property`); font family bound to `Font/Heading` or `Font/Body` | `fill_slots` → the instance's property value |
| `logo` | INSTANCE of the Brands library's **Logo** set | its `Brand` variant | the brand (§4.1) |
| `picture` | any shape or frame | an IMAGE fill, scale mode FILL | a product picture, an image route's result, `place_image` |
| `accent`, `background` | any shape or frame | a fill bound to a `Color/*` variable of the Brand collection | the brand (mode) |

### 3.4 Brands library

The generated file "Brands" (§4.1) carries `designer.social` / `brandLibrary` on its DOCUMENT node: `{v: 1, generatedFrom: Record<brandId, number /* Brand.updated */>}` — how the file knows which brands changed since it was generated.

### 3.5 Library index

`LibraryAsset` (`shared/store/types.ts`) gains `social?: { template: SocialTemplateData }`, filled at publish for a component set (or component) carrying the template marker, so the gallery lists library templates without fetching payloads. Stores and the multiplayer server keep the field as they keep the others (18b checks the server's manifest validator passes it through).

## 4. Templates and the Brands library

### 4.1 Brands library generation

**Brands panel › "Create brands library"** (no brand has a `libraryFileKey`) or **"Update brands library"** (it exists):
1. Create: `workspace.createFile({name: "Brands", folderId: null})` (Drafts), every brand saved with `libraryFileKey` = its key (`BrandsRepository.saveBrand`), then `nav:open-file` (`src/shared/ipc.ts`) brings it in front. Update: `nav:open-file` on the existing key.
2. An editor view whose document carries the `brandLibrary` marker — or whose key is a brand's `libraryFileKey` and whose document is empty — shows a **Banner** (`ds/components/Banner.tsx`) over the canvas: "Brands library · ‹n› brands changed" with **Update** and **Publish…**. On an empty new file Update runs at once, then the Publish dialog opens (`PublishDialog.tsx`, Figma's flow; the owner presses Publish).
3. **Update** (`editor/social/templates/brandLibrary.ts`, one undo step "Update brands library"), idempotent, by names:
   - Collection **Brand**, one mode per brand (named as the brand; a removed brand's mode is deleted). COLOR variables `Color/Primary`, `Color/Secondary`, `Color/Accent`, `Color/Background`, `Color/Text`, `Color/On primary` from `Brand.colors` — matched by name (case and accents folded, as `BrandsRepository.find` folds), else in list order; `Color/On primary` is white or near-black, whichever contrasts more with Primary (WCAG ratio); a brand's other colours become `Color/‹name›` (other modes get the brand's Primary). STRING variables `Font/Heading` = `Brand.fonts[0]`, `Font/Body` = `Brand.fonts[1] ?? fonts[0]` (Inter when empty).
   - Text styles **Heading** (64/1.1, 700), **Body** (32/1.35, 400), **CTA** (36/1.2, 600) [sizes ours, for 1080-wide posts], their family bound to `Font/*` where the engine binds a style's font family; if it doesn't, templates bind on their text layers (§3.3) and the styles take the default mode's family.
   - Page "Logos": component set **Logo**, variant property `Brand`, one component per brand holding its first `logo` picture (`BrandsRepository.image`) as an IMAGE fill at the picture's aspect, 400 px on the long side.
   - The marker's `generatedFrom` updated.
4. The library is enabled in a file the first time Social applies a template or a brand there (`LibraryRegistry.setEnabled`; a toast says "Brands library enabled") [ours]; Figma's update review handles every later change.

The manager calls the same function when a brand is created in the chat and the owner agrees (`ask_choice`), through `make_brand_library` (§7.2) — it opens the file in a background tab and returns when the banner's Update has run; publishing stays the owner's click.

### 4.2 Starter templates (proposed answer §12.4)

Made **in the app by the agent**, not shipped as a binary: **Templates › "Make starter templates…"** (left panel) sends the manager a fixed brief (`STARTER_BRIEF` in `src/shared/social/managerPrompt.ts`): a new file "Social templates" in Drafts; for Instagram and LinkedIn, the matrix of §4.2a; each a component set with a `Format` variant per format, slots wired per §3.3 against the enabled Brands library; animated ones with Motion presets; then `save_as_template` on each and the Publish dialog for the owner. The owner reviews them on the canvas before publishing; nothing is published by the agent.

**§4.2a matrix** (names [ours]): Product hero (static: picture, headline, label, logo) · Product hero (animated: picture scale-in, headline TextStagger, logo fade at the end) · Quote / statement (static: background, headline, body, logo) · Announcement (static: headline, body, CTA, picture) · Carousel cover + slide (static) · Story / Reel (animated, 9:16 only: picture, headline, CTA). Formats per set: `instagram.post`, `instagram.square`, `instagram.story` (animated sets also `instagram.reel`), `linkedin.landscape`, `linkedin.square`, `linkedin.portrait`.

### 4.3 Templates gallery (left panel, §6.2)

Lists the current file's local template sets and every enabled library's (`LibraryAsset.social`), filtered by **platform**, **format**, **Static / Animated** and **brand** (a template fits a brand when its file has the Brands library enabled). Previews: the assets' thumbnails (`panels/libraries/Thumbs.tsx`). Click inserts the variant for the picked format (default: the first) as a post (`newPost` with `template`), bound to the picked brand (mode + logo variant) and, when a product is picked in the Post section, its first packshot in the picture slot; drag inserts it where dropped. A library template is imported as Figma imports a library component (an instance of the remote component).

### 4.4 Save as template

Post frame's context menu and Post section › **Save as template…** (dialog `SaveAsTemplateDialog.tsx`): name, platforms, which formats; it converts the frame to a component (Figma's Create component), wraps it in a component set with a `Format` variant (the post's format name), tags the slots it can infer (texts → headline / body / cta by size and order; the logo instance; the picture-filled layer; brand-bound fills) and shows them for the owner to correct; refuses with the missing wiring named (§3.3). The agent offers it after drawing a post without a template (§7.1).

### 4.5 Table view and bulk create (Buzz's model)

**Table** (toolbar Social slot, `social.table`): a panel docked along the bottom like Motion's timeline (`EditorApp.module.css`'s docking), `PostsTable.tsx`. One row per post of the page (campaign order): thumbnail, name, format, brand, the template's text slots (one column per role present: Headline, Body, CTA, Label), Caption, Hashtags, Alt text, Status. Cells edit in place through `actions.ts` (a text slot through its component property; one undo step per cell). Row click selects the post. **Import CSV…**: a header row names columns (`headline`, `body`, `cta`, `label`, `caption`, `hashtags`, `alt`, `product`, `brand`, case-insensitive); the dialog picks a template, formats and campaign; one post per row × format, placed as a new campaign row. ≤ 500 rows. The agent fills the table through `fill_slots` / `set_post` ("write five variations of the headline").

## 5. Formats (`src/shared/social/formats.ts`)

### 5.1 Shape

```ts
type Platform = "instagram" | "linkedin" | "facebook" | "x" | "tiktok" | "youtube" | "pinterest";
type PostKind = "image" | "carousel" | "document" | "video" | "thumbnail";
interface Insets { top: number; right: number; bottom: number; left: number }   // px at the format's size
interface CaptionLimits {
  max: number;
  /** How the platform counts: graphemes (Intl.Segmenter), UTF-16 code units */
  unit: "grapheme" | "utf16";
  /** Characters shown before "… more" (feed) */
  fold?: number;
  hashtags?: number;
  mentions?: number;
  /** A separate title field (YouTube, Pinterest, TikTok photo) */
  title?: number;
}
interface VideoLimits { minSec: number; maxSec: number; fps: [number, number]; codecs: ("h264" | "hevc" | "vp8" | "vp9")[]; containers: ("mp4" | "mov" | "webm")[]; maxMB: number; maxMbps?: number }
interface ImageLimits { maxMB: number; types: ("jpeg" | "png" | "webp" | "gif")[] }
interface PlatformFormat extends SocialFormat {   // SocialFormat: {id, name, width, height} (studio/types.ts)
  platform: Platform;
  kind: PostKind;
  /** "4:5" */
  aspect: string;
  /** What the platform's UI covers (0 where it covers nothing) */
  safeArea: Insets;
  caption: CaptionLimits;
  image?: ImageLimits;
  video?: VideoLimits;
  /** Carousels / documents: slides */
  items?: { min: number; max: number };
  tier: "first" | "catalogue";
  /** Keys of SOCIAL_SOURCES */
  sources: string[];
  /** Field paths not confirmed by an official page ("caption.fold", "safeArea") */
  unverified: string[];
}
```

`formatById(id)`, `formatsFor(platform)`, `nearestFormat(width, height, platform?)`, `captionCount(text, unit)` and `parseHashtags(text)` live beside it (`src/shared/social/caption.ts`).

### 5.2 The catalogue

Safe areas as px at the format's size (Meta's percentages rounded). "—" = no limit known; [u] = unverified (in `unverified`).

| id | Name | Size | Kind | Safe area (t / r / b / l) | Caption | Image | Video |
|---|---|---|---|---|---|---|---|
| `instagram.post` | Instagram post | 1080 × 1350 (4:5) | image | 0 | 2 200 graphemes; fold 125 [u]; 30 hashtags; 20 mentions | JPEG ≤ 8 MB, width 320–1440, aspect 4:5 … 1.91:1 | — |
| `instagram.square` | Instagram square | 1080 × 1080 | image | 0 | as post | as post | — |
| `instagram.landscape` | Instagram landscape | 1080 × 566 (1.91:1) | image | 0 | as post | as post | — |
| `instagram.carousel` | Instagram carousel | 1080 × 1350 × 2–10 | carousel | 0 | as post (one caption) | as post | slides may be videos (Reel limits) |
| `instagram.story` | Instagram story | 1080 × 1920 (9:16) | image / video | 269 / 65 / 672 / 65 | — | JPEG ≤ 8 MB | 3–60 s, 23–60 fps, H.264 / HEVC, MP4 / MOV, ≤ 100 MB, ≤ 25 Mbps, AAC ≤ 48 kHz |
| `instagram.reel` | Instagram reel | 1080 × 1920 | video | 269 / 65 / 672 / 65 | as post | — | 3 s–15 min, 23–60 fps, H.264 / HEVC, MP4 / MOV, ≤ 300 MB, ≤ 25 Mbps |
| `linkedin.landscape` | LinkedIn landscape | 1200 × 628 (1.91:1) | image | 0 | 3 000; fold 150 (LinkedIn's ads guidance; organic fold [u]); hashtags — [u] | JPG / PNG / GIF ≤ 5 MB, ≤ 7680 × 4320 | — |
| `linkedin.square` | LinkedIn square | 1200 × 1200 | image | 0 | as landscape | as landscape | — |
| `linkedin.portrait` | LinkedIn portrait | 1080 × 1350 (4:5; LinkedIn recommends 720 × 900 — our size is 1.5× [ours]) | image | 0 | as landscape | as landscape | — |
| `linkedin.document` | LinkedIn document | 1080 × 1350 × 1–300 | document | 0 | as landscape | PDF ≤ 100 MB, ≤ 300 pages | — |
| `linkedin.video` | LinkedIn video | 1080 × 1350 | video | 0 | as landscape | — | 3 s–15 min, 10–60 fps, MP4 / MOV / WebM …, 75 KB–5 GB, 192 kbps–30 Mbps, aspect 1:2.4 … 2.4:1, 256 × 144 … 4096 × 2304 |
| `linkedin.video-vertical` | LinkedIn vertical video | 1080 × 1920 | video | 0 [u] | as landscape | — | as video |
| `facebook.post` | Facebook post | 1080 × 1350 (4:5; Meta's feed ad spec says 1440 × 1800) | image | 0 | — [u] | JPG / PNG ≤ 30 MB (ads) | — |
| `facebook.story` | Facebook story | 1080 × 1920 | image / video | 250 / 0 / 340 / 0 | — | as post | 1 s–3 min (ads), ≤ 4 GB |
| `x.image` | X image | 1600 × 900 (16:9) [u] | image | 0 | 280 [u] | JPG / PNG / GIF / WebP ≤ 5 MB; GIF ≤ 15 MB, ≤ 1280 × 1080, ≤ 350 frames | — |
| `x.video` | X video | 1280 × 720 | video | 0 | 280 [u] | — | 0.5 s–20 min (longer for Premium), ≤ 60 fps, H.264 High, AAC LC, ≤ 8 GB, 32 × 32 … 1280 × 1024, aspect 1:3 … 3:1 |
| `tiktok.video` | TikTok video | 1080 × 1920 | video | safe area [u]: 269 / 65 / 672 / 65 (Meta's Reels zones used until TikTok publishes its own) | 2 200 UTF-16 | — | ≤ 10 min (API; the app trims to the account's limit), 23–60 fps, H.264 / H.265 / VP8 / VP9, MP4 / WebM / MOV, ≤ 4 GB, 360–4096 px |
| `tiktok.photo` | TikTok photo | 1080 × 1920 | carousel | 0 [u] | title 90, description 4 000 UTF-16 | JPEG / WebP ≤ 20 MB, ≤ 1080p; ≤ 35 photos | — |
| `youtube.thumbnail` | YouTube thumbnail | 1280 × 720 (16:9; YouTube recommends 3840 × 2160, min width 640) | thumbnail | 0 | title 100, description 5 000; hashtags 60 (more: all ignored) | JPG / PNG ≤ 2 MB (mobile; 50 MB desktop) | — |
| `youtube.short` | YouTube Short | 1080 × 1920 | video | safe area [u]: 269 / 65 / 672 / 65 | as thumbnail | — | ≤ 3 min, square or vertical; codec / fps [u] (H.264, 24–60 fps assumed) |
| `pinterest.pin` | Pinterest pin | 1000 × 1500 (2:3) | image | 0 | title 100 (40 shown), description 800 | PNG / JPEG ≤ 20 MB | — |
| `pinterest.video` | Pinterest video pin | 1000 × 1500 | video | 0 | as pin | — | 4 s–15 min, H.264 / H.265, MP4 / MOV / M4V, ≤ 2 GB, aspect between 1:2 and 1.91:1 |

The plan's sizes that changed against the official pages: LinkedIn landscape 1200 × 627 → **1200 × 628**, LinkedIn square 1080 × 1080 → **1200 × 1200** (LinkedIn's recommended pixels), YouTube thumbnail stays 1280 × 720 but YouTube now recommends 3840 × 2160 (the preset exports at 3×, §8).

Where a limit comes from an ads page (Meta's safe zones, LinkedIn's fold, Facebook's sizes), it is the platform's own published guidance applied to organic posts [ours]; Meta states its safe zones for ads, and no platform publishes organic ones.

### 5.3 Sources (accessed 2026-10-18)

| Key | Page | Confirms |
|---|---|---|
| `ig-api-media` | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | IG image JPEG ≤ 8 MB, width 320–1440, 4:5 … 1.91:1, sRGB; Reels MOV/MP4, HEVC/H.264, AAC ≤ 48 kHz, 23–60 fps, ≤ 1920 wide, 3 s–15 min, ≤ 300 MB, ≤ 25 Mbps; Story video 3–60 s, ≤ 100 MB; carousel ≤ 10; caption 2 200, 30 hashtags, 20 mentions |
| `meta-reels-image` | https://www.facebook.com/business/ads-guide/update/image/instagram-reels | Reels 9:16, 1440 × 2560, safe zone ~14 % top, ~35 % bottom, ~6 % sides |
| `meta-ig-story-video` | https://en-gb.facebook.com/business/ads-guide/update/video/instagram-story | IG Stories 9:16, 14 % / 35 % / 6 % |
| `meta-fb-story-video` | https://www.facebook.com/business/ads-guide/update/video/facebook-story | FB Stories 9:16, 1 s–3 min, ≤ 4 GB, ~14 % (250 px) top, ~20 % (340 px) bottom |
| `meta-fb-feed-image` | https://www.facebook.com/business/ads-guide/update/image | FB feed 4:5, 1440 × 1800, JPG / PNG ≤ 30 MB |
| `li-video` | https://www.linkedin.com/help/linkedin/answer/a548372 | LinkedIn video 75 KB–5 GB, 3 s–15 min, 256 × 144–4096 × 2304, 1:2.4–2.4:1, 10–60 fps, 192 kbps–30 Mbps, formats |
| `li-image-ads` | https://www.linkedin.com/help/lms/answer/a426534 | 1200 × 628, 1200 × 1200, 720 × 900 (4:5), ≤ 7680 × 4320, JPG / PNG / GIF ≤ 5 MB; 150 characters before truncation, 3 000 max |
| `li-document` | https://www.linkedin.com/help/linkedin/answer/97459 | documents ≤ 100 MB, ≤ 300 pages, PPT / PPTX / DOC / DOCX / PDF |
| `li-post` | https://www.linkedin.com/help/linkedin/answer/a528176 | posts ≤ 3 000 characters |
| `x-media` | https://docs.x.com/x-api/media/quickstart/best-practices | images ≤ 5 MB, GIF limits, video limits |
| `tt-media` | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide | TikTok video and photo restrictions |
| `tt-video-post` | https://developers.tiktok.com/doc/content-posting-api-reference-direct-post | caption ≤ 2 200 UTF-16 runes |
| `tt-photo-post` | https://developers.tiktok.com/doc/content-posting-api-reference-photo-post | photo title 90, description 4 000, ≤ 35 photos |
| `yt-thumbnail` | https://support.google.com/youtube/answer/72431 | thumbnails 3840 × 2160 recommended, min 640 wide, 16:9, JPG / PNG, 2 MB mobile / 50 MB desktop |
| `yt-shorts` | https://support.google.com/youtube/answer/15424877 | Shorts up to 3 minutes, square or vertical |
| `yt-hashtags` | https://support.google.com/youtube/answer/6390658 | > 60 hashtags: all ignored; 3 shown by the title |
| `yt-title` | https://support.google.com/youtube/answer/57407 | title 100, description 5 000 |
| `pin-specs` | https://help.pinterest.com/en/business/article/pinterest-product-specs | 2:3, 1000 × 1500, ≤ 20 MB; video 4 s–15 min, ≤ 2 GB, H.264 / H.265; title 100 (40 shown), description 800 |

**Not verified** (marked [u] in the table and listed in each entry's `unverified`): Instagram's caption fold (~125), LinkedIn's organic "see more" fold and any hashtag limit, Facebook's organic caption limit, X's image size (1600 × 900; Figma's Twitter post preset is 1200 × 675) and its 280-character post limit (help.x.com refused the fetch), TikTok's and YouTube Shorts' safe areas (no official numbers; Meta's Reels zones stand in), YouTube Shorts' codec and frame rate, LinkedIn vertical video's safe area. Instagram's 3:4 (1080 × 1440) feed format is not in the catalogue: the content publishing API still says 4:5 … 1.91:1.

## 6. The chrome (18a)

### 6.1 Layout when the mode switches to Social

All metrics [ours], from DS tokens (`--ds-space-*`, `ds/tokens.ts` text styles; colours only `--figma-color-*`).

```
┌ rail ┬ left panel (Posts) ─────────┬────────── canvas: the board ──────────┬ right panel: Agent ─────┐
│ Posts│ Brand ▾  Partner Agro      │  Campaign "Liq Humus — October"        │ [Agent | Properties]    │
│ File │ ─────────────────────────  │  ┌ Post 1080×1350 ┐ ┌ Story 9:16 ┐    │ Chat (manager)          │
│ Assets│ Posts            + New    │  │                │ │            │     │ ▸ brief / task cards    │
│ Brands│ ▾ Liq Humus — October     │  │  (frame)       │ │            │     │ ▸ review card           │
│ Tools│   ▣ Post v1  ✓             │  └────────────────┘ └────────────┘     │ composer + model ⟳ ▶   │
│      │   ▣ Story v1 ▶ ●           │  ┌ LinkedIn 1200×628 ┐                 │ ─────────────────────   │
│      │ ─────────────────────────  │  └───────────────────┘                 │ ▸ Post (collapsed)      │
│      │ ▸ Templates [gallery]     │   [toolbar: Design + Draw tools · Social]│ ▸ Design (collapsed)    │
└──────┴───────────────────────────┴──────────── timeline (Motion, when the selected post animates) ─────┘
```

`EditorApp.tsx`: `LeftSide` mounts `SocialLeftPanel` when `mode === "social"` and the rail's tab is `posts`; `RightSide` mounts `SocialRightPanel`; `CanvasLayers` adds `SafeAreaOverlay` and `ReviewPins`; `Overlays` keeps `<MotionMode />` (it shows the timeline in Social when the selected post has a timeline — `editor/motion/MotionMode.tsx` reads `mode === "motion" || (mode === "social" && hasTimeline)`) and adds `PostsTable` and `BrandLibraryBanner`.

**Easing, 2026-10-19** (`docs/motion.md` §6.14): a segment clicked on Social's timeline no longer opens the floating Easing popover. It selects the segment (⇧ adds) and its layer as in Motion, brings the right panel's **Properties** tab forward (`ui.socialRightTab`), and the Design part shows the segment's **Easing page** (Back, the preset select and its presets popover, Curve | Spring, the graph, Bezier + Flip curve or Bounce; several segments → Mixed; one undo step per change). Social's Design part has no Audio section under it. Image: `docs/research/figma/live/owner-2026-10-19/after/easing-social.png`.

### 6.2 Left panel (`editor/social/SocialLeftPanel.tsx` + `.module.css`)

- **Rail**: `RailTab` gains `"posts"` (icon `24.social`), first and selected when Social opens; **Agents** is hidden in Social (the agent is on the right); File, Assets, Brands, Tools unchanged (Layers and Pages through File, as in Design).
- **Brand picker** (`BrandPicker.tsx`, ds `Select`): the brands of `BrandsRepository.list()`, "No brand", a separator, **Manage brands…** (opens the Brands tab). The pick is the board's current brand (`ui.socialBrandId`, kept per file in `FileUiState`); new posts and inserted templates take it.
- **Posts** (`PostsList.tsx`): the page's posts grouped by campaign (`SocialCampaign` order, then "No campaign"), each group a disclosure with its name (double-click renames) and post count; each row 32 px: thumbnail (24 px, the frame's image from the engine's thumbnail path the Layers panel uses), name, format name, the platform glyph, and one state glyph — ✓ reviewed / approved, ⚠ problems (count), ● draft, ⇩ exported; ▶ when animated. Context menu: Resize to ›, Duplicate for › (formats), Move to campaign ›, Ask agent…, Save as template…, Export…, Delete. Selecting a row selects the frame and zooms to it (`applySelection(ed, [id], true)` from `mcpTools.ts`); ⇧ / ⌘ extend. **+ New** opens the New post menu (§6.6).
- **Templates** (`templates/TemplatesGallery.tsx`, 18b; collapsible, closed by default when the page has posts).

### 6.3 Right panel (`editor/social/SocialRightPanel.tsx` + `.module.css`) — proposed answer §12.1

- A ds `SegmentedControl` at the top: **Agent | Properties**. **Agent** (default): the existing `AgentsPanel` full height (moved, not copied — `AgentsPanel` takes `placement: "left" | "right"`; one instance mounts at a time), then two `PanelSection`s collapsed under the composer: **Post** (§6.5) and **Design** (`DesignPanel`, the selection's sections). **Properties**: Post then Design expanded, the chat hidden; a badge on "Agent" counts unread manager messages and running tasks.
- Width: `ui.socialRightWidth`, default 320 [ours], resizable with ds `ResizeHandle` (240–560); Design mode's `rightWidth` is untouched.
- The chat's context chips show the selected posts (as layers are shown today), with their format.

### 6.4 Canvas: the board

- **Placement** (`editor/social/board.ts`): a new post goes to the right of its campaign's row (gap 120 px [ours]); a new campaign's row goes 240 px under the page's lowest post row, left-aligned with the first row; Studio's `StudioChatData.rows` (make_posts) uses the same function. Frames the owner draws elsewhere are left alone.
- **Safe areas** (`SafeAreaOverlay.tsx`, DOM over the canvas like `AgentImagePlaceholders`, placed from `ed.store.camera`, no React render per camera change; on by default in Social, toolbar toggle `social.toggle-safe-areas`, `ui.socialSafeAreas`): for each visible post whose format has a non-zero `safeArea`, the covered bands filled `--figma-color-bg-warning-tertiary` at 50 % opacity with a 1 px dashed `--figma-color-border-warning` edge; hidden while the canvas zooms (as the comments' pins are) and below 8 px band height on screen.
- **Review pins** (`ReviewPins.tsx`, the comments' pin shape from `comments/CommentsLayer.tsx`, colour `--figma-color-bg-warning`, number in `--figma-color-icon-onwarning`): one per `PostProblem` with a box, at the box's top-left; hover shows the detail (ds tooltip); click selects the problem in the review card (opens the Agent tab) and the post. Pins leave when the problem is cleared (§7.3).
- **Empty state** (`EmptyBoard.tsx`): no posts on the page → a centred card in the canvas: "Tell the agent what to make", three example prompts (clicking one fills the composer), the brand picker, **Start from a template** (opens the gallery); the composer takes focus.
- Frame titles unchanged (no engine change): the platform shows in the Posts list and the Post section.

### 6.5 Post section (`editor/social/PostSection.tsx` + `.module.css`)

For one selected post (several: the fields they share, mixed shown as Figma's "Mixed"):
- **Platform** and **Format** (two ds `Select`s; changing the format runs `resizePost`, §6.7), **Brand** (as the picker), **Product** (the brand's products; picking one fills the picture slot with its first packshot), **Template** (swap to another set's same-format variant; "None").
- **Caption** (multi-line field; a counter "1 234 / 2 200" in the format's unit — `--figma-color-text-danger` past `max`, a dashed rule at `fold`), **Hashtags** (chips; typing `#` or space commits; count against `hashtags`), **Alt text**.
- **Status** (Draft / Reviewed / Approved / Exported), **Campaign**.
- **Problems** (when any): the list, each with **Fix** (asks the manager, §7.3) and **Leave**.
- **Ask agent…**: puts "About ‹post name›: " in the composer with the post as context and switches to the Agent tab.
- With a slot layer selected inside a post: its **role**, **locked**, the property it drives, and — for text — its character count against `maxChars`.

Every field writes through `actions.ts` (§6.7), one undo step each.

### 6.6 Toolbar, menus and commands

`EditorToolbar` in Social shows Design's tool groups (Draw's when the owner picks a Draw tool from the slot menus — the same `TOOL_GROUPS` / `DRAW_TOOL_GROUPS`; nothing new to learn) and a **Social** slot [ours] after them: **New post** (menu: platform › format, each with its size; then the brand's own formats), **Safe areas** (toggle), **Table** (toggle). Commands (`COMMANDS`, labels through `t`):

| id | Label | Keys |
|---|---|---|
| `view.mode-social` | Social | — (Figma's ⇧D stays Dev Mode's) |
| `social.new-post` | New post… | — |
| `social.toggle-safe-areas` | Safe areas | — |
| `social.table` | Table | — |
| `social.save-as-template` | Save as template… | — |
| `social.export-campaign` | Export campaign… | — |
| `social.ask-agent` | Ask agent… | — |

The canvas context menu on a post adds Resize to ›, Duplicate for ›, Save as template…, Export…; the main menu's View gets "Safe areas" while in Social.

### 6.7 Actions (`editor/social/actions.ts`; the one implementation behind the chrome and the tools)

```ts
type Writer = <T>(label: string, fn: () => T) => T;
newPost(ed, w, {formatId, name?, brandId?, campaignId?, template?: {key, variant?}, productId?, at?: {x, y}}): Guid
setPost(ed, w, ids, patch: Partial<Pick<SocialPostData, "brandId" | "productIds" | "campaignId" | "caption" | "hashtags" | "altText" | "status">>): void
resizePost(ed, w, ids, formatId, {duplicate}): Guid[]      // template variant swap when it has one, else resize + responsive re-layout (agents/responsive.ts)
applyTemplate(ed, w, ids, {key, variant?, brandId?, productId?}): Guid[]   // swaps an instance's component, or replaces a plain frame by an instance at its place (its texts carried to the slots by role)
fillSlots(ed, w, id, values: Partial<Record<SlotRole, string>>, picture?: ImageArg): void
applyBrand(ed, w, ids, brandId): void                        // Brand collection mode + Logo variant
setCampaign(ed, w, page, campaign: SocialCampaign | {id, remove: true}): void
saveAsTemplate(ed, w, id, opts): {key: string} | {error: string}
checkPosts(ed, ids): PostProblem[]                          // deterministic limits, §7.3
```

## 7. The agent in Social (18c)

### 7.1 What the manager does

The manager (`docs/studio.md` §2) with Social's paragraph knows the board, the brand, the templates and the platform rules. Beyond Studio's loop:
- **Reads the board**: `get_board` first in every Social turn.
- **Makes posts from a sentence** ("Liq Humus için bu hafta Instagram post + story, LinkedIn de olsun"): brief card → `make_posts` with catalogue format ids, a template (from `list_templates`; none fits → the worker draws the frame as today and the manager offers `save_as_template`), captions on → image tasks + template tasks (`new_post` with the template, `fill_slots`) + a caption pass + review.
- **Writes the words**: caption, hashtags, alt text in the brand's `tone` and the format's `caption` limits, Turkish and English (`set_post`).
- **Resizes and adapts**: `resize_post` ("make the LinkedIn version": `duplicate: true`), then `check_posts`.
- **Animates** ("6 saniyelik Reels yap"): `resize_post {formatId: "instagram.reel", duplicate: true}` → `set_timeline {duration: 6}` → `add_animation` / `apply_animation_style` (Motion's tools as built) → `check_posts` (duration within the format) → on request `export_posts`.
- **Reviews and fixes**: Studio's `review` / `report_review` with Social's kinds (§7.3); problems become pins and the review card; "Fix selected" runs the fix loop.
- **Suggests** [ours]: after a review passes, one `ask_choice` with at most three follow-ups ("Story's animated version?", "LinkedIn carousel from these three?") — choice chips, never tasks started unasked.
- **Exports** on request: `export_posts`.

### 7.2 Tools

Social's canvas tools join `TOOLS` (every session: manager, workers, outside clients), in a `// Social (docs/social.md §7.2, round 18)` group after Motion's; run by `editor/agents/socialTools.ts`, dispatched from `runTool` in `mcpTools.ts` as `motionTools.ts` is. Each write is one `env.write` transaction. Ids as the other tools (`"123:456"`; writes never fall back to the selection — `WRITE_IDS`).

```ts
{ name: "get_board", write: false, inputSchema: { type: "object", properties: {
    pageId: { type: "string" } } } }
// → {brand: {id, name} | null, campaigns: [{id, name, brandId, posts: [{nodeId, name, formatId, format: {name, width, height, platform}, brandId, productIds, template, group, status, caption, hashtags, altText, animated, durationSec, problems, duplicateOf?}]}], unplaced: [...] }

{ name: "list_formats", write: false, inputSchema: { type: "object", properties: {
    platform: { enum: ["instagram", "linkedin", "facebook", "x", "tiktok", "youtube", "pinterest"] },
    brandId: { type: "string", description: "Adds the brand's own sizes" } } } }

{ name: "list_templates", write: false, inputSchema: { type: "object", properties: {
    platform: { type: "string" }, formatId: { type: "string" }, animated: { type: "boolean" } } } }
// → [{key, name, source: "local" | <library name>, formats: {variant: formatId}, animated, slots: [{role, property, locked, maxChars}]}]

{ name: "new_post", write: true, inputSchema: { type: "object", properties: {
    formatId: { type: "string" }, name: { type: "string" },
    brandId: { type: "string" }, productId: { type: "string" },
    campaignId: { type: "string" }, campaign: { type: "string", description: "A new campaign's name (instead of campaignId)" },
    templateKey: { type: "string" }, variant: { type: "string" },
    x: { type: "number" }, y: { type: "number" } }, required: ["formatId"] } }
// → {nodeId, campaignId, slots: [{role, nodeId, property}]}

{ name: "apply_template", write: true, inputSchema: { type: "object", properties: {
    nodeIds: writeIds, nodeId: writeId, templateKey: { type: "string" }, variant: { type: "string" },
    brandId: { type: "string" }, productId: { type: "string" } }, required: ["templateKey"] } }

{ name: "fill_slots", write: true, inputSchema: { type: "object", properties: {
    nodeId: { type: "string" },
    values: { type: "object", properties: { headline: { type: "string" }, body: { type: "string" }, cta: { type: "string" }, label: { type: "string" } } },
    picture: imageArg }, required: ["nodeId"] } }
// a locked slot is refused ("‹role› is locked in this template"); text over maxChars is written and reported

{ name: "set_post", write: true, inputSchema: { type: "object", properties: {
    nodeIds: writeIds, nodeId: writeId,
    brandId: { type: ["string", "null"] }, productIds: ids, campaignId: { type: ["string", "null"] },
    caption: { type: "string" }, hashtags: ids, altText: { type: "string" },
    status: { enum: ["draft", "reviewed", "approved", "exported"] },
    formatId: { type: "string", description: "Marks a frame as a post of this format (it isn't one yet); resizing is resize_post" } } } }
// → each post's caption count against its format ({count, max, fold, hashtags}) so the agent sees overruns at once

{ name: "resize_post", write: true, inputSchema: { type: "object", properties: {
    nodeIds: writeIds, nodeId: writeId, formatId: { type: "string" },
    duplicate: { type: "boolean", description: "Make a copy in the new format next to it (default false)" } }, required: ["formatId"] } }

{ name: "set_campaign", write: true, inputSchema: { type: "object", properties: {
    campaignId: { type: "string" }, name: { type: "string" }, brandId: { type: "string" }, remove: { type: "boolean" } } } }

{ name: "check_posts", write: false, inputSchema: { type: "object", properties: { nodeIds: ids } } }
// → [{nodeId, problems: PostProblem[]}] — caption / hashtag / mention counts, text and logo layers inside the safe area, video duration and fps against the format, a missing logo or more than one, text contrast over its backdrop (WCAG 4.5:1 for < 24 px, 3:1 above, sampled from the frame's render)

{ name: "save_as_template", write: true, inputSchema: { type: "object", properties: {
    nodeId: { type: "string" }, name: { type: "string" },
    slots: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, role: { type: "string" }, locked: { type: "boolean" }, maxChars: { type: "number" } }, required: ["nodeId", "role"] } } },
    required: ["nodeId", "name"] } }

{ name: "export_posts", write: false, inputSchema: { type: "object", properties: {
    nodeIds: ids, campaignId: { type: "string" },
    preset: { type: "string", description: "A preset id (§8), or \"auto\" (default): each post's own" },
    zip: { type: "boolean", description: "One zip (default when more than one file)" } } } }
// → files via ToolResult.files (saved in the chat's folder by src/main/agents/toolFiles.ts) + per post {file, bytes, warnings}
```

`export_posts` joins `WAITING_TOOLS` (30 min, as `export_animation`). Manager-only additions (`MANAGER_TOOLS`):
- `make_posts` gains `formats` accepting catalogue ids (Studio's brand format ids still work), `template?: string` (a template key), `captions?: boolean` (default true in Social), `campaign?: string` (name; default "‹Products› — ‹Month›"), `animate?: {seconds: number, style?: string}` (adds a Motion pass per video format). Its frame tasks use `new_post` / `fill_slots` when a template is given; `PostRecord` gains `nodeId`-based `formatId` as a catalogue id.
- `make_brand_library {}` → runs §4.1 (create or update), returns `{fileKey, brands}`; publishing stays the owner's.
- `report_review` items' problems take the new kinds (§7.3); in Social it also writes each problem into its post's `problems` (pins) and clears them on the owner's answer.

### 7.3 Review in Social

`ProblemKind` (`src/shared/studio/types.ts`) gains `"safe-area" | "caption" | "contrast" | "logo" | "video"`; `ReviewProblem.fix` gains `"rewrite"` (the manager rewrites the caption itself with `set_post`) and `"retime"` (`set_timeline` / clip edits). Mapping: `safe-area`, `contrast`, `logo` → `relayout`; `caption` → `rewrite`; `video` → `retime`. `PostProblem` = `ReviewProblem & {source: "review" | "check"}`; `check_posts` produces the deterministic ones, the manager's `review` the visual ones; both go into the same review card and pins. A problem is cleared from its post when its fix task ends done, when `check_posts` no longer finds it, or on Leave.

### 7.4 Social's prompt (`src/shared/social/managerPrompt.ts`)

`socialPrompt(ctx: SocialPromptContext)` → a paragraph appended by `managerPrompt` when `ManagerPromptContext.social` is set (the view sets it in Social): the board's brand and campaigns (names and counts only — `get_board` gives the rest), Instagram and LinkedIn first, "read the board first", "use a template when one fits; never draw over a template's locked slots", "captions within the format's limits, in the brand's tone, Turkish unless asked otherwise", "every video ≤ the format's length", "suggest at most one follow-up". `STARTER_BRIEF` (§4.2) lives here. Worker prompts get one line naming Social's tools.

## 8. Video and export presets (18d)

`src/shared/social/presets.ts`:

```ts
interface SocialExportPreset {
  id: string;
  label: string;
  formatIds: string[];
  still?: { format: "PNG" | "JPEG" | "PDF"; scale: number; quality?: number };
  animated?: AnimatedExportSettings;        // src/shared/motion/types.ts
  /** Checked after rendering: over → a warning on the file */
  maxMB?: number;
}
```

| id | Formats | Still | Animated | Checks |
|---|---|---|---|---|
| `instagram-image` | instagram.post / square / landscape / carousel / story (static) | JPEG, 1×, quality 0.92 | — | ≤ 8 MB, sRGB |
| `instagram-reel` | instagram.reel, instagram.story (animated) | — | MP4, 1080 × 1920, 30 fps, HIGH | duration vs format; ≤ 25 Mbps; ≤ 300 / 100 MB |
| `linkedin-image` | linkedin.landscape / square / portrait | PNG, 1× (JPEG 0.92 when the PNG is over 5 MB) | — | ≤ 5 MB |
| `linkedin-document` | linkedin.document | PDF of the group's frames in `index` order (Export frames to PDF's renderer) | — | ≤ 100 MB, ≤ 300 pages |
| `linkedin-video` | linkedin.video / video-vertical | — | MP4, format size, 30 fps, HIGH | 3 s–15 min |
| `vertical-video` | tiktok.video, youtube.short, facebook.story (animated) | — | MP4, 1080 × 1920, 30 fps, HIGH | duration vs format |
| `youtube-thumbnail` | youtube.thumbnail | JPEG, 3× (3840 × 2160), quality lowered in steps until ≤ 2 MB | — | ≤ 2 MB |
| `generic-image` | everything else static | PNG, 1× | — | format's `image.maxMB` |
| `generic-video` | everything else animated | — | MP4, format size, 30 fps, HIGH | format's `video` |

- **"auto"** picks per post: an animated post (has a timeline with content) → its format's animated preset, else its still preset.
- **Export…** on a post (and the Export campaign command) opens a small dialog (`editor/social/export/ExportPostsDialog.tsx`): the posts, each preset (changeable), file names "‹Campaign› / ‹post name› — ‹format›.‹ext›", **Export** → one file, or a zip (`zipStored`) of a campaign or a multi-selection, saved through `saveFiles`. Status of each exported post → `exported`, `exportedAt` set (one undo step).
- **Motion's Animated tab** (`panels/design/ExportAnimated.tsx`) gains a **Preset** menu above its fields for a post: picking one fills the fields from the preset (the fields stay editable, Figma's tab unchanged otherwise).
- **The timeline's Social header** (`editor/motion/timeline/`, a `header` slot prop the Social mount passes): the format's name and video limits next to Duration ("Instagram reel · 3 s – 15 min · 30 fps"), Duration in `--figma-color-text-danger` when outside them.
- Audio: Motion's audio clips as built (a music track per post, `add_audio`).
- Later, optional: clips from a video model as VIDEO fills (not in round 18).

## 9. Shared types — committed by the main session before 18a (they decide)

- `src/shared/social/types.ts`: `Platform`, `PostKind`, `Insets`, `CaptionLimits`, `VideoLimits`, `ImageLimits`, `PlatformFormat`, `PostStatus`, `SlotRole`, `SocialPostData`, `SocialCampaign`, `SocialTemplateData`, `TemplateSlotData`, `BrandLibraryMarker`, `PostProblem`, `SocialPromptContext`, `SocialExportPreset`, `SOCIAL_PLUGIN_ID = "designer.social"`, keys `SOCIAL_KEYS = {post: "post", campaigns: "campaigns", template: "template", slot: "slot", brandLibrary: "brandLibrary"}`, `readSocial<T>(entries, key)` / `withSocial(entries, key, value | null)` (pure; tolerant of bad JSON → null).
- `src/shared/social/formats.ts`: `SOCIAL_FORMATS` (§5.2, as data), `SOCIAL_SOURCES` (§5.3), `formatById`, `formatsFor`, `nearestFormat`, `brandFormatId`.
- `src/shared/social/caption.ts`: `captionCount`, `parseHashtags`, `captionReport(text, hashtags, format)`.
- `src/shared/social/presets.ts`: `SOCIAL_EXPORT_PRESETS` (§8) — data only; 18d writes the renderer side.
- `src/shared/studio/types.ts`: `ProblemKind` and `ReviewProblem.fix` extended (§7.3).
- `src/shared/store/types.ts`: `LibraryAsset.social?` (§3.5).
- `ds/components/EditorToolbar.tsx`: `EditorMode` gains `"social"` and `EDITOR_MODES` its entry (between Design and Motion), listed in `disabledModes` by `EditorApp` until 18a lands; `uiStore.ts`: `mode` and `RailTab` (`"posts"`) widened, `socialBrandId`, `socialSafeAreas`, `socialRightWidth`, `socialTable`; `ds/icons`: `24.social`.
- `plugins/api/nodes.ts`: `RESERVED_PLUGIN_IDS = new Set(["designer.workflow", "designer.social"])`.
- Stubs: `editor/social/actions.ts` (signatures of §6.7, each throwing "not built"), `editor/agents/socialTools.ts` (empty runner), `src/shared/social/managerPrompt.ts` (`socialPrompt` returning "").

## 10. Ownership and merge order

| Agent | Owns | Delivers | Verification |
|---|---|---|---|
| **18a shell** | `editor/social/` (except `templates/`, `export/`): `SocialMode.tsx`, `SocialLeftPanel.tsx`, `BrandPicker.tsx`, `PostsList.tsx`, `SocialRightPanel.tsx`, `PostSection.tsx`, `SafeAreaOverlay.tsx`, `ReviewPins.tsx`, `EmptyBoard.tsx`, `NewPostMenu.tsx`, `socialState.ts` (the posts index, kept from document changes), `posts.ts`, `board.ts`, `actions.ts` (all but `applyTemplate`, `fillSlots`, `saveAsTemplate`, `applyBrand`), their `.module.css`; `EditorApp.tsx` (the mounts), `EditorToolbar.tsx` (the Social slot), `panels/Rail.tsx` (`posts`, Agents hidden), `panels/agents/AgentsPanel.tsx` (`placement` prop only), `motion/MotionMode.tsx` (the Social condition only), `commands.ts` (the `social.*` / `view.mode-social` rows), `i18n/tr` entries for its strings | §1.1–1.4, §6 | Tests: `posts.ts` read / write keeps other pluginData entries and survives bad JSON; `socialState` lists posts by campaign after create / duplicate / delete / undo; `board.ts` placement (row right, new row under); `actions` each one undo step (wasm test on the committed engine); `captionCount` / `parseHashtags` (graphemes vs UTF-16, emoji, Turkish letters); dom tests: the mode switch mounts the Social panels and back; the Post section's counter turns red past `max`; safe-area bands at a camera zoom. Manual: `npm run dev:demo`, a Design file → Social → New post › Instagram › Story → safe areas drawn; Agent / Properties switch; Design mode unchanged |
| **18b templates** | `editor/social/templates/` (`brandLibrary.ts`, `templates.ts` — marker, slots, `applyTemplate`, `fillSlots`, `applyBrand`, `saveAsTemplate` —, `TemplatesGallery.tsx`, `SaveAsTemplateDialog.tsx`, `BrandLibraryBanner.tsx`, `PostsTable.tsx`, `csvImport.ts`, css); `editor/studio/BrandsPanel.tsx` (the Create / Update brands library button only); the publish path's `LibraryAsset.social` fill (`panels/libraries/PublishDialog.tsx` / its asset builder) and the server's manifest pass-through if needed (`server/`, that field only) | §3.3–3.5, §4 | Tests: brand library generation on two brands (collection, modes, variables by name and by order, contrast pick, Logo set variants), idempotent on a second run, a removed brand's mode removed; `saveAsTemplate` refusals per missing wiring; `applyTemplate` on a plain frame carries texts by role; `applyBrand` switches mode and logo variant and nothing else; CSV parser (quotes, commas, newlines in cells, BOM, ≤ 500 rows); the gallery's filters on local + library fixtures; one undo step per action. Manual: two brands → Create brands library → Publish → a second file → New post from a template → switch brand in the Post section: colours, fonts and logo change |
| **18c agent** | `src/shared/agents/tools.ts` (the Social group, `make_posts`' fields, `make_brand_library`, `WAITING_TOOLS`), `editor/agents/socialTools.ts`, `editor/agents/mcpTools.ts` (dispatch lines only), `editor/agents/managerTools.ts` (make_posts with templates / captions / animate, make_brand_library, Social review kinds and pins), `editor/agents/service.ts` (manager forced on for Social turns, `ManagerPromptContext.social`), `src/shared/social/managerPrompt.ts`, `src/shared/studio/managerPrompt.ts` (the hook), `panels/agents/StudioCards.tsx` (new kinds, suggestion chips), `actions.checkPosts` | §1.3, §7 | Tests: each tool on the committed wasm (`editor/__tests__/agentsSocial.wasm.test.ts`): new_post with and without a template, set_post counts, resize_post duplicate, fill_slots refusing a locked slot, check_posts finding a caption overrun / a text in a story's bottom band / a 20 s video on a 15 s format, a turn's writes one undo step; `make_posts` with a template on fakes for the library and images (`managerTools` tests' pattern); the Social paragraph present only in Social; worker sessions refuse `make_brand_library`. Manual: the owner's sentence ("Liq Humus için bu hafta Instagram post + story, LinkedIn de olsun") on the demo brand with a fake image route → posts on the board, captions set, review card with pins |
| **18d video** | `src/shared/social/presets.ts` (renderer side), `editor/social/export/` (`exportPosts.ts`, `ExportPostsDialog.tsx`), `panels/design/ExportAnimated.tsx` (Preset menu), `editor/motion/timeline/` (the `header` slot), `socialTools.ts`' `export_posts` body, the animated rows of `STARTER_BRIEF` | §8 | Tests: preset pick for a static / animated post; file names; zip of a campaign; the YouTube JPEG quality steps stay ≤ 2 MB on a noisy fixture; PDF of a 3-slide document in index order; size checks warn; `export_posts` returns `files`; the timeline header's limits and red Duration. Manual: a 6 s Reel from a template → Export → MP4 plays 1080 × 1920 at 30 fps with its audio |

**Merge order:** 18a → 18b → 18c → 18d. 18b and 18c can start together on the pre-round stubs (18c tests `apply_template` / `fill_slots` once 18b is merged; before that, on a fixture template). Each agent runs the affected suites (`npx vitest run <its folders>`) and `npm run typecheck`; the main session runs `npm run check` and `npm run engine:test` after the last merge (no wasm rebuild: no C++ changes).

**After the merge** (main session): the owner's flow end to end — Partner Agro's brands library created and published, "Make starter templates", then the sentence above with Nano Banana Pro, a review with a fix, the Reel animated and exported.

## 11. Order overall

Motion (round 8: done, `docs/motion.md` "Motion status") → this contract → the main session's pre-round commit (§9) → 18a → 18b ∥ 18c → 18d → the after-merge run.

## 12. Open questions for the owner — each with a proposed default (building starts on the defaults if he agrees)

1. **Right panel default in Social**: the Agent panel full height with Post / Design collapsed under it, or a two-pane split (chat above, properties below)?
   **Proposed — owner to confirm:** Agent full height with **Post** and **Design** collapsed under the composer, and an **Agent | Properties** switch at the top that gives the whole panel to properties when hand-editing (§6.3).
2. **Which platforms first?**
   **Proposed — owner to confirm:** **Instagram and LinkedIn** first (starter templates, export presets, the review's limit checks); Facebook, X, TikTok, YouTube and Pinterest as catalogue entries only — New post, safe areas and limits work, no starter templates (§1.9, §5.2).
3. **The Motion capture of `docs/motion.md` §12.1** — a sample `.fig` and a signed-in recording.
   **Proposed — owner to confirm:** **not blocking.** Motion is built to its contract and its [unverified] looks stay ours; the capture refines Motion's chrome whenever it comes, Social doesn't wait for it.
4. **Starter templates**: made by the agent in the app, or imported from a Figma file the owner designs?
   **Proposed — owner to confirm:** **made by the agent in the app** ("Make starter templates…", §4.2), reviewed by the owner on the canvas before he publishes them; a Figma file he designs can still be imported later (`.fig` import) and saved as templates with "Save as template".

## 13. As built — 18a, the shell (2026-10-18)

**Built on §12's proposed defaults, which stay pending the owner's confirmation.** Each is one place in the code: §12.1 (the right panel) is `SOCIAL_RIGHT_PANEL` in `editor/social/SocialRightPanel.tsx` (Agent tab first, Post and Design collapsed under the chat, 320 wide, 240–560); §12.2 (Instagram and LinkedIn first) is `FIRST_PLATFORMS` in `src/shared/social/formats.ts` (each format's `tier` follows it); §12.3 needs nothing; §12.4 (starter templates by the agent) is 18b / 18c's (`STARTER_BRIEF`).

**Pre-round commit (§9), on the same branch before 18a:** `src/shared/social/` — `types.ts` (every type of §9, `SOCIAL_PLUGIN_ID`, `SOCIAL_KEYS`, `readSocial` / `withSocial`; `CaptionLimits.max` 0 means "no caption or no limit known: nothing checked"), `formats.ts` (§5.2 as data with `SOCIAL_SOURCES`, the `unverified` fields, `formatById`, `formatsFor`, `nearestFormat`, `brandFormatId`, `parseBrandFormatId`, `resolveFormat`, `PLATFORMS`, `PLATFORM_NAMES`), `caption.ts` (`captionCount` by graphemes — `Intl.Segmenter` — or UTF-16, `parseHashtags`, `parseMentions`, `publishedText`: the caption then the hashtags on their own line, `captionReport`), `presets.ts` (§8 as data), `managerPrompt.ts` (stub); `ProblemKind` / `ReviewProblem.fix` widened (managerTools' `FIX_OF` maps the new kinds as §7.3 says); `LibraryAsset.social?`; `FileUiState.socialBrandId?`; `EditorMode` "social" in `EDITOR_MODES` between Design and Motion; `RESERVED_PLUGIN_IDS` in `plugins/api/nodes.ts` (both IDs hidden from plugins); icons `24.social`, `24.safe-area`, `24.table`; the `actions.ts` and `agents/socialTools.ts` stubs; Turkish names of the formats.

**18a:**
- **Mode.** `view.mode-social` (the switch's Social segment, View › Social) enters and leaves; `setMode` opens Social on its Posts tab and gives File back when leaving; the rail shows Posts only in Social and no Agents tab there. Switching is no undo step and changes nothing in the document (tested).
- **Posts index** (`socialState.ts`): the current page's top-level frames / instances / components carrying a post record, grouped by the page's campaigns then "No campaign", each post's place, size, `animated` (`motionTimeline(root)` has keyframes, presets, an animated instance or audio) and `duplicateOf` (a twin record from a plain ⌘D). Read once per change: any committed change, undo, page or structure change marks it stale.
- **Actions** (`actions.ts`): `newPost` (a white frame of the format's size named after it, its record, placed by `board.ts`; the page's first post goes right of its other layers), `setPost` (hashtags cleaned), `resizePost` (in place, or `duplicate`: the engine's Duplicate, placed at its campaign row's end, a fresh draft), `setCampaign` (add / rename / remove — removing moves its posts to "No campaign"), `leaveProblems`, `newCampaign`; `editorWriter(ed)` (the chrome's writer, `ed.batch`), `withinWrite` (actions inside another write), `canWritePosts` (viewers write nothing). Each is one undo step (tested on the committed wasm). `applyTemplate`, `fillSlots`, `applyBrand`, `saveAsTemplate`, `checkPosts` stay stubs for 18b / 18c; `newPost` with a template throws "not built".
- **Left panel** (`SocialLeftPanel.tsx`): Posts header with "+" (New post's menu), the brand picker (`BrandPicker.tsx`: brands, No brand, Manage brands… → the Brands tab; kept per file through `FileUiState.socialBrandId`, `SocialMode`), the Posts list (`PostsList.tsx`: campaigns as disclosures with counts, double-click renames; rows with the engine's 24 px thumbnail, name, format, a two-letter platform mark [ours: no platform logos], ▶ animated, one state glyph; click selects and zooms, ⇧ / ⌘ toggle; context menu Resize to ›, Duplicate for ›, Move to campaign › (New campaign makes one and renames it in place), Ask agent…, Save as template… / Export… (off), Delete), Templates (the gallery's place, closed once the page has posts).
- **Right panel** (`SocialRightPanel.tsx`): the header (account, Present, Share), Agent | Properties, the Agents panel full height (`AgentsPanel` gained `placement` and a `draft` the composer takes once — Ask agent…, the empty board's prompts), Post and Design collapsed under it; Properties: Post then Design, a badge counting running agent tasks.
- **Post section** (`PostSection.tsx`): Platform / Format (a change resizes), Brand, Product, Template (off until 18b), Caption with the counter in the format's unit (red past `max`, a bar with the fold's dashed mark), Hashtags as chips ("#", space, comma or Enter; ⌫ takes the last back; counted against the limit), Alt text, Status, Campaign, Problems (Fix puts "Fix on ‹post›: ‹detail›" in the composer; Leave clears it), Ask agent…; several posts: shared fields with Mixed, caption / hashtags / alt text for one post only; a slot layer inside a post shows its role, lock, property and characters (read-only until 18b writes slots).
- **Canvas**: `SafeAreaOverlay.tsx` (bands from the format's insets scaled to the frame, placed from the camera, hidden while zooming and under 8 px; toggle `social.toggle-safe-areas`, the toolbar's Safe areas, View menu in Social), `ReviewPins.tsx` (numbered warning pins at each problem's box; click selects the post and shows the Agent tab), `EmptyBoard.tsx` (the card with three example prompts, the brand picker, Start from a template; the composer takes the focus).
- **Toolbar** (`NewPostMenu.tsx`, `EditorToolbar`'s new `slot`): New post ▾ (platform › format with sizes, then the brand's own sizes), Safe areas, Table (off until 18b); `social.new-post` (⌘K) opens the same menu.
- **Motion**: `MotionMode` shows the timeline in Social while the selected post's timeline has content (`ui.socialTimeline`), and the engine's motion layer is on with it (`motionLayerOn` in `motion/motionState.ts`).
- **Commands**: `view.mode-social`, `social.new-post`, `social.toggle-safe-areas`, `social.table` (off), `social.save-as-template` (off), `social.export-campaign` (off), `social.ask-agent`; New post and Save as template are viewer-disabled.

**Beyond §10's file list** (small, each needed by the above): `devmode/devMode.ts` (the rail tab on mode changes, `syncEngine` exported), `motion/motionState.ts` (`motionLayerOn`), `keyboard.ts` (Social follows Design's shortcut table), `menus.ts` (View › Social, Safe areas), `canvas/BottomToolbar.tsx`, `uiStore.ts` (`socialRightTab`, `socialTimeline`, `socialDraft`, `socialNewPostMenu`, `socialTemplatesOpen`), `editor/documentSource.ts` (`socialBrandId`), `EditorApp.tsx` exports `LeftSide` / `RightSide` / `CanvasLayers` for the DOM tests.

**Tests:** `src/shared/social/social.test.ts` (the catalogue as §5.2, sources, tiers, `nearestFormat`, brand formats, presets covering the first platforms, graphemes vs UTF-16 with emoji / flags / Turkish letters / combining marks, hashtags and mentions, the caption report, plugin data keeping other entries and bad JSON); `editor/__tests__/social.wasm.test.ts` (records through pluginData with another plugin's entry kept and bad JSON, New post's size / name / one undo step, the index by campaign after create / duplicate / delete / undo / campaign removal, resize in place, twin records, the board's placement); `editor/__tests__/socialPanels.wasm.test.ts` (the mode switch mounting the Posts tab and the agent's panel and back, the Posts list, the caption counter red past 2 200, a story's bands at zoom 0.5 and 0.1, safe areas off). Visual check: `npm run web -- --mode demo` (`?editor`), headless Chromium — Social's empty board, New post › Instagram › Instagram story with its safe areas, the Post section, the Agent tab, back to Design.

**Not done in 18a (left for later rounds or a follow-up):**
- The canvas context menu's post rows (Resize to ›, Duplicate for ›, Save as template…, Export… on a post frame — §6.6); the Posts list has them.
- The chat's context chips showing the posts with their format (§6.3) — 18c with the agent's Social context.
- Brand and Product only write the record: the Brand collection's mode / Logo variant and the product's packshot in the picture slot are 18b's `applyBrand` / `fillSlots`; Template stays off until 18b.
- Problems' Fix drafts a message instead of running the manager's fix loop (18c); pins don't select the problem in a review card (18c).
- ⇧-click in the Posts list toggles like ⌘ (no range); no drag to reorder or to move between campaigns.
- Space doesn't play the timeline in Social (`motion.play-pause` is Motion's); the timeline's Social header is 18d's.
- The desktop app wasn't driven, and a view-only shared file wasn't tried (the write controls follow `canWritePosts`).

## 14. As built — 18c, the agent in Social (2026-10-18)

Built on 18a and §12's proposed defaults (still pending the owner's confirmation), before 18b and 18d: where their functions are stubs, the tools answer "not available yet" (below), and nothing else waits for them.

- **Tools** (`src/shared/agents/tools.ts`, the `// Social` group after Motion's, §7.2's schemas; `editor/agents/socialTools.ts`, dispatched first in `runTool`): `get_board` (the board's brand from the picker, campaigns with their posts, `unplaced`; each post's format, record, `animated`, `durationSec`, problems, `duplicateOf`), `list_formats` (the catalogue as data, `unverified` included; `brandId` adds the brand's own sizes as `brand:<id>:<format>`), `list_templates` (the file's component sets carrying the template marker with their tagged slots, and the enabled libraries' `LibraryAsset.social`; filters platform / format / animated), `new_post` (a new campaign by `campaign`, made after the post so a refused template leaves nothing), `apply_template`, `fill_slots` (locked slots refused by the slots' own tags before anything is written; over `maxChars` written and reported), `set_post` (caption / hashtags / mentions counted against the format in the answer; `formatId` makes a page's top-level frame a post), `resize_post`, `set_campaign` (add / rename / re-brand / remove), `check_posts` (§7.3, below), `save_as_template`, `export_posts`. Each write is one `env.write` with the actions run inside it (`withinWrite`), so a turn stays one undo step (tested). `export_posts` and `make_brand_library` join `WAITING_TOOLS`; main reads `fill_slots`' `picture.path` like `place_image`'s (`src/main/agents/imageArgs.ts`).
- **Not available yet (round 18b / 18d):** `apply_template`, `fill_slots`' write, `save_as_template`, `new_post` with `templateKey` (18b's `applyTemplate` / `fillSlots` / `saveAsTemplate` are still stubs in `actions.ts`), and `export_posts` (18d). Their tools call the actions; a stub's "not built" becomes "‹tool› isn't available yet: templates come with round 18b (docs/social.md §10)". Nothing to change in the tools when 18b lands — its functions answer instead. `make_brand_library` asks `ManagerEnv.brandLibrary`, which the view leaves unset until 18b wires its generation in `service.ts`.
- **Checks** (`actions.ts`: `checkPost`, `checkPosts`, `applyChecks`): caption, hashtag and mention counts (`captionReport`; the caption on a carousel's first slide); TEXT and logo layers (a slot tagged `logo`, or a layer named "logo" — the outermost) reaching into a safe-area band, the insets scaled to the post's size; a missing logo on a post with a brand, or more than one; an animated post's length and the timeline's fps against the format's `video`; text contrast over what is under it — the post drawn by `renderNodeThumbnailPixels` at 512 px, the box's pixels unlike the text's colour averaged (over white), WCAG 4.5:1 under 24 px, 3:1 from 24 px [ours] (skipped where the engine can't draw: headless tests). Problem ids name the kind and the layer (`check:safe-area:‹id›`), so a finding keeps its pin; `check_posts` writes its findings onto the posts (`source: "check"`, the review's kept) and a finding no longer found leaves; viewers only read.
- **The manager in Social** (`service.ts`): `managerProvider()` is the manager whenever the view is in Social (`inSocial()`), even with `ManagerSettings.enabled` off; the turn's instructions get `ManagerPromptContext.social` (the board's brand and campaigns with counts, `socialContext()`), and `managerPrompt` / `managerReminder` append Social's paragraph (`src/shared/social/managerPrompt.ts` `socialPrompt`: get_board first, Instagram and LinkedIn first, templates when one fits and never over locked slots, captions with `set_post` within the limits in the brand's tone and Turkish unless asked, videos within the format's length, the review's kinds and their fixes, at most one round of follow-ups, export only when asked). Worker prompts in Social get `SOCIAL_WORKER_LINE`. `STARTER_BRIEF` is §4.2 / §4.2a's brief (sent by 18b's "Make starter templates…").
- **`make_posts` on the board** (`managerTools.ts` `makeBoardPosts`, when `ManagerEnv.social()`): formats as catalogue ids (`formatsFor` also takes `brand:` ids and the brand's own; default `instagram.post` + `instagram.story`), a campaign (`campaign`, default "‹Products› — ‹Month›", `campaignName`), every post made at once with `new_post` in its row (from `template` when given; a template that can't be used yet falls back to a drawn post, and the answer says so), then per post the image task and a frame task drawing *in* that post (`postPrompt`: the format's safe-area bands named; with a template, `fill_slots`), the picture into its Picture layer (a template's picture slot through `fill_slots`), a Motion pass per format with video limits when `animate {seconds, style?}` asks (`animatePrompt`, the length clamped to the format), and the review after all; `captions` (default on) puts the caption pass in the answer's `next` — the manager writes them itself with `set_post`. Outside Social, Studio's `make_posts` is unchanged.
- **Review in Social:** `cleanReport` keeps the five new kinds with §7.3's fixes; `report_review` writes the problems onto the posts it is about (`source: "review"`, `ManagerEnv.posts`, one step of the owner's history each, "Studio: Review"); Leave as is, and the problems the owner unticks, leave the pins; picked `rewrite` / `retime` come back as `yours` for the manager to do in its turn (and leave the pins), Blur's at once, the others when their task ends done. `dispatchFixes` gives each task its `nodeId`.
- **Chrome:** a post's **Fix** (Post section) sends the manager "Fix on ‹post› (‹id›): ‹kind› — ‹detail› (fix: …)" at once with the post as context (`AgentsService.fixProblem`, `fixWithAgent` in `SocialMode.tsx`; where agents can't run — the browser — it drafts it in the composer as 18a did). A **review pin** sets `ui.socialProblem`; the review card that has the problem marks it (`data-pinned`, the warning tint) and scrolls it into view. **Follow-ups**: `ask_choice {suggestions: true}` puts at most three chips under the answer without waiting (`ManagerEnv.suggest`); a click is the owner's next message (`pickSuggestion`). **Context**: a selected post goes to the agent with its format (`contextOf`, `selection[].format`, main's prompt "a post: Instagram story"), and its chip shows the format. The review card names the new kinds (Safe area, Caption, Contrast, Logo, Video).

**Tests:** `editor/__tests__/agentsSocial.wasm.test.ts` (every Social tool listed with an object schema, read / write flags, `export_posts` waiting; `new_post` in a new campaign and the board by campaign and row; `list_formats` with a brand's sizes and a brand-size post; a template refused as not available yet with nothing left behind; `set_post`'s counts and marking a frame; `resize_post` duplicate and in place; `set_campaign` add / rename / remove; `fill_slots` refusing a locked slot; `check_posts` finding a 3 100-character LinkedIn caption, a story's CTA in its bottom band and a 61 s story video, written as pins and cleared once fixed; logos missing / two; a turn's Social writes one undo step); `agentsManager.test.ts` (Social's `make_posts`: the campaign, posts made at once with catalogue ids, Social's worker line and safe area in the prompt, the Motion pass on the story only, the review; a template falling back and one used through `fill_slots`; the review's pins, `yours`, unpinning on fix and on Leave; follow-up chips; `make_brand_library` not available, then answered; Social's kinds in `cleanReport`); `agentsManagerService.wasm.test.ts` (Social forces the manager with the board in its instructions, Design doesn't; the post's format in the turn's context; the manager's Social tool calls answered; a worker refused `make_brand_library`; a post's Fix sends the problem; a follow-up chip sends the owner's next message); `socialPanels.wasm.test.ts` (a pin selects its post, the Agent tab and marks its problem in the review card; a post's format in the context); `src/shared/social/social.test.ts` (the paragraph only in Social, its rules, the reminder, the starter brief); `src/main/agents/imageArgs.test.ts` (`fill_slots`' picture path). Visual check in the web demo, headless: a story with a CTA in its bottom band and a LinkedIn post with an over-long caption and a light-grey text — `check_posts` found the safe area, the caption and the contrast (1.3:1, from the real render), the pin sits on the CTA, the Post section lists the problem with Fix / Leave.

**Not done in 18c (left for later rounds or a follow-up):**
- The owner's sentence wasn't run with a real model and a fake image route (§10's manual step) — the tools and the manager were tested directly.
- Templates and the Brands library through the agent (`apply_template`, `fill_slots`, `save_as_template`, `new_post` from a template, `make_brand_library`) wait for 18b's functions; `export_posts` for 18d's. `list_templates` shows library templates without their slots (the manifest carries the template marker only).
- In Social the composer shows the manager's chip; picking another agent there for a direct turn (§1.3's "the composer's agent picker still sends direct worker turns") isn't built — leave Social, or turn the manager off and use Design, for a direct turn.
- The "Fix on …" message is the manager's to act on (its paragraph says how); there is no structured fix path from the Post section that skips the model.
- Contrast samples a 512 px render and averages the box's non-text pixels: busy pictures behind thin text can pass or fail loosely; gradients and images aren't sampled per glyph.

## 15. As built — 18b, templates and the Brands library (2026-10-18)

**Built on §12's proposed defaults (pending the owner's confirmation):** Instagram and LinkedIn first (`FIRST_PLATFORMS`) — the Save as template dialog offers their formats first; starter templates stay the agent's (§12.4: the gallery's empty state asks the agent; `STARTER_BRIEF` is 18c's). Files in `editor/social/templates/` as §10 lists them (the task's `editor/studio/brandLibrary.ts` / `editor/social/templates.ts` paths: the contract's folder wins).

- **Brands library** (`brandLibrary.ts`): `writeBrandLibrary(ed, brands, logos)` — inside a Writer, idempotent, everything by name — makes the **Brand** collection with a mode per brand named as the brand (a new collection's "Mode 1" and a removed brand's mode are reused / deleted; the first brand's mode is the default), COLOR `Color/Primary`, `Secondary`, `Accent`, `Background`, `Text` (matched by name, folded as `BrandsRepository.find` folds, then the unnamed colours in list order; fallbacks [ours]: Primary #1E1E1E, Secondary / Accent the Primary, Background #FFFFFF, Text #1E1E1E), `Color/On primary` (white or #1E1E1E by WCAG ratio), a brand's left-over colours under their own names (other modes: their Primary), STRING `Font/Heading` / `Font/Body` (Inter without fonts); text styles **Heading** 64/110 % Bold, **Body** 32/135 % Regular, **CTA** 36/120 % Semi Bold, their family **bound** to the font variables (the engine binds a style's `FONT_FAMILY`), the default mode's families as values; the page **Logos** with the **Logo** set (Create multiple components + Combine as variants on first run, Add variant for a new brand, a removed brand's variant deleted; each variant the brand's first logo as an IMAGE fill at its aspect, 400 on the long side, square and empty without one; laid out in a row, the set hugging them); the `brandLibrary` marker on the DOCUMENT. `updateBrandLibrary` imports the logos first (async), then one undo step "Update brands library". `createBrandsLibrary` makes the file **"Brands" in the workspace's first folder [ours — a file in Drafts can't be published, data.md §9; Drafts when there is no folder]**, saves every brand's `libraryFileKey`, opens it; an existing one is only opened. `makeBrandLibrary` is `make_brand_library`'s body: in the library file it updates (the studio's write, "Studio: Update brands library"), elsewhere it makes / opens the file — wired as `ManagerEnv.brandLibrary` through `StudioDeps.brandLibrary` (`agents/service.ts`).
- **Brands panel** (`studio/BrandsPanel.tsx`): **Create brands library** / **Update brands library** under the brands list.
- **Banner** (`BrandLibraryBanner.tsx`, over the canvas in every mode): in the library file (its marker, or a brand's `libraryFileKey`) — "Brands library · ‹n› brands changed" (new, edited or removed brands against `generatedFrom`) / "· up to date", **Publish…** (Figma's Publish dialog) and **Update**; on the new file (nothing on the page shown) Update runs at once and the Publish dialog opens. The owner presses Publish.
- **Templates** (`templates.ts`): markers read tolerantly (`normalizeTemplate`, `normalizeSlot`); the index — this file's sets and lone components with the marker, and every enabled library's from its manifest's `social` (no payloads), with the copy here when imported; `filterTemplates` (platform, format, Static / Animated, the brand's libraries); `ensureTemplate` (a library template's copy brought in, `ensureCopy`); `pickVariant` (the variant for the post's format, else the asked one, else the first); slots (`postSlots`: an instance's derived sublayers carry their main's slot records — read from the instance itself, so a library copy's and an Add-variant copy's work); `inferSlots` (texts — a CTA / label by its layer's name, then the largest the headline, the next the body —, the Logo instance, the first picture-filled layer, Brand-bound fills: background when it is the frame or covers it, else accent); `slotWiringError` per §3.3. Actions, each one undo step, each with a `…Now` core for a Writer already open:
  - `applyBrandNow` / `applyBrand` — the post's explicit mode on every collection named Brand (local or the library's copy) by the brand's name, the logo slots' `Brand` variant, the record's brand (its products cleared on a change).
  - `fillSlotsNow` / `fillSlots` — text roles through the instance's TEXT property (a plain frame: the text itself), the picture as an IMAGE fill (FILL); a locked slot refused, text over `maxChars` written and reported, roles without a slot reported.
  - `applyTemplateNow` / `applyTemplate` — an instance swaps (SWAP_INSTANCE) to the variant for its format; a plain frame is replaced by an instance at its place and layer order, its texts carried by role, its record kept with `template` set; then the brand and the product's packshot.
  - `newTemplatePostNow`, `insertTemplate` (the gallery: copy in, packshot imported, then one "New post" step bound to the brand), `setProduct` (product + packshot into the picture slot, one step).
  - `saveAsTemplateNow` / `saveAsTemplate` — refusals named (no slot, a slot's wiring, an instance, a template already, not a frame); Create component + Combine as variants, the property renamed **Format** with the format's name as value, more formats as Add-variant copies resized (`formats`), each text slot a TEXT property bound to its layer with its family bound to `Font/Heading` (headline, CTA) or `Font/Body` (body, label) when the file has them, the slot records, the marker (platforms from the formats, `animated` from the timeline); the asset key written in the same step (field 319: `ensureAssetKeys` is a SYSTEM change the engine refuses inside a step); the post goes on as an instance of the template at its campaign row's end, its record moved there.
  - `actions.ts` keeps §6.7's synchronous signatures for the agents' tools (they write inside their own write): `applyTemplate` (the template in the file; brand and packshot as last read), `fillSlots` (a picture already imported), `applyBrand` (the brand as last read), `saveAsTemplate`; `newPost` with a template (an instance of its variant, bound to the brand). `prepareTemplate` / `importPicture` fetch first — 18c's `apply_template`, `fill_slots` and `new_post` now await them (`agents/socialTools.ts`, three lines each). The chrome uses `templates.ts`' async versions.
- **Gallery** (`TemplatesGallery.tsx`, the Posts tab's Templates section): Platform / Format / Static-and-animated filters; cards with the set's thumbnail (local: the engine's; library: the published PNG), name, source, formats; click inserts at the board's next place, drag inserts centred where dropped; the board's brand, the selected post's product; empty: Make starter templates… (puts a request in the agent's composer).
- **Post section**: Brand runs `applyBrand`, Product `setProduct`, **Template** lists the templates with a variant for the post's format and applies one.
- **Save as template…** (`SaveAsTemplateDialog.tsx`; the Posts list's menu, `social.save-as-template` for one selected post): name, platforms, "Also as" formats, the inferred slots with role / Not a slot, Locked, Most characters; a refusal shown in the dialog.
- **Posts table** (`PostsTable.tsx`; `social.table`, the toolbar's Table): docked along the bottom like Motion's timeline (`--ds-size-social-table` 240, `EditorApp.module.css`), rows by campaign — picture, name, format, brand, a column per text role present, Caption, Hashtags, Alt text, Status — cells edit in place (a text slot through `fillSlots`, the rest `setPost`), one step each; a row's click selects the post. **Import CSV…** (`csvImport.ts`): RFC 4180 (quotes, doubled quotes, commas and line breaks in cells, BOM, CRLF; a semicolon file when its header has more `;` [ours]), columns by name in any case, ≤ 500 rows; the dialog picks the template, its formats and the new campaign's name (the file's); one "Import CSV" step makes a campaign and a post per row × format at its row's end, slots filled, caption / hashtags / alt text, the row's brand by name (else the board's) bound, the product's packshot in the picture slot.
- **`LibraryAsset.social`** filled at publish (`libraries.ts`: `PublishItem.social` from the set's marker, into the manifest entry). The local store, the memory store and the server's manifest validator keep it as they keep every field (`toLibraryAsset` and the server's `...a` spread) — no server change.

**Beyond §10's file list:** `actions.ts` (the four functions, `newPost` with a template, `NewPostOptions.brand`), `agents/socialTools.ts` and `agents/service.ts` (the 18c hand-off above), `socialState.ts` (`isAnimated` exported), `PostsList.tsx` (Save as template… on, `PostThumb` / `formatLabel` exported), `PostSection.tsx`, `SocialLeftPanel.tsx`, `NewPostMenu.tsx` (Table on), `commands.ts` (`social.table`, `social.save-as-template` on), `EditorApp.tsx` / `.module.css` (mounts, docking), `uiStore.ts` (`socialSaveTemplate`, `socialCsvImport`), `ds/tokens.ts` (`social-table`), `i18n/tr/editor.ts`.

**Tests:** `editor/__tests__/socialTemplates.wasm.test.ts` — colours by name then order, On primary's pick; the library for two brands (modes, variables, fonts, styles bound, the Logo set on its page, the marker, changed-brand count), a second run changing nothing, a removed brand's mode and variant gone, undo; the file made in the first folder and the brands pointed at it; Save as template's refusals per wiring and the set it makes (Format variant, TEXT properties, slot records, the post an instance, undo); a plain frame's texts carried by role; `fillSlots` refusing a locked slot and reporting an overrun, the main untouched; a brand switching only the mode, the logo variant and the font family (Poppins → Inter); CSV import (4 posts in a new campaign row, slots, record, brands by name, undo); publish → manifest `social` → another file lists the template, inserts it for LinkedIn bound to Acme, switches to Beta; `ManagerEnv.brandLibrary` updating the library as one studio step. `socialCsv.test.ts` — the parser, columns, limits; the gallery's filters over local + manifest fixtures; markers read tolerantly. `agentsSocial.wasm.test.ts` (18c's) gained save_as_template → new_post from it → fill_slots → apply_template through the tools. Visual check (`npm run web -- --mode demo`, headless Chromium): two brands → Create brands library → the Brands file opened, its banner updated it and opened Publish → published; a template there published; a second file with the library enabled → Social → the gallery's card → the post in Acme's green with its texts → Post section › Brand › Beta: red, mode Beta, logo variant Beta (read back); the table docked with Headline / Body columns.

**Not done in 18b (left for later rounds or a follow-up):**
- The logos' images inside template instances didn't draw in the headless demo within the wait (the Logo set itself draws its images, `levelOf` "full"; the variant switch is read back right) — to look at on the desktop app; library images reaching a consumer file follow data.md's image path, not checked here.
- Brand fonts weren't seen rendered (the demo has only its bundled fonts); the binding is tested (the family follows the mode).
- A renamed brand gets a new mode / logo variant (matched by name); posts set to the old mode fall back to the default until the brand is applied again.
- The table has no thumbnail cache, no sorting, no multi-cell paste; Import CSV takes no product pictures for rows naming a product of another brand than the row's; XLSX waits (§1.11).
- Drag from the gallery has no drop preview; Save as template doesn't show the inferred slots on the canvas; `maxChars` isn't suggested from the layer's size.
- The canvas context menu's post rows (Save as template… there) stay as 18a left them.
- `list_templates` (18c) still lists slots only for local templates.


## 16. As built — 18d, video and export (2026-10-18)

Built on 18a–18c and §12's proposed defaults (pending the owner's confirmation); files as §10 lists them (`editor/social/export/exportPosts.ts`, `ExportPostsDialog.tsx` + `.module.css`). No engine or schema change, no new dependency.

- **Presets' renderer side** (`exportPosts.ts`; `src/shared/social/presets.ts` stays data): `autoPreset` (§8's "auto": an animated post — `isAnimated`, a timeline with something on it — takes its format's video preset, else its still one; formats outside every preset, and brands' own sizes, the generic ones), `presetsFor` (the dialog's menu: the format's own then the generic ones; a still post only still ones). `planPostExport` / `planExports`: the file `‹Campaign›/‹post name› — ‹format›.‹ext›` (no campaign: no folder; "/" in names replaced), still settings (PNG / JPEG / PDF at the preset's scale, **sRGB**, JPEG at its quality, PDF `contentsOnly`), the output size; video: MP4 through Motion's Animated export, the size from the preset (`scaleOf`) padded even, fps, codec (H.264; WebM's VP9 when a preset asks it), bitrate (`bitrateOf`: High = 0.2 bits per pixel per frame — 12.4 Mbps at 1080 × 1920 × 30), the exported length (`planFrames`, Ping-pong twice). **Checked before rendering** (warnings in the plan, the file still made): the length against the format's `video.minSec` / `maxSec`, the fps against `video.fps`, the bitrate against `maxMbps`, MP4 / H.264 against `containers` / `codecs`, a side over 4096, a video preset on a post whose timeline doesn't move, a document's pages against `items`. The limit a file is checked against afterwards: the preset's `maxMB` and the format's (`image.maxMB` / `video.maxMB`), the lower (a story through the reel preset: 100 MB, not the preset's 300).
- **After rendering** (`fitStill`, `renderPlan`): a JPEG over its limit is written again down `JPEG_STEPS` (0.92, 0.85, 0.78, 0.7, 0.6, 0.5, 0.4, 0.3 [steps ours]) until it fits — §8's YouTube thumbnail rule, applied to every JPEG with a limit [ours]; a PNG over its limit becomes JPEG 0.92 (then the steps) when the format takes JPEG — §8's LinkedIn rule, applied to every such format [ours], the file renamed `.jpg`; what still doesn't fit is a warning ("‹n› MB is over the ‹max› MB limit"). A LinkedIn document is one PDF of its group's slides in `index` order through the engine's PDF writer (Export frames to PDF's), the other slides folded into it.
- **`exportPosts(ed, ids, {preset, zip, zipName, renderers, onProgress, signal})`**: renders each plan through the editor's two exports (`renderExport`, `renderAnimated`; tests pass their own `ExportRenderers`), one zip (`zipStored`, the editor's own writer) when more than one file — named after the campaign when every post shares one, else the design file —, a single file without its folder. `markExported` (status `exported`, `exportedAt` now, one undo step "Export posts"); `exportAndSavePosts` (the chrome: `saveFiles`, then `markExported` once saved; viewers' exports write nothing; refused when the file's owner blocks exports).
- **Export…** (`ExportPostsDialog.tsx`, `ui.socialExport`): the Posts list's and the canvas menu's Export…, and `social.export-campaign` (now on: the selected posts' campaigns, nothing selected every post on the page by campaign — `campaignPosts` in `SocialMode.tsx`). A row per post: its thumbnail, name, **Preset** ("Auto (‹preset›)" then the post's presets), what it renders ("1080 × 1920 · MP4 · H.264 · 30 fps · 12.4 Mbps · 6 s · ≤ 300 MB"), its file, its warnings in the danger colour; Export → a progress row with Cancel ("Exporting ‹post›: frame ‹k› of ‹n›…"), the files saved, a toast; the dialog stays open with the results only when rendering found more (an error, a size over, a smaller JPEG).
- **The Animated tab's Preset menu** (`panels/design/ExportAnimated.tsx`): for a post, above the fields — its format's video presets, the one the fields match shown (Custom when none); a pick writes the preset's settings to the layer (Motion's stored entry, one undo step) and the fields stay editable.
- **The timeline's Social header** (`Timeline`'s `header` prop: `{content, minUs?, maxUs?}`; `MotionMode`'s Social mount passes `timelineHeader(ed, root)`): "Instagram reel · 3 s – 15 min · 30 fps" (the format's name, its video length, the video preset's rate) after the time fields; Duration in `--figma-color-text-danger` while the length (the dragged one too) is outside them. A format without video limits shows its name only.
- **`export_posts`** (`agents/socialTools.ts`): `nodeIds` or `campaignId`, `preset` ("auto" or an id; an unknown one refused with the list), `zip`; the files back through `ToolResult.files` as `export_animation`'s (main saves them in the agent's folder, names without folders; more than 10 unzipped refused, each ≤ 200 MB), the posts marked exported inside the turn's step; the answer lists each post's preset, file, bytes, warnings or error.
- **Starter templates** (`STARTER_BRIEF`, the animated rows §10 gives 18d): Product hero (animated) 6 s, Story / Reel 8 s on a 30 fps grid, the logo's fade ending on the last frame, then `export_posts {preset: "auto"}` on a post from each animated set to see its MP4 within the format's limits.
- **18a's leftovers closed:** the canvas menu over post frames alone (Social) starts with Resize to ›, Duplicate for ›, Save as template…, Export… (`postCanvasRows` in `PostsList.tsx`, ids `post:…` run by `menus.ts` on the selected posts; disabled rows dropped as Figma's canvas menus drop them); Space plays and pauses the timeline in Social while the selected post's timeline shows (`motion.play-pause` enabled with `ui.socialTimeline`).

**Beyond §10's file list:** `PostsList.tsx` (Export… on, the canvas rows), `SocialMode.tsx` (`exportPostsDialog`, `campaignPosts`), `menus.ts`, `commands.ts`, `uiStore.ts` (`socialExport`), `EditorApp.tsx` (the dialog's mount), `motion/MotionMode.tsx` (the header), `i18n/tr/editor.ts`.

**Tests:** `editor/__tests__/socialExport.wasm.test.ts` (10) — "auto" for still / animated posts and the menus; plans (file names with the campaign, 1080 × 1920 · 30 fps · H.264 · 12 441 600 bps, a 61 s story outside 3 s – 1 min with the story's 100 MB, the thumbnail's 3840 × 2160 JPEG 0.92 sRGB), the header's text and limits; a campaign's zip (entries under its folder, the post outside it left out, one file without folder or zip), `markExported` one undo step; the JPEG steps on a noisy fixture's size model reaching 0.4 ≤ 2 MB and every step tried when hopeless, LinkedIn's PNG over 5 MB → JPEG; size warnings (a 120 MB story, a 101 MB document); a 3-slide document in index order 2 / 0 / 1 → one PDF, its three pages from the engine's real PDF writer; `export_posts` (a campaign's two PDFs as one zip back in `files`, statuses exported, one post's PDF alone, an unknown preset / campaign refused); the dialog's rows, specs, files and warnings, a preset picked; the Animated tab's Preset menu (Instagram reel matched, Custom, a pick writing MP4 · 30 · High · 1080 wide; none on a plain frame); the canvas menu's post rows (resize through them, Export… opening the dialog, none in Design), Export campaign… on, Space only while the timeline shows. `motion/__tests__/timeline.dom.test.ts` — the header's text, Duration red under 3 s and not at 6 s, no limits never red. `agentsSocial.wasm.test.ts` — `export_posts {}` now asks for the posts. Visual check on `npm run web -- --mode demo` (headless Chromium, swiftshader): three posts in "Spring sale" → Export campaign… (rows as above, the 2 s reel's warning) → Export → `Spring sale.zip` downloaded: a 1080 × 1350 JPEG, a 1200 × 628 PNG and an MP4 (`avc1` 1080 × 1920, 60 samples over 2 s = 30 fps) — headless Chromium's WebCodecs encoded the H.264 here —, statuses exported, undo "Export posts"; the reel's timeline header "Instagram reel · 3 s – 15 min · 30 fps" with 2000 ms in red, not at 6 s; the canvas menu's four rows on top; a GIF of the reel through Motion's export (`GIF89a`, 158 KB).

**Not done in 18d (left for later rounds or a follow-up):**
- **To check on the owner's Mac (desktop app):** an MP4 from a template plays at 1080 × 1920 · 30 fps with its audio (AAC through `AudioEncoder` there; no audio clip was in the headless check), the file opens in QuickTime and uploads to Instagram / LinkedIn; a WebM (Motion's Animated tab, VP9) plays in Chrome; the desktop's Save dialog saving one zip for a campaign; a LinkedIn document PDF uploading as a carousel; the YouTube thumbnail's steps on a real photo (the test's sizes are a model — no JPEG encoder runs headless in Node).
- The dialog has no per-format quality fields (a preset is as §8 has it) and no "zip or files" choice (several files are always one zip; `export_posts {zip: false}` returns them one by one).
- Animated posts in a carousel (slides as videos) export each slide as its own file; Instagram's carousel isn't packaged.
- One animated export at a time per file is Motion's lock on its own tab; Social's export doesn't take it, so starting both at once encodes in parallel.
- "sRGB" is the stills' profile; a video's colour is what WebCodecs makes of the frames (no colour tags written).

## 17. As built — leftovers (2026-10-18)

The not-done lists of §13–§16, closed in the owner's order (2026-10-18: build on §12's proposed defaults and go on; he reviews the panel himself later): correctness first, then the agent's flow, then the chrome. No engine or schema change, no new dependency; `LibraryAsset.social` and `BrandLibraryMarker` gained an optional field each (old manifests and markers read as before).

**Correctness:**
- **Logos inside template instances (§15) — not a bug of ours.** Read back on the engine: the logo instance carries the Logo variant's IMAGE fill (the instance itself, a nested instance inside a template instance, and after a variant swap or a library update), and in another file of the same workspace the library copy's nested logo has the fill and the store has its bytes. In the web demo the logo draws inside both the template's main and its instance (the image's level "full") — 18b's check placed the logo with `INSERT_INSTANCE {x, y}`, which takes **page** coordinates, so it sat outside its post and was clipped. Left for the Mac: a library published and enabled from another file, drawn there.
- **A renamed brand keeps its mode and logo variant** (§15): the library's marker remembers each brand's name (`BrandLibraryMarker.names`, by brand id); an update renames the brand's mode (`RENAME_VARIABLE_MODE`, the mode id kept, so posts set to it stay) and its Logo variant's value (`EDIT_COMPONENT_PROPERTY`, the same component, so instances showing it stay), instead of making new ones; a renamed brand's old mode is never taken by a new brand; a name another brand now has isn't taken back (`brandLibrary.ts` `renamedBrands`).
- **Library templates' slots in `list_templates`** (§14, §15): publishing writes the template's slots next to its marker (`LibraryAsset.social.slots`, one per role and property — `templateSlotsIn` in `shared/social/types.ts`, the reader `list_templates`' local templates use too); `list_templates` shows them for a library's template before it is first used. A manifest published before this has none (shown empty, as before).
- **Social's export takes Motion's lock** (§16): `takeAnimatedExport` (`motion/export/exportAnimated.ts`, the one lock Motion's Animated tab uses) is held by `exportPosts` for the whole run when any post exports as video; while it is held elsewhere every post answers "An animation is already being exported" and nothing renders (stills alone don't need it). The Export dialog says so and waits, as the Animated tab does.

**The agent's flow:**
- **Make starter templates…** (§12.4, §15) sends the manager `STARTER_BRIEF` at once (`makeStarterTemplates` in `SocialMode.tsx`; the chat shows "Make starter templates", `AgentsService.send`'s new `shown`); a direct pick in the composer gives way to the manager first. Where agents can't run, the brief waits in the composer.
- **Fix without a model where it is mechanical** (§14, §7.3): a post's Fix first tries `fixProblem` (`actions.ts`, one undo step "Fix problem", the post checked again in it) — a text or logo reaching into a safe-area band is moved inside it (when it fits there, its parent places it freely — no auto layout, or absolute in it — with no turn or scale, and it isn't a layer inside an instance); a missing logo is a hidden logo slot shown again, or a detached template post given its template again (`applyTemplateNow`: its logo slot back, the brand bound). Else a **relayout** problem (safe area, contrast, logo, the review's layout / brand) goes to a worker's task without a manager turn (`AgentsService.relayoutProblem` with `managerTools.ts`' `relayoutTask`, the one the review's Fix selected uses): the chat gets the request and the task's card under the manager's answer, the pin leaves when the task ends done. A caption (rewrite) or a timeline (retime) stays the manager's turn as 18c built it.
- **Direct turns in Social** (§1.3, §14): the composer shows an agent menu in Social — the manager first, then every agent's models as the model menu lists them; picking a model sends the following turns straight to that agent (`AgentsState.socialDirect`, `chooseInSocial`), picking the manager brings him back. Outside Social the manager's setting decides, as before.

**The chrome:**
- **⇧-click** in the Posts list adds the rows from the last one clicked (across campaigns, the shown rows only); ⌘ toggles; a ⇧-click with no row clicked before toggles as ⌘ (§13).
- **The gallery's drop preview** (§15): while a template is dragged over the canvas, the post's outline at the canvas's zoom, centred on the pointer where the drop puts it, with its format above ("Instagram post · 1080 × 1350"); off the canvas the dragged card shows, as before (`dropPreview`).
- **The posts table** (§15): a header's click sorts the posts within each campaign by that column — ascending, descending, then the campaign's order again; numbers as numbers, the locale's letters, empty last (`sortRows`); a paste of several cells from a spreadsheet (tabs and line breaks; quoted cells as spreadsheets write them, `parseCsv` with a tab) fills from the cell rightwards and down over the text columns (the slots', Caption, Hashtags, Alt text) as one undo step "Paste cells", a locked slot left as it is and named in a toast (`pasteTargets`, `pasteCells`).
- **The Export dialog** (§16): **Save as** One zip / Separate files when there are several (separate: each file at its "‹Campaign›/…" path — the desktop writes them into a picked folder, a browser still downloads one zip); each row's **quality fields** over its preset — a JPEG's Quality (%; the size steps start under it), a video's Quality and Frame rate (Motion's Animated tab's fields; the bitrate and the format's checks follow).
- **A carousel's slides** (§16, §5.2 "slides may be videos"): exporting any slide of a grouped carousel exports them all, in `index` order, each its own file in one folder named as its cover's file — "Spring sale/Cover — Instagram carousel/01 — Cover.jpg", "…/03 — Field.mp4" — a video slide on its format's video limits (Instagram's carousel: a Reel's 3 s – 15 min), the slides' count checked against the format's `items` (2–10) on the cover.

**Tests:** `socialTemplates.wasm.test.ts` (a renamed brand: mode id and variant kept, a new brand before it not taking its mode, the marker's names; the manifest's slots and `list_templates` in another file; a detached template post that lost its logo given the template again by Fix; the table sorting a campaign and a two-by-two paste as one undo step); `socialExport.wasm.test.ts` (the lock refusing videos and held while rendering; quality overrides on a JPEG and a reel, the steps under the asked quality; a 3-slide carousel in index order in its folder with the video slide's Reel limits and the zip; the dialog's Save as, quality fields and waiting on the lock); `agentsManagerService.wasm.test.ts` (direct turns in Social and back; a safe-area move and a hidden logo fixed with no turn; a contrast problem as a worker's relayout task without a manager turn, its pin gone when done; Make starter templates as the manager's turn); `socialPanels.wasm.test.ts` (⇧ ranges and ⌘); `socialCsv.test.ts` (sorting, the paste's spread, the drop preview). Visual check (`npm run web -- --mode demo`, headless): the Posts list's ⇧ range, the Export dialog (Save as menu, a JPEG's Quality 92 %, a reel's High / 30 fps), the table sorted by Name, the drop preview over the canvas, a story's CTA moved out of its bottom band by Fix (undo "Fix problem"), and the logo drawn inside a template's main and its instance.

**Still not done (left for later or for the owner's Mac):**
- **On the owner's Mac (desktop app):** a Brands library published and enabled from another file, its logo drawn in a template there; Separate files written into a picked folder; a carousel's MP4 slide uploaded with its stills; the starter brief, a relayout task and a direct turn with real agents; everything §16 lists for the Mac (MP4 / WebM, audio, uploads).
- Mechanical fixes are the safe area's move and the logo's; a layer inside an instance or in auto layout, a text too big for the safe area, contrast and several logos go to an agent.
- The table has no thumbnail cache and no paste into Status / Brand; Import CSV takes no product pictures for rows naming another brand's product; XLSX waits (§1.11).
- Save as template doesn't show the inferred slots on the canvas or suggest `maxChars` from the layer's size; the Posts list has no drag to reorder or to move between campaigns.
- Contrast samples a 512 px render (§14); brand fonts weren't seen rendered (§15); a video's colour carries no tags (§16).

## 18. Social is its own kind of file (owner, 2026-10-24) — step 1 built

**Decision (the owner's words, translated):** "Instead of a mode, a separate file — we have our Design format, this would be the Social format." Figma's own answer is the same: Buzz is a file type of its own, next to Design, with its own Home button and interface. The UX plan for the rest (the board as platform › format grids, the focus view and its transition, the agent on the left, the Brands pages, converting a Design file) is drawn in the owner's "Sosyal Medya" file, page "wireframe" (v1.1); the steps after this one wait for his review.

**Built (step 1):**
- **The kind.** `FileMeta.editorType` is `FileEditorType` = `"design" | "buzz"` ("buzz": Figma's API name for a Buzz file; the UI says "Social"). `createFile({…, editorType})` (both stores, `fileEditorType` folds anything else to "design"); a duplicate and a version's duplicate keep the kind; `nav:new-file` and `NavApi.newFile(folderId, name, editorType)` carry it; an org file's copy takes it (`createDraft` / `projects.createFile` with `editorType: "buzz"`, the server's `files.editor_type`).
- **Home.** A **Social** button between Developer and Design (`files/SocialButton.tsx`), in Drafts, folders, the org's Drafts, its folders and team pages; a Social file's card carries a **Social** badge at the thumbnail's top left (`FileCard.kind`), its row the Social glyph (`FileKindIcon kind`); Home's existing "Files shown" menu gains **Social files** (`FileFilter` "buzz") — no other filter.
- **The editor.** `DocumentSource.editorType` (the store's source reads the meta). A Social file opens in Social on its Posts tab (`EditorController`'s first UI state) and keeps it: `setMode` refuses any other mode, Dev Mode / Switch to Draw / Switch to Motion are disabled, and the toolbar has **no mode switch** (`EditorToolbar.modes`, empty). A Design file's switch is Draw · Design · Motion · Dev Mode — `view.mode-social` and View › Social are gone.
- **Formats.** `instagram.portrait` — "Instagram post 3:4", 1080 × 1440 (the owner's posts; Instagram's profile grid shows 3:4 since 2025; a third-party source, `aspect` marked unverified) — with the still presets.

**Not done yet / known limits:** a Design file's posts can't be opened in Social until **Convert to Social file** (wireframe H) is built — the owner's "Sosyal Medya" is a Design file; a personal draft synced to the cloud is a Design file there (`server/src/personal/routes.ts` takes only "design"; changing it is a server deploy), so another computer would open it in Design; a shared org Social file opened for the first time on another computer opens in Design (its copy's meta is made without the kind); the kind isn't written into the document itself (a `.fig` export carries none).


### 18.1 Convert to Social file (wireframe H) — built

**Entry points.** In a Design file, File › **Convert to Social file…** (`file.convert-to-social`, after Duplicate; enabled in a Design file this person can edit — not in a Social file, not for a viewer). In Home, a single Design file's context menu (after Duplicate): the file opens with the dialog shown (its FileUiState `socialConvertOpen`, cleared on open); a file already open in a tab says to use its File menu instead.

**The dialog** (`editor/social/convert/ConvertToSocialDialog.tsx`): **Copy as a new Social file “‹name›”** (the default, recommended — the Design file stays as it is) or **Convert this file** (a version "Before converting to Social file" is saved first; offered only for a local file: an org file's kind is its server's, a branch's its main's). **Found · ‹n› frames**, per page, with **→ brand: ‹Brand›** when the page's name is a brand's (the Brands library, case and accents folded: `foldName`). Each row: a checkbox, what it is ("“Post” holds 24 designs" — "the container is unwrapped, order kept"), its size, and a format Select (Skip (no format), then the formats of that size and shape); a size that fits no format is "Skip (no format)", unchecked. Footer: "‹n› designs move to Social · ‹m› skipped", Cancel / Convert. The pages left out are named under the list.

**The rules** (pure: `shared/social/convert.ts`, tested on the owner's file as it is): a top-level frame (component, instance) of a format's size is a post; a **container** — a top-level frame or section not itself a format's size whose children are mostly (more than half, at least two) frames of one format's size — is unwrapped: its children become top-level posts in **reading order** (rows top-down, a row being the layers that start above its first one's middle; each row left to right), a child of another format's size keeping its own format; a size fits a format exactly (the catalogue's order between formats of one size: 1080² → Instagram square, 1080 × 1350 → Instagram post, 1080 × 1440 → Instagram post 3:4), else the nearest format when its aspect ratio is within 2 % and its sides within 25 %; the page holding the file's thumbnail (DOCUMENT.thumbnailInfo), a page named "Thumbnail" or "Cover", and a page without a format-sized frame are left out. Each post's record: its format, the page's brand, status draft, no campaign (a frame already a post keeps its record).

**The mechanism.** The copy: the store's `workspace.duplicateFile(fileKey, { editorType: "buzz", name })` (both stores; the copy keeps node GUIDs — `withNewAssetIdentity` only clears local assets' keys), the conversion (`SocialConversion`: per page the containers to unwrap with their children in order, the posts' records, and the pages the copy drops) written into the copy's FileUiState `socialConvert`, the copy opened in a tab; the Social editor applies it once as it opens (`applyPendingConversion`) as **one undo step "Convert to Social file"** — children moved to the page at the container's place (`moveNodes`, where they are on the page; the first on top in Layers), the empty container removed, the records written, the left-out pages deleted — then clears it and zooms to fit. Nothing is written to the original. Convert this file: version saved, the same `applyConversion` here (its pages all kept), then `workspace.setEditorType(fileKey, "buzz")` (new: local files only; "file.updated" tells Home and the editor) and the editor switches to Social. Applying a conversion twice changes nothing.

**Not done:** "Send to Social file" for a selection; a cloud-synced personal draft converted in place is still a Design file on the server (as in step 1); the dialog's look follows the wireframe's content, not a capture.

## 19. A Social file's board, focus view and panels (2026-10-24) — the wireframe's B–G built

The owner's asks (2026-10-24): the canvas behaves like auto layout, not a free table — the posts in a 3-column grid per platform and format, gaps between them; a click on a post glides into its design and centres it, the panels following; the agent on the left, Social's own screens on the right; a frame clicked shows its Design panel and hides Social's, a click on the blank brings them back; the "Tell the agent what to make" card he couldn't close reworked. Open questions answered with the plan's proposals (the owner, "do the rest"): one click opens; one board per page, the brand a filter; the order of a grid is the order it is read in.

- **The board** (`social/board.ts` `boardLayout`, `BOARD`): a section per platform, one under the other in the catalogue's order (a brand's own sizes and unknown formats last, "Other sizes"); in a section a grid per format, side by side in the catalogue's order; three columns; the posts at their real size in reading order (rows by their middles, then left to right). Gaps [ours, canvas units at 1080-wide posts]: 80 between posts, 400 between grids, 720 between sections, 600 above a section's grids for the titles — which are drawn in screen pixels (a grid's 22 px over its posts, leaving the engine's post names room; the section's 48 px over that), so they read at any zoom.
- **Arranging** (`social/arrange.ts`): only a Social file's current page, only its top-level posts. The chrome's writes (`EditorController.batch`) and the agents' (their actor's write, `agents/turns.ts`) arrange before they commit (`EditorController.beforeCommit`); an edit on the canvas by the user (a drag among the posts — it reorders —, ⌘D, Delete, paste, a panel's size field) is followed by an arrange folded into its step — the engine's new **`txnBeginAmend`** (C++ `Editor::txnBeginAmend`, `engine_txn_begin_amend`; a USER transaction joined to the user's last step while nothing is to redo, else a step of its own; native test in `scene.txn.test.cpp`). So one ⌘Z takes an edit and its reflow back together; undo and redo, other sessions and loads aren't arranged. A new post goes past every post (`boardEnd`) and the arrange puts it at its grid's end.
- **Titles and "+"** (`social/BoardLabels.tsx`): over the canvas, placed from the camera: each section's platform and count, each grid's format, ratio, size and count, and a dashed "+" cell where the grid's next post goes — a new post of that format, opened in focus.
- **Focus** (`social/focus.ts`, `FocusChrome.tsx`): the selection decides — one post, or layers inside one, is in focus; two posts or more, or nothing, isn't; a click with ⇧ or ⌘ picks posts without opening it (`ui.socialPicking`), so the next ⇧-click lands where the post still is. Entering, the camera glides from the board to the post (320 ms, ease-out quart, zoom in log space; a jump with Reduce motion), the board's view kept; post to post it glides across; a click on the blank (or Esc up to nothing) glides back. The rest of the board dims around the post (`Spotlight`); the path bar on top ("← Board", platform › format, the name, ‹ n of N ›) and the strip of the grid's posts at the bottom (a click focuses one). The board's titles hide in focus. Leaving goes back to the board's view as it was, or — when that view didn't show the post (one just made from the empty board) — to the whole board.
- **Panels**: the rail's first tab in a Social file is the agent (`SocialAgentPanel`, the Agents panel on the left; Posts, File, Assets, Brands after it; the browser shows it too, saying agents run on the computer); drafts for the agent (Ask agent…, Fix, pins) open it. The right panel (`SocialRightPanel`) follows the selection: nothing — the **Board** (brand, posts by status, the grids with a glide to each, problems with Select them, Export approved…); two posts or more — **bulk** (the Post section's shared fields, Ask agent…, Export…, Delete); one post or layers in it — Figma's **Design** panel with the post's **Post** section as a tab beside it (`ui.socialPanelTab`); layers outside posts — the Design panel. Round 18's Agent | Properties switch is gone.
- **The empty board** (`social/EmptyBoard.tsx`): a strip over the canvas's top, never a modal: a button per common format (Instagram post 3:4, reel, story, LinkedIn square, Facebook post, TikTok video — a click makes the post, its grid appears and it opens in focus), Start from a template, and × (closed for the session; the first post removes it).

**Not built yet:** the tiles' hover checkbox and ⋯ menu (⇧/⌘-click selects several, the canvas menu has the post rows); hiding a grid; grouping other than platform › format (by product, campaign, brand) and sorting other than reading order; Instagram's profile preview (3:4 crop); the board's view per page kept between sessions; ←/→ keys in focus (the arrows nudge, as in Figma; the bar's ‹ › and the strip do it).

## 20. The canvas as Figma Buzz's (owner, 2026-10-24) — the bugs he hit, and the templates back

The owner's report: moving a layer from one post to another flickered; a layer that fell onto the canvas made the zoom jump; "the canvas side should be like Figma Buzz"; the templates he had before were nowhere to be found.

**Causes, measured:** the focus view followed the selection, and a layer dragged inside a post could be dropped into another post or onto the page — the selection then lay in another post (or none), so the camera glided away mid-drag and the dimming overlay jumped with it; a selection that also asked for "zoom to selection" (`applySelection(…, true)`: the Posts list, a template inserted, Duplicate for) zoomed on top of the focus view's glide; the board's titles, the safe areas and the pins hid while the zoom changed, so every glide blinked them off and on; the safe areas and pins of the other posts stayed over a post in focus. The board itself is cheap: 200 posts read and checked in 2–3 ms per commit (a wasm bench), 200 new posts made and arranged in ~180 ms.

**Built:**
- **Asset view as Buzz's.** A post in focus is the engine's single shown design (`Engine.setFocus`, Dev Mode's focus view): only it is drawn and picked. New in the engine: what is dropped or drawn while a design is in focus stays in it (`Editor::focusFloor` — `dropTargetAt` takes only the design and its frames, the Rectangle / Frame / … tools draw into it; the design itself moves as any layer would; native test in `editor.move.test.cpp`). Entering, the board gives way to the post when the camera arrives; leaving, the board is back before the camera moves (no pop, no dim overlay — `Spotlight` is gone).
- **One camera move.** In a Social file `applySelection` doesn't zoom into a post in focus (the focus view glides); several posts are zoomed to on the board (§21).
- **No blinking.** The board's titles, the safe areas and the review pins follow the camera through zooms instead of hiding; in focus only the post's own bands and pins show.
- **Templates** are the rail's own tab after Posts (`SocialTemplatesPanel`: the board's brand and the gallery full height — this file's and the enabled libraries' templates, filters, click or drag to insert, Make starter templates… when there are none), as Buzz keeps them in its left panel; the empty board's Start from a template opens it. The Posts tab is the posts list alone.
- **Rulers** are off in a Social file unless the file kept its own choice (Buzz has none).

## 21. A quiet board, Buzz's grid view (owner, 2026-10-24) — and a test file with two brands

The owner: "the canvas side looks very ugly, it should be more minimal, like Buzz"; make two imaginary brands with three products each and a template test file showing every feature ("Social-test"); add what Wecra is missing.

What Buzz's grid view shows (help.figma.com "Explore Figma Buzz", "Create and organize assets"; the Plugin API's canvas grid): assets in rows, each under its name, a blue **+** beside an asset adding one of the same size; no headings; the asset view shows one asset. So:

- **Board chrome** (`BoardLabels`): the platform headings and the dashed "+" cells go. Each grid keeps one small secondary title — its format (whose name carries the platform) and its count — over its posts' names; the titles go when the board is zoomed out too far to hold them (`data-dense`). A round brand-blue **+** sits beside each grid's last post (Buzz's), a new post of that format opening in focus.
- **Spacing** (`BOARD`): 200 between posts across and down (the names between rows no longer sit on the posts above), 480 between grids, 560 between sections, 240 over a section.
- **Only the post in focus carries its marks:** the safe areas, the review pins and the Social timeline show in focus; on the board each post with problems has one count badge in its top right corner (a click focuses it; its tooltip lists them). Selecting several animated posts no longer opens the timeline.
- **Focus bar** (`SocialFocus`): a small centred bar — ← Board, the post's name (platform › format as its tooltip), ‹ n of m › — instead of the full-width path bar.
- **Grids** in the Board panel by the format's name alone ("Instagram story", not "Instagram · Instagram story").
- **The Brands library for outside clients:** an MCP client of the owner's (Claude Code, Claude Desktop) now lists and calls the library's tools (`library_find`, `library_get`, `library_save_brand`, `library_save_product`, `library_add_image`, …; their definitions moved to `shared/studio/libraryTools.ts`); a worker's or a plain chat's session still doesn't have them, the manager has them among its own.

**The test file** ("Social-test", built through those tools): brands **Toprak Bereket** (agro: HumiPro 1 L, KökGüç 5 L, YaprakMax 1 KG — its labels left unconfirmed) and **Kuzey Kahve** (coffee: Sabah Harmanı, Etiyopya Yirgacheffe, Soğuk Demleme — no packshot), logos and packshots; campaigns Sonbahar Ekimi and Kış Menüsü; templates **Ürün Duyurusu** (Instagram post 3:4) and **Hikâye Kampanya** (story) with headline / body / CTA / label / picture slots (a locked label, character limits); posts from them per product, plain LinkedIn / Facebook / TikTok posts, an animated reel and TikTok, every status, captions and hashtags, a headline over its limit, and the check's problems.

**Still open:** a template's background, accent and logo slots need the Brands library's Brand collection and Logo set — the two new brands reach them once the owner runs Brands › Update brands library (and publishes it); until then the Kuzey Kahve posts carry their colours as overrides.

