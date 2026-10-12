import { lazy, StrictMode, Suspense, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import "@/ds/global.css";
import { isWebApp, webRoute } from "@/app/webApp";
import { completeWebSignIn, currentWebSession } from "@/store/webAccount";

const webSignedIn = () => currentWebSession() !== null;

/**
 * One page, a role per view (docs/desktop-impl.md), each loading only its
 * own code. Each page brings the design system's CSS (Inter, the
 * `--figma-color-*` tokens) and follows the theme through `ds/theme.ts`.
 * - `?tabbar`: the tab bar's view
 * - `?welcome`: the signed-out window's view (the splash, the welcome page; docs/desktop.md §18.6)
 * - `?files` (and no query): Home, the file browser on the store
 * - `?editor&file=<fileKey>`: a file's editor (`?editor` alone: a sample, in a browser)
 * - `?present&file=<fileKey>[&page=…][&node=…]`: the presentation view (a prototype tab)
 * - `?gallery`: the design system's gallery; `?engine`: the engine's playground; `?admin`: the Admin app on its fake
 * In a browser (`npm run web`) the same routes run without Electron.
 */
const params = new URLSearchParams(location.search);

const page = (): ComponentType => {
  // The web app (docs/cloud.md §7): the product's routes only; signed out, a file's address shows the welcome page
  // (Home's gate) and comes back to the file after Log in
  if (isWebApp()) {
    const route = webRoute(location.search);
    if (route !== "files" && webSignedIn()) return route === "editor" ? lazy(() => import("@/editor/EditorRoute")) : lazy(() => import("@/present/PresentRoute"));
    // Back from Log in on a file's address: the session first, then the file's page
    if (route !== "files" && params.has("auth_code"))
      return lazy(async () => {
        await completeWebSignIn();
        location.reload();
        return { default: () => null };
      });
    return lazy(() => import("@/files/FilesApp"));
  }
  if (params.has("tabbar")) return lazy(() => import("@/app/TabBarApp"));
  if (params.has("welcome")) return lazy(() => import("@/account/WelcomeApp"));
  if (params.has("gallery")) return lazy(() => import("@/ds/Gallery"));
  if (params.has("engine")) return lazy(() => import("@/engine/Playground"));
  if (params.has("admin")) return lazy(() => import("@/admin/AdminRoute"));
  if (params.has("present")) return lazy(() => import("@/present/PresentRoute"));
  if (params.has("editor")) return lazy(() => import("@/editor/EditorRoute"));
  return lazy(() => import("@/files/FilesApp"));
};
const Page = page();

/**
 * One root per container for the page's life. A hot update that re-runs this module (Vite, when an update reaches it)
 * renders into the root it made before instead of calling createRoot on the same container again, which React refuses
 * ("createRoot() on a container that has already been passed"). A full reload starts afresh as before.
 */
const container = document.getElementById("root")! as HTMLElement & { __designerRoot?: Root };
const root = (import.meta.hot?.data?.root as Root | undefined) ?? container.__designerRoot ?? createRoot(container);
container.__designerRoot = root;
if (import.meta.hot?.data) import.meta.hot.data.root = root;

root.render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>
);
