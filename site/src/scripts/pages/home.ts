// /: the live editor (it grows with the scroll and stays pinned while the visitor uses it), then a full-screen
// animation per part of the app.
import { initPage } from "../common";
import { initHeroScroll } from "../heroScroll";
import { mountScenes } from "../../scenes/runtime/mount";

initPage();
initHeroScroll();
mountScenes({
  hero: () => import("../../scenes/hero/HeroScene"),
  autolayout: () => import("../../scenes/design/AutoLayoutScene"),
  prototype: () => import("../../scenes/home/PrototypeScene"),
  devmode: () => import("../../scenes/home/DevModeScene"),
  together: () => import("../../scenes/home/TogetherScene"),
  firstdraft: () => import("../../scenes/home/FirstDraftScene"),
});
