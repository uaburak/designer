/**
 * Social's actions (docs/social.md §6.7): the one implementation behind the chrome's controls and the agents' Social
 * tools. Each takes a Writer — the chrome passes the editor's batch (`editorWriter`: one click, one undo step), an
 * agent tool its `ToolEnv.write` (a chat turn stays one undo step per worker) — so both entry points run the same
 * function. Round 18a builds the posts, campaigns and resizing; templates, slots and brands (applyTemplate,
 * fillSlots, applyBrand, saveAsTemplate) are 18b's, in templates/templates.ts — the ones here hand over to them (those
 * needing a library copy, a picture or a brand from the store are async: they fetch, then write once); the checks
 * (checkPost, §7.3) 18c's.
 */
import type { Guid, Message, NodeChange, Pixels } from "@/engine/codec";
import { keyAfter, keyBetween } from "@shared/schema/fractionalIndex";
import type { ImageArg } from "@shared/agents/images";
import { formatById, resolveFormat } from "@shared/social/formats";
import { captionReport } from "@shared/social/caption";
import { readSocial, withSocial, type Insets, type PluginDataEntry, type PostProblem, type SlotRole, type SocialCampaign, type SocialPostData, type TemplateSlotData } from "@shared/social/types";
import type { SocialFormat } from "@shared/studio/types";
import { contrastRatio, type RGBA } from "@/ds";
import type { EditorController } from "../controller";
import { newNodeGuid } from "../variables";
import { defaults, IDENTITY } from "../agents/nodeSpec";
import { presenceOf } from "../multiplayer/presence";
import { placePost, POST_GAP } from "./board";
import { cleanHashtags, postRecord, readCampaigns, readPost, socialId, writeCampaigns, writePost } from "./posts";
import { motionRead } from "../motion/motionState";
import { readBoard, type SocialBoard } from "./socialState";
import * as templates from "./templates/templates";
import type { FillReport } from "./templates/templates";
import type { ImportedImage } from "../images";

/** Runs `fn` as one write labelled `label` (one undo step) and returns what it returns. */
export type Writer = <T>(label: string, fn: () => T) => T;

/** The chrome's writer: the editor's batch, one undo step per call. */
export function editorWriter(ed: EditorController): Writer {
  return <T,>(label: string, fn: () => T): T => {
    let out!: T;
    ed.batch(label, () => {
      out = fn();
    });
    return out;
  };
}

/** For actions run inside another write (several actions as one undo step): runs `fn` as it is. */
export const withinWrite: Writer = (_label, fn) => fn();

/** Viewers ("can view" in a shared file) read posts; every write control is off (docs/social.md §1.1). */
export function canWritePosts(ed: EditorController): boolean {
  const p = presenceOf(ed)?.state;
  return !(p?.shared && p.role === "viewer");
}

export interface NewPostOptions {
  formatId: string;
  /** A brand's own size ("brand:<brandId>:<formatId>" ids): its dimensions, which the catalogue doesn't know */
  format?: SocialFormat;
  name?: string;
  brandId?: string | null;
  campaignId?: string | null;
  template?: { key: string; variant?: string };
  /** With a template: the brand to bind it to (the Brand mode's and the logo variant's name) */
  brand?: { id: string; name: string } | null;
  productId?: string;
  at?: { x: number; y: number };
}

export type PostPatch = Partial<Pick<SocialPostData, "brandId" | "productIds" | "campaignId" | "caption" | "hashtags" | "altText" | "status">>;

export type SaveAsTemplateOptions = templates.SaveTemplateOptions;

function formatOf(formatId: string, given?: SocialFormat): SocialFormat {
  const f = given ?? resolveFormat(formatId);
  if (!f) throw new Error(`Unknown format "${formatId}"`);
  return f;
}

/** Where a new post goes on the board: its campaign's row, a new row, or — the page's first — beside its other layers. */
function spotFor(board: SocialBoard, campaignId: string | null): { x: number; y: number } {
  if (!board.posts.length && board.others) return { x: board.others.x + board.others.width + POST_GAP, y: board.others.y };
  return placePost(board.posts, campaignId);
}

