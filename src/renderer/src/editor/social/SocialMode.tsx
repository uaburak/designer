/**
 * Social (docs/social.md, round 18 [ours]): the interface built around the agent — since §18 (2026-10-24) the mode of a
 * Social file (Figma's Buzz), which opens in it and keeps it, with no mode switch; EditorApp mounts its pieces while
 * `ui.mode` is "social" — the Posts tab on the left (SocialLeftPanel), the agent on the right (SocialRightPanel), the
 * safe areas and review pins over the canvas, the empty board, the toolbar's Social slot — and Motion's timeline when
 * the selected post animates (motion/MotionMode.tsx). Switching modes never changes the document and is no undo step.
 *
 * This file: the mode's commands' bodies (Safe areas, Ask agent…) and `SocialMode`, which keeps the
 * board's brand per file (the store's FileUiState `socialBrandId`).
 */
import { useEffect } from "react";
import type { Guid } from "@/engine/codec";
import { t } from "@/i18n";
import { useEditor, type EditorController } from "../controller";
import { modeOf } from "../devmode/devMode";
import type { PostProblem } from "@shared/social/types";
import { STARTER_BRIEF } from "@shared/social/managerPrompt";
import { applySelection } from "../agents/mcpTools";
import { agentsOf, type AgentsService } from "../agents/service";
import { canWritePosts, editorWriter, fixProblem } from "./actions";
import { socialOf } from "./socialState";
import type { UIState } from "../uiStore";

export const isSocial = (ed: EditorController): boolean => modeOf(ed) === "social";

/** Safe areas: on by default in Social (docs/social.md §6.4). */
export const safeAreasShown = (ed: EditorController): boolean => ed.ui.get().socialSafeAreas !== false;

export function toggleSafeAreas(ed: EditorController): void {
  ed.ui.set({ socialSafeAreas: !safeAreasShown(ed) });
}

export type SafeAreaColor = NonNullable<UIState["socialSafeAreaColor"]>;
/** The safe areas' opacities offered, and the one they start at (Figma's layout guide is 10 %; the owner found it faint) */
export const SAFE_AREA_OPACITIES = [0.1, 0.2, 0.3, 0.4, 0.5] as const;
const SAFE_AREA_DEFAULT_OPACITY = 0.2;
/** This computer's choice, kept between files and launches (a view preference: the browser's storage, never the file) */
const LOOK_KEY = "wecra.social.safeAreaLook";

function keptLook(): { opacity?: number; color?: SafeAreaColor } {
  try {
    return JSON.parse(localStorage.getItem(LOOK_KEY) ?? "{}") as { opacity?: number; color?: SafeAreaColor };
  } catch {
    return {};
  }
}

/** The safe areas' opacity and colour: this editor's, else this computer's last, else 20 % and auto. */
export function safeAreaLook(ui: Pick<UIState, "socialSafeAreaOpacity" | "socialSafeAreaColor">): { opacity: number; color: SafeAreaColor } {
  const kept = keptLook();
  return { opacity: ui.socialSafeAreaOpacity ?? kept.opacity ?? SAFE_AREA_DEFAULT_OPACITY, color: ui.socialSafeAreaColor ?? kept.color ?? "auto" };
}

export function setSafeAreaLook(ed: EditorController, look: { opacity?: number; color?: SafeAreaColor }): void {
  const next = { ...safeAreaLook(ed.ui.get()), ...look };
  ed.ui.set({ socialSafeAreaOpacity: next.opacity, socialSafeAreaColor: next.color, socialSafeAreas: true });
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(next));
  } catch {
    // No storage (a private window): this editor keeps it
  }
}

/** The selected layers that are posts. */
export function selectedPosts(ed: EditorController): Guid[] {
  const posts = new Set(socialOf(ed).get().posts.map((p) => p.id));
  return ed.selection.filter((id) => posts.has(id));
}

