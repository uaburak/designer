# Social (plan, round 18 [ours]; written 2026-10-17, revised the same day — docs only, not yet a contract)

The owner's request (2026-10-17, his words, translated): next to **Design** and **Dev Mode** in the toolbar's mode switch, a **Social** mode — an interface arranged entirely for social media content. Ready **templates** per platform (Instagram, LinkedIn, …) fed from the **Brands** panel; the **agent** works here too; our **drawing modes** work here too; and it makes **videos**, built the way Figma's **Motion** builds them. Motion doesn't exist yet in the app and is added first, "directly as in Figma, with everything".

**Owner's answers, 2026-10-17:** Social is **a mode of the same document** (confirmed). Not Figma Buzz as such, but Buzz's logic (templates, brand assets, bulk create) is fine as the model. **The agent plays the active role**: it will be used very heavily in Social, so entering Social mode must bring up **an interface built around the agent**, not Design's chrome with a chat tucked in a tab.

This file is the general plan. Each step gets its own contract (as `docs/motion.md`, `docs/studio.md`) before agents start. Figma has no Social mode; Figma's names are used where they exist (Motion, libraries, variables, Dev Mode), everything else is [ours].

## 1. Decisions

1. **Social is a mode of a Design file** (`EditorMode` gains `"social"`; the switch reads **Draw / Design / Social / Motion / Dev Mode**; `FileMeta.editorType` stays `"design"`). One document, one engine, one undo: Draw's tools, Design's panels, Motion's timeline and the agents all act on the same frames with no conversion. Switching modes never changes the document.
2. **The agent is the primary input in Social; the canvas is where its work lands.** Every Social action has two entry points: a sentence to the agent, and a direct control (button, field, drag) that does the same thing without the agent. The direct controls are built as `runEditorCommand` commands, and the agent's tools call the same commands, so the two never drift (`docs/studio.md` §2's manager and workers stay the machinery).
3. **A post is a top-level frame carrying a `SocialPost` record** (platform, format, brand, product, caption, hashtags, alt text, status, campaign). Stored as the frame's plugin data under our namespace in the first round (no schema change); promoted to schema fields only if search or multiplayer needs it. Everything the post is made of is ordinary Design.
4. **Templates are components with brand-bound slots** (logo → instance swap, colours → variables, fonts → text styles, product picture → image fill, headline / body / CTA → text properties), one component set per template with a variant per format. They live in library files and travel through the existing libraries (publish, enable, review updates). A **Social template** flag and the slots' roles are component plugin data; Buzz's locked fields are the model for what an editor may change inside an instance.
5. **Brands feed templates through a generated brand library** (`Brand.libraryFileKey` already exists): a colour collection (one mode per brand), text styles from `Brand.fonts`, logo components from its pictures. Applying a template to another brand = swapping the library and variable mode, not copying values.
6. **Video = Motion.** A post's frame is a Motion timeline root (`docs/motion.md` §3.5); animated templates carry their presets. Export is Motion's Animated export (§7) with platform presets on top. No separate video editor.
7. **Export only, no publishing to the platforms** in this round (scheduling / Graph API later through `docs/agents-reach.md` if the owner wants it).

## 2. Step 1 — Motion (round 8, unpaused)

Round 8 is contracted (`docs/motion.md`, corrected 2026-10-15 from Figma's code) and was deferred (`docs/roadmap.md` "Round 8"). Social video depends on it, so it goes first, as written: pre-round (schema with Figma's numbers, `engine:gen`, `src/shared/motion/types.ts`, stubs) → 8a engine model (evaluator, tracks, motion layer, player) → 8b engine editing (commands 330–349, auto-keyframe, anchor, motion paths) → 8c Motion mode + timeline + audio → 8d right panel (diamonds, Animations, easing editor, Easing / Timing variables) → 8h `figma:motion` runtime and presets → 8e export (MP4 / WebM / GIF / SVG / Lottie) → 8f Dev Mode tab, plugin API, REST, **agents' motion tools**.

`docs/motion.md` §12.1 still asks for one signed-in capture and a Motion sample `.fig`; without them the chrome's metrics stay [unverified] and we build with our constants (owner, 2026-10-12).

