/**
 * The agents' Social tools (docs/social.md §7.2: get_board, list_formats, list_templates, new_post, apply_template,
 * fill_slots, set_post, resize_post, set_campaign, check_posts, save_as_template, export_posts), dispatched from
 * `runTool` in mcpTools.ts as motionTools.ts is. Thin over editor/social/actions.ts — the functions the chrome's
 * controls call — each write one `env.write` transaction (the actions run inside it with `withinWrite`). Templates,
 * slots and brands (applyTemplate, fillSlots, saveAsTemplate) are round 18b's and the export (export_posts) 18d's:
 * until they land, their tools answer that they aren't available yet instead of failing deep in the engine.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { textResult, type ToolResult } from "@shared/agents/tools";
import { isImageArg } from "@shared/agents/images";
import { captionReport } from "@shared/social/caption";
import { formatById, PLATFORMS, resolveFormat, SOCIAL_FORMATS, brandFormatId } from "@shared/social/formats";
import { POST_STATUSES, readSocial, SLOT_ROLES, type PlatformFormat, type PluginDataEntry, type PostStatus, type SlotRole, type SocialTemplateData, type TemplateSlotData } from "@shared/social/types";
import type { Brand, SocialFormat } from "@shared/studio/types";
import type { EditorController } from "../controller";
import { motionRead } from "../motion/motionState";
import { brandsRepo } from "../studio/forms";
import { importPicture, prepareTemplate } from "../social/templates/templates";
import { applyChecks, applyTemplate, canWritePosts, checkPost, fillSlots, newCampaign, newPost, resizePost, saveAsTemplate, setCampaign, setPost, withinWrite, type PostPatch } from "../social/actions";
import { postRecord, readCampaigns, readPost, writePost } from "../social/posts";
import { readBoard, type PostRow } from "../social/socialState";
import type { ToolEnv } from "./mcpTools";
import { explicitNodeIds, ToolError } from "./toolError";
import { normId, type Spec } from "./nodeSpec";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The layers a write names (never the selection), each one there. */
function ids(env: ToolEnv, args: Spec, tool: string): Guid[] {
  const list = explicitNodeIds(args, tool).map(normId).filter(Boolean);
  const missing = list.filter((id) => !env.ed.engine.readNode(id, { fields: ["name"] }));
  if (missing.length) throw new ToolError(`No layer ${missing.join(", ")} in this file. Use get_board or get_metadata to find ids.`);
  if (!list.length) throw new ToolError(`${tool}: no nodes given — the ids aren't layer ids ("123:456").`);
  return list;
}

/** The named posts; a layer that isn't one is refused by name. */
function postIds(env: ToolEnv, args: Spec, tool: string): Guid[] {
  const list = ids(env, args, tool);
  const not = list.filter((id) => !readPost(env.ed, id));
  if (not.length) throw new ToolError(`${tool}: ${not.join(", ")} ${not.length > 1 ? "aren't posts" : "isn't a post"} (get_board lists the posts; set_post {formatId} makes a frame one).`);
  return list;
}

/** The library's brands (none when the store can't answer: a brand's own sizes are then unknown). */
async function brandList(): Promise<Brand[]> {
  try {
    return await brandsRepo().list();
  } catch {
    return [];
  }
}

/** A format id's size: the catalogue's, or a brand's own; refused when neither knows it. */
function formatFor(id: string, brands: readonly Brand[]): SocialFormat {
  const f = resolveFormat(id, brands);
  if (!f) throw new ToolError(`Unknown format "${id}": list_formats lists the ids ("instagram.post"; a brand's own size is "brand:<brandId>:<formatId>").`);
  return f;
}

/**
 * Runs a function another round builds (18b's templates, 18d's export): its "not built" stub becomes the agent's
 * "not available yet", any other error stays as it is.
 */
function whenBuilt<T>(tool: string, round: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && /not built/.test(err.message)) throw new ToolError(`${tool} isn't available yet: ${round} (docs/social.md §10). Draw the frame with the design tools meanwhile.`);
    throw err;
  }
}

const TEMPLATES_ROUND = "templates come with round 18b";

