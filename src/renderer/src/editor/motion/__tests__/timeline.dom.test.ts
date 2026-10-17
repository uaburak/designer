// @vitest-environment happy-dom
// The timeline (docs/motion.md §6.2) on a fixed model (the committed wasm predates Motion, so the view is tested on its
// own): the rows, the diamonds' selection and drag, Delete, the segment's Easing menu, the header's controls; increment
// 2's marquee, ⌘C / ⌘V and the top edge; round 8a increment 2's animated instance bar dragged in time.
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { TimelineModel } from "@shared/motion/types";
import { $, $$, box, click, focus, key, mount, pointer, spy, type } from "@/ds/__tests__/dom";
import { Timeline, type TimelineProps } from "../timeline/Timeline";
import { ORIGIN_PX, fitScale, frameUs } from "../timeline/maths";

const MODEL: TimelineModel = {
  root: "1:1",
  rootName: "Card",
  timelineId: "1:1",
  durationUs: 2_000_000,
  playback: "LOOP",
  snappingFps: 60,
  layers: [
    {
      node: "1:2",
      name: "Rect",
      icon: "16.rectangle",
      depth: 0,
      tracks: [
        { id: "t1", field: { type: "PROPERTY", name: "OPACITY" }, label: "Opacity", keyframes: [
          { id: "k1", timeUs: 0, value: { type: "FLOAT", value: 1 }, easing: { type: "LINEAR" } },
          { id: "k2", timeUs: 500_000, value: { type: "FLOAT", value: 0 }, easing: { type: "EASE_OUT" } },
        ] },
        { id: "t2", field: { type: "PROPERTY", name: "TRANSLATION_XY" }, label: "Position", keyframes: [
          { id: "k3", timeUs: 1_000_000, value: { type: "VECTOR", value: { x: 0, y: 0 } }, easing: { type: "LINEAR" } },
        ] },
      ],
      clips: [],
      startUs: 0,
      endUs: 1_000_000,
    },
    { node: "1:3", name: "Title", icon: "16.text", depth: 0, tracks: [], clips: [], startUs: 0, endUs: 0 },
  ],
  audioTracks: [],
  audio: [],
};

type Spies = { [K in keyof TimelineProps as NonNullable<TimelineProps[K]> extends (...a: never[]) => void ? K : never]-?: ReturnType<typeof spy> };

function setup(over: Partial<TimelineProps> = {}) {
  const s = {
    onSeek: spy(), onTogglePlay: spy(), onToggleAutoKeyframe: spy(), onToggleCollapse: spy(), onSetTimeline: spy(), onSelectKeyframes: spy(),
    onMoveKeyframes: spy(), onDeleteKeyframes: spy(), onDeleteTrack: spy(), onSetEasing: spy(), onSelectLayer: spy(),
    onCopyKeyframes: spy(), onPasteKeyframes: spy(), onResize: spy(), onMoveInstance: spy(),
  } as unknown as Spies;
  const props = { model: MODEL, timeUs: 0, playing: false, autoKeyframe: false, collapsed: false, unit: "ms", selectedKeyframes: new Set(), selectedNodes: new Set(), ...(s as unknown as Partial<TimelineProps>), ...over } as TimelineProps;
  // The same component each time, so the view's own state (rows, drags) survives a props change.
  const view = mount(Timeline, props);
  const rerender = (patch: Partial<TimelineProps>) => view.rerender(Timeline, { ...props, ...patch } as TimelineProps);
  // happy-dom has no layout: the track area reports its default 600 width, its box starts at 0.
  box($('[aria-label="Tracks"]', view.host), { left: 0, top: 0, width: 600, height: 200 });
  return { view, s, rerender, scale: fitScale(2_000_000, 600) };
}

const windowPointer = (type: "pointermove" | "pointerup", init: { clientX: number; clientY?: number; shiftKey?: boolean }) =>
  act(() => void window.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0, ...init })));

