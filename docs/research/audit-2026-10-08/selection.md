# Audit: selection and canvas interaction vs Figma (2026-10-08)

Sources: SEL https://help.figma.com/hc/en-us/articles/360040449873 · PASTE https://help.figma.com/hc/en-us/articles/4409078832791 · ZOOM https://help.figma.com/hc/en-us/articles/360041065034 · XFORM https://help.figma.com/hc/en-us/articles/360039956914 · RADIUS https://help.figma.com/hc/en-us/articles/360050986854 · SMART https://help.figma.com/hc/en-us/articles/360040450233 · SECT https://help.figma.com/hc/en-us/articles/9771500257687 · NOBLE (third-party shortcuts) https://www.nobledesktop.com/shortcuts/figma/mac · NEST forum https://forum.figma.com/t/disable-auto-nesting-auto-reparenting-while-moving-objects/799 · ORDER forum https://forum.figma.com/ask-the-community-7/changing-bring-forward-bring-to-front-hotkeys-47717
Live Figma captures (exact panel/menu/canvas reference): docs/research/figma/live/ — CONFIRM every unverified item there.

## HIGH
1. Frame titles: no hit-test. Figma: title selects + drags the frame, double-click renames, hover shows outline. Ours: nothing (hit/, tools/, editor/); dragging a frame's background with children starts a marquee (Gestures.cpp:384-390). engine.md §6.11/§8.2 claim it works. Fix: hit-test title rect ahead of hitPath; press select, drag move, dbl-click REQUEST_RENAME.
2. ⌘-marquee must include nested layers (SEL). marqueeHits (hit/Marquee.cpp) has no deep mode; dragMarquee ignores MOD_PRIMARY.
3. Lines: no endpoint handles (box {len,0}; roomy false Overlay.cpp:248; edge zones need sh>=12). Add two endpoint handles for LINE and zero-width/height vectors; drag about the other end; ⇧ 45°.
4. No on-canvas corner radius handles (RADIUS): white circles with blue border inset from corners on hover; drag sets radius; ⌥ single corner. Add Handle::Radius + Gesture::Radius + overlay.
5. Lock aspect ratio ignored on canvas; ⌃ overrides when locked, ⇧ when unlocked (XFORM). dragResize only reads shift (Gestures.cpp:1072). keep = proportionsConstrained ? !(mods&CTRL) : shift.
6. Move modifiers: Figma ⌘ = force nesting (even into smaller frame / over auto-layout safeguard), Space (held while dragging) = don't nest, default: don't nest into a frame smaller than the layer, ⌃ = no snapping. Ours: ⌘ keeps parents + no snapping (Gestures.cpp:813-814); dropTargetAt (:683) takes topmost frame regardless of size; Space ignored. Update engine.md §8.6.
7. ⌘ while resizing = ignore constraints (children don't follow; NOBLE); snapping off = ⌃ (XFORM). Ours: ⌘ = no snapping (Gestures.cpp:1049).
8. Sections: ⇧S tool missing (toolImplemented excludes SECTION, Editor.cpp:17); no section title pill (Overlay.cpp:150 skips); pick() returns path[1] (Picking.cpp:23) so children of frames inside sections are wrong; frames inside sections get no titles; no "Wrap in new section", no ⌘⌫ (delete section keep contents), double-click title rename (SECT).
9. Esc: Figma (SEL) Esc deselects (⇧Enter / \ selects parent). Ours selects parent (Editor.cpp:1215+, engine.md §8.2 decision). Confirm in live Figma, then: Esc ends text/vector/grid edit, else cancels gesture, else resets tool, else deselects.
10. Select matching layers ⌥⌘A (incl. ⇧ marquee/click add/remove, section-scoped) and Edit ▸ Select all with same Fill/Stroke/Effect/Text properties/Font/Instance (SEL). Ours: later() stub.
11. Paste to replace ⇧⌘R missing (PASTE: removes selection, takes its place + constraints, in context menu). Paste over selection ⇧⌘V must place on top of the selected frame (sibling above), at its x/y; ours pastes inside (Commands.cpp:1234) at copied pos. Canvas menu shows "Paste over selection" where Figma shows "Paste to replace".
12. Overlay constants drift: ChromePalette.generated.h (from ds/tokens.ts canvasChrome) is never included; OverlayStyle.h hard-codes: hover stroke 2 vs contract 1; handle 8 vs 7; equal-spacing marks red (Overlay.cpp:352) vs spacingGuide pink #ff24bd/#f316b0; frame title colour by UI theme vs by page-background luminance (#ffffff76 / #00000080); pixel grid never drawn; badge weight 500 vs 450. Build OverlayStyle from kChrome*; calibrate against live Figma screenshots.

## MEDIUM
13. Smart selection (SMART): pink spacing handles in gaps (drag to change), pink centre rings (drag to reorder), Tidy up ⌃⌥T (stub).
14. Tools: K Scale, S Slice, C Comment, I / ⌃C Eyedropper, held Z zoom tool (⌥Z out, drag-zoom area) — all missing (no ZOOM in Tool enum).
15. Shortcuts: 1–9/0 layer opacity with 2-digit buffer (~300 ms); ] / [ bring to front / send to back; \ select parent; N / ⇧N next/prev frame; ⌥R rotation origin; ⌃P pixel preview; pixel grid ⌘' (ours ⇧', stub).
16. Pixel grid drawn from 400% (ZOOM; engine.md says 800%); snap to pixel grid ⇧⌘'; layout guides ⌃G; ruler guides draggable from rulers (Figma `guides` field) + snapping to guides and layout grids (prepareSnapping only gathers siblings + parent).
17. Auto layout on canvas: draggable padding/gap bands + click-to-edit value (engine.md §6.11 promises; absent).
18. Paste placement: keep x/y within destination frame else centre per axis; view centre if target frame off-screen; zoom out if larger than view. Duplicate offset memory (⌘D) unverified.
19. Marquee: a top-level frame selected by marquee picks only other top-level layers (SEL); ours mixes levels (Marquee.cpp:34).
20. "Select layer ▸" menu: include locked layers with padlock + type icons (SEL); forEachHit cuts at locked ancestor (HitTest.cpp:127).
21. Canvas context menu: mirror Figma's exact items/order from the live capture (docs/research/figma/live); add Paste to replace, Wrap in new section, Select matching layers, Copy link to selection, Set as thumbnail, Plugins/Widgets entries.
22. Cursors: rotated SVG resize cursor at exact angle (cursors.ts buckets to 4); Figma's own arrow/crosshair/zoom/eyedropper/scale cursors.
23. Component/instance frame titles show the component/instance glyph before the name.

