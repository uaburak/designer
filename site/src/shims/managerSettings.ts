// Stand-in for src/renderer/src/editor/panels/agents/ManagerSettings.tsx (vite.config.ts SHIMS). The real hook asks
// main for the image routes over IPC; the site has no main process, so it lists the routes Studio offers
// (docs/studio.md §2.4) with the models' real ids.
import type { ImageRouteInfo } from "@shared/ai/types";

export const SITE_IMAGE_ROUTES: ImageRouteInfo[] = [
  {
    providerId: "gemini-images",
    label: "Gemini API",
    models: [
      { id: "gemini-3-pro-image-preview", label: "Nano Banana Pro", detail: "Best text and detail" },
      { id: "gemini-2.5-flash-image", label: "Nano Banana", detail: "Quick" },
    ],
    available: true,
    references: true,
  },
  { providerId: "gemini-cli", label: "Gemini CLI", models: [], available: true, references: true },
  { providerId: "antigravity", label: "Antigravity", models: [], available: true, references: true },
  { providerId: "openai-images", label: "OpenAI Images", models: [], available: false, reason: "Add an OpenAI API key in Settings › AI", references: true },
];

export function useImageRoutes(): ImageRouteInfo[] {
  return SITE_IMAGE_ROUTES;
}

export const managerStatus = () => "On";
