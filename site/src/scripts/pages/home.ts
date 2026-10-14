// /: the hero (the editor, one story in it), three small tiles, Design, Prototype, Dev Mode, AI and Studio, then the live canvas.
import { initPage } from "../common";
import { mountScenes } from "../../scenes/runtime/mount";

initPage();
mountScenes({
  hero: () => import("../../scenes/hero/HeroScene"),
  components: () => import("../../scenes/features/ComponentsCollage"),
  variables: () => import("../../scenes/features/VariablesCollage"),
  comments: () => import("../../scenes/features/CommentsCollage"),
  together: () => import("../../scenes/together/TogetherCollage"),
  design: () => import("../../scenes/home/DesignCollage"),
  prototype: () => import("../../scenes/home/PrototypeCollage"),
  devmode: () => import("../../scenes/home/DevModeCollage"),
  studio: () => import("../../scenes/ai/StudioCollage"),
  try: () => import("../../scenes/try/TryScene"),
});
