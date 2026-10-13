// /ai: the intro, then a full-screen scene per AI part of the app (docs/site.md §2.3).
import { initPage } from "../common";
import { mountScenes } from "../../scenes/runtime/mount";

initPage();
mountScenes({
  actions: () => import("../../scenes/ai/ActionsScene"),
  image: () => import("../../scenes/ai/ImageToolsScene"),
  search: () => import("../../scenes/ai/VisualSearchScene"),
  agents: () => import("../../scenes/ai/AgentsScene"),
  studio: () => import("../../scenes/ai/StudioScene"),
  credits: () => import("../../scenes/ai/CreditsScene"),
});