// ---- Reads ------------------------------------------------------------------------------------------------------

/** A post as get_board shows it. */
function postView(ed: EditorController, p: PostRow, brands: readonly Brand[]) {
  const f = resolveFormat(p.data.formatId, brands);
  const timeline = p.animated ? motionRead(() => ed.engine.motionTimeline(p.id), null) : null;
  return {
    nodeId: p.id,
    name: p.name,
    formatId: p.data.formatId,
    format: f ? { name: f.name, width: f.width, height: f.height, platform: (f as PlatformFormat).platform ?? "brand" } : null,
    brandId: p.data.brandId,
    productIds: p.data.productIds,
    template: p.data.template,
    group: p.data.group,
    status: p.data.status,
    caption: p.data.caption,
    hashtags: p.data.hashtags,
    altText: p.data.altText,
    animated: p.animated,
    durationSec: timeline ? Math.round(timeline.durationUs / 1e4) / 100 : null,
    problems: p.data.problems.map((x) => ({ id: x.id, kind: x.kind, detail: x.detail, fix: x.fix, source: x.source, ...(x.box ? { box: x.box } : {}) })),
    ...(p.duplicateOf ? { duplicateOf: p.duplicateOf } : {}),
  };
}

async function getBoard(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const page = normId(args.pageId) || (env.page?.() ?? env.ed.store.page);
  if (!page) throw new ToolError("get_board: no page.");
  const node = env.ed.engine.readNode(page, { fields: ["type"] });
  if (node?.type !== "CANVAS") throw new ToolError(`get_board: ${page} isn't a page (get_metadata lists them).`);
  const board = readBoard(env.ed, page);
  const brands = await brandList();
  const id = env.ed.ui.get().socialBrandId ?? null;
  const brand = id ? brands.find((b) => b.id === id) : undefined;
  return textResult({
    pageId: page,
    brand: brand ? { id: brand.id, name: brand.name } : null,
    campaigns: board.groups.filter((g) => g.campaign).map((g) => ({ id: g.campaign!.id, name: g.campaign!.name, brandId: g.campaign!.brandId, posts: g.posts.map((p) => postView(env.ed, p, brands)) })),
    unplaced: (board.groups.find((g) => !g.campaign)?.posts ?? []).map((p) => postView(env.ed, p, brands)),
  });
}

async function listFormats(args: Spec): Promise<ToolResult> {
  const platform = str(args.platform);
  if (platform && !PLATFORMS.includes(platform as PlatformFormat["platform"])) throw new ToolError(`list_formats: platform is one of ${PLATFORMS.join(", ")}.`);
  const formats = SOCIAL_FORMATS.filter((f) => !platform || f.platform === platform).map((f) => ({
    id: f.id,
    name: f.name,
    width: f.width,
    height: f.height,
    platform: f.platform,
    kind: f.kind,
    aspect: f.aspect,
    safeArea: f.safeArea,
    caption: f.caption,
    ...(f.image ? { image: f.image } : {}),
    ...(f.video ? { video: f.video } : {}),
    ...(f.items ? { items: f.items } : {}),
    tier: f.tier,
    ...(f.unverified.length ? { unverified: f.unverified } : {}),
  }));
  const brandId = str(args.brandId);
  const brand = brandId ? (await brandList()).find((b) => b.id === brandId) : undefined;
  if (brandId && !brand) throw new ToolError(`list_formats: no brand ${brandId} in the library.`);
  return textResult({ formats, ...(brand ? { brand: brand.formats.map((f) => ({ id: brandFormatId(brand.id, f.id), name: f.name, width: f.width, height: f.height })) } : {}) });
}

/** A template as list_templates shows it. */
interface TemplateView {
  key: string;
  name: string;
  source: string;
  formats: Record<string, string>;
  animated: boolean;
  slots: { role: SlotRole; property: string | null; locked: boolean; maxChars: number | null }[];
}

type Marked = NodeChange & { pluginData?: PluginDataEntry[]; key?: string };