## 3. Step 2 — Social mode: the agent-first interface

### 3.1 Layout when the mode switches to Social

Figma's chrome rearranges around the agent (all metrics [ours], from DS tokens):

```
┌ rail ┬ left panel (Brand · Posts) ┬────────── canvas: the board ──────────┬ right panel: Agent ─────┐
│ File │ Brand ▾  Partner Agro      │  Campaign "Liq Humus — October"        │ Chat (manager)          │
│ Agents│ ─────────────────────────  │  ┌ Post 1080×1350 ┐ ┌ Story 9:16 ┐    │ ▸ brief card            │
│ Assets│ Posts            + New    │  │                │ │            │     │ ▸ task cards            │
│ Brands│ ▣ Liq Humus — Post v1  ✓  │  │  (frame)       │ │            │     │ ▸ review card           │
│ Tools│ ▣ Liq Humus — Post v2  ⚠  │  └────────────────┘ └────────────┘     │ ───────────────────     │
│      │ ▣ Liq Humus — Story v1 ●  │  ┌ LinkedIn 1200×627 ┐                 │ Post ▸ (properties)     │
│      │ ─────────────────────────  │  │                   │                 │ Design ▸ (collapsed)    │
│      │ Templates  [gallery]      │  └───────────────────┘                 │ ───────────────────     │
│      │                           │   [toolbar: Design + Draw tools · Social] │ composer  +  model ⟳ ▶ │
└──────┴───────────────────────────┴──────────── timeline (Motion, when a post animates) ──────────────┘
```

- **Right panel = the Agent panel**, full height, by default (`ui.mode === "social"` mounts `SocialRightPanel`). It is the existing `AgentsPanel` (chats, composer, task / choice / form / review cards from `docs/studio.md` §2.3–2.4, §6) with the **manager on by default in Social** (`ManagerSettings.on` is forced on for Social turns; the composer's agent picker stays for direct worker turns). Under the chat, two collapsible sections: **Post** (§3.3) and **Design** (Design's sections for the selected layer, collapsed by default). A segmented control at the panel's top, **Agent | Properties**, lets the owner give the whole panel to properties when hand-editing; the chat keeps streaming in the Agent tab's badge.
- **Left panel = Brand and Posts.** A **brand picker** at the top (the brands from `BrandsRepository`; "Manage brands…" opens the Brands tab). Then **Posts**: the page's posts grouped by **campaign** (a row of frames = one campaign, as `docs/studio.md` §5.1 lays them out), each row with a thumbnail, name, format, state glyph (✓ reviewed, ⚠ problems, ● draft, ▶ animated) and a context menu (Resize to…, Duplicate for…, Ask agent…, Export). Selecting a post selects its frame and zooms to it. Below, **Templates** (§4.3) as a collapsible gallery. Layers and Pages are reachable through the rail's File tab, unchanged.
- **Canvas = the board.** Posts in rows per campaign; each frame's title shows the format's name and the platform's glyph; a **safe-area overlay** per format (the zones a platform's UI covers: Reels / Story top and bottom bars, LinkedIn's feed crop) drawn by the engine's overlay (`render/Overlay`, `OverlayStyle::socialSafeArea*`), toggled from the toolbar; the agent's review problems (§3.4) drawn as numbered pins on the frames. Frames outside the board (not posts) are drawn normally — the owner may draw anywhere.
- **Toolbar**: the same `EditorToolbar` with Design's and Draw's tools (pen, pencil, brush, the vector edit toolbar — nothing new to learn); a **Social** slot [ours] holding **New post** (platform › format), **Safe areas** (toggle) and **Table** (§4.4). The mode switch's Social segment.
- **Bottom**: Motion's timeline mounts when the selected post has a timeline (the same `editor/motion/timeline/` component with its Social header: the format's video limits shown next to Duration, red when exceeded).
- **Empty state** (a new file, no brand or posts): the canvas shows a centred card — "Tell the agent what to make" with three example prompts, a brand picker and "Start from a template" — and the composer is focused.

### 3.2 The agent in Social

The manager (`docs/studio.md` §2) is the owner's counterpart in Social. Its Social system prompt (`src/shared/social/managerPrompt.ts`, appended to Studio's) knows the board, the brand, the templates and the platform rules. What it does, beyond Studio's `make_posts` loop:

