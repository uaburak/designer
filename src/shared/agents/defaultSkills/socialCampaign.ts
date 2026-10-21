import type { DefaultSkill } from "./types";

export const SOCIAL_CAMPAIGN: DefaultSkill = {
  name: "social-campaign",
  description:
    "Make a series of social media posts on brand in Wecra's Social mode: a campaign on the board, formats from the catalogue, templates and slots, the brand's colours, fonts and logo, captions and hashtags within limits, a consistent series with variation, checks and export. Use when asked for posts, a campaign, carousels, stories, reels covers or ads for a brand.",
  instructions: `## 1. Read the board and the brand
- get_board first (every Social turn): the board's brand, campaigns, posts, their status and problems.
- The brand: the brand-guidelines skill (variables / Brand collection modes, Logo component, fonts, tone). Products and their pictures come from Studio's Brands library (the manager's library tools; as a worker you get them in the task).
- Formats: list_formats {platform, brandId} — size, safe area (pixels the platform's UI covers), caption limits (max, fold, hashtags, mentions). Never guess a size.
- Templates: list_templates {platform, formatId} — slots (logo, picture, headline, body, cta, label, accent, background), locked slots, maxChars.

## 2. Plan the series
- One idea for the campaign and 3–6 messages (one per post or per carousel card). A series looks related (same grid, type, logo place, colour system) and varies one thing (picture, accent colour from the brand, layout mirror).
- Write the copy first: headline ≤ 6–8 words, body ≤ 20 words, one CTA. Turkish copy per the turkish-microcopy skill. Caption: hook in the first line (before the fold), then value, then CTA; hashtags 3–8, relevant, brand tag first.

## 3. Make the posts
- set_campaign {name, brandId} to add the campaign (or use the board's).
- new_post {formatId, campaignId, brandId, productId?, templateKey?, variant?} per post; it lands in the campaign's row. With a template, fill_slots {values: {headline, body, cta, label}, picture} — respect maxChars and locked slots. Without a template, build the frame with create_nodes: auto layout, brand variables bound, logo instance, a bottom layer "Picture" for the image.
- Many formats of one post (feed 1080 × 1350, story 1080 × 1920, square 1080 × 1080): make the main one, then new_post for each format with the same content (or apply_template with the other Format variant), re-laid out — not scaled.
- Keep text and logo inside the safe area; text over pictures gets a scrim or a solid band for contrast.
- Captions and metadata: set_post {caption, hashtags (without #), altText, status: "draft"}; it returns the caption count against the format.
- Motion posts: animate the post frame (motion-opus skill) and keep it inside the format's video limits.

## 4. Check and fix
- check_posts: caption / hashtag / mention counts, safe area, video duration, a missing or doubled logo, text contrast over its backdrop. Fix every problem, then run it again.
- get_screenshot of the campaign row: the series reads as one family; nothing cropped; no two posts identical (duplicates show as duplicateOf in get_board).
- As the manager: the review loop (review → report_review) for generated pictures.

## 5. Deliver
- set_post {status: "reviewed"} when checked; "approved" is the owner's.
- export_posts {campaignId, preset: "auto"} when asked (stills as JPEG / PNG, animated as MP4; one zip for many).

## Checklist
- [ ] get_board read; brand, formats and templates from the catalogue
- [ ] Series idea; copy written first; captions with a hook and 3–8 hashtags
- [ ] Posts via new_post / templates / fill_slots; brand tokens and logo instance
- [ ] Each format re-laid out; text and logo in the safe area; contrast ok
- [ ] check_posts clean; captions within limits; status set
- [ ] Exported with export_posts when asked`,
};
