# Social (plan, round 18 [ours]; written 2026-10-17, docs only — not yet a contract)

The owner's request (2026-10-17, his words, translated): next to **Design** and **Dev Mode** in the toolbar's mode switch, a **Social** mode — an interface arranged entirely for social media content. Ready **templates** per platform (Instagram, LinkedIn, …) fed from the **Brands** panel; the **agent** works here too; our **drawing modes** work here too; and it makes **videos**, built the way Figma's **Motion** builds them. Motion doesn't exist yet in the app and is added first, "directly as in Figma, with everything".

This file is the general plan. Each step below gets its own contract (as `docs/motion.md`, `docs/studio.md`) before agents start. Figma has no Social mode; its closest product is **Figma Buzz** (templates with locked fields, brand assets, bulk create — set aside as round 11 on 2026-10-11). Names here are [ours] unless Figma's.

## 1. Decisions proposed (owner to confirm, §7)

1. **Social is a mode of a Design file, not a file type** — as Draw and Motion (`docs/draw.md`, `docs/motion.md` §3). One document, one engine, one undo: Draw's tools, Design's panels, Motion's timeline and the agents all work on the same frames with no conversion. `FileMeta.editorType` stays `"design"`. The switch reads **Draw / Design / Social / Motion / Dev Mode** (`EditorMode` gains `"social"`; `ds/components/EditorToolbar.tsx` `EDITOR_MODES`, icon new).
2. **A social post is a top-level frame with a format** — the platform and format are stored on the frame (a plugin-data style field, no schema change in the first step; a schema field later only if needed). Everything else about it (layers, auto layout, components, variables) is ordinary Design.
3. **Templates are components** (component sets with variants per format) whose fields are **slots bound to the brand**: logo (instance swap), colours (variables), fonts (text styles), product picture (image fill), headline / body / CTA (text properties). Templates live in a library file and are published / enabled through the existing libraries (Phase 4), so updates are reviewed and accepted the Figma way. Buzz's locked fields are the model for which slots an editor may change.
4. **Brands feed the templates through a brand library.** Each brand (`src/shared/studio/types.ts` `Brand`) gets a generated library file (`Brand.libraryFileKey`, already in the type): colour variables, text styles, logo components. Applying a template to a brand = swapping the variable mode / library, not copying values.
5. **Video = Motion.** A post's frame is a Motion timeline root (`docs/motion.md` §3.5); animated templates carry their timeline and presets. Export is Motion's Animated export (§7: MP4, WebM, GIF, Lottie) with platform presets on top. No separate video editor.
6. **The agent is the same Agents panel and manager** (`docs/studio.md`), with Social and Motion tools added; `make_posts` targets templates instead of drawing frames from scratch.

## 2. Step 1 — Motion (round 8, unpaused)

