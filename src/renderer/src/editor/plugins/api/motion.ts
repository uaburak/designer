/**
 * The Plugin API's Motion (docs/motion.md §9; round 8f): the node properties `manualKeyframeTracks` (get / set),
 * `animationStyles` (get / set), `timelines`, `animations`, the methods `applyManualKeyframeTrack`,
 * `removeManualKeyframeTrack`, `applyAnimationStyle`, `removeAnimationStyle`, `setTimelineDuration`, and `figma.motion`
 * (`figmaAnimationStyles()`, `playheadPosition`, `physicalSpringToNormalized()`); round 8j: custom animation styles
 * (`figma.getLocalCustomAnimationStylesAsync`, `createCustomAnimationStyle`, a style's name, `animationEntries`,
 * `addAnimationEntryAsync`, `removeAnimationEntry`, `remove`) and `{type: "CUSTOM"}`. Figma's shapes and rules live in
 * motion/publicApi.ts (shared with the agents' tools); this file only adds the run's write slice and Dev Mode's
 * read-only rule (Dev Mode exposes the reads). Seconds at the API.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { motionUi } from "../../motion/motionState";
import {
  addAnimationEntry,
  animationStylesOf,
  animationsOf,
  applyAnimationStyle,
  applyManualKeyframeTrack,
  createCustomAnimationStyle,
  customAnimationStyle,
  customAnimationStyles,
  figmaAnimationStyles,
  manualKeyframeTracks,
  removeAnimationEntry,
  removeAnimationStyle,
  removeCustomAnimationStyle,
  removeManualKeyframeTrack,
  renameCustomAnimationStyle,
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
    // Custom animation styles (round 8j): handles {id} whose fields the host reads (figma.js `animationStyle`).
    "motion.localStyles": () => customAnimationStyles(ctx().ed).map((st) => ({ id: st.id })),
    "motion.createStyle": () => {
      writing(ctx(), "createCustomAnimationStyle");
      return wrap("createCustomAnimationStyle", () => ({ id: createCustomAnimationStyle(ctx().ed).id }));
    },
    "motion.style.get": (id, field) => {
      const st = customAnimationStyle(ctx().ed, s(id));
      if (!st) throw new ApiError(`The custom animation style ${s(id)} does not exist`);
      return (st as unknown as Record<string, unknown>)[s(field)] ?? null;
    },
    "motion.style.set": (id, field, v) => {
      if (field !== "name") throw new ApiError(`in set_${s(field)}: a custom animation style's ${s(field)} is read-only (addAnimationEntryAsync / removeAnimationEntry change its entries)`);
      writing(ctx(), "set_name");
      wrap("set_name", () => renameCustomAnimationStyle(ctx().ed, s(id), v));
    },
    "motion.style.addEntry": (id, definition, props) => {
      writing(ctx(), "addAnimationEntryAsync");
      return wrap("addAnimationEntryAsync", () => addAnimationEntry(ctx().ed, s(id), definition, props));
    },
    "motion.style.removeEntry": (id, entry) => {
      writing(ctx(), "removeAnimationEntry");
      wrap("removeAnimationEntry", () => removeAnimationEntry(ctx().ed, s(id), s(entry)));
    },
    "motion.style.remove": (id) => {
      writing(ctx(), "remove");
      wrap("remove", () => removeCustomAnimationStyle(ctx().ed, s(id)));
    },
  };
}
