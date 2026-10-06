import { lazy, StrictMode, Suspense, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "@/ds/global.css";

/**
 * One page, a role per view (docs/desktop-impl.md), each loading only its
 * own code. Each page brings the design system's CSS (Inter, the
 * `--figma-color-*` tokens) and follows the theme through `ds/theme.ts`.
 * - `?tabbar`: the tab bar's view
 * - `?files` (and no query): Home, the file browser on the store
 * - `?editor&file=<fileKey>`: a file's editor (`?editor` alone: a sample, in a browser)
 * - `?gallery`: the design system's gallery; `?engine`: the engine's playground
 * In a browser (`npm run web`) the same routes run without Electron.
 */
const params = new URLSearchParams(location.search);

const page = (): ComponentType => {
  if (params.has("tabbar")) return lazy(() => import("@/app/TabBarApp"));
  if (params.has("gallery")) return lazy(() => import("@/ds/Gallery"));
  if (params.has("engine")) return lazy(() => import("@/engine/Playground"));
  if (params.has("editor")) return lazy(() => import("@/editor/EditorRoute"));
  return lazy(() => import("@/files/FilesApp"));
};
const Page = page();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>
);
