import { createContext, useContext } from "react";

/**
 * Where keyboard focus goes when a field is left with Enter or a second Esc (Figma: back to the canvas, the
 * selection kept). The editor provides `() => canvas.focus()`; without a provider the field just blurs.
 */
export const ReturnFocusContext = createContext<(() => void) | null>(null);
export const ReturnFocusProvider = ReturnFocusContext.Provider;
export const useReturnFocus = () => useContext(ReturnFocusContext);