/** The page's last child's place, for a layer added on top. */
function topKey(ed: EditorController, page: Guid): string {
  const kids = (ed.engine.readNode(page, { childIds: true, fields: ["type"] })?.childIds ?? []) as Guid[];
  const last = kids[kids.length - 1];
  const pos = last ? ed.engine.readNode(last, { fields: ["parentIndex"] })?.parentIndex?.position : undefined;
  return pos ? keyAfter(pos) : keyBetween("", null);
}

/**
 * A new post on the current page: a white frame of the format's size named after it, carrying its record (a draft,
 * the brand, product and campaign given), placed on the board (§6.4) unless `at` says where. With a template (one
 * this file has: a local one or a library copy already brought in — `templates.insertTemplate` brings one in first):
 * an instance of its variant for the format, bound to `brand` when given.
 */
export function newPost(ed: EditorController, w: Writer, opts: NewPostOptions): Guid {
  const format = formatOf(opts.formatId, opts.format);
  if (opts.template) {
    const entry = templates.templateByKey(ed, opts.template.key);
    if (!entry?.node) throw new Error(`The template ${opts.template.key} isn't in this file yet`);
    const page = ed.store.page;
    const campaignId = opts.campaignId ?? null;
    const at = opts.at ?? spotFor(readBoard(ed, page), campaignId);
    const record = postRecord(opts.formatId, { brandId: opts.brandId ?? opts.brand?.id ?? null, campaignId, productIds: opts.productId ? [opts.productId] : [] });
    const tpl = opts.template;
    // The brand and the product's packshot as last read (templates.prepareTemplate fetches them first).
    const brand = opts.brand ?? (record.brandId ? templates.knownBrand(record.brandId) : null);
    const picture = opts.productId ? templates.knownPicture(ed, opts.productId) : null;
    return w("New post", () => {
      const id = templates.newTemplatePostNow(ed, page, { key: tpl.key, node: entry.node!, data: entry.data, formatId: opts.formatId, variant: tpl.variant, at, record, name: opts.name ?? format.name });
      if (brand) templates.applyBrandNow(ed, [id], brand);
      if (picture) templates.fillSlotsNow(ed, id, {}, picture);
      return id;
    });
  }
  const page = ed.store.page;
  const campaignId = opts.campaignId ?? null;
  const at = opts.at ?? spotFor(readBoard(ed, page), campaignId);
  const record = postRecord(opts.formatId, { brandId: opts.brandId ?? null, campaignId, productIds: opts.productId ? [opts.productId] : [] });
  return w("New post", () => {
    const guid = newNodeGuid(ed);
    const node = {
      guid,
      type: "FRAME",
      ...defaults("FRAME"),
      phase: "CREATED",
      name: opts.name ?? format.name,
      transform: { ...IDENTITY, m02: Math.round(at.x), m12: Math.round(at.y) },
      size: { x: format.width, y: format.height },
      parentIndex: { guid: page, position: topKey(ed, page) },
      pluginData: withSocial([], "post", record),
    } as NodeChange;
    const message: Message = { type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges: [node] };
    const status = ed.engine.applyChanges(message, "user");
    if (status !== 0) throw new Error(`The engine refused the post (status ${status})`);
    return guid;
  });
}

/** Changes the posts' records (the fields given), one write; frames that aren't posts are left alone. */
export function setPost(ed: EditorController, w: Writer, ids: readonly Guid[], patch: PostPatch): void {
  const posts = ids.map((id) => [id, readPost(ed, id)] as const).filter((x): x is readonly [Guid, SocialPostData] => !!x[1]);
  if (!posts.length) return;
  const clean: PostPatch = { ...patch, ...(patch.hashtags ? { hashtags: cleanHashtags(patch.hashtags) } : {}) };
  w("Edit post", () => {
    for (const [id, data] of posts) writePost(ed, id, { ...data, ...clean, ...(clean.status === "exported" && data.status !== "exported" ? { exportedAt: Date.now() } : {}) });
  });
}

