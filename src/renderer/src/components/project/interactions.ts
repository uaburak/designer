import type { InteractionAction, InteractionAnimation, InteractionDirection, InteractionEasing, InteractionTrigger } from "@/types/design";

/**
 * A prototype's choices (see Reaction in the Figma model), as Figma's: its
 * triggers, actions, animations and easings — what an instance turning into
 * another variant plays (NodeView), and what the prototype's player plays
 * going from frame to frame (Player).
 *
 * An instance's change is CSS: while it plays, the instance's frame carries
 * `data-variant-motion` (and its duration and easing as custom properties) —
 * Smart animate transitions every property of it and its layers (the same
 * elements: variants' layers share their ids), dissolve fades the new one in
 * (see MOTION_CSS).
 */

/** The springs, as Figma's presets — their curves worked out from the physics (see springCurve). */
export const SPRINGS: Record<"gentle" | "quick" | "bouncy" | "slow", { mass: number; stiffness: number; damping: number }> = {
  gentle: { mass: 1, stiffness: 100, damping: 15 },
  quick: { mass: 1, stiffness: 300, damping: 20 },
  bouncy: { mass: 1, stiffness: 600, damping: 15 },
  slow: { mass: 1, stiffness: 80, damping: 20 },
};

/** Figma's easings, in its menu's order: the curves, then the springs. */
export const EASINGS: Record<InteractionEasing, { label: string; css: string; spring?: boolean }> = {
  linear: { label: "Linear", css: "linear" },
  "ease-in": { label: "Ease in", css: "cubic-bezier(0.42, 0, 1, 1)" },
  "ease-out": { label: "Ease out", css: "cubic-bezier(0, 0, 0.58, 1)" },
  "ease-in-out": { label: "Ease in and out", css: "cubic-bezier(0.42, 0, 0.58, 1)" },
  "ease-in-back": { label: "Ease in back", css: "cubic-bezier(0.3, -0.05, 0.7, -0.5)" },
  "ease-out-back": { label: "Ease out back", css: "cubic-bezier(0.45, 1.45, 0.8, 1)" },
  "ease-in-out-back": { label: "Ease in and out back", css: "cubic-bezier(0.7, -0.4, 0.4, 1.4)" },
  "custom-bezier": { label: "Custom bezier", css: "cubic-bezier(0.42, 0, 0.58, 1)" },
  gentle: { label: "Gentle", css: "", spring: true },
  quick: { label: "Quick", css: "", spring: true },
  bouncy: { label: "Bouncy", css: "", spring: true },
  slow: { label: "Slow", css: "", spring: true },
  "custom-spring": { label: "Custom spring", css: "", spring: true },
};

/** Figma's trigger menu, its groups in its order. */
export const TRIGGER_GROUPS: InteractionTrigger[][] = [["click", "drag", "hover", "press", "key"], ["mouseenter", "mouseleave", "mousedown", "mouseup"], ["delay"]];

export const TRIGGERS: Record<InteractionTrigger, string> = {
  click: "On click",
  drag: "On drag",
  hover: "While hovering",
  press: "While pressing",
  key: "Key/Gamepad",
  mouseenter: "Mouse enter",
  mouseleave: "Mouse leave",
  mousedown: "Mouse down",
  mouseup: "Mouse up",
  delay: "After delay",
};

/** A trigger as the noodles' label and the interaction's row say it ("Press", "Hover"…). */
export const TRIGGER_SHORT: Record<InteractionTrigger, string> = {
  click: "Click",
  drag: "Drag",
  hover: "Hover",
  press: "Press",
  key: "Key",
  mouseenter: "Mouse enter",
  mouseleave: "Mouse leave",
  mousedown: "Mouse down",
  mouseup: "Mouse up",
  delay: "After delay",
};

export const ACTIONS: Record<InteractionAction, string> = {
  navigate: "Navigate to",
  change: "Change to",
  back: "Back",
  scroll: "Scroll to",
  url: "Open link",
};

export const ANIMATIONS: Record<InteractionAnimation, string> = {
  instant: "Instant",
  dissolve: "Dissolve",
  smart: "Smart animate",
  "move-in": "Move in",
  "move-out": "Move out",
  push: "Push",
  "slide-in": "Slide in",
  "slide-out": "Slide out",
};

