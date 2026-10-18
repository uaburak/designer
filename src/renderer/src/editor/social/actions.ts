/**
 * Social's actions (docs/social.md §6.7): the one implementation behind the chrome's controls and the agents' Social
 * tools. Each takes a Writer — the chrome passes the editor's batch (one click, one undo step), an agent tool its
 * `ToolEnv.write` (a chat turn stays one undo step per worker) — so both entry points run the same function. Stubs
 * until round 18a (posts, campaigns, resizing), 18b (templates, slots, brands) and 18c (checks) build them.
 */
import type { Guid } from "@/engine/codec";
import type { ImageArg } from "@shared/agents/images";
import type { PostProblem, SlotRole, SocialCampaign, SocialPostData } from "@shared/social/types";
import type { EditorController } from "../controller";

/** Runs `fn` as one write labelled `label` (one undo step) and returns what it returns. */
export type Writer = <T>(label: string, fn: () => T) => T;

export interface NewPostOptions {
  formatId: string;
  name?: string;
  brandId?: string | null;
  campaignId?: string | null;
  template?: { key: string; variant?: string };
  productId?: string;
  at?: { x: number; y: number };
}

export type PostPatch = Partial<Pick<SocialPostData, "brandId" | "productIds" | "campaignId" | "caption" | "hashtags" | "altText" | "status">>;

export interface SaveAsTemplateOptions {
  name: string;
  platforms?: string[];
  formats?: string[];
  slots?: { nodeId: Guid; role: SlotRole; locked?: boolean; maxChars?: number }[];
}

const notBuilt = (name: string): never => {
  throw new Error(`${name}: not built (docs/social.md §10)`);
};

export function newPost(ed: EditorController, w: Writer, opts: NewPostOptions): Guid {
  void [ed, w, opts];
  return notBuilt("newPost");
}

export function setPost(ed: EditorController, w: Writer, ids: readonly Guid[], patch: PostPatch): void {
  void [ed, w, ids, patch];
  notBuilt("setPost");
}

/** A template variant swap when it has one, else a resize; `duplicate` makes the copy beside it. */
export function resizePost(ed: EditorController, w: Writer, ids: readonly Guid[], formatId: string, opts: { duplicate: boolean }): Guid[] {
  void [ed, w, ids, formatId, opts];
  return notBuilt("resizePost");
}

export function applyTemplate(ed: EditorController, w: Writer, ids: readonly Guid[], opts: { key: string; variant?: string; brandId?: string; productId?: string }): Guid[] {
  void [ed, w, ids, opts];
  return notBuilt("applyTemplate");
}

export function fillSlots(ed: EditorController, w: Writer, id: Guid, values: Partial<Record<SlotRole, string>>, picture?: ImageArg): void {
  void [ed, w, id, values, picture];
  notBuilt("fillSlots");
}

/** The Brand collection's mode and the logo's Brand variant. */
export function applyBrand(ed: EditorController, w: Writer, ids: readonly Guid[], brandId: string): void {
  void [ed, w, ids, brandId];
  notBuilt("applyBrand");
}

export function setCampaign(ed: EditorController, w: Writer, page: Guid, campaign: SocialCampaign | { id: string; remove: true }): void {
  void [ed, w, page, campaign];
  notBuilt("setCampaign");
}

export function saveAsTemplate(ed: EditorController, w: Writer, id: Guid, opts: SaveAsTemplateOptions): { key: string } | { error: string } {
  void [ed, w, id, opts];
  return notBuilt("saveAsTemplate");
}

/** The deterministic limits (§7.3): caption, hashtags, mentions, safe area, video, logo, contrast. */
export function checkPosts(ed: EditorController, ids: readonly Guid[]): PostProblem[] {
  void [ed, ids];
  return notBuilt("checkPosts");
}
