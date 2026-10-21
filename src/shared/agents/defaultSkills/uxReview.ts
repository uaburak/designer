import type { DefaultSkill } from "./types";

export const UX_REVIEW: DefaultSkill = {
  name: "ux-review",
  description:
    "Review a design's UX heuristically and leave findings as comments pinned on the layers (add_comment): Nielsen's heuristics, hierarchy, spacing, consistency, states, copy, flows. Use when asked to review, critique, audit the UX of, or give feedback on screens or a prototype.",
  instructions: `Review like a senior designer: specific, located, ranked, with a fix. Don't change the design unless asked.

## 1. Gather
- get_selection (the screens to review; nothing selected: ask or take the page's top-level frames from get_metadata).
- get_screenshot of each screen; get_design_context for spacing, styles and states; get_prototype for flows and interactions; get_comments to avoid repeating open threads.
- Know the task: what the user of this screen is trying to do. If unclear, state your assumption at the top of the summary.

## 2. Look through these lenses
1. Visibility of status — loading, saving, progress, selected / current item, errors shown where they happen.
2. Match with the real world — words users use (Turkish copy: turkish-microcopy skill), natural order, familiar icons with labels.
3. User control — back, cancel, undo, close on overlays, escape from flows; destructive actions confirmed.
4. Consistency — same thing looks and is named the same everywhere: buttons, spacing, radius, icon style; platform conventions (web vs iOS vs Android).
5. Error prevention and recovery — constraints, defaults, inline validation, messages that say what happened and how to fix it.
6. Recognition over recall — visible options, labels on inputs (not placeholder-only), recent items.
7. Efficiency — primary path short; keyboard and bulk actions where experts need them.
8. Minimalist design — every element earns its place; one primary action per view.
9. Hierarchy — the eye lands on the most important thing first (squint test on the screenshot); headings, size, weight and colour in a clear order; no two equal-weight primaries.
10. Spacing and alignment — one spacing scale, related things closer than unrelated (proximity), consistent edges; ragged alignments listed with the layers.
11. States — every interactive component has default / hover / pressed / focus / disabled (component-authoring skill); screens have empty, loading, error, partial and overflow (long names, 1 vs 1,000 items) states.
12. Accessibility basics — contrast, target sizes, text sizes (details in accessibility-audit).

## 3. Write findings
- One comment per finding, pinned on the exact layer: add_comment {nodeId, message}. Format:
  "[Severity] Heuristic — what is wrong and why it matters. Fix: concrete change."
  Severity: Critical (blocks the task), Major (slows or confuses most users), Minor (polish), Note (idea).
  Example: "[Major] Visibility of status — after 'Kaydet' nothing confirms the save. Fix: a toast 'Değişiklikler kaydedildi' (overlay, bottom-center, 3 s), and the button shows a spinner while saving."
- Don't mention people (mentions notify; the owner confirms). Keep each under ~400 characters; group repeats ("same on 4 cards") instead of 4 comments.
- 5–15 comments for a screen is typical; fewer, sharper ones beat a long list.

## 4. Summarise in the chat
Three to six lines: the overall verdict, the top three issues by severity, and what is good (so it isn't changed). Offer to fix the Critical and Major ones; fixes are a separate step after the owner says yes.

## Checklist
- [ ] Task and user stated; screenshots, context, prototype read
- [ ] All lenses checked, including states and edge-case content
- [ ] Each finding pinned on its layer with severity, heuristic and a fix
- [ ] Repeats grouped; no mentions; no edits unless asked
- [ ] Short ranked summary with an offer to fix`,
};
