// /features: a short intro, then a full-screen scene per part of the app — the pen on the live engine, Home, components,
// variables and comments.
import { initPage } from "../common";
import { mountScenes } from "../../scenes/runtime/mount";

initPage();
mountScenes({
  draw: () => import("../../scenes/features/DrawScene"),
  files: () => import("../../scenes/features/FilesScene"),
  components: () => import("../../scenes/features/ComponentsScene"),
  variables: () => import("../../scenes/features/VariablesScene"),
  comments: () => import("../../scenes/features/CommentsScene"),
});
