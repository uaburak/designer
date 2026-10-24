/**
 * Review pins (docs/social.md §6.4): one per problem of a post's last review that has a place (`box`), at the box's
 * top left, numbered within the post, in the comments' pin shape (comments/CommentsLayer.tsx) in the warning colour.
 * Hover tells the problem; a click selects the post, shows the Agent tab and selects the problem in the review card that
 * has it (round 18c). A pin goes when its problem is cleared (fixed, no longer found, or left). Placed from the camera
 * like the safe areas, hidden while the canvas zooms.
 */
import { useMemo, useRef } from "react";
import { tooltipProps } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { applySelection } from "../agents/mcpTools";
import { useCameraPlacement } from "./SafeAreaOverlay";
import { useFocusedPost } from "./focus";
import { useSocialBoard, type PostRow } from "./socialState";
import styles from "./ReviewPins.module.css";

function placePins(el: HTMLElement, row: PostRow, cam: { x: number; y: number; zoom: number }): void {
  const z = cam.zoom;
  el.style.transform = `translate(${row.x * z + cam.x}px, ${row.y * z + cam.y}px)`;
  for (const pin of Array.from(el.children) as HTMLElement[]) {
    const p = row.data.problems.find((x) => x.id === pin.dataset.problem);
    if (!p?.box) continue;
    // The pin's point (its bottom-left corner) on the box's top left.
    pin.style.left = `${p.box.x * z}px`;
    pin.style.top = `${p.box.y * z}px`;
  }
}

export function ReviewPins() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const focus = useFocusedPost(ed);
  const rows = useMemo(() => board.posts.filter((p) => p.data.problems.some((x) => x.box) && (!focus || p.id === focus)), [board, focus]);
  const layer = useRef<HTMLDivElement>(null);
  useCameraPlacement(ed, layer, rows, placePins);
  if (!rows.length) return null;
  return (
    <div ref={layer} className={styles.layer} data-review-pins="">
      {rows.map((row) => (
        <div key={row.id} className={styles.post} data-post={row.id}>
          {row.data.problems
            .filter((p) => p.box)
            .map((p, i) => (
              <button
                key={p.id}
                type="button"
                className={styles.pin}
                data-problem={p.id}
                aria-label={t("Problem {n}: {detail}", { n: String(i + 1), detail: p.detail })}
                {...tooltipProps(p.detail)}
                onClick={() => {
                  applySelection(ed, [row.id], false);
                  // The review card that has it marks it (StudioCards' ReviewCard).
                  ed.ui.set({ socialRightTab: "agent", railTab: "agents", socialProblem: { post: row.id, problem: p.id } });
                }}
              >
                {i + 1}
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}
