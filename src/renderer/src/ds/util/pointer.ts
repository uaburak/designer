/** Pointer capture that never throws (an element gone, a pointer already released, a test DOM without it). */
export function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture?.(pointerId);
  } catch {
    /* not capturable */
  }
}

export function release(el: Element, pointerId: number): void {
  try {
    el.releasePointerCapture?.(pointerId);
  } catch {
    /* released */
  }
}