/** Leave (the Post section, a pin): the problems go from the post, one write. */
export function leaveProblems(ed: EditorController, w: Writer, id: Guid, problemIds: readonly string[]): void {
  const data = readPost(ed, id);
  if (!data || !data.problems.some((p) => problemIds.includes(p.id))) return;
  w("Leave problem", () => writePost(ed, id, { ...data, problems: data.problems.filter((p) => !problemIds.includes(p.id)) }));
}

/**
 * Resizes the posts to another format (as Figma's frame presets do: the frame's size, its layers by their
 * constraints), or with `duplicate` makes a copy in the new format at the end of its campaign's row — a fresh draft,
 * without the original's problems or export. A template's variant swap is 18b's. Returns the posts resized (the copies).
 */
export function resizePost(ed: EditorController, w: Writer, ids: readonly Guid[], formatId: string, opts: { duplicate: boolean; format?: SocialFormat }): Guid[] {
  const format = formatOf(formatId, opts.format);
  const posts = ids.map((id) => [id, readPost(ed, id)] as const).filter((x): x is readonly [Guid, SocialPostData] => !!x[1]);
  if (!posts.length) return [];
  return w(opts.duplicate ? "Duplicate post" : "Resize post", () => {
    const out: Guid[] = [];
    for (const [id, data] of posts) {
      if (!opts.duplicate) {
        ed.engine.setProps([id], { size: { x: format.width, y: format.height } });
        writePost(ed, id, { ...data, formatId, problems: [] });
        out.push(id);
        continue;
      }
      const copy = duplicateFrame(ed, id);
      if (!copy) continue;
      const at = placePost(readBoard(ed, ed.store.page).posts.filter((p) => p.id !== copy), data.campaignId);
      const t = ed.engine.readNode(copy, { fields: ["transform"] })?.transform ?? IDENTITY;
      ed.engine.setProps([copy], { name: format.name, size: { x: format.width, y: format.height }, transform: { ...t, m02: at.x, m12: at.y } });
      writePost(ed, copy, { ...data, formatId, status: "draft", problems: [], exportedAt: null, group: null });
      out.push(copy);
    }
    return out;
  });
}

/** A copy of a top-level frame (the engine's Duplicate; the selection put back after). Inside a Writer. */
function duplicateFrame(ed: EditorController, id: Guid): Guid | null {
  const before = [...ed.selection];
  ed.engine.setSelection([id]);
  ed.engine.command("DUPLICATE");
  const copy = ed.engine.getSelection().refs[0] ?? null;
  ed.engine.setSelection(before);
  return copy && copy !== id ? copy : null;
}

/**
 * Adds or changes a campaign on the page (by id), or removes it — its posts then sit in "No campaign" (their frames
 * stay where they are).
 */
export function setCampaign(ed: EditorController, w: Writer, page: Guid, campaign: SocialCampaign | { id: string; remove: true }): void {
  const list = readCampaigns(ed, page);
  w("remove" in campaign ? "Remove campaign" : "Edit campaign", () => {
    if ("remove" in campaign) {
      writeCampaigns(ed, page, list.filter((c) => c.id !== campaign.id));
      for (const p of readBoard(ed, page).posts) if (p.data.campaignId === campaign.id) writePost(ed, p.id, { ...p.data, campaignId: null });
      return;
    }
    const i = list.findIndex((c) => c.id === campaign.id);
    writeCampaigns(ed, page, i < 0 ? [...list, campaign] : list.map((c, k) => (k === i ? campaign : c)));
  });
}

/** A new campaign's record, created now (setCampaign writes it). */
export function newCampaign(name: string, brandId: string | null): SocialCampaign {
  return { id: socialId(), name, brandId, created: Date.now() };
}

/*
 * Templates, slots and brands, synchronously (the agents' tools call these inside their own write, which can't wait):
 * what comes from outside the document — a library template's copy, a brand, a product's packshot, a picture's bytes
 * — is fetched first (`templates.prepareTemplate`, `templates.importPicture`); the chrome uses templates.ts's async
 * versions, which fetch and then write.
 */