/** The file's own templates: component sets (or lone components) on its pages carrying the template marker, with their slots. */
function localTemplates(ed: EditorController): TemplateView[] {
  const out: TemplateView[] = [];
  for (const page of ed.engine.pages()) {
    const kids = (ed.engine.readNode(page.guid, { childIds: true, fields: ["type"] })?.childIds ?? []) as Guid[];
    const rows = kids.length ? (ed.engine.readNodes(kids, { fields: ["pluginData", "name", "key"] }) as Marked[]) : [];
    for (const r of rows) {
      const data = readSocial<SocialTemplateData>(r.pluginData, "template");
      if (!data) continue;
      const slots = (ed.engine.readNodes([r.guid], { subtree: true, fields: ["pluginData"] }) as Marked[]).flatMap((n) => {
        const s = readSocial<TemplateSlotData>(n.pluginData, "slot");
        return s && SLOT_ROLES.includes(s.role) ? [{ role: s.role, property: s.property ?? null, locked: !!s.locked, maxChars: s.maxChars ?? null }] : [];
      });
      // One entry per role and property: every variant carries the same slots.
      const unique = [...new Map(slots.map((s) => [`${s.role}|${s.property ?? ""}`, s])).values()];
      out.push({ key: r.key || r.guid, name: data.name || r.name || "", source: "local", formats: data.formats ?? {}, animated: !!data.animated, slots: unique });
    }
  }
  return out;
}

/** The enabled libraries' templates, from their manifests (LibraryAsset.social; slots show once imported). */
function libraryTemplates(ed: EditorController): TemplateView[] {
  const state = ed.libraries.get();
  return state.enabled.flatMap((lib) =>
    (state.manifests.get(lib)?.assets ?? []).flatMap((a) => {
      const data = a.social?.template;
      return data ? [{ key: a.key, name: data.name || a.name, source: state.names.get(lib) ?? lib, formats: data.formats ?? {}, animated: !!data.animated, slots: [] }] : [];
    })
  );
}

function listTemplates(env: ToolEnv, args: Spec): ToolResult {
  const platform = str(args.platform);
  const formatId = str(args.formatId);
  const all = [...localTemplates(env.ed), ...libraryTemplates(env.ed)];
  const fits = all.filter((t) => {
    const ids = Object.values(t.formats);
    if (formatId && !ids.includes(formatId)) return false;
    if (platform && !ids.some((id) => formatById(id)?.platform === platform)) return false;
    return typeof args.animated !== "boolean" || t.animated === args.animated;
  });
  return textResult(fits.length ? fits : { templates: [], note: all.length ? "No template fits these filters." : "No templates in this file or its libraries yet: draw the post with the design tools, then offer save_as_template." });
}

// ---- Writes -----------------------------------------------------------------------------------------------------

/** A post's slots (template posts): each tagged layer's role and the property that drives it. */
function slotsOf(ed: EditorController, id: Guid) {
  return (ed.engine.readNodes([id], { subtree: true, fields: ["pluginData"] }) as Marked[]).flatMap((n) => {
    const s = readSocial<TemplateSlotData>(n.pluginData, "slot");
    return s ? [{ role: s.role, nodeId: n.guid, property: s.property ?? null }] : [];
  });
}

async function newPostTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const formatId = str(args.formatId);
  if (!formatId) throw new ToolError("new_post: formatId (list_formats lists them).");
  const format = formatFor(formatId, await brandList());
  const name = str(args.campaign);
  const given = str(args.campaignId);
  const page = env.ed.store.page;
  if (given && !readCampaigns(env.ed, page).some((c) => c.id === given)) throw new ToolError(`new_post: no campaign ${given} on this page (get_board lists them; campaign: "‹name›" makes one).`);
  const campaign = !given && name ? newCampaign(name, str(args.brandId) || null) : null;
  const templateKey = str(args.templateKey);
  if (templateKey) await prepareTemplate(env.ed, { key: templateKey, brandId: str(args.brandId) || null, productId: str(args.productId) || null }).catch(() => {});
  const at = typeof args.x === "number" && typeof args.y === "number" ? { x: args.x, y: args.y } : undefined;
  const id = env.write("New post", () => {
    const made = whenBuilt("new_post from a template", TEMPLATES_ROUND, () =>
      newPost(env.ed, withinWrite, {
        formatId,
        format,
        ...(str(args.name) ? { name: str(args.name) } : {}),
        brandId: str(args.brandId) || null,
        campaignId: campaign?.id ?? (given || null),
        ...(templateKey ? { template: { key: templateKey, ...(str(args.variant) ? { variant: str(args.variant) } : {}) } } : {}),
        ...(str(args.productId) ? { productId: str(args.productId) } : {}),
        ...(at ? { at } : {}),
      })
    );
    // The campaign after the post: a refused template leaves nothing behind.
    if (campaign) setCampaign(env.ed, withinWrite, page, campaign);
    return made;
  });
  const r = textResult({ nodeId: id, name: env.ed.engine.readNode(id, { fields: ["name"] })?.name ?? "", campaignId: campaign?.id ?? (given || null), size: { width: format.width, height: format.height }, slots: slotsOf(env.ed, id) });
  r.touched = [id];
  return r;
}