- **Understands the board.** `get_board` → campaigns, posts (format, brand, product, status, caption, timeline yes / no, problems). The chat shows the selected posts as context chips, as layers are shown today.
- **Makes posts from a sentence.** "Liq Humus için bu hafta Instagram post + story, LinkedIn de olsun" → brief card (brand, products, platforms × formats, scene, variations, template) → tasks: picture (Studio's image route), `apply_template` (worker), captions, review. Templates replace drawing frames from scratch; if no template fits, the worker draws one as today and offers to save it as a template.
- **Writes the words**: caption, hashtags, alt text, in the brand's tone and the platform's limits (character counts, hashtag counts, LinkedIn's "see more" fold at ~210 characters [to verify]) — `set_caption`. Turkish and English.
- **Resizes and adapts**: `resize_post {format}` through the template's variant; "make the LinkedIn version" duplicates with the variant swap and re-runs review.
- **Animates**: "6 saniyelik Reels yap" → duplicate to 9:16, `add_animation_style` (Motion's presets: fade / move / scale in, Text enter per line, logo out), `set_duration`, platform export preset. Motion's tools are 8f's.
- **Reviews and fixes** (Studio §6, extended): sharp texts, product fidelity, safe areas, caption limits, contrast of text over picture, a logo present once, the video within the format's length. Problems become pins on the frames and the review card; "Fix selected" runs the fix loop.
- **Suggests** [ours]: after a review passes, one line in the chat — "Story's animated version? / LinkedIn carousel from these three?" — as choice chips, never unprompted tasks.
- **Exports** on request: `export_posts {postIds, preset}` → the same files the Export dialog makes, into a folder the owner picks once per chat.

Every agent write stays one undo step per turn (`agents/turns.ts`), and every tool is a thin wrapper over an editor command, so the direct controls in §3.3 and the agent do exactly the same thing.

### 3.3 Post section (direct controls)

Above Design's sections for a selected post: **Platform** and **Format** (a size switch that resizes through the template's variant), **Brand**, **Product** (from the brand's products; picking one fills the picture slot), **Template** (swap), **Caption** (a text area with the platform's counter), **Hashtags**, **Alt text**, **Status** (Draft / Reviewed / Approved / Exported), **Ask agent…** (puts "About ‹post›: " in the composer with the post as context). For a selected template slot inside the post: its role and the field it is bound to.

### 3.4 Review on the canvas

Review problems (`ReviewReport`, `docs/studio.md` §6) get a canvas presence: numbered pins at each problem's box (the comments' pin style, a warning colour token), hover shows the problem, click selects it in the review card. Pins clear when the problem's fix lands or the owner says Leave as is.

### 3.5 Formats

`src/shared/social/formats.ts` (extends `DEFAULT_FORMATS`): Instagram post 1080×1350 / 1080×1080, Story and Reels 1080×1920, carousel (n × 1080×1350); LinkedIn post 1200×627 / 1080×1080 / 1080×1350, document carousel (PDF), video; Facebook post / story; X 1600×900; TikTok 1080×1920; YouTube thumbnail 1280×720 and Shorts 1080×1920; Pinterest 1000×1500. Each with its safe area, caption and hashtag limits and video limits (length, fps, codec, size). The numbers are re-checked against each platform's current help pages in the contract step; the catalogue is data, so the owner can edit it in Settings.

## 4. Step 3 — Templates and the brand kit

### 4.1 Brand library generation
"Create brand library" on a brand's page (Brands panel) builds or updates its library file: a colour collection (one mode per brand when several brands share templates), text styles from `Brand.fonts`, logo components from the logo pictures; `Brand.libraryFileKey` points at it. The agent calls the same command when a brand is created in the chat.

### 4.2 Template library
A starter set per platform and format, static and animated, shipped as a library file with the app (made in the app itself, by the agent, and reviewed by the owner); the owner's own templates are any published component carrying the Social template flag ("Save as template" on a post's frame, or the agent's offer in §3.2).

### 4.3 Templates gallery
In the left panel: filtered by platform / format / static or animated / brand fit; previews from the existing thumbnails; click or drag inserts an instance bound to the picked brand, with the slots filled from the brand (logo, colours, fonts) and the picked product (picture, sharp texts where the template has a label field).

### 4.4 Bulk create and Table view (Buzz's model)
A **Table** of the board's posts (one row per post: thumbnail, format, headline, body, CTA, caption, status), editable in place; **Import rows** from CSV / XLSX makes one post per row × format from a template; the agent can fill the table ("write five variations of the headline").

## 5. Step 4 — Video

- Every post can have a timeline (Motion). Animated templates come with presets already placed.
- **Export presets** on Motion's Animated tab: Instagram Reels, Story, LinkedIn video, TikTok, YouTube Shorts (size, fps, codec, bitrate, max length checked against the format); **Export campaign** as one zip (`export_posts`).
- Audio: Motion's audio clips (§6.6) — a music track per post.
- Later, optional: clips from a video model (as image routes today) as VIDEO fills inside the timeline.

## 6. Shared types (sketch, fixed in the contract)

```ts
// src/shared/social/types.ts
export type Platform = "instagram" | "linkedin" | "facebook" | "x" | "tiktok" | "youtube" | "pinterest";
export interface PlatformFormat extends SocialFormat { platform: Platform; kind: "image" | "carousel" | "video"; safeArea: Insets; caption?: { max: number; fold?: number; hashtags?: number }; video?: { maxSec: number; fps: number[]; codec: "h264"; maxMb: number } }
export interface SocialPost { id: string; nodeId: string; campaignId: string; formatId: string; brandId: string; productIds: string[]; templateKey?: string; caption: string; hashtags: string[]; altText: string; status: "draft" | "reviewed" | "approved" | "exported"; problems: ReviewProblem[] }
export interface SocialTemplate { componentKey: string; name: string; formats: string[]; animated: boolean; slots: TemplateSlot[] }
export interface TemplateSlot { nodeId: string; role: "logo" | "picture" | "headline" | "body" | "cta" | "label" | "accent"; locked: boolean }
```

Agent tools (`src/shared/agents/tools.ts`, Social group; manager and workers): `get_board`, `new_post`, `apply_template`, `fill_slots`, `resize_post`, `set_caption`, `set_post_status`, `list_templates`, `save_as_template`, `export_posts`; manager-only: `make_campaign` (Studio's `make_posts` with templates and captions).

## 7. Ownership (proposed, after Motion)

| Agent | Owns | Delivers |
|---|---|---|
| 18a shell | `editor/social/` (new: `SocialMode.tsx`, `SocialLeftPanel.tsx`, `PostsList.tsx`, `PostSection.tsx`, `SocialRightPanel.tsx`), `EditorToolbar.tsx` (the Social segment and slot), `EditorApp.tsx` (panel mounts per mode), `uiStore.ts`, `src/shared/social/` (types, formats), engine overlay (safe areas, pins) | §3.1, §3.3, §3.4, §3.5 |
| 18b templates | brand library generation (`editor/studio/brandLibrary.ts`), the template flag and slots, the gallery, the starter library file, Table view and import | §4 |
| 18c agent | `src/shared/social/managerPrompt.ts`, the Social tools in `shared/agents/tools.ts` + `editor/agents/socialTools.ts`, `make_campaign`, review extensions, suggestions, `export_posts` | §3.2 |
| 18d video | export presets, campaign zip, animated starter templates, the timeline's Social header | §5 |

Merge order: 18a → 18b → 18c → 18d. Each round ends with `npm run check` and `npm run engine:test` green.

## 8. Order overall

Motion pre-round → 8a, 8b → 8c, 8d, 8h → 8e, 8f → Social contract (this file rewritten as a contract, formats verified) → 18a → 18b → 18c → 18d.

## 9. Open for the owner

1. Right panel default in Social: the Agent panel full height with Post / Design collapsed under it (proposed), or a two-pane split (chat above, properties below)?
2. Which platforms first (proposed: Instagram and LinkedIn; the rest as catalogue entries only)?
3. The Motion capture of `docs/motion.md` §12.1 — a sample `.fig` and a signed-in recording.
4. Should the starter templates be made by the agent in the app (proposed) or imported from a Figma file the owner designs?
