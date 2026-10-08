# Audit: Design panel vs Figma UI3 (2026-10-08)
Skeleton already right: 240px grid (16/88/8/88/8/24/8), 40px headers, section order Position → Layout → Appearance → Typography → Fill → Stroke → Selection colors → Effects → Layout guide → Export, header actions row, stroke/effect/guide/export/type-settings popovers. Crops: scratchpad/audit/design/crops/. LIVE FIGMA REFERENCE (decides every "unverified"): /Users/burak/Desktop/Burak/Code/DesignerV2/docs/research/figma/live/.

## A. Number fields (ds/components/NumericInput.tsx, ds/util/evaluate.ts, ds/util/scrub.ts)
1 HIGH Math on Mixed / relative: "Mixed+100" adds to each layer; "+100", "*2" relative (help 360039956914). Ours: "+100" → absolute 100 to all (evaluate.ts:22-23), "*2" NaN dropped (:11-29), no per-layer path (NumericInput.tsx:79-81 onStep only arrows). Fix: onExpression(fn) evaluated per layer.
2 LOW `^` exponent (right-assoc, above *).
3 MED Scrub: from label OR Alt-hover over field; vertical cursor position changes speed (2x,1x,1/2,1/4); Shift/arrows big nudge 10. Ours prefix only, Shift ×10, Alt ×0.1 (scrub.ts:10-12, NumericInput.tsx:121-150).
4 MED Prefix-less fields not scrubbable: font size (Typography.tsx:146), effect X/Y/Blur/Spread (Effects.tsx:121-131), stroke Dash/Gap/Miter (Stroke.tsx:208-244), layout guide Count/Width/Gutter (Effects.tsx:249-262) — popover labels should scrub.
5 MED (verify live) Enter: ours exits to canvas (Sections.tsx:129-131); Figma likely commits and keeps field focused/selected. 6 Esc revert vs commit — verify. 7 LOW Tab order skips icon buttons (tabIndex -1 / roving order).
8 HIGH Gap accepts "Auto" (help 31289464393751); ours display-only label (Sections.tsx:287) — onKeyword.
## B. Colour
9 MED 8-digit hex → alpha (help 360043042113); normalizeHex 3/6 only (ds/util/color.ts:10-17).
10 HIGH Paint types: Solid, Gradient (one icon + Linear/Radial/Angular/Diamond dropdown), Pattern, Image, Video; Flip + Rotate gradient (help 34208860210199, 360041003694). Ours 6 icons (ds/util/paint.ts:31-38), no Pattern/Video type, no Rotate (ColorPicker.tsx:460).
11 MED Check color contrast; "+" create colour style/variable from picker (help 360041003774).
12 MED Drag handles to reorder fill/effect/export rows (Paints.tsx:124-150).
## C. Header (DesignPanel.tsx:147-242, Component.tsx:130-400)
13 MED Frame dropdown: presets Phone, Tablet, Desktop, Presentation, Watch, Paper, Social Media, Figma Community, Archive (live capture has the full list with sizes); Frame/Group/Section convert. Ours 3 categories/10 presets (DesignPanel.tsx:34-38).
14 MED Resize to fit (⌥⇧⌘R) button in Layout header (live: "Resize to fit" button at Layout row) — missing.
15 MED Header actions vary per selection (live captures list them per type: frame: Ready for dev toggle, Create component, Use as mask; shape: Create component, Use as mask, Boolean group + dropdown, Edit object; text: Create link, Apply variable, Create component; component: Add variant, Component configuration, More actions) — ours fixed set, Boolean disabled on frames (DesignPanel.tsx:170-191).
16 LOW type labels per type — take from live. 17 LOW instance header check vs live.
## D. Position (Sections.tsx:57-126, Constraints.tsx)
18 LOW Shift-click align = align to parent. 19 MED distribute/tidy for 2+ (verify live). 20 cosmetic rotation range. 21/22 OK (check wording vs live).
## E. Layout / Auto layout (Sections.tsx:139-298, Sizing.tsx)
23 HIGH Individual padding (Default / Individual / Uniform or CSS shorthand "1,2,3,4", ⌘-click uniform) (help 31289464393751, 31289469907863); ours H/V only writing pairs (Sections.tsx:242-267); padH reads only stackHorizontalPadding (:239-240) → Mixed bug; padding fields lack onStep.
24 HIGH Wrap: "Gap between rows" (stackCounterSpacing, own Auto) + stackCounterAlignContent — absent.
25 HIGH Auto layout settings popover: gap "Auto"; "Auto spacing" Between (default)/Evenly/Around; "Text baseline alignment"; Strokes included/excluded; Canvas stacking First on top/Last on top. Ours "Spacing mode Packed/Space between", "Align text baseline" (Sizing.tsx:202-242).
26 LOW alignment box with Auto gap: 3 choices only — check. 27 MED W/H show number + Hug/Fill mode (UI3 blog) vs ours replacing the number (Sizing.tsx:99-108) — verify live.
28 HIGH Group W/H editable (scale children); ours disabled (Sizing.tsx:102,110).
29 MED ⇧A wraps any selection in auto layout frame; Suggest auto layout ⌃⇧A; ours frames only (Sections.tsx:161-167).
30/31 LOW wording: live shows "Lock aspect ratio" (ours "Constrain proportions"); sizing menu ellipsis — check live.
Live facts: Layout section "Flow" segmented Freeform / Vertical / Horizontal / Grid (aria labels; input values NONE/VERTICAL/HORIZONTAL/GRID); "Dimensions" W/H + "Lock aspect ratio" toggle; "Clip content" checkbox; "Resize to fit" + "Toggle auto layout" header buttons; text Layout shows "Resizing" Auto width / Auto height / Fixed size segmented.
## F. Appearance (Sections.tsx:318-466)
32 HIGH Corner smoothing slider + "iOS" 60% (help 360050986854); schema cornerSmoothing unused.
33 MED Corner radius on polygon/star/vector (shared.ts:124 rect/frame only) — verify live.
34 MED Blend mode shown inline (name row) when not default.
35 LOW Apply variable mode hidden when no collections (verify).
Live: Appearance header has Hide (eye) + "Apply blend mode"; Opacity + Corner radius fields; "Individual corners" button.
## G. Typography (Typography.tsx, TypeSettings.tsx)
36 MED Justify in panel's horizontal alignment (live shows Align left/center/right only? — verify; help lists Justify). 37 LOW paragraph spacing placement (verify). 38 OK.
Live text: Font family combobox 184x32, Font style + Font size (listbox), Line height / Letter spacing, Alignment Horizontal + Vertical (top/middle/bottom), "Type settings" button; header "Create link", "Apply variable", "Create component".
## H. Stroke (Stroke.tsx)
39 HIGH End points per path end: None, Round (default), Square, Line arrow, Triangle arrow, Reverse triangle, Diamond arrow (help 360049283914); ours single Cap, "Reversed triangle", extra "Circle arrow". Needs engine.
40 MED Stroke style Solid/Dashed/Custom + Dashes field; join "Rounded".
41 LOW Brush tab + dynamic stroke Frequency/Wiggle/Smoothen.
42 MED single-side weight stepping writes strokeWeight (Stroke.tsx:107 vs writeWeight :68).
43 LOW popover width truncates "Stroke style" (Stroke.tsx:192, Design.module.css:96) → SETTINGS_WIDTH.
## I. Effects (Effects.tsx)
44 HIGH Glass, Noise (Mono/Duo/Multi, size, density, colour, opacity), Texture (size, radius, clip to shape) (help 360041488473) — schema + engine + panel.
45 HIGH Progressive blur (Uniform/Progressive) for layer & background blur.
46 MED Blend mode on drop/inner shadow and noise.
## J. Layout guide / Selection colors / Export
47 LOW "Uniform grid", Columns, Rows wording. 48 LOW selection colors rules (variables, styles first; top 3 + See all; excludes image/video/pattern/hidden/masks). 49 OK.
## K. Per selection type
50 MED Section panel of its own (no auto layout; Mark as ready for dev button). 51 Image label/crop (verify). 52 polygon/star Count/Ratio placement (verify). 53 ellipse arc (verify). 54 multi: Select matching, multi-edit, distribute. 55 OK.
## L. 2026 changes (live Figma is the target version)
56 Variables moved to the left navigation rail (live rail: File, Agents, Assets, Tools, Variables); remove "Local variables → Open variables" from the right panel.
57 "Property labels" renamed "Additional labels", in main menu > View, on by default.
## Priority
1 number fields; 2 padding + wrap gap + Auto spacing; 3 group W/H; 4 effects Glass/Noise/Texture/Progressive (schema+engine first); 5 corner smoothing + radius on polygon/star/vector; 6 arrow end points (engine); 7 paint picker; 8 header actions per type + Resize to fit + presets; 9 Section panel; 10 small items.
Sources: help.figma.com articles 360039956914, 360043042113, 31289464393751, 31289469907863, 360040451373, 360050986854, 360040667874, 360041488473, 360049283914, 34208860210199, 360041003694, 360041003774, 360039956634, 360041539473, 360042553434, 360040450513, 13402894554519, 360039831974, 9771500257687; UI3 blog https://www.figma.com/blog/our-approach-to-designing-ui3/.
