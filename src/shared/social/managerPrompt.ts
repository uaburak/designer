/**
 * The manager's Social paragraph (docs/social.md §7.4), appended by shared/studio/managerPrompt.ts when the view is in
 * Social mode; the line a worker's prompt gets about Social's tools; and the starter templates' brief (§4.2), sent by
 * Templates › "Make starter templates…". Pure — the view gives the board's brand and campaigns (names and counts only:
 * get_board gives the rest).
 */
import type { SocialPromptContext } from "./types";

export function socialPrompt(ctx: SocialPromptContext): string {
  const brand = ctx.brand ? `${ctx.brand.name} (${ctx.brand.id})` : "none picked — ask which brand when it matters";
  const campaigns = ctx.campaigns.length ? ctx.campaigns.map((c) => `- ${c.name} (${c.id}): ${c.posts} post${c.posts === 1 ? "" : "s"}`).join("\n") : "- (none yet)";
  const unplaced = ctx.unplaced ? `\n- ${ctx.unplaced} post${ctx.unplaced === 1 ? "" : "s"} outside any campaign` : "";
  return `[Social mode. The owner is on the Social board: posts are top-level frames carrying a record (format, brand, products, campaign, caption, hashtags, alt text, status), in rows by campaign.

The board's brand: ${brand}. Campaigns on this page:
${campaigns}${unplaced}

How to work here:
- Read the board first: get_board in every Social turn, before anything else.
- Formats: Instagram and LinkedIn first (list_formats gives every format with its size, safe area and limits). Use the catalogue's ids ("instagram.post", "instagram.story", "linkedin.landscape" …) in new_post and make_posts.
- Posts from a sentence: make_posts with the catalogue's format ids and the campaign's name. Use a template when one fits (list_templates; new_post with templateKey, then fill_slots); never draw over a template's locked slots. None fits: the frame is drawn as before, and once it is done offer save_as_template (ask_choice).
- The words: each post's caption, hashtags and alt text with set_post — in the brand's tone, within the format's caption limits (set_post answers the count), Turkish unless the owner asks otherwise. The hashtags go in hashtags, not in the caption.
- Other sizes: resize_post {formatId, duplicate: true} ("make the LinkedIn version"), then check_posts.
- Video: resize_post to the video format, set_timeline {duration}, add_animation / apply_animation_style; every video at most the format's length (list_formats' video limits); then check_posts.
- Review: check_posts finds the rule problems (caption, safe area, logo, contrast, video); review / report_review the visual ones (kinds safe-area, caption, contrast, logo, video too). Both show on the canvas as pins. Fixes: caption → rewrite it yourself with set_post; video → retime it yourself (set_timeline); safe-area, contrast, logo → a relayout (report_review starts it). A message "Fix on ‹post› …" from the Post section names one problem: fix it, then check_posts.
- After a review passes, suggest at most one round of follow-ups: ask_choice {suggestions: true} with at most three short options ("Story's animated version?", "LinkedIn carousel from these?"). Never start work the owner didn't ask for.
- Export only when asked: export_posts.]`;
}

/** The line a worker's prompt gets in Social (its task may make or change posts). */
export const SOCIAL_WORKER_LINE =
  "[Social mode: posts are top-level frames with a record — new_post makes one at a format's size, set_post writes its caption / hashtags / alt text, fill_slots fills a template's slots, check_posts checks the format's rules (safe area, caption, logo, contrast, video). Keep text and logo out of the format's safe-area bands.]";

/** The starter templates' brief (§4.2, §4.2a): sent to the manager by Templates › "Make starter templates…". */
export const STARTER_BRIEF = `Make the starter templates for Social mode (docs/social.md §4.2), for the owner to review on the canvas before he publishes them — publish nothing yourself.

1. Work in a new file "Social templates" in Drafts with the Brands library enabled (make_brand_library first when there is none; ask before).
2. For Instagram and LinkedIn, one component set per template, with a Format variant per format — instagram.post, instagram.square, instagram.story, linkedin.landscape, linkedin.square, linkedin.portrait (animated sets also instagram.reel):
   - Product hero (static): picture, headline, label, logo.
   - Product hero (animated): picture scale-in, headline TextStagger, logo fade at the end.
   - Quote / statement (static): background, headline, body, logo.
   - Announcement (static): headline, body, CTA, picture.
   - Carousel cover + slide (static).
   - Story / Reel (animated, 9:16 only: instagram.story and instagram.reel): picture, headline, CTA.
3. Wire every slot (docs/social.md §3.3): texts to TEXT component properties with their font family bound to Font/Heading or Font/Body; the logo an instance of the Brands library's Logo set; colours bound to the Brand collection's Color/* variables; the picture an image fill (scale mode FILL). Keep text and logo out of each format's safe area (list_formats).
4. Animated sets: Motion presets as listed (add_animation / apply_animation_style), each within its format's length — Product hero (animated) 6 s, Story / Reel 8 s, on a 30 fps grid (the Instagram reel preset's rate); the logo's fade ends on the last frame. Then export_posts {preset: "auto"} on a post made from each animated set, to see the MP4 within its format's limits (no warnings in the answer).
5. save_as_template on each set (name, slots with role, locked where the layout depends on it, maxChars for texts), then check_posts on a post made from each, and tell the owner to review them and press Publish.`;