/** Swaps an instance post's component, or replaces a plain frame by an instance at its place (its texts carried by role). */
export function applyTemplate(ed: EditorController, w: Writer, ids: readonly Guid[], opts: { key: string; variant?: string; brandId?: string; productId?: string }): Guid[] {
  return templates.applyTemplateSync(ed, w, ids, opts);
}

/**
 * Text slots through their TEXT properties, the picture as an image fill (imported first: an ImageArg's bytes are
 * refused here); a locked slot refused, an overrun reported.
 */
export function fillSlots(ed: EditorController, w: Writer, id: Guid, values: Partial<Record<SlotRole, string>>, picture?: ImageArg | ImportedImage): FillReport {
  if (picture && !("hash" in picture)) throw new Error("fill_slots: the picture must be imported first (templates.importPicture)");
  return w("Fill slots", () => templates.fillSlotsNow(ed, id, values, (picture as ImportedImage | undefined) ?? null));
}

/** The Brand collection's mode and the logo's Brand variant (the brand as last read: `templates.primeBrands`). */
export function applyBrand(ed: EditorController, w: Writer, ids: readonly Guid[], brandId: string): void {
  const brand = templates.knownBrand(brandId);
  if (!brand) throw new Error(`No brand ${brandId}`);
  w("Apply brand", () => templates.applyBrandNow(ed, ids, brand));
}

/** The frame made a template (a component set with a Format variant, its slots tagged and wired), or what's missing. */
export function saveAsTemplate(ed: EditorController, w: Writer, id: Guid, opts: SaveAsTemplateOptions): { key: string } | { error: string } {
  return templates.saveAsTemplate(ed, w, id, opts);
}

// ---- Checks (§7.3, round 18c) ---------------------------------------------------------------------------------------

/** Text this size and up is "large" for contrast: 3:1 instead of 4.5:1 (WCAG's large text, at a post's 1080 px) [ours] */
const LARGE_TEXT = 24;
/** The post is drawn this big to sample text backdrops */
const SAMPLE_SIZE = 512;

type Layer = NodeChange & { pluginData?: PluginDataEntry[] };
type Box = { x: number; y: number; width: number; height: number };
type Affine = { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };

const mul = (a: Affine, b: Affine): Affine => ({
  m00: a.m00 * b.m00 + a.m01 * b.m10,
  m01: a.m00 * b.m01 + a.m01 * b.m11,
  m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
  m10: a.m10 * b.m00 + a.m11 * b.m10,
  m11: a.m10 * b.m01 + a.m11 * b.m11,
  m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
});

/** A layer's bounds under `t` (its transform composed with its parents' up to the post). */
function boxIn(t: Affine, w: number, h: number): Box {
  const corners = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ];
  const xs = corners.map(([x, y]) => t.m00 * x + t.m01 * y + t.m02);
  const ys = corners.map(([x, y]) => t.m10 * x + t.m11 * y + t.m12);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The post's visible layers with their boxes in the post's own coordinates, parents before children. */
function layersOf(ed: EditorController, id: Guid): { node: Layer; box: Box; parent: Guid }[] {
  const nodes = ed.engine.readNodes([id], { subtree: true, fields: ["type", "name", "transform", "size", "visible", "pluginData", "fillPaints", "fontSize", "parentIndex"] }) as Layer[];
  const world = new Map<Guid, Affine>([[id, IDENTITY as Affine]]);
  const out: { node: Layer; box: Box; parent: Guid }[] = [];
  for (const n of nodes) {
    const parent = n.parentIndex?.guid;
    const base = parent ? world.get(parent) : undefined;
    // A hidden layer hides its children (they never get a place).
    if (n.guid === id || !parent || !base || n.visible === false) continue;
    const t = mul(base, (n.transform ?? IDENTITY) as Affine);
    world.set(n.guid, t);
    out.push({ node: ed.withRealType(n) as Layer, box: boxIn(t, n.size?.x ?? 0, n.size?.y ?? 0), parent });
  }
  return out;
}

const roleOf = (n: Layer): SlotRole | null => readSocial<TemplateSlotData>(n.pluginData, "slot")?.role ?? null;
const isLogo = (n: Layer): boolean => roleOf(n) === "logo" || /\blogo\b/i.test(n.name ?? "");

