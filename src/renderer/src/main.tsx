import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/app.css";
import { FIGMA_TOKENS } from "@/figma/tokens";
import { tabParams } from "@/app/bridge";

/**
 * One page, two roles: the shell (the tab bar, the home — the window's top
 * page) or a tab (`?tab=…`: an open file, in a frame of the shell). Each
 * loads only its own code.
 */
const ShellApp = lazy(() => import("@/app/ShellApp"));
const TabApp = lazy(() => import("@/tab/TabApp"));

// Figma's colours on :root, light and dark — what the chrome and the menus (drawn at the page's root) read.
const block = (vars: object) => Object.entries(vars).map(([k, v]) => `${k}:${v};`).join("");
const tokens = document.createElement("style");
tokens.textContent = `:root{${block(FIGMA_TOKENS.light)}}[data-theme="dark"]{${block(FIGMA_TOKENS.dark)}}`;
document.head.prepend(tokens);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>{tabParams.id ? <TabApp /> : <ShellApp />}</Suspense>
  </StrictMode>
);
