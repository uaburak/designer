/**
 * Social mode (docs/social.md, round 18 [ours]): a mode of the same Design file, the interface built around the agent.
 * The mode switch's Social segment and View › Social (`view.mode-social`) enter it; EditorApp mounts its pieces while
 * `ui.mode` is "social" — the Posts tab on the left (SocialLeftPanel), the agent on the right (SocialRightPanel), the
 * safe areas and review pins over the canvas, the empty board, the toolbar's Social slot — and Motion's timeline when
 * the selected post animates (motion/MotionMode.tsx). Switching modes never changes the document and is no undo step.
 *
 * This file: the mode's commands' bodies (enter / leave, Safe areas, Ask agent…) and `SocialMode`, which keeps the
 * board's brand per file (the store's FileUiState `socialBrandId`).
 */
import { useEffect } from "react";
import type { Guid } from "@/engine/codec";
import { t } from "@/i18n";
import { useEditor, type EditorController } from "../controller";
import { modeOf, setMode } from "../devmode/devMode";
import type { PostProblem } from "@shared/social/types";
import { applySelection } from "../agents/mcpTools";
import { agentsOf } from "../agents/service";
import { socialOf } from "./socialState";

export const isSocial = (ed: EditorController): boolean => modeOf(ed) === "social";

/** Social ⇄ Design (the mode switch's segment, View › Social). Social starts on Move. */
export function toggleSocialMode(ed: EditorController): void {
  if (isSocial(ed)) return setMode(ed, "design");
  setMode(ed, "social");
  ed.setTool("MOVE");
}

/** Safe areas: on by default in Social (docs/social.md §6.4). */
export const safeAreasShown = (ed: EditorController): boolean => ed.ui.get().socialSafeAreas !== false;

export function toggleSafeAreas(ed: EditorController): void {
  ed.ui.set({ socialSafeAreas: !safeAreasShown(ed) });
}

/** The selected layers that are posts. */
export function selectedPosts(ed: EditorController): Guid[] {
  const posts = new Set(socialOf(ed).get().posts.map((p) => p.id));
  return ed.selection.filter((id) => posts.has(id));
}

/**
 * Puts text in the agent's composer and shows the Agent tab (the right panel's default): the composer takes focus and
 * the selection is the message's context (as anywhere in the Agents panel).
 */
export function draftForAgent(ed: EditorController, text: string): void {
  ed.ui.set((s) => ({ socialRightTab: "agent", socialDraft: { id: (s.socialDraft?.id ?? 0) + 1, text }, uiHidden: false }));
}

/** Ask agent… (a post's menu, the Post section, ⌘K): "About ‹post›: " in the composer, the posts selected as its context. */
export function askAgent(ed: EditorController, ids: readonly Guid[] = selectedPosts(ed)): void {
  const posts = ids.map((id) => socialOf(ed).post(id)).filter((p) => !!p);
  if (posts.length) applySelection(ed, posts.map((p) => p.id), false);
  const about = posts.length === 1 ? t("About {name}: ", { name: posts[0].name }) : posts.length ? t("About these {n} posts: ", { n: String(posts.length) }) : "";
  draftForAgent(ed, about);
}

/**
 * A problem's Fix (the Post section, docs/social.md §6.5, §7.3): the manager's fix loop on it — a turn sent at once with
 * the post as its context, in the Agent tab. Where agents can't run (the browser), the request waits in the composer.
 */
export function fixWithAgent(ed: EditorController, post: { id: Guid; name: string }, problem: PostProblem): void {
  ed.ui.set({ socialRightTab: "agent", socialProblem: { post: post.id, problem: problem.id }, uiHidden: false });
  const agents = agentsOf(ed);
  if (!agents.get().available) return draftForAgent(ed, t("Fix on {name}: {detail}", { name: post.name, detail: problem.detail }));
  agents.fixProblem(post, problem);
}

/** Keeps the board's brand with the file (restored on open, written when it changes). Mounted once per editor. */
export function SocialMode() {
  const ed = useEditor();
  useEffect(() => {
    const kept = ed.source.uiState?.socialBrandId;
    if (kept !== undefined && ed.ui.get().socialBrandId === undefined) ed.ui.set({ socialBrandId: kept });
    let brand = ed.ui.get().socialBrandId;
    return ed.ui.subscribe(() => {
      const next = ed.ui.get().socialBrandId;
      if (next === brand) return;
      brand = next;
      ed.source.setUiState?.({ socialBrandId: next ?? null });
    });
  }, [ed]);
  return null;
}
