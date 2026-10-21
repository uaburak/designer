import type { DefaultSkill } from "./types";

/**
 * "Opus 5.5 motion" (the owner, 2026-10-21): the craft of high-end motion graphics as Claude Opus writes it with GSAP /
 * Remotion, mapped onto Wecra's native `animate` → `get_motion_frames` loop. It replaces the old built-in
 * motion-design skill (whose workflow it includes); `get_skill motion-design` answers with this one.
 */
export const MOTION_OPUS: DefaultSkill = {
  name: "motion-opus",
  description:
    "Opus 5.5 motion: make high-end motion graphics and animated UI in Wecra's Motion (logo reveals, UI walkthroughs, sketch → animated interface, kinetic type, data stories, social clips, loops) with the craft of a senior motion designer — storyboard beats, choreography, easing by role, staggers, text reveals, draw-ons, counters, camera moves, seamless loops — written as one animate script, checked frame by frame with get_motion_frames, scored with sound, exported. Use for any animation or motion request (it replaces motion-design).",
  instructions: `Motion is choreography: every move has a reason, a role and a place in time. Work like a motion designer with GSAP or Remotion — but natively, so the result stays editable in Wecra's timeline and exports to MP4 / WebM / GIF / Lottie.

## 1. Brief → storyboard (write it before any tool call)
- Length: UI micro-piece 2–4 s, UI walkthrough 5–10 s, logo sting 2–4 s, social clip 6–15 s, loop 2–6 s. Frame: the user's frame, or 1920 × 1080, 1080 × 1080, 1080 × 1350, 1080 × 1920.
- 3–7 beats with times and ONE hero move each: "0.0–0.6 bg wipes in; 0.4–1.2 card rises (hero); 0.9–1.7 title by words; 1.5–2.3 list staggers; 2.2–2.6 button pops; 2.6–4.0 hold". Beats overlap by 20–40 % — strictly sequential beats feel like a slideshow.
- Decide the energy curve: build → climax → settle. The climax is the fastest, biggest move; everything before it is smaller, everything after calmer.

## 2. Layers built for motion
- get_metadata / get_screenshot first. Build with create_nodes when nothing exists.
- The top-level frame is the timeline: never animate it. Camera moves: wrap the content in a frame "Camera" (the top-level frame clips) and animate Camera's x / y / scale.
- Name every animated layer ("Title", "Card 1", "Bar 3", "Logo mark"); paths target groups ("Cards/*" = all children). What moves together lives in one frame; what moves separately is separate. One text per line if lines move separately (or split: "lines").
- Things enter from where they rest: animate with from {y, opacity}; never park layers off-canvas.
- Draw-ons need strokes (svg markup in create_nodes keeps paths as vectors); rings and pies: an ellipse with a stroke, animated with arcEnd or drawSVG. Masks / wipes: a clipping frame (clipsContent) whose child slides, or a growing shape used as a mask.
- From a sketch or a screenshot: rebuild it as clean layers (auto layout, real text, shapes, svg icons) at the same composition. Never animate a flat picture of a UI.

## 3. Timing ranges
- Micro (hover, tap feedback, icon morph): 0.15–0.3 s.
- UI element (card, panel, list item): 0.3–0.6 s. Exits ~70 % of entrances (0.2–0.4 s).
- Hero / full-screen / logo: 0.8–1.5 s. Camera moves: 1.2–2.5 s.
- Hold the final state ≥ 1 s (1.5–2 s for logos and end cards): set the timeline duration past the last tween.
- Contrast of speed: a slow move next to a fast one reads as intentional; everything at 0.5 s reads as a template.

## 4. Easing by role (the biggest quality lever)
- Entrances: "expo.out" (premium, decisive) or "power3.out" / "power4.out". Exits: "power2.in" / "expo.in". Moves between states / camera: "power2.inOut", "expo.inOut" for dramatic travels. Continuous rotation or tickers: "none".
- Overshoot: "back.out(1.4–2)" for pops, badges, buttons — sparingly, one or two per piece. "elastic.out(1, 0.4)" only for playful brands. "bounce.out" for drops. Physical things: {type: "spring", bounce: 0.25–0.45}.
- Mechanical, typewriter, flipboard: "steps(n)".
- Never "linear" on anything that starts or stops; never the same ease on every tween (entrance vs move vs settle differ).

## 5. Choreography principles
- Overlap: start the next element before the previous lands (position "<0.15", "-=0.25").
- Offset: related items never move in perfect unison — offset 0.03–0.1 s.
- Follow-through and settle: a big move ends with a small one (the card lands, then its shadow / content settles 0.1 s later; a scale 1.04 → 1 after arrival).
- Anticipation: before a big move, a small move the other way (scale 0.96 for 0.12 s, then out), or a riser in sound.
- Hierarchy in time: the most important element moves first or biggest; secondary details later and smaller.
- Direction: elements enter along the reading direction (up / left-to-right) unless the story says otherwise; exits continue the motion's direction (don't reverse).
- Distances: 16–60 px for UI, 80–300 px for full-screen travel; scale entrances from 0.85–0.95 (0 only for pops and particles); rotations under 8° for UI, any for graphics. Always combine opacity with movement.

## 6. Staggers
- stagger number (each) or {each | amount, from: "start" | "end" | "center" | "edges" | "random" | index}.
- Lists / grids: each 0.04–0.1 ("start"); a total spread for many items: {amount: 0.5–0.8}. Grids bloom: from "center"; closing / converging: from "edges"; particles, confetti, stars: "random" with a short amount.
- Characters 0.02–0.04, words 0.06–0.12, lines 0.1–0.18.

## 7. Signature techniques
- Text reveals: split "chars" / "words" / "lines" with from {y: 20–40, opacity: 0}; for a masked reveal put the text in a clipping frame so it rises from an invisible edge. Only opacity and transforms play per element; colour and size apply to the whole text.
- Draw-on: fromTo [{drawSVG: "0%"}, {drawSVG: "100%"}] with "power2.inOut" (signatures, icons, charts, underlines); a travelling segment: fromTo [{drawSVG: "0% 10%"}, {drawSVG: "90% 100%"}].
- Rings and gauges: arcEnd from 0 to the value (degrees) on an ellipse; arcStart for wipes.
- Counters: Wecra's animate doesn't tween text characters. Use a stack of number texts in a clipping frame moved by y with "steps(n)" or "power3.out" (a rolling counter), or several texts swapped by opacity at Hold keys; the bar or ring carries the smooth value.
- Camera: one slow push-in (Camera scale 1 → 1.06 over the whole piece, "none" or "sine.inOut") makes static scenes cinematic; whip pans: Camera x by a full frame width in 0.4 s "expo.inOut" with blur 0 → 12 → 0.
- Blur for speed: blur 8–16 px at the fastest moment of a big move, 0 at rest.
- Colour beats: fill tweens on backgrounds at beat changes (0.6–1 s, "power2.inOut").

## 8. Loops that seam
- playback LOOP: the last frame must equal the first. Either end every element where it started (an exit beat back to rest), or use repeat: -1 with yoyo for ping-pong elements, or "none"-eased continuous rotations that complete full turns (360° multiples) in the loop's length.
- Set timeline {duration, playback: "LOOP"} explicitly; keep loops 2–6 s. PING_PONG only without audio.

## 9. Write ONE animate script
- In storyboard order, with labels for beats ({label: "title", position: 0.8}) and positions relative to them ("title+=0.1", "<0.2"). defaults {duration, ease} for the common case; override per tween.
- "+=" / "-=" count from the end of everything so far, "<" / ">" from the previous tween: write whole-piece tweens (a camera push, a background drift) last with an absolute position, or every relative position after them shifts.
- mode "replace" (default) owns the properties it animates; "merge" adds to existing keys — use merge for targeted fixes on a finished piece.
- Units: seconds; x / y px from rest; rotate degrees clockwise; colours "#RRGGBB". One call = one undo step. Layers inside component instances aren't animated one by one: animate the instance (or the main component's own timeline).

## 10. Self-check loop (always 2–3 rounds)
get_motion_frames {nodeId, count: 8–12} for the whole piece; times: [...] dense around the busy beat (e.g. every 0.1 s across the climax); gif: true when the owner should see it moving. Look for:
- A from-state missing: something visible before its beat (frame 0 should show only what the story starts with).
- Spacing: uneven gaps between staggered items mid-animation; items overlapping or colliding while travelling.
- Dead frames: stretches where nothing moves that aren't intended holds; or everything moving at once (no hierarchy).
- Jitter: a value jumping back (two tweens fighting on one property — merge them or move the second's position).
- Overshoot out of the frame or clipping by a parent; text unreadable at the hold; the last frame not the intended end state; a loop whose first and last frames differ.
Fix with animate again (whole script, or mode "merge" for one property) and look again.

## 11. Sound and delivery
- Rhythm: music beats at bpm B fall every 60/B s — align beat starts to them (at 120 bpm: 0.5 s grid) and land the climax on a downbeat.
- Unless the user wants silence (or it is a Lottie icon / GIF), score it once the motion is final: get_skill sound-design → score_motion → generate_sound (bed + effects on the events in one call) → get_sound_mix → fix. Retiming later means re-placing sounds.
- export_animation when asked (MP4 for video, GIF for previews, LOTTIE for apps, WEBM with alpha); set_selection on the frame; one sentence on what you made.

## 12. Worked scripts (adapt names and numbers; nodeId is the top-level frame)

A. Sketch → animated UI card (1080 × 1350; layers: "Bg", "Card", "Card/Avatar", "Card/Title", "Card/Rows/*", "Card/Button"):
{"nodeId": "<frame>", "defaults": {"duration": 0.6, "ease": "expo.out"}, "timeline": {"duration": 4.5, "playback": "ONCE"},
 "tweens": [
  {"targets": "Bg", "from": {"opacity": 0}, "duration": 0.5, "ease": "power2.out"},
  {"label": "card", "position": 0.25},
  {"targets": "Card", "from": {"y": 60, "opacity": 0, "scale": 0.94}, "duration": 0.9, "position": "card"},
  {"targets": "Card/Avatar", "from": {"scale": 0.6, "opacity": 0}, "ease": "back.out(1.7)", "duration": 0.5, "position": "card+=0.35"},
  {"targets": "Card/Title", "split": "words", "from": {"y": 24, "opacity": 0}, "stagger": 0.08, "position": "<0.1"},
  {"targets": "Card/Rows/*", "from": {"x": -24, "opacity": 0}, "stagger": {"each": 0.07, "from": "start"}, "duration": 0.5, "position": "-=0.3"},
  {"targets": "Card/Button", "from": {"scale": 0.85, "opacity": 0}, "duration": 0.5, "ease": "back.out(1.8)", "position": "-=0.15"},
  {"targets": "Card", "to": {"y": -6}, "duration": 1.6, "ease": "sine.inOut", "position": ">"}
 ]}

B. Logo reveal with draw-on and settle (1920 × 1080; "Camera" holds "Logo mark" (stroked paths), "Logo fill", "Wordmark", "Tagline"):
{"nodeId": "<frame>", "timeline": {"duration": 4, "playback": "ONCE"},
 "tweens": [
  {"targets": "Logo mark", "fromTo": [{"drawSVG": "0%"}, {"drawSVG": "100%"}], "duration": 1.1, "ease": "power2.inOut", "position": 0.2},
  {"targets": "Logo fill", "from": {"opacity": 0, "scale": 0.9}, "duration": 0.5, "ease": "back.out(1.6)", "position": "-=0.25"},
  {"label": "word", "position": "-=0.1"},
  {"targets": "Wordmark", "split": "chars", "from": {"y": 30, "opacity": 0}, "stagger": {"each": 0.03, "from": "center"}, "duration": 0.6, "ease": "expo.out", "position": "word"},
  {"targets": "Tagline", "from": {"y": 12, "opacity": 0}, "duration": 0.6, "ease": "power3.out", "position": "word+=0.45"},
  {"targets": "Camera", "fromTo": [{"scale": 1.08}, {"scale": 1}], "duration": 4, "ease": "power1.out", "position": 0}
 ]}
(the camera push spans the whole piece, so it goes last with an absolute position: "-=" / "+=" count from the end so far, which a long tween early in the list would move.)

C. Data viz: bars + rolling counter (1080 × 1080; "Bars/*" bottom-anchored rectangles, "Axis", "Counter/Digits" a column of numbers 0–9 in a clipping frame "Counter", "Label"):
{"nodeId": "<frame>", "defaults": {"ease": "power3.out"}, "timeline": {"duration": 5, "playback": "ONCE"},
 "tweens": [
  {"targets": "Axis", "fromTo": [{"drawSVG": "0%"}, {"drawSVG": "100%"}], "duration": 0.6, "ease": "power2.inOut", "position": 0.1},
  {"targets": "Bars/*", "from": {"scaleY": 0}, "transformOrigin": "center bottom", "duration": 0.9, "stagger": {"amount": 0.5, "from": "start"}, "ease": "expo.out", "position": "-=0.2"},
  {"targets": "Counter/Digits", "fromTo": [{"y": 0}, {"y": -720}], "duration": 1.4, "ease": "steps(8)", "position": "<"},
  {"targets": "Counter", "keyframes": [{"scale": 1.08, "duration": 0.15, "ease": "power2.out"}, {"scale": 1, "duration": 0.3, "ease": "power2.inOut"}], "position": ">"},
  {"targets": "Label", "from": {"opacity": 0, "y": 16}, "duration": 0.5, "position": "-=0.2"}
 ]}
(the digit column's step = one digit's height; 8 steps from 0 to the shown value 8; then get_motion_frames times [0.5, 0.8, 1.1, 1.4, 1.7, 2.0, 2.5, 5].)

## Checklist
- [ ] Storyboard with timed, overlapping beats and one hero move each; a climax
- [ ] Layers named and grouped for motion; the frame itself never animated
- [ ] Durations in range; eases by role; overshoot used sparingly
- [ ] Overlap, offset, follow-through; staggers with sensible from / amount
- [ ] End state held ≥ 1 s, or a loop whose first and last frames match
- [ ] 2–3 rounds of get_motion_frames: no early visibility, collisions, dead frames or jitter
- [ ] Sound via sound-design unless silent; exported when asked`,
};
