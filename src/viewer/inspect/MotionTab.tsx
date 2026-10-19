/**
 * Dev Mode's Motion tab (docs/motion.md §8.2; round 8f): in the Inspect panel when the selection is or holds an
 * animated layer (help: "the Motion tab"), for the editor's Dev Mode and the developer preview viewer alike.
 *
 * - **Show in timeline view**: the Motion timeline read-only (editor/motion/timeline's `readOnly`: play, scrub, zoom)
 *   along the bottom of the canvas; the canvas plays the frame (the engine's motion layer on, as Motion mode, nothing
 *   editable), and closing it puts the design at rest again.
 * - **Timing**: the timeline's duration and playback, then per animated property its start, end, easing and values.
 * - **Code**: CSS (default) / React / JSON (./motionCode.ts) with Copy; lengths in Dev Mode's unit.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, CodeBlock, PanelSection, SegmentedControl } from "@/ds";
import type { Engine } from "@/engine/Engine";
import { t, useT } from "@/i18n";
import { Clock } from "@/editor/motion/clock";
import { Timeline } from "@/editor/motion/timeline/Timeline";
import { EASING_LABELS, KEYFRAME_FIELDS, PLAYBACK_LABELS, type KeyframeValue, type Micros, type MotionEasing, type ResolvedMotion, type TimelineModel } from "@shared/motion/types";
import { motionCode, timingRows, type MotionCodeFormat } from "./motionCode";
import { cssInUnit, type UnitSettings } from "./units";
import styles from "../Viewer.module.css";

/** The resolved motion of a layer and everything animated under it (null: nothing animated, or no Motion in this build). */
export function motionOf(engine: Engine, id: string): ResolvedMotion | null {
  let first: ResolvedMotion | null;
  try {
    first = engine.motionResolved(id);
  } catch {
    return null;
  }
  if (!first) return null;
  const all = first.root === id ? first : (engine.motionResolved(first.root) ?? first);
  // A layer's own entry, or the layers under it (a group, a frame inside the timeline's root).
  const under = (node: string) => {
    let n = engine.readNode(node, { fields: ["parentIndex"] });
    for (let i = 0; n && i < 400; i++) {
      if (n.guid === id) return true;
      n = n.parentIndex?.guid ? engine.readNode(n.parentIndex.guid, { fields: ["parentIndex"] }) : null;
    }
    return false;
  };
  const layers = all.layers.filter((l) => l.node === id || under(l.node));
  return layers.length ? { ...all, layers } : null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function valueText(v: KeyframeValue): string {
  switch (v.type) {
    case "FLOAT":
      return String(Math.round(v.value * 1000) / 1000);
    case "VECTOR":
      return `${r1(v.value.x)}, ${r1(v.value.y)}`;
    case "COLOR":
      return `rgba(${Math.round(v.value.r * 255)}, ${Math.round(v.value.g * 255)}, ${Math.round(v.value.b * 255)}, ${r1(v.value.a)})`;
    default:
      return JSON.stringify(v.value);
  }
}

/** A property's name as the timeline's rows say it ("Position", "Opacity"; a paint: "Fill 1", "Stroke 1"). */
function propertyLabel(key: string): string {
  const info = KEYFRAME_FIELDS[key as keyof typeof KEYFRAME_FIELDS];
  if (info) return t(info.label);
  const paint = /^(fills|strokes|effects)\[(\d+)\]$/.exec(key);
  if (!paint) return key;
  const n = Number(paint[2]) + 1;
  return paint[1] === "fills" ? t("Fill {n}", { n }) : paint[1] === "strokes" ? t("Stroke {n}", { n }) : t("Effect {n}", { n });
}

function easingText(e: MotionEasing): string {
  const name = t(EASING_LABELS[e.type]);
  const b = e.easingFunctionCubicBezier;
  if (e.type === "CUSTOM_CUBIC_BEZIER" && b) return `${name} (${[b.x1, b.y1, b.x2, b.y2].map((x) => Math.round(x * 100) / 100).join(", ")})`;
  if (e.type === "CUSTOM_SPRING" && e.easingFunctionSpring) return `${name} (${t("Bounce")} ${Math.round(e.easingFunctionSpring.bounce * 100) / 100})`;
  return name;
}

export function MotionTab({ engine, id, units, onTimeline }: { engine: Engine; id: string; units: UnitSettings; onTimeline: (open: boolean) => void }) {
  useT();
  const resolved = useMemo(() => motionOf(engine, id), [engine, id]);
  // Text layers' fills animate `color`, not `background-color`.
  const textLayers = useMemo(() => new Set((resolved?.layers ?? []).filter((l) => engine.readNode(l.node, { fields: ["type"] })?.type === "TEXT").map((l) => l.node)), [engine, resolved]);
  const [format, setFormat] = useState<MotionCodeFormat>("css");
  const code = useMemo(() => {
    if (!resolved) return "";
    const c = motionCode(format, { resolved, textLayers });
    return format === "json" ? c : cssInUnit(c, units);
  }, [resolved, format, textLayers, units]);
  if (!resolved) return <div className={styles.multi}>{t("Nothing here is animated")}</div>;
  const rows = timingRows(resolved);
  return (
    <div data-motion-tab="">
      <div className={styles.compareRow}>
        <Button variant="secondary" onClick={() => onTimeline(true)} data-show-timeline="">
          {t("Show in timeline view")}
        </Button>
      </div>
      <PanelSection title={t("Timing")}>
        <div className={styles.list} data-motion-timing="">
          <div className={styles.motionRow}>
            <span className={styles.valueLabel}>{t("Duration")}</span>
            <span>{`${Math.round(resolved.durationUs / 1000)} ms · ${t(PLAYBACK_LABELS[resolved.playback])}`}</span>
          </div>
          {rows.map((r, i) => (
            <div key={`${r.layer}${r.property}${i}`} className={styles.motionRow} data-motion-property={r.property}>
              <span className={styles.valueLabel}>{`${r.layer} · ${propertyLabel(r.property)}`}</span>
              <span>{r.startMs === r.endMs ? `${r.startMs} ms` : `${r.startMs}–${r.endMs} ms`}</span>
              <span className={styles.valueSub}>{easingText(r.easing)}</span>
              <span className={styles.valueSub}>{r.values.length > 6 ? `${r.values.slice(0, 5).map(valueText).join(" → ")} → … → ${valueText(r.values[r.values.length - 1])}` : r.values.map(valueText).join(" → ")}</span>
            </div>
          ))}
        </div>
      </PanelSection>
      <PanelSection
        title={t("Code")}
        actions={
          <SegmentedControl
            label={t("Code format")}
            value={format}
            options={[
              { value: "css", label: "CSS" },
              { value: "react", label: "React" },
              { value: "json", label: "JSON" },
            ]}
            onChange={(v) => setFormat(v as MotionCodeFormat)}
          />
        }
      >
        <div className={styles.code} data-language={format} data-motion-code="">
          <CodeBlock code={code} label={t("Copy")} />
        </div>
      </PanelSection>
    </div>
  );
}

/**
 * The timeline view: the root's timeline read-only along the canvas's bottom (left of the Inspect panel, `panel`), the
 * canvas playing it; closing it (or leaving the tab) turns the motion layer off again.
 */
export function DevTimeline({ engine, root, panel, onClose }: { engine: Engine; root: string; panel: HTMLElement | null; onClose: () => void }) {
  useT();
  const model = useMemo<TimelineModel | null>(() => {
    try {
      return engine.motionTimeline(root);
    } catch {
      return null;
    }
  }, [engine, root]);
  const [timeUs, setTimeUs] = useState<Micros>(0);
  const [playing, setPlaying] = useState(false);
  const clock = useRef<Clock | null>(null);
  useEffect(() => {
    if (!model) return;
    const c = new Clock({ durationUs: model.durationUs, playback: model.playback, onTime: setTimeUs, onEnd: () => setPlaying(false) });
    clock.current = c;
    return () => {
      c.pause();
      clock.current = null;
    };
  }, [model]);
  // The canvas plays the root at the playhead; at rest again when the view closes.
  useEffect(() => {
    try {
      engine.setMotion({ on: true, root, timeUs });
    } catch {
      // a build without Motion: the timeline still reads
    }
  }, [engine, root, timeUs]);
  useEffect(
    () => () => {
      try {
        engine.setMotion({ on: false, root: null, timeUs: 0 });
      } catch {
        // as above
      }
    },
    [engine]
  );
  const [right, setRight] = useState(0);
  useEffect(() => {
    if (!panel) return;
    const measure = () => setRight(Math.max(0, window.innerWidth - panel.getBoundingClientRect().left));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [panel]);
  if (!model) return null;
  const noop = () => {};
  return createPortal(
    <div className={styles.devTimeline} style={{ right }} data-dev-timeline="">
      <Timeline
        model={model}
        timeUs={timeUs}
        playing={playing}
        autoKeyframe={false}
        collapsed={false}
        unit="ms"
        selectedKeyframes={new Set()}
        selectedNodes={new Set()}
        readOnly
        onSeek={(t) => {
          clock.current?.seek(t);
          setTimeUs(t);
        }}
        onTogglePlay={() => {
          const c = clock.current;
          if (!c) return;
          if (c.playing) c.pause();
          else c.play(timeUs);
          setPlaying(c.playing);
        }}
        onToggleAutoKeyframe={noop}
        onToggleCollapse={onClose}
        onSetTimeline={noop}
        onSelectKeyframes={noop}
        onMoveKeyframes={noop}
        onDeleteKeyframes={noop}
        onDeleteTrack={noop}
        onSelectLayer={noop}
        onCopyKeyframes={noop}
        onPasteKeyframes={() => false}
        onResize={noop}
      />
    </div>,
    document.body
  );
}
