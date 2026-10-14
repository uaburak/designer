/** The visitor asked for less motion: every animation shows its end state. */
export const prefersReduced = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
