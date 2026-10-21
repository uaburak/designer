import type { DefaultSkill } from "./types";

export const BRAND_GUIDELINES: DefaultSkill = {
  name: "brand-guidelines",
  description:
    "Apply a brand consistently in Wecra: find the brand (the file's variables and styles, an enabled brand library, Studio's Brands library), then use only its colours, fonts, logo, tone and spacing; flag what is off-brand. Use when asked to make something on-brand, to brand a design, or to check a design against a brand.",
  instructions: `## 1. Find the brand (in this order; stop when you have it)
1. This file: get_variable_defs {all: true} — a collection named "Brand", "Color", "Theme" or similar, often with a mode per brand; text styles and paint styles from get_design_context of existing frames.
2. Libraries: get_libraries — a library like "Brands" or the company's design system (enabled or not). If it holds the brand and isn't enabled, ask before set_library_enabled {enabled: true}. Use its published variables and components (get_libraries {assets: key}, insert_library_component).
3. Studio (Social mode): get_board shows the board's brand and campaigns; Studio's Brands library (logos, colours, fonts, tone, products) is what make_brand_library turns into a "Brands" library file — one Brand collection with a mode per brand, colour and font variables, text styles, a Logo component set with a Brand variant per brand. If no brand library exists and you are the manager, suggest make_brand_library (the owner confirms; publishing stays his click).
4. Nothing found: ask the owner for the logo, 2–3 colours, fonts and tone (ask_choice or a short question). Never invent a brand silently.

Write the brand down for yourself before designing: primary / secondary / accent colours (hex and variable names), neutrals, heading and body fonts with weights, logo component and its variants, corner radius and spacing habits, photo style, tone of voice in three adjectives, and the don'ts.

## 2. Apply it
- Colours only through the brand's variables (bind_variable / apply_variable on fills and strokes) or its paint styles (apply_style). A raw hex that equals a brand colour must become the variable.
- Brand modes: when the collection has a mode per brand, put the whole frame in the brand's mode with set_variable_mode {nodeIds: [frame], collectionId: "Brand", mode: "<Brand>"} instead of rebinding layers.
- Type: the brand's text styles (apply_style); otherwise its families with the brand's weights only. No third font.
- Logo: an instance of the brand's Logo component (insert_library_component, or duplicate an existing instance), never a re-drawn or recoloured copy. Keep clear space of at least the logo's cap height; never stretch (scale proportionally), never on a busy photo without a plate; pick the variant (positive / negative / mark) by the background.
- Shape language: the brand's radius and stroke weight everywhere (bind cornerRadius to the radius variable if there is one).
- Tone: headlines and buttons in the brand's voice; Turkish copy per the turkish-microcopy skill.
- Photography: place_image into frames shaped and cropped the way the brand does; colour treatments from the brand only.

## 3. Check a design against the brand
- get_design_context of the frame: list every fill, stroke, font and radius that is not bound to a brand variable or style (variables appear as bound values; a raw value is a miss).
- Report as a short table: layer → what is off → the brand's token to use. With the owner's go-ahead fix them in one pass (bind_variable / apply_style), or leave comments (add_comment on the layer) when asked to review only.
- Social posts: check_posts also flags a missing or doubled logo, safe-area and contrast problems — run it on post boards.

## Checklist
- [ ] Brand found and summarised (colours, type, logo, radius, tone, don'ts)
- [ ] Every colour and text bound to brand variables / styles; brand mode set
- [ ] Logo as an instance, right variant, clear space kept
- [ ] No third font, no off-brand colour, brand radius everywhere
- [ ] Copy in the brand's voice; off-brand items reported or fixed`,
};
