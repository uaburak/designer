/**
 * The built-in **sound-design** skill (docs/motion.md §9.3; [ours]): how an agent scores a motion piece with Wecra's
 * local sound engine — read the motion (score_motion) → pick a palette → place sounds on its events (generate_sound) →
 * check the mix by numbers (get_sound_mix) → fix. Listed with every chat turn's skills beside motion-design and
 * answered by `get_skill` in main (src/main/agents/host.ts).
 */

export const SOUND_SKILL = {
  name: "sound-design",
  description: "Score an animation with sound in Wecra's Motion — sound effects synced to the motion and a music bed, made locally (generate_sound), placed on the motion's events (score_motion), checked by numbers (get_sound_mix). Use it when making motion (unless the user doesn't want sound) and for \"add sound to this animation\".",
  instructions: `Score motion the way a sound designer does. You can't listen, so you work from the motion's events and the mix's numbers.

1. Read the motion: score_motion {nodeId}. Note the length and playback (a LOOP timeline needs a bed that loops: generate it from 0 without a duration), the accents, the climax, when everything is at rest, the staggers' times and the energy curve (where it builds, where it is calm). The cues are a starting point, not a plan.

2. Choose a palette before placing anything — one character for the piece, in one key:
   - One bed (music, mood by the brief: uplifting / corporate for product pieces, calm / dreamy for soft UI, tense / dark / epic for drama, playful for fun, lofi for chill) — or none for short UI micro-interactions under 2 s.
   - 3–6 sound-effect families, each kept consistent (same preset and brightness, different seeds for variation): e.g. whoosh.fast for moves, pop for elements appearing, tick / typing for text, impact or logo-hit for the main landing, shimmer for a reveal, a riser into the climax.
   - Same key for everything tonal (bed, chimes, shimmers): pass key on each, e.g. "A minor".
   - Match the motion's character: snappy UI → short, bright, dry sounds (click, pop, swoosh; reverb 0–0.1); cinematic → bigger, darker, with tails (whoosh.heavy, impact.cinematic, boom, reverb 0.3–0.5); playful → pops, bubbles, chimes; techy → glitch, ticks, click.mechanical.

3. Place (generate_sound, all sounds of the piece in one call — one undo step; align "sync" is the default):
   - Hits on arrivals: at = the arrive / accent time. The strongest accent (the climax: a logo lands, the hero card settles) gets the biggest hit; small arrivals get thud / tap / pop or nothing.
   - Whooshes on big moves: at = the move's peak (its fastest moment), duration ≈ the move's length (0.3–0.5 s swoosh for quick UI moves, 0.6–1.2 s whoosh for big ones); pan / panTo follow the direction (left → right: pan −0.6, panTo 0.6).
   - Pops on scale pops and small elements appearing; clicks / taps on buttons and toggles.
   - Ticks on staggers: typing with times = the stagger's times minus its first time (at = the first), or count + interval = its step; for 10+ elements thin them (every other one) or use a single shimmer.
   - A riser into the climax: at = the climax time (align sync puts the riser's end there), duration 1–3 s, not longer than the build. Optionally a downlifter or reverse-swell after a big moment.
   - Shimmer / sparkle on reveals, logo resolves, success states; chime.success / notification for UI feedback moments.
   - The bed from 0 (length: the timeline by default), fadeOut so it ends with the piece; when the piece ends on a hit, the bed can stop there (duration = the hit time) and the hit's tail carries the end.
   - Silence is a tool: not every event gets a sound. One hero sound per moment; at most ~3–4 effect starts per second except a stagger's ticks.

4. Levels (volumeDb, dBFS of the clip; defaults are sensible): bed −18 (−20 to −16), hero hits −6, whooshes −9 to −12, UI clicks / pops −10 to −14, ticks −14 to −18, shimmers −12, risers −10. Quieter for repeated and small things, louder for big and rare ones.

5. Check: get_sound_mix {nodeId}. Fix every warning with edit_audio (volume 0–1 linear: −6 dB ≈ 0.5, −12 dB ≈ 0.25, −18 dB ≈ 0.125; offset; remove: true) or by regenerating: clipping or a peak above −1 dBFS → lower the loudest clips there; pile-ups → keep one, drop or lower the others; flams → same time or ≥ 60 ms apart; a bed within 10 dB of the effects → lower the bed. Aim: peak −3 to −1 dBFS, overall RMS around −20 to −14 dBFS.

6. Report in a sentence what you added (bed, families, the key moments) and that the clips are editable in the timeline (move, trim, volume, delete). Exported MP4 / WebM carry the sound; GIF and Lottie don't (Lottie has no audio).

Variations: change seed for a fresh take of the same sound; brightness for darker / brighter, intensity for softer / punchier. Sound for an existing animation ("add sound to this"): same steps, keep the motion as it is. When the user asks for no music or no sound, respect it.`,
} as const;
