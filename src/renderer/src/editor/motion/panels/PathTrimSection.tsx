/**
 * Path trim in Motion mode (docs/motion.md §4.13, §6.5; round 8a, increment 2): the selection's strokes' "Path trim
 * start" and "Path trim end" (0–100 %), Figma's two keyframable fields, each with its diamond. The engine draws them —
 * it cuts each stroke's centre line by arc length (help: path trim works on center-aligned strokes; others draw
 * whole, and the section says so) — and routes the write: a value typed while the field has a track, or with
 * auto-keyframe on, is a keyframe at the playhead (motionRouteWrite); otherwise it is the design's own path trim.
 *
 * `pathTrim` is the layer's OptionalVector (x = start, y = end, 0–1; absent: the whole path). The live node holds the
 * motion layer's value at the playhead, so the fields follow the playhead as Design's do.
 */
import { NumericInput, PanelSection, PropertyGrid, PropertyRow } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../../controller";
import { fieldValue, mixedNumber } from "../../model/mixed";
import { perLayer } from "../../panels/design/Sections";
import { fields, type PanelNode } from "../../panels/design/shared";
import { MotionField } from "./MotionField";
import styles from "./MotionPanels.module.css";

/** The layer's path trim as fractions (absent: the whole path). */
export const trimOf = (n: PanelNode) => ({ start: n.pathTrim?.value?.x ?? 0, end: n.pathTrim?.value?.y ?? 1 });

/** Whether a layer draws a stroke for the trim to cut: a weight and a visible stroke paint. */
export const hasStroke = (n: PanelNode) => (n.strokeWeight ?? 0) > 0 && (n.strokePaints ?? []).some((p) => p.visible !== false);

/** Open paths (lines, open vectors) are stroked on their centre line whatever their alignment says. */
const centred = (n: PanelNode) => n.strokeAlign === "CENTER" || n.type === "LINE" || n.type === "VECTOR";

const percent = (v: number) => Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;

export function PathTrimSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  if (!nodes.length || !nodes.every(hasStroke)) return null;
  const refs = nodes.map((n) => n.guid);
  const handlers = (end: boolean) =>
    perLayer(
      ed,
      "Path trim",
      refs,
      (n) => (end ? trimOf(n).end : trimOf(n).start) * 100,
      (n, v) => {
        const cur = trimOf(n);
        const x = end ? cur.start : percent(v) / 100;
        const y = end ? percent(v) / 100 : cur.end;
        return fields({ pathTrim: { value: { x, y } } });
      },
      percent
    );
  const start = mixedNumber(nodes.map((n) => percent(trimOf(n).start * 100)));
  const end = mixedNumber(nodes.map((n) => percent(trimOf(n).end * 100)));
  return (
    <PanelSection title={t("Path trim")} data-path-trim>
      <PropertyGrid labels>
        <PropertyRow labels={[t("Start"), t("End")]}>
          <MotionField field="PATH_TRIM_START">
            <NumericInput label={t("Path trim start")} unit="%" precision={2} min={0} max={100} value={fieldValue(start)} {...handlers(false)} />
          </MotionField>
          <MotionField field="PATH_TRIM_END">
            <NumericInput label={t("Path trim end")} unit="%" precision={2} min={0} max={100} value={fieldValue(end)} {...handlers(true)} />
          </MotionField>
        </PropertyRow>
      </PropertyGrid>
      {!nodes.every(centred) && <div className={styles.hint}>{t("Path trim only applies to center strokes.")}</div>}
    </PanelSection>
  );
}