## LOW
24. Nudge amounts are preferences (XFORM); nudge must not move instance sublayers (startMove filters isDerived, nudge doesn't).
25. Space while drawing/resizing repositions (unverified).
26. Angle readout while rotating (unverified).
27. ⌘⌫ remove frame/group/section keeping contents.
28. Snapping to layers nested in sibling frames (unverified); resize snaps edges only.
29. Tab/⇧Tab skip hidden/locked (unverified).
30. Handles hidden below 24 px on screen (Figma rule unverified).
31. Text shortcuts ⇧⌘</>, ⌥⇧</>, ⌥⌘</>, ⌥</> (NOBLE).

## Already matching
Click picks direct child of top-level frame; ⇧-click; ⌘-click deep + ⌘-hover preview; dbl-click one level down; Enter children / edit text-vector; ⇧Enter parent; ⌘A siblings; ⇧⌘A invert; ⌥-drag duplicate (instance from main); ⇧ axis lock; resize through zero flips; ⌥ resize from centre; press inside selected keeps selection; right-click selects under pointer; ⌥ hover red measurement; auto-layout insertion line + reorder; arrows reorder in auto layout; zoom ⇧0/⇧1/⇧2, ⌘±, pinch, ⌘-scroll; Space/middle pan; tool keys V F/A R O L ⇧L P ⇧P T H; ⇧R rulers; ⇧⌘K; ⇧H/⇧V flip; selection #0d99ff/#0c8ce9, component #9747ff/#8a38f5; size badge.
Order: 1, 2, 3, 6, 5, 8, 4, 9, 11, 10, 12.