/** The bands of the format's safe area a box reaches into (the insets scaled to the post's size). */
function bandsHit(box: Box, safe: Insets, size: { x: number; y: number }, format: SocialFormat): (keyof Insets)[] {
  const kx = size.x / format.width;
  const ky = size.y / format.height;
  const sides: (keyof Insets)[] = [];
  if (safe.top > 0 && box.y < safe.top * ky) sides.push("top");
  if (safe.bottom > 0 && box.y + box.height > size.y - safe.bottom * ky) sides.push("bottom");
  if (safe.left > 0 && box.x < safe.left * kx) sides.push("left");
  if (safe.right > 0 && box.x + box.width > size.x - safe.right * kx) sides.push("right");
  return sides;
}

type SolidPaint = { type?: string; visible?: boolean; opacity?: number; color?: RGBA };

/** A text's colour: its first visible solid fill. */
function textColour(n: Layer): RGBA | null {
  const p = ((n as { fillPaints?: SolidPaint[] }).fillPaints ?? []).find((f) => f.visible !== false && f.type === "SOLID" && f.color);
  return p?.color ? { ...p.color, a: (p.color.a ?? 1) * (p.opacity ?? 1) } : null;
}

/**
 * The backdrop behind a text, from the post's render (`k`: render px per post px): its box's pixels unlike the text's
 * own colour (the glyphs) averaged, over white where the render is transparent. Null when nothing is left to sample.
 */
function backdropOf(px: Pixels, k: number, box: Box, fg: RGBA): RGBA | null {
  const x0 = Math.max(0, Math.floor(box.x * k));
  const y0 = Math.max(0, Math.floor(box.y * k));
  const x1 = Math.min(px.width, Math.ceil((box.x + box.width) * k));
  const y1 = Math.min(px.height, Math.ceil((box.y + box.height) * k));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * px.width + x) * 4;
      const a = px.pixels[i + 3] / 255;
      const c = [0, 1, 2].map((j) => (px.pixels[i + j] / 255) * a + (1 - a));
      if (Math.abs(c[0] - fg.r) + Math.abs(c[1] - fg.g) + Math.abs(c[2] - fg.b) < 0.25) continue;
      r += c[0];
      g += c[1];
      b += c[2];
      count++;
    }
  }
  return count ? { r: r / count, g: g / count, b: b / count, a: 1 } : null;
}

const CHECK_FIX: Record<"caption" | "safe-area" | "contrast" | "logo" | "video", PostProblem["fix"]> = { caption: "rewrite", "safe-area": "relayout", contrast: "relayout", logo: "relayout", video: "retime" };

/** A check's problem: its id names the kind and what it is about, so the same finding keeps its pin from one check to the next. */
function problem(kind: keyof typeof CHECK_FIX, about: string, detail: string, box?: Box): PostProblem {
  const b = box ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } : undefined;
  return { id: `check:${kind}:${about}`, kind, detail, ...(b ? { box: b } : {}), fix: CHECK_FIX[kind], source: "check" };
}

/**
 * One post's deterministic problems (§7.3): the caption's, hashtags' and mentions' counts against its format; text and
 * logo layers reaching into the safe area; an animated post's length and frame rate against the format's video
 * limits; a missing logo (a post with a brand) or more than one; text under its contrast minimum over what it is drawn
 * on (sampled from the post's render — skipped where the engine can't draw). A brand's own size has no limits: only the
 * logo and contrast are checked. Not a post: none.
 */
