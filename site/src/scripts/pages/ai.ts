// /ai: one tile per AI part of the app — actions, image tools, visual search, agents and MCP, Studio, credits.
import { initPage } from "../common";
import { mountScenes } from "../../scenes/runtime/mount";

initPage();
mountScenes({
  actions: () => import("../../scenes/ai/ActionsCollage"),
  image: () => import("../../scenes/ai/ImageCollage"),
  search: () => import("../../scenes/ai/SearchCollage"),
  agents: () => import("../../scenes/ai/AgentsCollage"),
  studio: () => import("../../scenes/ai/StudioCollage"),
  credits: () => import("../../scenes/ai/CreditsCollage"),
});
