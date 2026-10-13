// /: the live editor, then a full-screen scene per part of the app.
import { initPage } from "../common";
import { mountScenes } from "../../scenes/runtime/mount";

initPage();
mountScenes({
  hero: () => import("../../scenes/hero/HeroScene"),
  autolayout: () => import("../../scenes/design/AutoLayoutScene"),
  prototype: () => import("../../scenes/home/PrototypeScene"),
  devmode: () => import("../../scenes/home/DevModeScene"),
  together: () => import("../../scenes/home/TogetherScene"),
  firstdraft: () => import("../../scenes/home/FirstDraftScene"),
});