async function applyTemplateTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const nodes = postIds(env, args, "apply_template");
  const key = str(args.templateKey);
  if (!key) throw new ToolError("apply_template: templateKey (list_templates lists them).");
  // A library template's copy, the brand and the product's packshot first (round 18b): the write can't wait for them.
  await prepareTemplate(env.ed, { key, brandId: str(args.brandId) || null, productId: str(args.productId) || null });
  const out = env.write("Apply template", () => whenBuilt("apply_template", TEMPLATES_ROUND, () => applyTemplate(env.ed, withinWrite, nodes, { key, ...(str(args.variant) ? { variant: str(args.variant) } : {}), ...(str(args.brandId) ? { brandId: str(args.brandId) } : {}), ...(str(args.productId) ? { productId: str(args.productId) } : {}) })), nodes);
  const r = textResult({ posts: out.map((id) => ({ nodeId: id, slots: slotsOf(env.ed, id) })) });
  r.touched = out;
  return r;
}

async function fillSlotsTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const [id] = postIds(env, { nodeId: args.nodeId }, "fill_slots");
  const raw = args.values && typeof args.values === "object" && !Array.isArray(args.values) ? (args.values as Record<string, unknown>) : {};
  const values: Partial<Record<SlotRole, string>> = {};
  for (const role of ["headline", "body", "cta", "label"] as const) if (typeof raw[role] === "string") values[role] = raw[role] as string;
  const picture = isImageArg(args.picture) ? args.picture : undefined;
  if (!Object.keys(values).length && !picture) throw new ToolError("fill_slots: values ({headline, body, cta, label}) or a picture.");
  // A locked slot is the template author's: refused before anything is written.
  const slots = (env.ed.engine.readNodes([id], { subtree: true, fields: ["pluginData"] }) as Marked[]).flatMap((n) => {
    const s = readSocial<TemplateSlotData>(n.pluginData, "slot");
    return s ? [s] : [];
  });
  const locked = slots.filter((s) => s.locked && (s.role in values || (s.role === "picture" && picture))).map((s) => s.role);
  if (locked.length) throw new ToolError(locked.map((r) => `${r} is locked in this template`).join("; "));
  // The picture's bytes imported first (round 18b): the write can't wait for them.
  const image = picture ? await importPicture(env.ed, picture) : undefined;
  env.write("Fill slots", () => whenBuilt("fill_slots", TEMPLATES_ROUND, () => fillSlots(env.ed, withinWrite, id, values, image)), [id]);
  const over = slots.flatMap((s) => (s.maxChars !== null && values[s.role] !== undefined && [...values[s.role]!].length > s.maxChars ? [{ role: s.role, characters: [...values[s.role]!].length, maxChars: s.maxChars }] : []));
  const r = textResult({ nodeId: id, filled: Object.keys(values), ...(picture ? { picture: true } : {}), ...(over.length ? { overMaxChars: over, note: "Written as asked; shorten these so they fit." } : {}) });
  r.touched = [id];
  return r;
}

const POST_TYPES = new Set(["FRAME", "INSTANCE", "SYMBOL"]);

