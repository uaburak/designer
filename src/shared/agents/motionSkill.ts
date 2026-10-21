/**
 * The built-in **motion-design** skill (docs/research/motion-for-agents.md §3e): how an agent plans and makes a motion
 * piece natively in Wecra — storyboard → layers built for motion → one `animate` script → `get_motion_frames` → refine →
 * export — with the defaults motion designers use. Always listed with a chat's skills and answered by `get_skill` in main
 * (src/main/agents/host.ts), beside the agents' reach skills.
 */

export const MOTION_SKILL = {
  name: "motion-design",
  description: "Make motion graphics and animated UI in Wecra's Motion (logo stings, UI walkthroughs, stat reveals, kinetic type, sketch → animated interface): storyboard, layers built for motion, an animate script, frames to check, refine, export.",
  instructions: `Make motion the way a motion designer does, natively — the result stays editable in the timeline and exports to MP4 / GIF / Lottie.

1. Brief → storyboard. Decide the length (UI pieces 3–8 s, a logo sting 2–4 s, social clips 6–15 s), the frame size (1920×1080, 1080×1080, 1080×1920 — or the user's frame) and 3–6 beats with times, e.g. "0–0.8 s background and card in; 0.6–1.6 s title by characters; 1.4–2.2 s list items stagger in; 2.2–3 s button pops; hold to 4 s". One hero move per beat; overlap beats rather than playing them strictly one after another.

2. Layers built for motion (get_metadata / get_screenshot first; build with create_nodes when there is nothing yet):
   - The top-level frame is the timeline and never moves itself. For camera pans / zooms, put everything in a frame named "Camera" inside it (clipsContent on the top-level frame) and animate Camera's x / y / scale.
   - Name every layer you will animate ("Title", "Card 1" …); group what moves together into a frame; keep things that move separately apart (one text per line if lines animate separately — or split: "lines").
   - Things that enter from outside start inside the frame at their final place: animate them in with from {x / y / opacity} — never park them off-canvas.
   - Lines, icons and signatures that should draw on: strokes (svg markup in create_nodes keeps paths as vectors), then drawSVG. Rings, pies and loaders: an ellipse with a stroke or arcEnd. Reveals: a frame with clipsContent whose child slides in, or a mask layer that grows.
   - From a sketch or screenshot: look at it, then rebuild it as clean layers (auto layout frames, real text, shapes, svg for drawn icons) at the same composition; don't animate the picture itself.

3. Write ONE animate script for the whole piece (tweens in storyboard order; labels for the beats; position "<0.1" / "-=0.2" to overlap; stagger for groups). Good defaults:
   - Entrances 0.4–0.8 s, ease "power3.out" or "expo.out"; exits 0.25–0.4 s "power2.in"; moves between states "power2.inOut".
   - Emphasis and pops: "back.out(1.7)" or {type: "spring", bounce: 0.3–0.5}; playful drops: "bounce.out"; mechanical ticks: "steps(n)".
   - Distances: 16–60 px for UI, 80–300 px for full-screen moves; scale entrances from 0.8–0.95 (not 0) unless it's a pop.
   - Stagger 0.04–0.1 s between items, 0.02–0.04 s between characters (split: "chars"), 0.06–0.12 s between words.
   - Opacity with movement (from {opacity: 0, y: 24}), not opacity alone.
   - Hold the finished state at least 1 s: set timeline {duration} past the last tween; loops: playback LOOP with an exit beat that returns to the start, or PING_PONG.
   - rotate is clockwise + (CSS's); x / y are offsets from where the layer sits; colours as "#RRGGBB".

4. Look at it: get_motion_frames {nodeId, count: 8} (more around a busy beat with times: [...]). Check: does each beat land where the storyboard says, is anything visible before it should be (a from-state missing), do moves overshoot or collide, is text readable at the hold, is the last frame the intended end state. Refine with animate again — mode "merge" keeps what you didn't touch, or re-send the whole script (mode "replace" owns the properties it animates) — and look again. Two or three rounds are normal.

5. Deliver: export_animation (MP4 for video, GIF for chat previews, LOTTIE for apps) when asked, select the frame (set_selection) and say in a sentence what you made.

Units and limits: seconds everywhere; one animate call is one undo step. Layers inside component instances aren't animated one by one (animate the instance, or the main component's own timeline). Text split animates opacity and transforms per element; colour and size apply to the whole text.`,
} as const;