/** Export… (docs/social.md §8): the dialog for these posts (export/ExportPostsDialog.tsx). */
export function exportPostsDialog(ed: EditorController, ids: readonly Guid[]): void {
  if (ids.length) ed.ui.set({ socialExport: { ids: [...ids] }, uiHidden: false });
}

/** Export campaign…'s posts: every post of the selected posts' campaigns; nothing selected, every post by campaign. */
export function campaignPosts(ed: EditorController): Guid[] {
  const board = socialOf(ed).get();
  const picked = new Set(selectedPosts(ed));
  const groups = picked.size ? board.groups.filter((g) => g.posts.some((p) => picked.has(p.id))) : board.groups;
  return groups.flatMap((g) => g.posts.map((p) => p.id));
}

/**
 * Puts text in the agent's composer and shows the agent (the left panel's Agents tab, docs/social.md §19): the composer takes focus and
 * the selection is the message's context (as anywhere in the Agents panel).
 */
export function draftForAgent(ed: EditorController, text: string): void {
  ed.ui.set((s) => ({ socialRightTab: "agent", railTab: "agents", socialDraft: { id: (s.socialDraft?.id ?? 0) + 1, text }, uiHidden: false }));
}

/** Ask agent… (a post's menu, the Post section, ⌘K): "About ‹post›: " in the composer, the posts selected as its context. */
export function askAgent(ed: EditorController, ids: readonly Guid[] = selectedPosts(ed)): void {
  const posts = ids.map((id) => socialOf(ed).post(id)).filter((p) => !!p);
  if (posts.length) applySelection(ed, posts.map((p) => p.id), false);
  const about = posts.length === 1 ? t("About {name}: ", { name: posts[0].name }) : posts.length ? t("About these {n} posts: ", { n: String(posts.length) }) : "";
  draftForAgent(ed, about);
}

/**
 * A problem's Fix (the Post section, docs/social.md §6.5, §7.3), the cheapest way that fixes it: a mechanical fix here
 * and now without a model (a layer moved out of a safe-area band, a hidden logo shown, the template applied again —
 * actions.ts `fixProblem`, one undo step); else a relayout problem goes to a worker's task without the manager's turn;
 * else (a caption to rewrite, a timeline to retime) the manager's fix loop — a turn sent at once with the post as its
 * context, in the Agent tab. Where agents can't run (the browser), the request waits in the composer.
 */
export function fixWithAgent(ed: EditorController, post: { id: Guid; name: string }, problem: PostProblem): void {
  if (canWritePosts(ed) && fixProblem(ed, editorWriter(ed), post.id, problem.id)) return;
  ed.ui.set({ socialRightTab: "agent", railTab: "agents", socialProblem: { post: post.id, problem: problem.id }, uiHidden: false });
  const agents = agentsOf(ed);
  if (!agents.get().available) return draftForAgent(ed, t("Fix on {name}: {detail}", { name: post.name, detail: problem.detail }));
  if (problem.fix !== "relayout") return agents.fixProblem(post, problem);
  void agents.relayoutProblem(post, problem).then((started) => started || agents.fixProblem(post, problem));
}

/**
 * Templates › Make starter templates… (§4.2, §12.4): the starter brief sent to the manager at once — the chat shows
 * "Make starter templates" — in the Agent tab (`agents`: the file's, tests pass theirs). Where agents can't run, the brief
 * waits in the composer.
 */
export async function makeStarterTemplates(ed: EditorController, agents: AgentsService = agentsOf(ed)): Promise<void> {
  if (!agents.get().available) return draftForAgent(ed, STARTER_BRIEF);
  ed.ui.set({ socialRightTab: "agent", railTab: "agents", uiHidden: false });
  // The brief is the manager's (its tools make the library and the sets): a direct pick in the composer gives way.
  if (agents.get().socialDirect) await agents.chooseInSocial(null);
  await agents.send(STARTER_BRIEF, [], [], [], t("Make starter templates"));
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