async function setPostTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const nodes = ids(env, args, "set_post");
  const formatId = str(args.formatId);
  const brands = await brandList();
  if (formatId) formatFor(formatId, brands);
  const page = env.ed.store.page;
  const plain = nodes.filter((id) => !readPost(env.ed, id));
  if (plain.length && !formatId) throw new ToolError(`set_post: ${plain.join(", ")} ${plain.length > 1 ? "aren't posts" : "isn't a post"} — pass formatId to make ${plain.length > 1 ? "them posts" : "it one"}.`);
  for (const id of plain) {
    const n = env.ed.engine.readNode(id, { fields: ["type", "parentIndex"] });
    if (!n || !POST_TYPES.has(env.ed.withRealType(n).type ?? "") || n.parentIndex?.guid !== page) throw new ToolError(`set_post: ${id} isn't a top-level frame of the current page — only those can be posts.`);
  }
  const patch: PostPatch = {};
  if (args.brandId !== undefined) patch.brandId = str(args.brandId) || null;
  if (args.productIds !== undefined) patch.productIds = strs(args.productIds);
  if (args.campaignId !== undefined) {
    const c = str(args.campaignId);
    if (c && !readCampaigns(env.ed, page).some((x) => x.id === c)) throw new ToolError(`set_post: no campaign ${c} on this page (set_campaign makes one).`);
    patch.campaignId = c || null;
  }
  if (typeof args.caption === "string") patch.caption = args.caption;
  if (args.hashtags !== undefined) patch.hashtags = strs(args.hashtags);
  if (typeof args.altText === "string") patch.altText = args.altText;
  if (args.status !== undefined) {
    if (!POST_STATUSES.includes(args.status as PostStatus)) throw new ToolError(`set_post: status is one of ${POST_STATUSES.join(", ")}.`);
    patch.status = args.status as PostStatus;
  }
  env.write("Edit post", () => {
    for (const id of plain) writePost(env.ed, id, postRecord(formatId));
    if (formatId) for (const id of nodes.filter((x) => !plain.includes(x))) writePost(env.ed, id, { ...readPost(env.ed, id)!, formatId });
    if (Object.keys(patch).length) setPost(env.ed, withinWrite, nodes, patch);
  }, nodes);
  const posts = nodes.map((id) => {
    const data = readPost(env.ed, id)!;
    const f = formatById(data.formatId);
    const c = captionReport(data.caption, data.hashtags, f);
    return { nodeId: id, formatId: data.formatId, status: data.status, caption: { count: c.count, max: c.max || null, unit: c.unit, fold: c.fold, over: c.over }, hashtags: c.hashtags, mentions: c.mentions };
  });
  const r = textResult({ posts });
  r.touched = nodes;
  return r;
}

async function resizePostTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const nodes = postIds(env, args, "resize_post");
  const formatId = str(args.formatId);
  if (!formatId) throw new ToolError("resize_post: formatId (list_formats lists them).");
  const format = formatFor(formatId, await brandList());
  const duplicate = args.duplicate === true;
  const out = env.write(duplicate ? "Duplicate post" : "Resize post", () => resizePost(env.ed, withinWrite, nodes, formatId, { duplicate, format }), nodes);
  const r = textResult({ posts: out.map((id) => ({ nodeId: id, name: env.ed.engine.readNode(id, { fields: ["name"] })?.name ?? "", formatId, width: format.width, height: format.height })), duplicate, next: "check_posts on them: a resize can push text into the safe area." });
  r.touched = out;
  return r;
}

function setCampaignTool(env: ToolEnv, args: Spec): ToolResult {
  const page = env.ed.store.page;
  const list = readCampaigns(env.ed, page);
  const id = str(args.campaignId);
  const existing = id ? list.find((c) => c.id === id) : undefined;
  if (id && !existing) throw new ToolError(`set_campaign: no campaign ${id} on this page (get_board lists them).`);
  if (args.remove === true) {
    if (!existing) throw new ToolError("set_campaign: remove needs the campaignId.");
    env.write("Remove campaign", () => setCampaign(env.ed, withinWrite, page, { id: existing.id, remove: true }));
    return textResult({ removed: existing.id, note: "Its posts stay where they are, without a campaign." });
  }
  const name = str(args.name);
  if (!existing && !name) throw new ToolError("set_campaign: a new campaign needs its name.");
  const next = existing ? { ...existing, ...(name ? { name } : {}), ...(args.brandId !== undefined ? { brandId: str(args.brandId) || null } : {}) } : newCampaign(name, str(args.brandId) || null);
  env.write(existing ? "Edit campaign" : "New campaign", () => setCampaign(env.ed, withinWrite, page, next));
  return textResult({ campaignId: next.id, name: next.name, brandId: next.brandId });
}

