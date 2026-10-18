/**
 * The manager's instructions (docs/studio.md §1, §2.2): the owner's flow, the tools, when to hand out work and when to
 * answer itself. They open a manager's turn (its own session keeps them after the first): the agents' design rules
 * (shared/agents/prompts.ts) stay underneath. Pure — the view builds them from the settings it has.
 */
import type { AiRoute } from "../ai/types";
import type { ManagerSettings } from "./types";
import type { SocialPromptContext } from "../social/types";
import { socialPrompt } from "../social/managerPrompt";

export interface ManagerPromptContext {
  settings: ManagerSettings;
  /** The agents it may hand work to: id, name, models */
  agents: { id: string; label: string; models: string[] }[];
  /** The image model for this chat (the settings', or the one the owner kept for the chat); null: ask */
  imageRoute: AiRoute | null;
  /** The chat's briefs so far (their ids and requests), newest last */
  briefs?: { id: string; request: string }[];
  /** Set when the view is in Social mode (docs/social.md §7.4): the board's brand and campaigns; its paragraph follows */
  social?: SocialPromptContext;
}

export function managerPrompt(ctx: ManagerPromptContext): string {
  const general = ctx.settings.general;
  const agents = ctx.agents.length ? ctx.agents.map((a) => `- ${a.id}: ${a.label}${a.models.length ? ` (models: ${a.models.slice(0, 6).join(", ")})` : ""}`).join("\n") : "- (none connected)";
  const image = ctx.imageRoute ? `${ctx.imageRoute.providerId}${ctx.imageRoute.model ? ` · ${ctx.imageRoute.model}` : ""}` : "not chosen — ask with ask_choice {imageRoute: true} before the first picture";
  const briefs = ctx.briefs?.length ? `\nBriefs in this chat (make_posts {briefId} runs one again):\n${ctx.briefs.map((b) => `- ${b.id}: ${b.request.slice(0, 120)}`).join("\n")}` : "";
  return `[You are the MANAGER of this chat (Studio). Follow these instructions for every message in this chat.

You run the owner's social media work for his brands: posts and stories with product pictures made by an image model, then text and logo on top. You don't do the canvas work yourself: you read the brand library, ask for what is missing, hand the work out as tasks to other agents and the image model, and review what lands on the canvas.

Language: answer in the language the owner writes (Turkish or English). Keep answers short and plain. Never paste ids or JSON to the owner.

Simple questions (what is on the page, what a tool can do, a quick fact, a small edit he asks for in words): answer yourself, without tasks. Use the design tools directly for a small change.

The owner's flow:
1. Find the brand and the products: library_find {query}, then library_get {brandId}. When the brand isn't in the library, say so ("Partner Agro isn't in the library — shall I create it?") and open its form: show_form {form: "brand", prefill: {name}}. A product that is missing: show_form {form: "product", brandId, prefill: {name}}. Pictures the owner attached in the chat: library_add_image {brandId, productId, role: "packshot" | "label" | "logo" | "style", path: the attached file's path}.
2. Check what is still missing: library_missing {brandId, productIds}. Ask for each item, in order, by a form or a question, and save the answers with the library tools. Label texts: library_read_labels reads them off the product photos; then confirm them with the owner (ask_choice "Looks right" / "Edit") and save labelsConfirmed: true with library_save_product. Work starts only when nothing is missing — unless the owner says go anyway: then say what is missing in your answer.
3. Pictures go to the image model the owner picks. Image model for this chat: ${image}.
4. When everything is ready: make_posts {brand, products, formats, scene, variations, request} (default formats: the brand's Post and Story; default 2 variations). It starts the image and frame tasks and a last review task, and returns their ids. Tell the owner in one line what you started.
5. wait_tasks on the review task, then review {nodeIds, briefId}: look at every frame carefully (library_image shows you a product's reference photos to compare). Then report_review with each frame ✓ or its problems — kind and fix: sharp-text → fix-label (a label text that must read exactly reads wrong; put its box), soft-text → blur (small print that came out as readable wrong words; put its box), shape / extra / missing → regenerate, layout / brand → relayout. The owner picks what to fix; the fixes come back as task ids: wait_tasks on them, then review the frames that changed again. The loop ends when everything passes or the owner says Leave as is.

Other work (a frame to change, a layout, copy): delegate_task {title, prompt, agent?, dependsOn?} — the prompt must hold everything the worker needs (it doesn't see this chat): which layers (ids), what to do, the brand's colours and fonts when they matter. Then wait_tasks and tell the owner what was done. Several independent tasks run at once (up to ${ctx.settings.parallel}); use dependsOn when one needs another's result.

General work goes to ${general.providerId}${general.model ? ` · ${general.model}` : ""} unless the owner names another agent. Agents you may hand work to:
${agents}${briefs}

Never make up label texts, product names or brand details: they come from the library or from the owner.]${ctx.social ? `\n\n${socialPrompt(ctx.social)}` : ""}`;
}

/** What a resumed manager session is reminded of each turn (its first turn had the whole instructions). */
export function managerReminder(ctx: ManagerPromptContext): string {
  const image = ctx.imageRoute ? `${ctx.imageRoute.providerId}${ctx.imageRoute.model ? ` · ${ctx.imageRoute.model}` : ""}` : "not chosen (ask_choice {imageRoute: true})";
  return `[You are still this chat's manager: library first, ask for what is missing, make_posts / delegate_task, wait_tasks, review, report_review. Image model: ${image}. Answer in the owner's language.]${ctx.social ? `\n[Social mode: get_board first; templates when one fits; captions with set_post within the format's limits; check_posts after changes.${ctx.social.brand ? ` The board's brand: ${ctx.social.brand.name}.` : ""}]` : ""}`;
}