Round 8 is contracted (`docs/motion.md`, corrected 2026-10-15 from Figma's code) and deferred (`docs/roadmap.md` "Round 8"). Social video depends on it, so it goes first, as written:

| Agent | Delivers |
|---|---|
| pre-round (main session) | schema (KEYFRAME 56 / KEYFRAME_TRACK 57 / ANIMATION_PRESET_INSTANCE 58 and the motion fields, current build's numbers), `engine:gen`, `src/shared/motion/types.ts`, Engine / abi / codec stubs, icons |
| 8a engine model | evaluator, tracks, interpolation, motion layer (preview writes), text stagger, render at t, player |
| 8b engine editing | commands 330–349, auto-keyframe, anchor point tool, motion path gestures, ownership in delete / duplicate / clipboard |
| 8c Motion mode | the mode switch enabled with the Beta tag, the timeline panel, clock, audio |
| 8d right panel | keyframe diamonds, Animations section, Motion transform, easing menu + Custom bezier / spring, Easing / Timing variables |
| 8e export | Animated tab: MP4 / WebM (WebCodecs), GIF, animated SVG, Lottie / dotLottie, audio mix |
| 8h presets | the `figma:motion` runtime and Figma's preset catalogue |
| 8f Dev Mode etc. | Motion tab (CSS / React / JSON), plugin API, REST, **agents' motion tools** |

Before it starts, `docs/motion.md` §12.1 still asks for one signed-in capture and a Motion sample `.fig` (the owner can make one in Figma Motion); without it the chrome's metrics stay [unverified] and we build with our constants (owner, 2026-10-12).

## 3. Step 2 — Social mode shell

- **Mode**: `ui.mode = "social"`, View › Switch to Social, the toolbar segment. Leaving it keeps every frame as is.
- **Left panel**: the rail opens on **Brands** (already built, `editor/studio/BrandsPanel.tsx`) and a new **Templates** item; Layers and Pages stay.
- **Canvas**: posts arranged as a board — one row per campaign / request, the format's name and platform icon in the frame title; a **safe-area overlay** per format (the zones a platform's UI covers: Story / Reels top and bottom bars, LinkedIn's crop), drawn by the engine's overlay, toggled from the toolbar.
- **Toolbar**: Design's tools and Draw's tools (pen, pencil, brush, the vector edit toolbar) — the same `EditorToolbar`, no new tool set. A **New post** button: platform › format picker.
- **Right panel**: a **Post** section above Design's sections (platform, format with a size switch that resizes through the template's variant, caption, hashtags, alt text — kept on the frame, not drawn), then Design's sections as usual; Motion's sections when the post has a timeline.
- **Format catalogue** (`src/shared/social/formats.ts`, extends `DEFAULT_FORMATS`): Instagram post 1080×1350 / 1080×1080, Story & Reels 1080×1920, carousel (n frames 1080×1350); LinkedIn post 1200×627 / 1080×1080 / 1080×1350, document carousel, video; Facebook, X (1600×900), TikTok 1080×1920, YouTube thumbnail 1280×720 and Shorts, Pinterest 1000×1500. Each with its safe area and its video limits (length, fps, codec). Sizes to be re-checked against each platform's current help pages in the contract step.

## 4. Step 3 — Templates and the brand kit

- **Brand kit generation**: "Create brand library" on a brand's page builds (or updates) its library file: a colour collection (one mode per brand when several brands share templates), text styles from `Brand.fonts`, logo components from the brand's logo pictures.
- **Template library**: a starter set per platform and format (static and animated), made as components in a library file shipped with the app; the owner's own templates are any component published with a **Social template** flag.
- **Templates panel**: a gallery filtered by platform / format / static or animated, previews from the existing thumbnails; click or drag inserts an instance bound to the selected brand.
- **Fill from brand / product**: picking a product fills the picture slot (Studio's image pipeline, `docs/studio.md` §5.3, or a library photo) and the label texts' sharp texts where a template asks for them.
- **Bulk create** (Buzz's model): a table of rows (CSV / XLSX or typed) → one post per row and format; a **Table view** of the board's posts to edit texts in a grid.

## 5. Step 4 — The agent in Social

- Same Agents panel and manager. New tools (worker and manager): `list_templates`, `apply_template {templateKey, brandId, productIds, format}`, `fill_slots`, `resize_post {format}`, `set_caption`, and Motion's tools from 8f (`add_animation_preset`, `set_keyframes`, `set_duration`).
- `make_posts` (`docs/studio.md` §5.4) gains a template path: picture task + `apply_template` instead of drawing the frame; review (§6) also checks safe areas and the caption.
- "Make a 6-second Reels version" = duplicate the post to the 9:16 variant, apply an animated style, export preset.

## 6. Step 5 — Video

- Every post can have a timeline (Motion). Animated templates come with presets already placed (fade / move / scale in, text enter per line, logo out).
- **Export presets** on Motion's Animated tab: "Instagram Reels", "Story", "LinkedIn video", "TikTok" (size, fps, codec, bitrate, max length checked against the format); **Export all posts** for a campaign as one zip.
- Audio: Motion's audio clips (§6.6) — a music track per post.
- Later, optional: video clips from a video model (as image routes today) placed as VIDEO fills inside the timeline.

## 7. Questions for the owner

1. Social as a **mode** of a Design file (proposed) or a separate file type like Figma Buzz?
2. Order: **Motion first** (round 8 as contracted), then Social — or Social's static parts in parallel with Motion?
3. Which platforms and formats first (proposed: Instagram post / story / reels / carousel, LinkedIn post / carousel / video)?
4. Should the app **publish** to the platforms (Instagram Graph API, LinkedIn API, scheduling) or stop at export? (Proposed: export only now; publishing later through `docs/agents-reach.md`.)
5. The Motion capture of `docs/motion.md` §12.1 — can the owner record one in Figma Motion?

## 8. Order

Motion pre-round → 8a, 8b → 8c, 8d, 8h → 8e, 8f → Social contract (`docs/social.md` rewritten as a contract) → shell → templates + brand kit → agent → video presets → bulk create. Each round ends with `npm run check` and `npm run engine:test` green.
