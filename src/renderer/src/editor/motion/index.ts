/**
 * Motion mode (docs/motion.md §6): the timeline, the clock, the easing editors and the right panel's Motion section.
 * Round 8 increment 1 (8c / 8d): the mode shell and timeline, the clock, the Easing menu, the Motion section's
 * diamonds. Increment 2: the panels at the playhead, the diamonds beside Design's fields and their routed X / Y /
 * Rotation, the timeline's marquee, ⌘C / ⌘V and top edge. Round 8e: `audio/` (the root's audio, its playback) and the
 * Audio section. Round 8i: the easing graph and EASING variables, the timeline settings, the Text stagger section,
 * custom animation styles. 2026-10-19: every easing edited with the right panel's Easing page's controls.
 */
export { MotionMode } from "./MotionMode";
export { Timeline, type TimelineProps } from "./timeline/Timeline";
export { Clock, type ClockOptions } from "./clock";
export { EasingControls, EasingPage, createEasingVariable } from "./easing/EasingPage";
export { easingMenuTypes, easingOfType } from "./easing/easingMaths";
export { MotionTransformSection, anchorPosition } from "./panels/TransformSection";
export { KeyframeDiamond } from "./panels/KeyframeDiamond";
export { MotionField, MotionFieldStates, combinedState, toggleKeyframe } from "./panels/MotionField";
export { motionPerLayer } from "./panels/motionWrites";
export { copySelectedKeyframes, pasteKeyframes } from "./keyframeClipboard";
export { motionUi, setMotionUi, pushMotion, setPlayhead, toggleMotionPlaying, toggleAutoKeyframe, motionRead } from "./motionState";
