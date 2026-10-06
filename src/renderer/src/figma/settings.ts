import { useCallback, useState } from "react";

/**
 * The editor's settings, kept in the browser (they are the person's, not the
 * project's): how the mouse works on the canvas.
 */
export interface EditorSettings {
  /** Hold the right button and drag to pan (a plain right click still opens the menu) */
  rightMousePan: boolean;
  /** The horizontal wheel (a Logitech MX Master's thumb wheel) zooms the canvas */
  horizontalScrollZoom: boolean;
  /** …the other way: right zooms out, left in */
  horizontalScrollZoomReversed: boolean;
}

export const DEFAULT_SETTINGS: EditorSettings = { rightMousePan: true, horizontalScrollZoom: false, horizontalScrollZoomReversed: true };

const KEY = "figma-editor-settings";

function read(): EditorSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "");
    if (saved && typeof saved === "object") {
      return {
        rightMousePan: typeof saved.rightMousePan === "boolean" ? saved.rightMousePan : DEFAULT_SETTINGS.rightMousePan,
        horizontalScrollZoom: typeof saved.horizontalScrollZoom === "boolean" ? saved.horizontalScrollZoom : DEFAULT_SETTINGS.horizontalScrollZoom,
        horizontalScrollZoomReversed: typeof saved.horizontalScrollZoomReversed === "boolean" ? saved.horizontalScrollZoomReversed : DEFAULT_SETTINGS.horizontalScrollZoomReversed,
      };
    }
  } catch { /* the defaults */ }
  return DEFAULT_SETTINGS;
}

/** The settings, and a way to change one (kept as it is). */
export function useEditorSettings() {
  const [settings, setSettings] = useState<EditorSettings>(() => read());
  const change = useCallback(<K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  return [settings, change] as const;
}
