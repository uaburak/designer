/**
 * The Plugin API's Motion (docs/motion.md §9; round 8f): the node properties `manualKeyframeTracks` (get / set),
 * `animationStyles` (get / set), `timelines`, `animations`, the methods `applyManualKeyframeTrack`,
 * `removeManualKeyframeTrack`, `applyAnimationStyle`, `removeAnimationStyle`, `setTimelineDuration`, and `figma.motion`
 * (`figmaAnimationStyles()`, `playheadPosition`, `physicalSpringToNormalized()`). Figma's shapes and rules live in
 * motion/publicApi.ts (shared with the agents' tools); this file only adds the run's write slice and Dev Mode's
 * read-only rule (Dev Mode exposes the reads). Seconds at the API.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { motionUi } from "../../motion/motionState";
import {
  animationStylesOf,
  animationsOf,
  applyAnimationStyle,
  applyManualKeyframeTrack,
  figmaAnimationStyles,
  manualKeyframeTracks,
  removeAnimationStyle,
  removeManualKeyframeTrack,
  setAnimationStyles,
  setManualKeyframeTracks,
  setTimeline,
  timelinesOf,
  type StyleConfig,
} from "../../motion/publicApi";
import { ApiError } from "./codec";
import { mustNode, type ApiContext } from "./context";

/** A scene node the motion API acts on (pages and the document have no timeline). */
function sceneNode(ctx: ApiContext, id: Guid, what: string): Guid {
  const n = mustNode(ctx, id);
  if (n.type === "CANVAS" || n.type === "DOCUMENT") throw new ApiError(`in ${what}: a page has no timeline`);
  return n.guid;
}

/** A write: refused in Dev Mode, else inside the run's slice. */
function writing(ctx: ApiContext, what: string): void {
  if (ctx.editorType === "dev") throw new ApiError(`in ${what}: Cannot write to the timeline in Dev Mode`);
  ctx.write();
}

const wrap = <T>(what: string, fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(`in ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** The node properties (nodes.ts PROPS). */
export const MOTION_PROPS = {
  manualKeyframeTracks: {
    get: (ctx: ApiContext, n: NodeChange) => manualKeyframeTracks(ctx.ed, n.guid),
    set: (ctx: ApiContext, n: NodeChange, v: unknown) => {
      writing(ctx, "set_manualKeyframeTracks");
      wrap("set_manualKeyframeTracks", () => setManualKeyframeTracks(ctx.ed, n.guid, v));
    },
  },
  animationStyles: {
    get: (ctx: ApiContext, n: NodeChange) => animationStylesOf(ctx.ed, n.guid),
    set: (ctx: ApiContext, n: NodeChange, v: unknown) => {
      writing(ctx, "set_animationStyles");
      wrap("set_animationStyles", () => setAnimationStyles(ctx.ed, n.guid, v));
    },
  },
  timelines: { get: (ctx: ApiContext, n: NodeChange) => timelinesOf(ctx.ed, n.guid) },
  animations: { get: (ctx: ApiContext, n: NodeChange) => animationsOf(ctx.ed, n.guid) },
};

/** The host calls of the node methods and `figma.motion` (host.ts). */
export function motionOps(ctx: () => ApiContext): Record<string, (...a: unknown[]) => unknown> {
  const s = (v: unknown) => String(v ?? "");
  return {
    "motion.applyTrack": (id, field, track) => {
      const node = sceneNode(ctx(), s(id), "applyManualKeyframeTrack");
      writing(ctx(), "applyManualKeyframeTrack");
      wrap("applyManualKeyframeTrack", () => void applyManualKeyframeTrack(ctx().ed, node, field, track));
    },
    "motion.removeTrack": (id, field) => {
      const node = sceneNode(ctx(), s(id), "removeManualKeyframeTrack");
      writing(ctx(), "removeManualKeyframeTrack");
      wrap("removeManualKeyframeTrack", () => void removeManualKeyframeTrack(ctx().ed, node, field));
    },
    "motion.applyStyle": (id, styleId, config) => {
      const node = sceneNode(ctx(), s(id), "applyAnimationStyle");
      writing(ctx(), "applyAnimationStyle");
      return wrap("applyAnimationStyle", () => applyAnimationStyle(ctx().ed, node, styleId, (config ?? {}) as StyleConfig));
    },
    "motion.removeStyle": (id, entry) => {
      const node = sceneNode(ctx(), s(id), "removeAnimationStyle");
      writing(ctx(), "removeAnimationStyle");
      wrap("removeAnimationStyle", () => removeAnimationStyle(ctx().ed, node, s(entry)));
    },
    "motion.setDuration": (id, timelineId, seconds) => {
      const node = sceneNode(ctx(), s(id), "setTimelineDuration");
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) throw new ApiError("in setTimelineDuration: Expected a number of seconds");
      writing(ctx(), "setTimelineDuration");
      wrap("setTimelineDuration", () => void setTimeline(ctx().ed, node, s(timelineId), { duration: seconds }));
    },
    "motion.styles": () => figmaAnimationStyles(),
    "motion.playhead": () => motionUi(ctx().ed).timeUs / 1e6,
  };
}