export function checkPost(ed: EditorController, id: Guid): PostProblem[] {
  const data = readPost(ed, id);
  if (!data) return [];
  const format = formatById(data.formatId);
  const size = ed.engine.readNode(id, { fields: ["size"] })?.size ?? { x: format?.width ?? 1, y: format?.height ?? 1 };
  const out: PostProblem[] = [];
  // The caption lives on a carousel's first slide.
  if (format && (!data.group || data.group.index === 0)) {
    const r = captionReport(data.caption, data.hashtags, format);
    if (r.over) out.push(problem("caption", "count", `The caption is ${r.count} characters; ${format.name} takes ${r.max}.`));
    if (r.hashtags.over) out.push(problem("caption", "hashtags", `${r.hashtags.count} hashtags; ${format.name} takes ${r.hashtags.max}.`));
    if (r.mentions.over) out.push(problem("caption", "mentions", `${r.mentions.count} mentions; ${format.name} takes ${r.mentions.max}.`));
  }
  const layers = layersOf(ed, id);
  // A logo is the outermost layer tagged or named so (a logo frame's own picture isn't a second one).
  const logoIds = new Set(layers.filter((l) => isLogo(l.node)).map((l) => l.node.guid));
  const logos = layers.filter((l) => logoIds.has(l.node.guid) && !logoIds.has(l.parent));
  if (format) {
    for (const l of layers) {
      if (l.node.type !== "TEXT" && !logos.includes(l)) continue;
      const sides = bandsHit(l.box, format.safeArea, size, format);
      if (sides.length) out.push(problem("safe-area", l.node.guid, `“${l.node.name ?? ""}” reaches into ${format.name}'s ${sides.join(" and ")} band, which the platform's buttons cover.`, l.box));
    }
  }
  if (data.brandId && !logos.length) out.push(problem("logo", "missing", "The post has no logo."));
  if (logos.length > 1) out.push(problem("logo", "several", `The post has ${logos.length} logos.`, logos[1].box));
  const timeline = motionRead(() => ed.engine.motionTimeline(id), null);
  const animated = !!timeline && (timeline.audio.length > 0 || timeline.layers.some((l) => l.tracks.length > 0 || l.clips.length > 0 || !!l.instance));
  if (format?.video && timeline && animated) {
    const sec = Math.round(timeline.durationUs / 1e4) / 100;
    const v = format.video;
    if (sec < v.minSec || sec > v.maxSec) out.push(problem("video", "length", `The video is ${sec} s; ${format.name} takes ${v.minSec}–${v.maxSec} s.`));
    if (timeline.snappingFps < v.fps[0] || timeline.snappingFps > v.fps[1]) out.push(problem("video", "fps", `The timeline runs at ${timeline.snappingFps} fps; ${format.name} takes ${v.fps[0]}–${v.fps[1]} fps.`));
  }
  const texts = layers.filter((l) => l.node.type === "TEXT" && l.box.width > 0 && l.box.height > 0);
  const px = texts.length ? motionRead(() => ed.engine.renderNodeThumbnailPixels({ node: id, maxSize: SAMPLE_SIZE }), null) : null;
  if (px) {
    const k = px.width / Math.max(1, size.x);
    for (const l of texts) {
      const fg = textColour(l.node);
      const bg = fg ? backdropOf(px, k, l.box, fg) : null;
      if (!fg || !bg) continue;
      const ratio = contrastRatio(fg, bg);
      const min = ((l.node as { fontSize?: number }).fontSize ?? 0) >= LARGE_TEXT ? 3 : 4.5;
      if (ratio < min) out.push(problem("contrast", l.node.guid, `“${l.node.name ?? ""}” has a contrast of ${ratio.toFixed(1)}:1 over its backdrop; it needs ${min}:1.`, l.box));
    }
  }
  return out;
}

/** The deterministic limits (§7.3) of several posts: caption, hashtags, mentions, safe area, video, logo, contrast. */
export function checkPosts(ed: EditorController, ids: readonly Guid[]): PostProblem[] {
  return ids.flatMap((id) => checkPost(ed, id));
}

/**
 * A check's findings onto the post (its pins, §7.3): the last check's problems replaced by these, the review's kept —
 * a finding no longer found leaves. No write when nothing changed; returns whether it wrote.
 */
export function applyChecks(ed: EditorController, w: Writer, id: Guid, found: readonly PostProblem[]): boolean {
  const data = readPost(ed, id);
  if (!data) return false;
  const next = [...data.problems.filter((p) => p.source !== "check"), ...found];
  if (JSON.stringify(next) === JSON.stringify(data.problems)) return false;
  w("Check posts", () => writePost(ed, id, { ...data, problems: next }));
  return true;
}
