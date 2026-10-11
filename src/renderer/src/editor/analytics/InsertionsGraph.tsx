/**
 * The insertions graph (help "View library analytics"): weekly insertions for the chosen Type and Duration — current
 * data blue, unavailable data grey, comparison data black, a dashed line for an incomplete week — running to the end of
 * the current week. A legend names each line; hovering a week shows its numbers.
 */
import { useState } from "react";
import type { AnalyticsAssetType, LibraryActions } from "../../../../shared/libraries/orgTypes";
import { count, formatDay, graphWeeks, shortDate, type GraphWeek } from "./model";
import styles from "./Analytics.module.css";

const W = 640;
const H = 160;
const PAD = { left: 36, right: 8, top: 8, bottom: 20 };

/** A line through the weeks that have a value, cut into runs by kind (solid, unavailable, incomplete). */
function segments(weeks: readonly GraphWeek[], value: (w: GraphWeek) => number | null, x: (i: number) => number, y: (v: number) => number): { d: string; kind: "data" | "unavailable" | "incomplete" }[] {
  const out: { d: string; kind: "data" | "unavailable" | "incomplete" }[] = [];
  for (let i = 1; i < weeks.length; i++) {
    const a = value(weeks[i - 1]);
    const b = value(weeks[i]);
    if (a === null || b === null) continue;
    const kind = weeks[i].incomplete ? "incomplete" : weeks[i].unavailable || weeks[i - 1].unavailable ? "unavailable" : "data";
    out.push({ d: `M${x(i - 1)},${y(a)}L${x(i)},${y(b)}`, kind });
  }
  return out;
}

export function InsertionsGraph({ type, data, libraryName, today }: { type: AnalyticsAssetType; data: LibraryActions; libraryName: string; today?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [now] = useState(() => today ?? formatDay(Date.now()));
  const weeks = graphWeeks(type, data.series, data.compare?.series ?? null, data.throughDay, today ?? now);
  const max = Math.max(1, ...weeks.flatMap((w) => [w.insertions ?? 0, w.compare ?? 0]));
  const step = weeks.length > 1 ? (W - PAD.left - PAD.right) / (weeks.length - 1) : 0;
  const x = (i: number) => PAD.left + i * step;
  const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const labelEvery = Math.max(1, Math.ceil(weeks.length / 6));
  const current = segments(weeks, (w) => w.insertions, x, y);
  const compare = data.compare ? segments(weeks, (w) => w.compare, x, y) : [];
  const h = hover !== null ? weeks[hover] : null;
  const unavailable = weeks.some((w) => w.unavailable);
  const incomplete = weeks.some((w) => w.incomplete);
  return (
    <section aria-label="Insertions" className={styles.graph} data-insertions-graph="">
      <div className={styles.graphHead}>
        <span className={styles.sectionTitle}>Insertions</span>
        <div className={styles.legend}>
          <span className={styles.legendItem} data-legend="current">
            <span className={styles.swatchCurrent} />
            {libraryName}
          </span>
          {data.compare && (
            <span className={styles.legendItem} data-legend="compare">
              <span className={styles.swatchCompare} />
              {data.compare.name}
            </span>
          )}
          {unavailable && (
            <span className={styles.legendItem} data-legend="unavailable">
              <span className={styles.swatchUnavailable} />
              Unavailable
            </span>
          )}
          {incomplete && (
            <span className={styles.legendItem} data-legend="incomplete">
              <span className={styles.swatchIncomplete} />
              Incomplete week
            </span>
          )}
        </div>
      </div>
      <div className={styles.plot}>
        <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label={`Insertions per week, ${weeks.length} weeks`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className={styles.grid} />
              <text x={PAD.left - 6} y={y(t) + 3} className={styles.axis} textAnchor="end">
                {count(t)}
              </text>
            </g>
          ))}
          {weeks.map((w, i) =>
            i % labelEvery === 0 ? (
              <text key={w.week} x={x(i)} y={H - 4} className={styles.axis} textAnchor="middle">
                {shortDate(w.week)}
              </text>
            ) : null
          )}
          {compare.map((s, i) => (
            <path key={`c${i}`} d={s.d} className={s.kind === "incomplete" ? styles.lineCompareDashed : styles.lineCompare} data-line="compare" />
          ))}
          {current.map((s, i) => (
            <path key={`d${i}`} d={s.d} className={s.kind === "unavailable" ? styles.lineUnavailable : s.kind === "incomplete" ? styles.lineCurrentDashed : styles.lineCurrent} data-line={s.kind} />
          ))}
          {h && h.insertions !== null && <circle cx={x(hover!)} cy={y(h.insertions)} r={4} className={styles.dot} />}
          {weeks.map((w, i) => (
            <rect key={`h${w.week}`} x={x(i) - step / 2} y={0} width={Math.max(step, 8)} height={H} className={styles.hit} onMouseEnter={() => setHover(i)} data-week={w.week} />
          ))}
        </svg>
        {h && (
          <div className={styles.tooltip} style={{ left: `${(x(hover!) / W) * 100}%` }} role="status" data-graph-tooltip="">
            <div className={styles.tooltipTitle}>Week of {shortDate(h.week)}</div>
            <div>{h.insertions === null ? "No data yet" : `${count(h.insertions)} ${h.insertions === 1 ? "insertion" : "insertions"}`}</div>
            {data.compare && h.compare !== null && (
              <div className={styles.meta}>
                {data.compare.name}: {count(h.compare)}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