describe("the Motion timeline", () => {
  it("draws the layers, their property rows, the diamonds and the segments; the empty state without a model", () => {
    const { view, rerender } = setup();
    expect($$("[data-layer-row]", view.host).map((e) => e.textContent)).toEqual(["Rect", "Title"]);
    expect($$("[data-track-row]", view.host).map((e) => e.textContent)).toEqual(["Opacity", "Position"]);
    expect($$("[data-keyframe]", view.host).map((e) => e.dataset.keyframe)).toEqual(["k1", "k2", "k3"]);
    expect($("[data-segment]", view.host).getAttribute("aria-label")).toBe("Easing: Ease out");
    expect($("[data-layer-bar]", view.host)).not.toBeNull();
    expect(view.host.querySelector("section")?.dataset.motionTimeline).toBe("open");
    rerender({ model: null });
    expect(view.host.textContent).toContain("Select a layer inside a top-level frame");
    rerender({ model: MODEL, collapsed: true, autoKeyframe: true });
    expect(view.host.querySelector("section")?.dataset.motionTimeline).toBe("collapsed");
    expect(view.host.querySelector("section")?.hasAttribute("data-auto-keyframe")).toBe(true);
    expect($$("[data-keyframe]", view.host)).toHaveLength(0);
    view.unmount();
  });

  it("a diamond: click selects, ⇧-click adds, double-click seeks and selects the layer; a layer row selects all its keyframes", () => {
    const { view, s, rerender } = setup();
    const k2 = $('[data-keyframe="k2"]', view.host);
    pointer(k2, "pointerdown", { clientX: 100 });
    windowPointer("pointerup", { clientX: 100 });
    expect(s.onSelectKeyframes.calls).toEqual([[["k2"]]]);
    expect(s.onMoveKeyframes.calls).toHaveLength(0);
    rerender({ selectedKeyframes: new Set(["k2"]) });
    expect($('[data-keyframe="k2"]', view.host).hasAttribute("data-selected")).toBe(true);
    pointer($('[data-keyframe="k3"]', view.host), "pointerdown", { clientX: 200, shiftKey: true });
    windowPointer("pointerup", { clientX: 200 });
    expect(s.onSelectKeyframes.calls.at(-1)).toEqual([["k2", "k3"]]);
    act(() => void $('[data-keyframe="k2"]', view.host).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(s.onSeek.calls.at(-1)).toEqual([500_000]);
    expect(s.onSelectLayer.calls.at(-1)).toEqual(["1:2", false]);
    click($('[data-layer-row="1:2"]', view.host));
    expect(s.onSelectLayer.calls.at(-1)).toEqual(["1:2", false]);
    expect(s.onSelectKeyframes.calls.at(-1)).toEqual([["k1", "k2", "k3"]]);
    view.unmount();
  });

  it("dragging a diamond moves the selected keyframes together, snapped to frames, one final call on release", () => {
    const { view, s, scale } = setup({ selectedKeyframes: new Set(["k1", "k2"]) });
    pointer($('[data-keyframe="k2"]', view.host), "pointerdown", { clientX: 100 });
    windowPointer("pointermove", { clientX: 101 }); // under the drag threshold
    expect(s.onMoveKeyframes.calls).toHaveLength(0);
    const dx = 60;
    windowPointer("pointermove", { clientX: 100 + dx });
    const dUs = dx / scale.pxPerUs;
    const snapped = Math.round(dUs / frameUs(60)) * frameUs(60);
    expect(s.onMoveKeyframes.calls).toHaveLength(1);
    const [edits, final] = s.onMoveKeyframes.calls[0] as [{ id: string; timeUs: number }[], boolean];
    expect(final).toBe(false);
    expect(edits.map((e) => e.id).sort()).toEqual(["k1", "k2"]);
    expect(edits.find((e) => e.id === "k1")!.timeUs).toBe(Math.round(snapped));
    expect(edits.find((e) => e.id === "k2")!.timeUs).toBe(Math.round(500_000 + snapped));
    windowPointer("pointerup", { clientX: 100 + dx });
    expect(s.onMoveKeyframes.calls).toHaveLength(2);
    expect(s.onMoveKeyframes.calls[1][1]).toBe(true);
    // Dragged left past 0: the earliest stays at 0.
    pointer($('[data-keyframe="k1"]', view.host), "pointerdown", { clientX: 100 });
    windowPointer("pointermove", { clientX: 10 });
    const back = s.onMoveKeyframes.calls.at(-1)![0] as { id: string; timeUs: number }[];
    expect(back.find((e) => e.id === "k1")!.timeUs).toBe(0);
    windowPointer("pointerup", { clientX: 10 });
    view.unmount();
  });

  it("Delete removes the selected keyframes, or the selected property row's track; arrows step a frame", () => {
    const { view, s, rerender } = setup({ selectedKeyframes: new Set(["k3"]) });
    const tracks = $('[aria-label="Tracks"]', view.host);
    key(tracks, "Delete");
    expect(s.onDeleteKeyframes.calls).toEqual([[["k3"]]]);
    rerender({ selectedKeyframes: new Set() });
    click($('[data-track-row="t1"]', view.host));
    expect(s.onSelectKeyframes.calls.at(-1)).toEqual([["k1", "k2"]]);
    rerender({ selectedKeyframes: new Set() });
    key(tracks, "Backspace");
    expect(s.onDeleteTrack.calls).toHaveLength(1);
    expect(s.onDeleteTrack.calls[0][0]).toBe("1:2");
    expect((s.onDeleteTrack.calls[0][1] as { id: string }).id).toBe("t1");
    key(tracks, "ArrowRight");
    expect(s.onSeek.calls.at(-1)![0]).toBeCloseTo(frameUs(60), 0);
    key(tracks, "ArrowRight", { shiftKey: true });
    expect(s.onSeek.calls.at(-1)![0]).toBeCloseTo(10 * frameUs(60), 0);
    key(tracks, "End");
    expect(s.onSeek.calls.at(-1)).toEqual([2_000_000]);
    key(tracks, " ");
    expect(s.onTogglePlay.calls).toHaveLength(1);
    view.unmount();
  });

  it("a segment opens the Easing menu for its end keyframe: Hold first; choosing one writes it", () => {
    const { view, s } = setup();
    click($("[data-segment]", view.host));
    const editor = $("[data-easing-editor]");
    expect(editor).not.toBeNull();
    const names = $$("[data-easing]", editor).map((e) => e.dataset.easing);
    expect(names[0]).toBe("HOLD");
    expect(names).not.toContain("GENTLE");
    expect($('[data-easing="EASE_OUT"]', editor).getAttribute("aria-selected")).toBe("true");
    click($('[data-easing="HOLD"]', editor));
    expect(s.onSetEasing.calls).toEqual([[["k2"], { type: "HOLD" }]]);
    view.unmount();
  });

  it("the header: Play, auto-keyframe, Playback cycles Loop → Once, Collapse, a typed time seeks, the ruler scrubs", () => {
    const { view, s, scale } = setup();
    click($('button[aria-label="Play"]', view.host));
    expect(s.onTogglePlay.calls).toHaveLength(1);
    click($('button[aria-label="Toggle auto-keyframe"]', view.host));
    expect(s.onToggleAutoKeyframe.calls).toHaveLength(1);
    click($('button[aria-label="Playback: Loop"]', view.host));
    expect(s.onSetTimeline.calls).toEqual([[{ playback: "ONCE" }, true]]);
    click($('button[aria-label="Collapse timeline"]', view.host));
    expect(s.onToggleCollapse.calls).toHaveLength(1);
    const time = $('input[aria-label="Current time"]', view.host) as HTMLInputElement;
    expect(time.value).toBe("0 ms");
    focus(time);
    type(time, "750");
    key(time, "Enter");
    expect(s.onSeek.calls.at(-1)).toEqual([750_000]);
    const duration = $('input[aria-label="Duration"]', view.host) as HTMLInputElement;
    expect(duration.value).toBe("2000 ms");
    focus(duration);
    type(duration, "3s");
    key(duration, "Enter");
    expect(s.onSetTimeline.calls.at(-1)).toEqual([{ durationUs: 3_000_000 }, true]);
    const ruler = $("[data-ruler]", view.host);
    pointer(ruler, "pointerdown", { clientX: ORIGIN_PX + 1_000_000 * scale.pxPerUs });
    expect(s.onSeek.calls.at(-1)![0]).toBeCloseTo(1_000_000, -4);
    view.unmount();
  });

  it("a marquee over the track area selects the keyframes it touches, ⇧ adds to the selection; a click there clears it", () => {
    const { view, s, rerender } = setup();
    // happy-dom has no layout: the diamonds' boxes as drawn (k1, k2 on the Opacity row, k3 on the Position row).
    box($('[data-keyframe="k1"]', view.host), { left: 10, top: 50, width: 16, height: 16 });
    box($('[data-keyframe="k2"]', view.host), { left: 150, top: 50, width: 16, height: 16 });
    box($('[data-keyframe="k3"]', view.host), { left: 300, top: 74, width: 16, height: 16 });
    const tracks = $('[aria-label="Tracks"]', view.host);
    pointer(tracks, "pointerdown", { clientX: 0, clientY: 40 });
    expect(s.onSelectKeyframes.calls).toEqual([[[]]]);
    windowPointer("pointermove", { clientX: 1, clientY: 41 }); // under the drag threshold: no marquee yet
    expect($("[data-marquee]", view.host)).toBeNull();
    windowPointer("pointermove", { clientX: 200, clientY: 60 });
    expect($("[data-marquee]", view.host).style.width).toBe("200px");
    expect(s.onSelectKeyframes.calls.at(-1)).toEqual([["k1", "k2"]]);
    windowPointer("pointerup", { clientX: 200, clientY: 60 });
    expect($("[data-marquee]", view.host)).toBeNull();
    rerender({ selectedKeyframes: new Set(["k1", "k2"]) });
    pointer(tracks, "pointerdown", { clientX: 290, clientY: 70, shiftKey: true });
    windowPointer("pointermove", { clientX: 320, clientY: 95, shiftKey: true });
    expect(s.onSelectKeyframes.calls.at(-1)).toEqual([["k1", "k2", "k3"]]);
    windowPointer("pointerup", { clientX: 320, clientY: 95 });
    view.unmount();
  });

  it("⌘C copies the selected keyframes and ⌘V pastes them: the document's clipboard events stop at the track area", () => {
    let pastes = 0;
    const { view, s } = setup({ selectedKeyframes: new Set(["k1", "k3"]), onPasteKeyframes: () => ++pastes > 0 });
    let reached = 0;
    const count = () => reached++;
    document.addEventListener("copy", count);
    document.addEventListener("paste", count);
    const tracks = $('[aria-label="Tracks"]', view.host);
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    act(() => void tracks.dispatchEvent(copy));
    expect(s.onCopyKeyframes.calls).toEqual([[["k1", "k3"]]]);
    expect(copy.defaultPrevented).toBe(true);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    act(() => void tracks.dispatchEvent(paste));
    expect(pastes).toBe(1);
    expect(paste.defaultPrevented).toBe(true);
    expect(reached).toBe(0);
    document.removeEventListener("copy", count);
    document.removeEventListener("paste", count);
    view.unmount();
  });

  it("nothing selected, nothing copied: the clipboard events go on to the document", () => {
    const { view, s } = setup({ onPasteKeyframes: () => false });
    const tracks = $('[aria-label="Tracks"]', view.host);
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    act(() => void tracks.dispatchEvent(copy));
    expect(s.onCopyKeyframes.calls).toHaveLength(0);
    expect(copy.defaultPrevented).toBe(false);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    act(() => void tracks.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(false);
    view.unmount();
  });

  it("the top edge resizes the timeline: at least 120, at most 60 % of the window; collapsed, there is no edge", () => {
    const { view, s, rerender } = setup();
    box(view.host.querySelector("section")!, { left: 0, top: 560, width: 1000, height: 240 });
    pointer($("[data-timeline-resize]", view.host), "pointerdown", { clientY: 560 });
    windowPointer("pointermove", { clientX: 0, clientY: 460 });
    expect(s.onResize.calls.at(-1)).toEqual([340, false]);
    windowPointer("pointermove", { clientX: 0, clientY: 900 });
    expect(s.onResize.calls.at(-1)).toEqual([120, false]);
    windowPointer("pointerup", { clientX: 0, clientY: -4000 });
    expect(s.onResize.calls.at(-1)).toEqual([Math.round(window.innerHeight * 0.6), true]);
    rerender({ collapsed: true });
    expect(view.host.querySelector("[data-timeline-resize]")).toBeNull();
    view.unmount();
  });

  it("an animated instance is one purple bar: dragged, it moves the instance in time (snapped to frames), one final call", () => {
    const withInstance: TimelineModel = {
      ...MODEL,
      layers: [...MODEL.layers, { node: "1:4", name: "Pulse", icon: "16.instance", depth: 0, instance: { offsetUs: 250_000, durationUs: 1_000_000, mainTimeline: "2:1" }, tracks: [], clips: [], startUs: 250_000, endUs: 1_250_000 }],
    };
    const { view, s, scale } = setup({ model: withInstance });
    const bar = $('[data-instance-bar="1:4"]', view.host);
    expect(bar.style.width).toBe(`${1_000_000 * scale.pxPerUs}px`);
    pointer(bar, "pointerdown", { clientX: 200 });
    expect(s.onSelectLayer.calls.at(-1)).toEqual(["1:4", false]);
    windowPointer("pointermove", { clientX: 201 }); // under the drag threshold
    expect(s.onMoveInstance.calls).toHaveLength(0);
    windowPointer("pointermove", { clientX: 260 });
    const want = Math.round(Math.round((250_000 + 60 / scale.pxPerUs) / frameUs(60)) * frameUs(60));
    expect(s.onMoveInstance.calls.at(-1)).toEqual(["1:4", want, false]);
    windowPointer("pointerup", { clientX: 260 });
    expect(s.onMoveInstance.calls.at(-1)).toEqual(["1:4", want, true]);
    // Read-only (Dev Mode): the bar doesn't move.
    view.unmount();
    const ro = setup({ model: withInstance, readOnly: true });
    pointer($('[data-instance-bar="1:4"]', ro.view.host), "pointerdown", { clientX: 200 });
    windowPointer("pointermove", { clientX: 300 });
    expect(ro.s.onMoveInstance.calls).toHaveLength(0);
    windowPointer("pointerup", { clientX: 300 });
    ro.view.unmount();
  });
});
