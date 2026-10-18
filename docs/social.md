# Social (contract, round 18 [ours]; planned 2026-10-17, **contract written 2026-10-18** from the plan, the owner's answers and the code on main `0e0f215c`)

The owner's request (2026-10-17, his words, translated): next to **Design** and **Dev Mode** in the toolbar's mode switch, a **Social** mode — an interface arranged entirely for social media content. Ready **templates** per platform (Instagram, LinkedIn, …) fed from the **Brands** panel; the **agent** works here too; our **drawing modes** work here too; and it makes **videos**, built the way Figma's **Motion** builds them. Motion doesn't exist yet in the app and is added first, "directly as in Figma, with everything".

**Owner's answers, 2026-10-17:** Social is **a mode of the same document** (confirmed). Not Figma Buzz as such, but Buzz's logic (templates, brand assets, bulk create) is fine as the model. **The agent plays the active role**: it will be used very heavily in Social, so entering Social mode must bring up **an interface built around the agent**, not Design's chrome with a chat tucked in a tab.

Motion (round 8) is built: `docs/motion.md` "Motion status" (2026-10-18) — nothing it lists as remaining blocks Social. This file is the contract agents **18a–18d** build from; the shared types of §9 are committed by the main session before them and decide. Figma has no Social mode. Figma's names are used where they exist (Motion, libraries, variables, components, component properties, Dev Mode, Export frames to PDF, the frame tool's **Social Media Presets**); everything else is [ours]. The UI is English, every string through `t` with its Turkish entry (`src/shared/i18n/tr/editor.ts`).

**Status (2026-10-18):** the pre-round commit (§9) and 18a, the shell, are built on §12's proposed defaults (pending the owner's confirmation) — §13 "As built — 18a"; 18b, 18c and 18d are next.

**Round 18 changes no engine code and no schema.** Everything is chrome, shared TypeScript and the agents' tools over existing engine commands; posts, templates and campaigns are plugin data (schema `pluginData`, 204) under a reserved plugin ID. `npm run engine:test` only has to stay green.

## 1. Decisions

1. **Social is a mode of a Design file.** `EditorMode` (`src/renderer/src/ds/components/EditorToolbar.tsx`) gains `"social"`; `EDITOR_MODES` reads **Draw / Design / Social / Motion / Dev Mode** (Social: icon `24.social` [ours], no shortcut, no badge); `UIState.mode` (`editor/uiStore.ts`) takes `"social"`; `FileMeta.editorType` stays `"design"`. One document, one engine, one undo: Draw's tools, Design's panels, Motion's timeline and the agents act on the same frames with no conversion. Switching modes never changes the document and is not an undo step. A view-only file can enter Social (it reads posts; every write control is disabled, as in Design).
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
