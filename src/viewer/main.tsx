/**
 * The developer preview viewer's entry (docs/data.md §13; built by vite.viewer.config.ts into out/viewer as one
 * self-contained page). No StrictMode: its second mount would load the preview and the engine twice.
 */
import { createRoot } from "react-dom/client";
import "@/ds/global.css";
import { ViewerApp } from "./ViewerApp";

createRoot(document.getElementById("root")!).render(<ViewerApp />);