/** check_posts: the deterministic problems of the posts (default: the board's), written onto them as pins. */
function checkPostsTool(env: ToolEnv, args: Spec): ToolResult {
  const named = strs(args.nodeIds).map(normId).filter(Boolean);
  const nodes = named.length ? named : readBoard(env.ed, env.ed.store.page).posts.map((p) => p.id);
  const not = named.filter((id) => !readPost(env.ed, id));
  if (not.length) throw new ToolError(`check_posts: ${not.join(", ")} ${not.length > 1 ? "aren't posts" : "isn't a post"}.`);
  const results = nodes.map((id) => ({ nodeId: id, problems: checkPost(env.ed, id) }));
  // The findings become the posts' pins (a problem no longer found leaves); viewers only read.
  if (canWritePosts(env.ed)) for (const r of results) applyChecks(env.ed, (label, fn) => env.write(label, fn, [r.nodeId]), r.nodeId, r.problems);
  const view = results.map((r) => ({ nodeId: r.nodeId, name: env.ed.engine.readNode(r.nodeId, { fields: ["name"] })?.name ?? "", problems: r.problems.map(({ source: _source, ...p }) => p) }));
  return textResult(nodes.length ? { posts: view, ok: view.every((v) => !v.problems.length) } : { posts: [], note: "No posts on this page." });
}

function saveAsTemplateTool(env: ToolEnv, args: Spec): ToolResult {
  const [id] = ids(env, { nodeId: args.nodeId }, "save_as_template");
  const name = str(args.name);
  if (!name) throw new ToolError("save_as_template: the template's name.");
  const slots = (Array.isArray(args.slots) ? args.slots : []).flatMap((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const role = SLOT_ROLES.find((r) => r === o.role);
    const node = normId(o.nodeId);
    if (!role || !node) throw new ToolError(`save_as_template: each slot is {nodeId, role: ${SLOT_ROLES.join(" | ")}}.`);
    return [{ nodeId: node, role, ...(typeof o.locked === "boolean" ? { locked: o.locked } : {}), ...(typeof o.maxChars === "number" ? { maxChars: o.maxChars } : {}) }];
  });
  const out = env.write("Save as template", () => whenBuilt("save_as_template", TEMPLATES_ROUND, () => saveAsTemplate(env.ed, withinWrite, id, { name, ...(slots.length ? { slots } : {}) })), [id]);
  if ("error" in out) throw new ToolError(out.error);
  return textResult({ templateKey: out.key, name });
}

// ---- The table --------------------------------------------------------------------------------------------------

/** A Social tool's answer, or null when `name` isn't one of them. */
export async function runSocialTool(env: ToolEnv, name: string, args: Spec): Promise<ToolResult | null> {
  switch (name) {
    case "get_board":
      return await getBoard(env, args);
    case "list_formats":
      return await listFormats(args);
    case "list_templates":
      return listTemplates(env, args);
    case "new_post":
      return await newPostTool(env, args);
    case "apply_template":
      return await applyTemplateTool(env, args);
    case "fill_slots":
      return await fillSlotsTool(env, args);
    case "set_post":
      return await setPostTool(env, args);
    case "resize_post":
      return await resizePostTool(env, args);
    case "set_campaign":
      return setCampaignTool(env, args);
    case "check_posts":
      return checkPostsTool(env, args);
    case "save_as_template":
      return saveAsTemplateTool(env, args);
    case "export_posts":
      throw new ToolError("export_posts isn't available yet: the platforms' export presets come with round 18d (docs/social.md §10). export_animation exports one animated post meanwhile.");
  }
  return null;
}
