/**
 * Tab in the Design panel (round 17, the owner's rule): Tab / ⇧Tab go from text field to text field — X, Y, W, H,
 * rotation, gap, padding, the colour rows' hex and opacity … — skipping every button between them (the W / H and gap
 * chevrons, "Apply variable", toggles, segmented controls). The field menus and "Apply variable" are no tab stops
 * anyway (`tabIndex -1`; ⌥↓ in the field opens them); this keeps the rest (toggles, checkboxes) out of the way too.
 * At either end it goes round to the other.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** The panel's text fields: inputs that take typing (not checkboxes, radios, ranges), enabled and shown. */
const TEXT_FIELD = 'input:not([type]), input[type="text"], input[type="search"], input[type="number"], textarea';

export function textFields(panel: HTMLElement): HTMLInputElement[] {
  return [...panel.querySelectorAll<HTMLInputElement>(TEXT_FIELD)].filter((el) => !el.disabled && !el.readOnly && el.tabIndex >= 0 && !el.closest("[hidden], [inert]"));
}

/** The field Tab (or ⇧Tab) goes to from `from`, or null when `from` isn't one of the panel's text fields. */
export function nextTextField(panel: HTMLElement, from: Element | null, back: boolean): HTMLInputElement | null {
  const all = textFields(panel);
  const i = all.indexOf(from as HTMLInputElement);
  if (i < 0 || all.length < 2) return null;
  return all[(i + (back ? all.length - 1 : 1)) % all.length];
}

/**
 * The Design panel's keydown, capturing: Tab from one of its text fields goes to the next one. The field's own key
 * handling doesn't run (it would only note "tab" as how it was left); its blur commits what was typed, as Tab's would.
 */
export function designPanelTab(e: ReactKeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab" || e.altKey || e.metaKey || e.ctrlKey) return;
  const panel = e.currentTarget;
  const target = e.target as Element;
  // Not from a popover the panel opened (a portal: React bubbles it here, the DOM doesn't hold it).
  if (!panel.contains(target)) return;
  const next = nextTextField(panel, target, e.shiftKey);
  if (!next) return;
  e.preventDefault();
  e.stopPropagation();
  next.focus();
  next.select();
}
