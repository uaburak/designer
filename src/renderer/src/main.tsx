import { lazy, StrictMode, Suspense, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/app.css";
import { FIGMA_TOKENS } from "@/figma/tokens";

/**
 * One page, a role per view (docs/desktop-impl.md), each loading only its
 * own code:
 * - `?tabbar`: the tab bar's view
 * - `?home` (the desktop app's default): Home's view
 * - `?tab=<id>&kind=…&slug=…`: a file tab's view (a frame of the shell in a browser)
 * - `?gallery`: the design system's gallery; `?engine`: the engine's playground
 * - nothing, in a browser (`npm run web`): the browser's shell — tab bar, Home, frames
 */
const params = new URLSearchParams(location.search);

/** A module another part of the app is still writing: shown once it is there, a note until then (the build never fails on it). */
const optional = import.meta.glob<{ default: ComponentType }>(["./ds/Gallery.tsx", "./engine/Playground.tsx"]);
const lazyOptional = (path: string) =>
  lazy(async () => {
    const load = optional[path];
    if (load) return load();
    return { default: () => <p style={{ padding: 24, font: "13px Inter, sans-serif" }}>{path.slice(2)} isn’t there yet.</p> };
  });

const page = (): ComponentType => {
  if (params.has("tabbar")) return lazy(() => import("@/app/TabBarApp"));
  if (params.has("gallery")) return lazyOptional("./ds/Gallery.tsx");
  if (params.has("engine")) return lazyOptional("./engine/Playground.tsx");
  if (params.get("tab")) return lazy(() => import("@/tab/TabApp"));
  if (params.has("home") || window.designer) return lazy(() => import("@/app/HomeApp"));
  return lazy(() => import("@/app/ShellApp"));
};
const Page = page();

// Figma's colours on :root, light and dark — what the chrome and the menus (drawn at the page's root) read.
const block = (vars: object) => Object.entries(vars).map(([k, v]) => `${k}:${v};`).join("");
const tokens = document.createElement("style");
tokens.textContent = `:root{${block(FIGMA_TOKENS.light)}}[data-theme="dark"]{${block(FIGMA_TOKENS.dark)}}`;
document.head.prepend(tokens);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>
);
