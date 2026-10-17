/**
 * Motion mode (docs/motion.md §6): the timeline, the clock, the easing editors and the right panel's Motion section.
 * Round 8 increment 1 (8c / 8d): the mode shell and timeline, the clock, the Easing menu, the Motion section's
 * diamonds. Later: `audio/`, the Animations and Transform sections, `export/` (8e).
 */
export { MotionMode } from "./MotionMode";
export { Timeline, type TimelineProps } from "./timeline/Timeline";
export { Clock, type ClockOptions } from "./clock";
export { EasingEditor, EasingMenu, easingMenuTypes, easingOfType } from "./easing/EasingEditor";
export { MotionSection, MOTION_SECTION_FIELDS, combinedState } from "./panels/MotionSection";
export { KeyframeDiamond } from "./panels/KeyframeDiamond";
export { motionUi, setMotionUi, pushMotion, setPlayhead, toggleMotionPlaying, toggleAutoKeyframe, motionRead } from "./motionState";
