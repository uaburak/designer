/**
 * Annotations on the canvas (help.figma.com 20774752502935: "In Dev Mode, annotations appear on the canvas as a green
 * dot"): a dot on each annotated layer's top-right corner with its note beside it; a click on the dot selects the
 * layer. Drawn over the canvas in CSS pixels from the page boxes, like the measurements.
 */
import { useMemo } from "react";
import { useCamera, useCurrentPage } from "@/engine/hooks";
import { useViewer } from "./context";
import styles from "./Viewer.module.css";

export function Annotations() {
  const { engine, store, doc } = useViewer();
  const page = useCurrentPage(store);
  const camera = useCamera(store);
  const pins = useMemo(
    () =>
      doc
        .annotations(page)
        .map((a) => ({ ...a, box: doc.pageBox(a.id) }))
        .filter((a) => a.box),
    [doc, page]
  );
  if (!pins.length) return null;
  return (
    <div className={styles.annotations} data-annotations={pins.length}>
      {pins.map((p) => {
        const b = p.box!;
        const x = (b.x + b.width) * camera.zoom + camera.x;
        const y = b.y * camera.zoom + camera.y;
        return (
          <div key={p.id} className={styles.annotationPin} style={{ left: x - 6, top: y - 6 }}>
            <button type="button" className={styles.annotationDot} aria-label="Select the annotated layer" onClick={() => engine.setSelection([p.id])} />
            {camera.zoom >= 0.25 && (
              <div className={styles.annotationCard}>
                {p.notes.map((n, i) => (
                  <div key={i}>
                    {n.text}
                    {n.properties.map((q) => (
                      <div key={q.label} className={styles.annotationProp}>
                        <span>{q.label}</span>
                        <span>{q.value}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