/** The animations an instance's change can play (it stays where it is): the rest move frames. */
export const CHANGE_ANIMATIONS: InteractionAnimation[] = ["instant", "dissolve", "smart"];
/** The animations that go a way (their direction). */
export const DIRECTED = new Set<InteractionAnimation>(["move-in", "move-out", "push", "slide-in", "slide-out"]);
export const DIRECTIONS: InteractionDirection[] = ["left", "right", "down", "up"];

/** What an animation needs of a reaction: its easing (a custom one's numbers) and its duration. */
export interface Timing {
  easing: InteractionEasing;
  duration: number;
  bezier?: [number, number, number, number];
  spring?: { mass: number; stiffness: number; damping: number };
}

/** A spring's motion from 0 to 1 (a damped oscillator, simulated) — its samples and how long it takes to settle. */
function springMotion({ mass, stiffness, damping }: { mass: number; stiffness: number; damping: number }) {
  const m = Math.max(0.1, mass);
  const k = Math.max(1, stiffness);
  const c = Math.max(0, damping);
  const dt = 1 / 1000;
  let x = 0;
  let v = 0;
  let t = 0;
  const points: { t: number; x: number }[] = [{ t: 0, x: 0 }];
  // Settled: near 1 and slow for a while — at most 5 seconds.
  let still = 0;
  while (t < 5) {
    const a = (-k * (x - 1) - c * v) / m;
    v += a * dt;
    x += v * dt;
    t += dt;
    if (Math.round(t * 1000) % 10 === 0) points.push({ t, x });
    still = Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01 ? still + dt : 0;
    if (still > 0.05) break;
  }
  return { points, duration: Math.round(t * 1000) };
}

const springCache = new Map<string, { css: string; duration: number }>();
/** A spring as a CSS easing (linear() through its samples) and the time it settles in. */
export function springCurve(spring: { mass: number; stiffness: number; damping: number }): { css: string; duration: number } {
  const key = `${spring.mass}|${spring.stiffness}|${spring.damping}`;
  const known = springCache.get(key);
  if (known) return known;
  const { points, duration } = springMotion(spring);
  const total = points[points.length - 1].t || 1;
  // About 60 stops along it (enough for a bounce), the last one exactly 1.
  const step = Math.max(1, Math.floor(points.length / 60));
  const stops = points.filter((_, i) => i % step === 0).map((p) => `${(Math.round(p.x * 1000) / 1000).toString()} ${Math.round((p.t / total) * 1000) / 10}%`);
  const out = { css: `linear(${[...stops, "1 100%"].join(", ")})`, duration };
  springCache.set(key, out);
  return out;
}

/** A reaction's spring, when its easing is one (a preset's, or its own). */
const springOf = (t: Timing) => (t.easing === "custom-spring" ? t.spring ?? SPRINGS.gentle : t.easing in SPRINGS ? SPRINGS[t.easing as keyof typeof SPRINGS] : null);

/** A reaction's easing as CSS: a curve, its own bezier, or a spring's curve. */
export function easingCss(t: Timing): string {
  const spring = springOf(t);
  if (spring) return springCurve(spring).css;
  if (t.easing === "custom-bezier" && t.bezier) return `cubic-bezier(${t.bezier.join(", ")})`;
  return EASINGS[t.easing]?.css || "ease-out";
}

/** How long it plays (ms): a spring's own time (as Figma's, its duration isn't set), else its duration. */
export function durationOf(t: Timing): number {
  const spring = springOf(t);
  return spring ? springCurve(spring).duration : t.duration;
}

/** The animations' CSS — put on the page with the design system (see DesignSystemStyle). */
export const MOTION_CSS = `
[data-variant-motion="smart"], [data-variant-motion="smart"] * { transition-property: all; transition-duration: var(--motion-duration); transition-timing-function: var(--motion-easing); }
[data-variant-motion="dissolve"] { animation: variant-dissolve var(--motion-duration) var(--motion-easing) both; }
@keyframes variant-dissolve { from { opacity: 0; } to { opacity: 1; } }
`;
