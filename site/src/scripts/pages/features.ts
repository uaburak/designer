// /features: the pen, Home, components, variables, comments and libraries, each a tile with the app at work.
import { initPage } from "../common";
import { mountScenes } from "../../scenes/runtime/mount";

initPage();
mountScenes({
  draw: () => import("../../scenes/features/DrawCollage"),
  files: () => import("../../scenes/features/FilesCollage"),
  workspace: () => import("../../scenes/together/WorkspaceCollage"),
  components: () => import("../../scenes/features/ComponentsCollage"),
  variables: () => import("../../scenes/features/VariablesCollage"),
  comments: () => import("../../scenes/features/CommentsCollage"),
  libraries: () => import("../../scenes/features/LibrariesCollage"),
});
