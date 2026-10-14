// Where things are on a collage's stage, read from the laid-out UI (so a cursor lands on a control wherever the
// ds draws it), and the ds Select's list driven the way a person drives it: the option under the cursor highlights
// (the list's own pointer-enter handler, so its own look), then the pick closes it with the new value.
import { kit } from "../collage/kit";
import type { Point } from "../runtime/path";

/** The stage `el` sits on, and its scale (the stage is drawn scaled to fit its tile). */
function stageOf(el: Element): { rect: DOMRect; scale: number } | null {
  const stage = el.closest<HTMLElement>(`.${kit.stage}`);
  if (!stage) return null;
  const rect = stage.getBoundingClientRect();
  return { rect, scale: rect.width / (stage.offsetWidth || 1) || 1 };
}

/** A point of `el` in stage px: `at` is where in its box (0…1 of its width and height), `dx`/`dy` stage px more. */
export function pointOf(el: Element | null | undefined, at: readonly [number, number] = [0.5, 0.5], dx = 0, dy = 0): Point | null {
  if (!el) return null;
  const s = stageOf(el);
  if (!s) return null;
  const r = el.getBoundingClientRect();
  return [Math.round((r.left + r.width * at[0] - s.rect.left) / s.scale + dx), Math.round((r.top + r.height * at[1] - s.rect.top) / s.scale + dy)];
}

/** The open list's option labelled `label` (a ds Select drawn `static`), inside `root`. */
export function optionOf(root: Element | null, label: string): HTMLElement | null {
  if (!root) return null;
  for (const o of root.querySelectorAll<HTMLElement>('[role="option"]')) if (o.textContent?.trim() === label) return o;
  return null;
}

/** Highlights an option as the pointer entering it does (React's enter comes from a pointerover with no origin). */
export function highlight(option: HTMLElement | null): void {
  if (!option || typeof PointerEvent !== "function") return;
  option.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
}
