// @vitest-environment happy-dom
// The timeline (docs/motion.md §6.2) on a fixed model (the committed wasm predates Motion, so the view is tested on its
// own): the rows, the diamonds' selection and drag, Delete, the segment's Easing menu, the header's controls; increment
// 2's marquee, ⌘C / ⌘V and the top edge; round 8a increment 2's animated instance bar dragged in time; round 8h's
// preset clips (selected, dragged, stretched by either handle, deleted); round 8e's audio rows; round 8i's settings
// popover, layer bar, scrolling lanes, combine / split menu and read-only view.
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
    onCopyKeyframes: spy(), onPasteKeyframes: spy(), onResize: spy(), onMoveInstance: spy(), onSelectClip: spy(), onEditClip: spy(), onDeleteClip: spy(),
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

  it("a preset's clip is a row under its layer: click selects it, drag moves it, its handles stretch it, Delete removes it", () => {
    const clip = { id: "c1", preset: "opacity" as const, name: "Opacity", startUs: 500_000, durationUs: 500_000, disabled: false, easing: { type: "EASE_OUT" as const }, props: {} };
    const withClip: TimelineModel = { ...MODEL, layers: [{ ...MODEL.layers[0], clips: [clip] }, MODEL.layers[1]] };
    const { view, s, scale, rerender } = setup({ model: withClip });
    // Its row (the type's name) before the property rows; its bar over its span.
    expect($$("[data-clip-row], [data-track-row]", view.host).map((e) => e.textContent)).toEqual(["Opacity", "Opacity", "Position"]);
    const bar = $('[data-clip="c1"]', view.host);
    expect(bar.style.left).toBe(`${ORIGIN_PX + 500_000 * scale.pxPerUs}px`);
    expect(bar.style.width).toBe(`${500_000 * scale.pxPerUs}px`);
    // A press selects it (and clears the keyframes'); a drag moves its start, snapped to frames, one final call.
    pointer(bar, "pointerdown", { clientX: 200 });
    expect(s.onSelectClip.calls.at(-1)).toEqual(["c1"]);
    expect(s.onSelectKeyframes.calls.at(-1)).toEqual([[]]);
    windowPointer("pointermove", { clientX: 230 });
    const moved = Math.round(Math.round((500_000 + 30 / scale.pxPerUs) / frameUs(60)) * frameUs(60));
    expect(s.onEditClip.calls.at(-1)).toEqual([clip, { startUs: moved }, false]);
    windowPointer("pointerup", { clientX: 230 });
    expect(s.onEditClip.calls.at(-1)).toEqual([clip, { startUs: moved }, true]);
    // The right handle: its length; the left: its start and length, the end kept.
    pointer($('[data-clip="c1"] [data-clip-handle="end"]', view.host), "pointerdown", { clientX: 300 });
    windowPointer("pointermove", { clientX: 330 });
    windowPointer("pointerup", { clientX: 330 });
    const end = Math.round(Math.round((1_000_000 + 30 / scale.pxPerUs) / frameUs(60)) * frameUs(60));
    expect(s.onEditClip.calls.at(-1)).toEqual([clip, { durationUs: end - 500_000 }, true]);
    pointer($('[data-clip="c1"] [data-clip-handle="start"]', view.host), "pointerdown", { clientX: 300 });
    windowPointer("pointermove", { clientX: 270 });
    windowPointer("pointerup", { clientX: 270 });
    const start = Math.round(Math.round((500_000 - 30 / scale.pxPerUs) / frameUs(60)) * frameUs(60));
    expect(s.onEditClip.calls.at(-1)).toEqual([clip, { startUs: start, durationUs: 1_000_000 - start }, true]);
    // Selected (the editor says so): Delete in the track area removes it.
    rerender({ model: withClip, selectedClip: "c1" });
    expect($('[data-clip="c1"]', view.host).hasAttribute("data-selected")).toBe(true);
    key($('[aria-label="Tracks"]', view.host), "Delete");
    expect(s.onDeleteClip.calls.at(-1)).toEqual(["c1"]);
    view.unmount();
  });

  it("audio rows under the layers: a clip selects, moves and trims (never past the file), its row's eye mutes, Delete removes it", () => {
    const clip = { id: "a1", trackId: "r1", name: "Beat", mediaHash: "h1", offsetUs: 500_000, startUs: 200_000, durationUs: 1_000_000, volume: 1, mute: false };
    const withAudio: TimelineModel = { ...MODEL, audioTracks: [{ id: "r1", name: "Beat", gain: 1, mute: false }], audio: [clip] };
    const a = { onSelectAudio: spy(), onEditAudio: spy(), onDeleteAudio: spy(), onToggleAudioRow: spy(), onAudioMenu: spy() };
    const { view, s, scale, rerender } = setup({ model: withAudio, ...(a as unknown as Partial<TimelineProps>), audioLength: () => 1_500_000, audioPeaks: () => new Float32Array(200).fill(0.5) });
    expect($$("[data-audio-row]", view.host).map((e) => e.textContent)).toEqual(["Beat"]);
    const bar = $('[data-audio-clip="a1"]', view.host);
    expect(bar.style.left).toBe(`${ORIGIN_PX + 500_000 * scale.pxPerUs}px`);
    expect(bar.querySelector("svg path")?.getAttribute("d")).toMatch(/^M0\.5 /); // the waveform
    // A press selects it; a drag moves it, snapped to frames, one final call.
    pointer(bar, "pointerdown", { clientX: 200 });
    expect(a.onSelectAudio.calls.at(-1)).toEqual(["a1"]);
    windowPointer("pointermove", { clientX: 230 });
    windowPointer("pointerup", { clientX: 230 });
    const moved = Math.round(Math.round((500_000 + 30 / scale.pxPerUs) / frameUs(60)) * frameUs(60));
    expect(a.onEditAudio.calls.at(-1)).toEqual([clip, { offsetUs: moved }, true]);
    // The right handle stops at the file's end (1.5 s long, the region starting 0.2 s in: 1.3 s at most).
    pointer($('[data-audio-clip="a1"] [data-audio-handle="end"]', view.host), "pointerdown", { clientX: 300 });
    windowPointer("pointermove", { clientX: 590 });
    windowPointer("pointerup", { clientX: 590 });
    expect(a.onEditAudio.calls.at(-1)).toEqual([clip, { durationUs: 1_300_000 }, true]);
    // The left handle trims the head: back no further than the file's start.
    pointer($('[data-audio-clip="a1"] [data-audio-handle="start"]', view.host), "pointerdown", { clientX: 300 });
    windowPointer("pointermove", { clientX: 0 });
    windowPointer("pointerup", { clientX: 0 });
    expect(a.onEditAudio.calls.at(-1)).toEqual([clip, { offsetUs: 300_000, startUs: 0, durationUs: 1_200_000 }, true]);
    // The row's eye mutes the row.
    click($('[data-audio-eye="r1"]', view.host));
    expect(a.onToggleAudioRow.calls.at(-1)).toEqual(["r1", true]);
    // Selected: Delete removes it; with audio, Playback skips Ping-pong (Loop → Once → Loop).
    rerender({ model: { ...withAudio, playback: "ONCE" }, selectedAudio: "a1" });
    expect($('[data-audio-clip="a1"]', view.host).hasAttribute("data-selected")).toBe(true);
    key($('[aria-label="Tracks"]', view.host), "Delete");
    expect(a.onDeleteAudio.calls.at(-1)).toEqual([["a1"]]);
    click($('[aria-label^="Playback"]', view.host));
    expect(s.onSetTimeline.calls.at(-1)).toEqual([{ playback: "LOOP" }, true]);
    view.unmount();
  });

  it("round 8i: the settings popover sets the units, the grid and the loop; Ping pong is off with audio", () => {
    const onSetUnit = spy();
    const { view, s, rerender } = setup({ onSetUnit } as unknown as Partial<TimelineProps>);
    click($("[data-timeline-settings]", view.host));
    const pop = $("[data-timeline-settings-popover]");
    expect(pop).not.toBeNull();
    click($$('[role="radio"]', pop).find((r) => r.textContent === "Frames")!);
    expect(onSetUnit.calls.at(-1)).toEqual(["frames"]);
    // A typed grid step (ms): 50 ms is 20 fps.
    const grid = $('input[aria-label="Grid (ms)"]', pop) as HTMLInputElement;
    focus(grid);
    type(grid, "50");
    key(grid, "Enter");
    expect(s.onSetTimeline.calls.at(-1)).toEqual([{ snappingFps: 20 }, true]);
    click($$('[role="radio"]', pop).find((r) => r.textContent === "Once")!);
    expect(s.onSetTimeline.calls.at(-1)).toEqual([{ playback: "ONCE" }, true]);
    click($("[data-timeline-settings]", view.host));
    const clip = { id: "a1", trackId: "r1", name: "Beat", mediaHash: "h1", offsetUs: 0, startUs: 0, durationUs: 1, volume: 1, mute: false };
    rerender({ model: { ...MODEL, audioTracks: [{ id: "r1", name: "Beat", gain: 1, mute: false }], audio: [clip] } });
    click($("[data-timeline-settings]", view.host));
    const ping = $$('[role="radio"]', $("[data-timeline-settings-popover]")).find((r) => r.textContent === "Ping-pong") as HTMLButtonElement;
    expect(ping.disabled).toBe(true);
    view.unmount();
  });

  it("round 8i: the layer bar moves its layer by each frame's change, its end handle scales about its start", () => {
    const onRetimeLayer = spy();
    const { view, scale } = setup({ onRetimeLayer } as unknown as Partial<TimelineProps>);
    const bar = $('[data-layer-bar="1:2"]', view.host);
    expect(bar.hasAttribute("data-editable")).toBe(true);
    pointer(bar, "pointerdown", { clientX: 100 });
    windowPointer("pointermove", { clientX: 101 }); // under the drag threshold
    expect(onRetimeLayer.calls).toHaveLength(0);
    windowPointer("pointermove", { clientX: 130 });
    windowPointer("pointermove", { clientX: 160 });
    windowPointer("pointerup", { clientX: 160 });
    const snapped = Math.round(Math.round((60 / scale.pxPerUs) / frameUs(60)) * frameUs(60));
    const moves = onRetimeLayer.calls.map((c) => (c[1] as { deltaUs: number }).deltaUs);
    expect(moves.reduce((a, b) => a + b, 0)).toBe(snapped);
    expect(onRetimeLayer.calls.at(-1)![2]).toBe(true);
    // The end handle: a scale about the bar's start (0), from its 1 s to the new length.
    onRetimeLayer.calls.length = 0;
    pointer($('[data-layer-bar="1:2"] [data-bar-handle="end"]', view.host), "pointerdown", { clientX: 300 });
    windowPointer("pointermove", { clientX: 300 + 1_000_000 * scale.pxPerUs });
    windowPointer("pointerup", { clientX: 300 + 1_000_000 * scale.pxPerUs });
    const scales = onRetimeLayer.calls.map((c) => (c[1] as { scale: { factor: number; pivotUs: number } }).scale);
    expect(scales[0].pivotUs).toBe(0);
    expect(scales.reduce((a, b) => a * b.factor, 1)).toBeCloseTo(2, 2);
    view.unmount();
  });

  it("round 8i: the lanes follow the layer column's scroll; a Position row's menu splits its track", () => {
    const onCombineTracks = spy();
    const { view } = setup({ onCombineTracks } as unknown as Partial<TimelineProps>);
    const rows = $('[aria-label="Animated layers"]', view.host);
    rows.scrollTop = 30;
    act(() => void rows.dispatchEvent(new Event("scroll")));
    expect(($('[aria-label="Tracks"]', view.host).querySelector("[data-lane]")!.parentElement as HTMLElement).style.transform).toBe("translateY(-30px)");
    act(() => void $('[data-track-row="t2"]', view.host).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
    click($$('[role="menuitem"]').find((r) => r.textContent?.includes("Split tracks"))!);
    expect(onCombineTracks.calls.at(-1)).toEqual(["1:2", "POSITION", false]);
    view.unmount();
  });

  it("round 8i: read-only (Dev Mode's timeline view) plays and scrubs, nothing else: no resize, settings, easing menu or bar drag", () => {
    const onRetimeLayer = spy();
    const { view } = setup({ readOnly: true, onRetimeLayer } as unknown as Partial<TimelineProps>);
    expect($("[data-timeline-resize]", view.host)).toBeNull();
    expect($("[data-timeline-settings]", view.host)).toBeNull();
    const segment = $("[data-segment]", view.host) as HTMLButtonElement;
    expect(segment.disabled).toBe(true);
    click(segment);
    expect($("[data-easing-editor]")).toBeNull();
    expect($('[data-layer-bar="1:2"]', view.host).hasAttribute("data-editable")).toBe(false);
    expect($("[data-duration-handle]", view.host).hasAttribute("data-readonly")).toBe(true);
    view.unmount();
  });
});
