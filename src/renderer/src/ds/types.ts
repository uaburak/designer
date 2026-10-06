/** Shared component types (contract §4.0). */

/** Several selected layers with different values. */
export const MIXED: unique symbol = Symbol("mixed");
export type Mixed<T> = T | typeof MIXED;
export const isMixed = (v: unknown): v is typeof MIXED => v === MIXED;

/** 24 | 32 */
export type ControlSize = "default" | "large";

/**
 * How a value changed. Continuous gestures (scrub, drag) send `final: false`
 * per frame and exactly one `final: true` on release — one undo step.
 * Typed and stepped values are always final.
 */
export type ChangeInfo = { final: boolean; source: "type" | "step" | "scrub" | "drag" | "pick" };

/** Why a field let go of focus — the editor returns focus to the canvas after Enter and Esc. */
export type ExitReason = "enter" | "escape" | "tab" | "shift-tab" | "blur";

export type Placement = "bottom" | "top" | "right" | "left";
