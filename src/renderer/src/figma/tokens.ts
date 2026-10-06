import type { CSSProperties } from "react";

/** Figma's colours, as its UI kit's variables resolve (Light / Dark) — the chrome's tokens, and the site's ones over them for shared pieces. */
export const FIGMA_TOKENS: Record<"light" | "dark", CSSProperties> = {
  light: {
    "--f-bg": "#ffffff", "--f-bg-secondary": "#f5f5f5", "--f-bg-tertiary": "#e6e6e6", "--f-bg-toggle-hover": "#f4f4f4", "--f-bg-hover": "#f5f5f5", "--f-bg-selected": "#e5f4ff", "--f-bg-selected-secondary": "#f2f9ff", "--f-bg-brand": "#0d99ff", "--f-bg-menu": "#1e1e1e",
    // The layers' and pages' rows: the site's bg/3 hovered, bg/4 selected (the user's choice — grey, light, not Figma's blue)
    "--f-bg-row-hover": "#f5f5f5", "--f-bg-row-selected": "#f0f0f0", "--f-bg-row-selected-secondary": "#f7f7f7",
    "--f-border": "#e6e6e6", "--f-border-translucent": "rgba(0,0,0,0.1)", "--f-border-selected": "#0d99ff",
    "--f-text": "rgba(0,0,0,0.9)", "--f-text-secondary": "rgba(0,0,0,0.5)", "--f-text-tertiary": "rgba(0,0,0,0.3)", "--f-text-brand": "#007be5", "--f-text-component": "#8638e5", "--f-icon-component": "#b49ee0",
    "--f-icon": "rgba(0,0,0,0.9)", "--f-icon-secondary": "rgba(0,0,0,0.5)", "--f-icon-tertiary": "rgba(0,0,0,0.3)",
    "--bg-1": "#ffffff", "--bg-2": "#ffffff", "--bg-3": "#ffffff", "--bg-4": "#f5f5f5", "--bg-5": "#e6e6e6",
    "--border": "#e6e6e6", "--border-hover": "#b3b3b3",
    "--text-title": "rgba(0,0,0,0.9)", "--text-p": "rgba(0,0,0,0.9)", "--text-subtitle": "rgba(0,0,0,0.5)",
    "--edit-component": "#8638e5", "--edit-canvas": "#f5f5f5", "--edit-selected": "#e5f4ff",
  } as CSSProperties,
  dark: {
    "--f-bg": "#2c2c2c", "--f-bg-secondary": "#383838", "--f-bg-tertiary": "#444444", "--f-bg-toggle-hover": "#585858", "--f-bg-hover": "#383838", "--f-bg-selected": "#4a5878", "--f-bg-selected-secondary": "#394360", "--f-bg-brand": "#0c8ce9", "--f-bg-menu": "#1e1e1e",
    "--f-bg-row-hover": "#262626", "--f-bg-row-selected": "#1e1e1e", "--f-bg-row-selected-secondary": "#232323",
    "--f-border": "#444444", "--f-border-translucent": "rgba(255,255,255,0.1)", "--f-border-selected": "#0c8ce9",
    "--f-text": "#ffffff", "--f-text-secondary": "rgba(255,255,255,0.7)", "--f-text-tertiary": "rgba(255,255,255,0.4)", "--f-text-brand": "#7cc4f8", "--f-text-component": "#c9a5ff", "--f-icon-component": "#9d82cf",
    "--f-icon": "#ffffff", "--f-icon-secondary": "rgba(255,255,255,0.7)", "--f-icon-tertiary": "rgba(255,255,255,0.4)",
    "--bg-1": "#2c2c2c", "--bg-2": "#2c2c2c", "--bg-3": "#2c2c2c", "--bg-4": "#383838", "--bg-5": "#444444",
    "--border": "#444444", "--border-hover": "#5c5c5c",
    "--text-title": "#ffffff", "--text-p": "rgba(255,255,255,0.9)", "--text-subtitle": "rgba(255,255,255,0.7)",
    "--edit-component": "#c9a5ff", "--edit-canvas": "#1e1e1e", "--edit-selected": "#4a5878",
  } as CSSProperties,
};
