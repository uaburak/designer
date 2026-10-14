// /: the hero's collage, three small tiles, Design, Prototype, Dev Mode, AI and Studio, then the live canvas.
import { initPage } from "../common";
import { mountScenes } from "../../scenes/runtime/mount";

initPage();
mountScenes({
  hero: () => import("../../scenes/home/HeroCollage"),
  components: () => import("../../scenes/features/ComponentsCollage"),
  variables: () => import("../../scenes/features/VariablesCollage"),
  comments: () => import("../../scenes/features/CommentsCollage"),
  design: () => import("../../scenes/home/DesignCollage"),
  prototype: () => import("../../scenes/home/PrototypeCollage"),
  devmode: () => import("../../scenes/home/DevModeCollage"),
  studio: () => import("../../scenes/ai/StudioCollage"),
  try: () => import("../../scenes/try/TryScene"),
});
