/**
 * Review pins (docs/social.md §6.4): one per problem of a post's last review that has a place (`box`), at the box's
 * top left, numbered within the post, in the comments' pin shape (comments/CommentsLayer.tsx) in the warning colour.
 * Hover tells the problem; a click selects its layer (else the post) and opens its card beside the pin (§30): what it
 * is, in the UI's language, with Fix — at once without a model where the fix is mechanical (actions.ts `fixProblem`),
 * else by an agent — and Leave. A pin goes when its problem is cleared (fixed, no longer found, or left). Placed from
 * the camera like the safe areas, hidden while the canvas zooms.
 */
import { useMemo, useRef, useState } from "react";
import { Button, Icon, Popover, tooltipProps } from "@/ds";
import type { PostProblem } from "@shared/social/types";
import { t, useT } from "@/i18n";
import { useEditor, type EditorController } from "../controller";
import { canFixProblem, canWritePosts, editorWriter, leaveProblems, problemText, problemTitle } from "./actions";
import { fixWithAgent } from "./SocialMode";
import { applySelection } from "../agents/mcpTools";
import { useCameraPlacement } from "./SafeAreaOverlay";
import { openPost, useFocusedPost } from "./focus";
import { isSocialFile } from "../devmode/devMode";
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

/** A Social file's grid view (§21, §29): one button at a post's top right, inside it, instead of its pins */
function placeBadge(el: HTMLElement, row: PostRow, cam: { x: number; y: number; zoom: number }): void {
  el.style.transform = `translate(${(row.x + row.width) * cam.zoom + cam.x}px, ${row.y * cam.zoom + cam.y}px) translate(-100%, 0)`;
}

export function ReviewPins() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const focus = useFocusedPost(ed);
  // A Social file's grid view, kept quiet: on each post the Design mode glyph that opens it (the owner, 2026-10-25:
  // instead of the problem counts — docs/social.md §29); the pins in the asset view.
  const badges = isSocialFile(ed) && !focus;
  const rows = useMemo(() => board.posts.filter((p) => (badges ? true : p.data.problems.some((x) => x.box) && (!focus || p.id === focus))), [board, focus, badges]);
  const layer = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ post: string; problem: string; at: HTMLElement } | null>(null);
  useCameraPlacement(ed, layer, rows, badges ? placeBadge : placePins);
  if (!rows.length) return null;
  if (badges)
    return (
      <div ref={layer} className={styles.layer} data-review-pins="">
        {rows.map((row) => (
          <div key={row.id} className={styles.post} data-post={row.id}>
            <button type="button" className={styles.badge} aria-label={t("Open in the asset view")} {...tooltipProps(t("Open in the asset view"))} onClick={() => openPost(ed, row.id)} data-post-open={row.id}>
              <Icon name="24.mode.design" />
            </button>
          </div>
        ))}
      </div>
    );
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
                onClick={(e) => {
                  const at = e.currentTarget;
                  // Its layer selected (a check's problem names it), else the post
                  applySelection(ed, [layerOf(ed, p.id) ?? row.id], false);
                  // A review card showing it marks it (StudioCards' ReviewCard)
                  ed.ui.set({ socialProblem: { post: row.id, problem: p.id } });
                  setCard((was) => (was?.problem === p.id && was.post === row.id ? null : { post: row.id, problem: p.id, at }));
                }}
              >
                {i + 1}
              </button>
            ))}
        </div>
      ))}
      {card ? <ProblemCard ed={ed} row={rows.find((r) => r.id === card.post)} problemId={card.problem} at={card.at} onClose={() => setCard(null)} /> : null}
    </div>
  );
}

/** The layer a check's problem is about ("check:<kind>:<guid>"), when it is one */
function layerOf(ed: EditorController, problemId: string): string | null {
  const about = /^check:[a-z-]+:(.+)$/.exec(problemId)?.[1];
  if (!about || !/\d:\d/.test(about)) return null;
  try {
    return ed.engine.readNode(about, { fields: ["type"] }) ? about : null;
  } catch {
    return null;
  }
}

/** A pin's card (§30): the problem's title and words, Fix and Leave; gone once the problem is. */
function ProblemCard({ ed, row, problemId, at, onClose }: { ed: EditorController; row: PostRow | undefined; problemId: string; at: HTMLElement; onClose: () => void }) {
  useT();
  const p: PostProblem | undefined = row?.data.problems.find((x) => x.id === problemId);
  if (!row || !p || !at.isConnected) return null;
  const write = canWritePosts(ed);
  const here = write && canFixProblem(ed, row.id, p.id);
  return (
    <Popover anchor={at} placement="right" onClose={onClose} label={problemTitle(p)} title={problemTitle(p)} width={280} draggable={false}>
      <div className={styles.card} data-problem-card={p.id}>
        <p className={styles.cardText}>{problemText(p)}</p>
        <div className={styles.cardActions}>
          <Button variant="ghost" disabled={!write} onClick={() => (leaveProblems(ed, editorWriter(ed), row.id, [p.id]), onClose())} data-problem-leave="">
            {t("Ignore")}
          </Button>
          <Button
            variant={here ? "primary" : "secondary"}
            disabled={!write}
            onClick={() => {
              fixWithAgent(ed, row, p);
              onClose();
            }}
            data-problem-fix=""
          >
            {here ? t("Fix") : t("Fix with agent")}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
