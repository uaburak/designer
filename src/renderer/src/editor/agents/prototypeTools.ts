/**
 * The agents' prototype tools (src/shared/agents/tools.ts: get_prototype, add_interaction, update_interaction,
 * remove_interaction, set_flow_starting_point, remove_flow_starting_point, set_prototype_settings) and the prototype
 * part of the reads: the shapes are prototypeSpec.ts' (Plugin API Reactions), the writes the panel's — the schema's
 * prototype fields through the engine's setProps, one transaction per call.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import { keyBetween } from "@shared/schema/fractionalIndex";
import { parseColorValue } from "@shared/agents/docSchema";
import { textResult, type ToolResult } from "@shared/agents/tools";
import { devicePreset, guidOf, liveInteractions, newInteractionId, nextFlowName, type PrototypeInteraction, type PrototypeStartingPoint } from "../model/prototype";
import type { ToolEnv } from "./mcpTools";
import { ToolError } from "./toolError";
import { normId, type Spec } from "./nodeSpec";
import { docInteractions, isDocShape, reactionsFromDoc, reactionToDoc, settingsFromDoc, settingsToDoc, SETTING_KEYS, type Errors, type OverlayWrite, type ProtoLookup, type ProtoNodeInfo } from "./prototypeSpec";

type Obj = Record<string, unknown>;
type ProtoNode = NodeChange & { prototypeInteractions?: PrototypeInteraction[]; prototypeStartingPoint?: PrototypeStartingPoint } & Obj;

const PROTO_FIELDS = ["name", "type", "parentIndex", "prototypeInteractions", "prototypeStartingPoint", "scrollDirection", "scrollBehavior", "overlayPositionType", "overlayBackgroundInteraction", "overlayBackgroundAppearance"];

const readP = (env: ToolEnv, id: Guid, fields?: string[]) => env.ed.engine.readNode(id, fields ? { fields } : {}) as ProtoNode | null;

function pageOfNode(env: ToolEnv, id: Guid): Guid | null {
  let n = readP(env, id, ["parentIndex", "type"]);
  for (let i = 0; n && i < 400; i++) {
    if (n.type === "CANVAS") return n.guid;
    n = n.parentIndex?.guid ? readP(env, n.parentIndex.guid, ["parentIndex", "type"]) : null;
  }
  return null;
}

export function protoLookup(env: ToolEnv): ProtoLookup {
  return {
    node(id) {
      const n = id ? readP(env, id, ["name", "type", "parentIndex", "isStateGroup"]) : null;
      if (!n) return null;
      const real = env.ed.withRealType(n);
      const parent = n.parentIndex?.guid ? readP(env, n.parentIndex.guid, ["type", "isStateGroup"]) : null;
      return { id: n.guid, name: n.name ?? "", type: real.type ?? "NONE", isStateGroup: !!n.isStateGroup, parentType: parent?.type ?? null, parentIsStateGroup: !!parent?.isStateGroup, pageId: pageOfNode(env, n.guid) } as ProtoNodeInfo;
    },
    collection(ref) {
      const c = env.ed.engine.variableCollections({ includeRemote: true }).find((x) => x.id === ref || x.name === ref);
      return c ? { id: c.id, name: c.name, modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })) } : null;
    },
    variable(ref) {
      const byId = ref ? env.ed.engine.variable(ref) : null;
      const v = byId ?? env.ed.engine.variables(undefined, { includeRemote: true }).find((x) => x.name === ref) ?? null;
      return v ? { id: v.id, name: v.name, resolvedType: v.resolvedType } : null;
    },
    newId: () => newInteractionId(env.ed.source.sessionID ?? 1),
  };
}

function sourceInfo(env: ToolEnv, look: ProtoLookup, id: unknown): ProtoNodeInfo {
  const ref = normId(id);
  const n = ref ? look.node(ref) : null;
  if (!n) throw new ToolError(`nodeId: no layer ${JSON.stringify(id ?? null)} in this file (get_metadata / get_prototype list ids).`);
  if (n.type === "CANVAS" || n.type === "DOCUMENT") throw new ToolError(`nodeId: ${n.name} is a page — interactions go on layers (a frame, a button …).`);
  return n;
}

const fail = (errors: Errors, hint = "describe_schema Reaction / Action / Trigger / Transition gives the shapes") => new ToolError(`Nothing was changed — ${errors.length} problem${errors.length === 1 ? "" : "s"}:\n- ${errors.join("\n- ")}\n(${hint})`);

/** Writes a layer's live interactions (Figma's tombstones kept) and overlay settings on destinations. */
function writeInteractions(env: ToolEnv, id: Guid, live: PrototypeInteraction[], overlays: OverlayWrite[] = []) {
  const n = readP(env, id, ["prototypeInteractions"]);
  const kept = (n?.prototypeInteractions ?? []).filter((i) => i.isDeleted);
  const value = [...live, ...kept];
  const status = env.ed.engine.setProps([id], { prototypeInteractions: value.length ? value : null } as never);
  if (status !== 0) throw new ToolError(`The engine refused the interactions (status ${status}${status === -6 ? ": read-only — a library copy" : ""}).`);
  for (const o of overlays) {
    const s = env.ed.engine.setProps([o.frame], o.fields as never);
    if (s !== 0) throw new ToolError(`The engine refused the overlay settings on ${o.frame} (status ${s}).`);
  }
}

const liveOf = (env: ToolEnv, id: Guid) => liveInteractions(readP(env, id, ["prototypeInteractions"])?.prototypeInteractions);

function result(env: ToolEnv, ids: Guid[], extra: Obj = {}): ToolResult {
  const r = textResult({ ...extra, nodes: ids.map((id) => ({ nodeId: id, name: readP(env, id, ["name"])?.name ?? "", reactions: reactionsFromDoc(readP(env, id, ["prototypeInteractions"])?.prototypeInteractions) })) });
  r.touched = ids;
  return r;
}

function nodeRefs(args: Spec): unknown[] {
  if (Array.isArray(args.nodeIds) && args.nodeIds.length) return args.nodeIds;
  if (args.nodeId !== undefined) return [args.nodeId];
  return [];
}

export function addInteractionTool(env: ToolEnv, args: Spec): ToolResult {
  const look = protoLookup(env);
  const refs = nodeRefs(args);
  const sources = refs.length ? refs.map((r) => sourceInfo(env, look, r)) : env.ed.selection.map((id) => sourceInfo(env, look, id));
  if (!sources.length) throw new ToolError("nodeId: the layer to add the interaction to (nothing is selected).");
  const errors: Errors = [];
  const overlays: OverlayWrite[] = [];
  const made = sources.map((s) => reactionToDoc({ trigger: args.trigger, ...(args.actions !== undefined ? { actions: args.actions } : { action: args.action }) }, look, s, "", errors, overlays));
  if (errors.length) throw fail(errors.map((e) => e.replace(/^\./, "")));
  env.write("Add interaction", () => sources.forEach((s, i) => writeInteractions(env, s.id, [...liveOf(env, s.id), made[i]!], i === 0 ? overlays : [])));
  return result(env, sources.map((s) => s.id));
}

function pickIndex(env: ToolEnv, id: Guid, args: Spec): number {
  const live = liveOf(env, id);
  if (!live.length) throw new ToolError(`${id} has no interactions.`);
  if (args.interactionId !== undefined) {
    const i = live.findIndex((x) => guidOf(x.id as never) === normId(args.interactionId));
    if (i < 0) throw new ToolError(`interactionId: ${id} has no interaction ${JSON.stringify(args.interactionId)} (it has ${live.map((x) => guidOf(x.id as never)).join(", ")}).`);
    return i;
  }
  if (typeof args.index === "number") {
    if (!Number.isInteger(args.index) || args.index < 0 || args.index >= live.length) throw new ToolError(`index: 0–${live.length - 1} (${id} has ${live.length} interaction${live.length === 1 ? "" : "s"}).`);
    return args.index;
  }
  throw new ToolError("index or interactionId: which interaction (get_prototype lists them).");
}

export function updateInteractionTool(env: ToolEnv, args: Spec): ToolResult {
  const look = protoLookup(env);
  const s = sourceInfo(env, look, args.nodeId);
  const i = pickIndex(env, s.id, args);
  if (args.trigger === undefined && args.actions === undefined) throw new ToolError("trigger and / or actions: what to change.");
  const live = liveOf(env, s.id);
  const current = reactionsFromDoc(live)[i];
  const errors: Errors = [];
  const overlays: OverlayWrite[] = [];
  const next = reactionToDoc({ trigger: args.trigger !== undefined ? args.trigger : current.trigger, actions: args.actions !== undefined ? args.actions : current.actions }, look, s, "", errors, overlays, live[i].id as never);
  if (errors.length) throw fail(errors.map((e) => e.replace(/^\./, "")));
  env.write("Edit interaction", () => writeInteractions(env, s.id, live.map((x, k) => (k === i ? next! : x)), overlays));
  return result(env, [s.id]);
}

export function removeInteractionTool(env: ToolEnv, args: Spec): ToolResult {
  const look = protoLookup(env);
  const refs = nodeRefs(args);
  if (!refs.length) throw new ToolError("nodeId: the layer whose interaction to remove.");
  const sources = refs.map((r) => sourceInfo(env, look, r));
  if (args.all !== true && sources.length > 1) throw new ToolError("index / interactionId pick one interaction of one layer; for several layers pass all: true.");
  const plan = sources.map((s) => ({ s, keep: args.all === true ? [] : ((i) => liveOf(env, s.id).filter((_, k) => k !== i))(pickIndex(env, s.id, args)) }));
  env.write("Remove interaction", () => plan.forEach((p) => writeInteractions(env, p.s.id, p.keep)));
  return result(env, sources.map((s) => s.id));
}

// ---- Flows ------------------------------------------------------------------------------------------------------------

function topFrame(env: ToolEnv, look: ProtoLookup, id: unknown): ProtoNodeInfo {
  const n = sourceInfo(env, look, id);
  if (!(["FRAME", "SYMBOL", "INSTANCE"].includes(n.type) && !n.isStateGroup && (n.parentType === "CANVAS" || n.parentType === "SECTION")))
    throw new ToolError(`nodeId: "${n.name}" is not a top-level frame — a flow starts on a frame directly on the page (or in a section).`);
  return n;
}

function flowsOf(env: ToolEnv, page: Guid): { nodeId: Guid; nodeName: string; flow: PrototypeStartingPoint }[] {
  const nodes = env.ed.engine.readNodes([page], { subtree: true, fields: ["name", "prototypeStartingPoint"] }) as ProtoNode[];
  return nodes
    .filter((n) => n.prototypeStartingPoint)
    .map((n) => ({ nodeId: n.guid, nodeName: n.name ?? "", flow: n.prototypeStartingPoint! }))
    .sort((a, b) => ((a.flow.position ?? "") < (b.flow.position ?? "") ? -1 : (a.flow.position ?? "") > (b.flow.position ?? "") ? 1 : 0));
}

const flowView = (f: { nodeId: Guid; nodeName: string; flow: PrototypeStartingPoint }) => ({ name: f.flow.name ?? "", nodeId: f.nodeId, nodeName: f.nodeName, ...(f.flow.description ? { description: f.flow.description } : {}) });

export function setFlowTool(env: ToolEnv, args: Spec): ToolResult {
  const look = protoLookup(env);
  const n = topFrame(env, look, args.nodeId);
  if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim())) throw new ToolError("name: a non-empty string.");
  if (args.description !== undefined && typeof args.description !== "string") throw new ToolError("description: a string.");
  const flows = flowsOf(env, n.pageId!);
  const own = flows.find((f) => f.nodeId === n.id)?.flow;
  const next: PrototypeStartingPoint = own
    ? { ...own, ...(args.name ? { name: (args.name as string).trim() } : {}), ...(args.description !== undefined ? { description: args.description as string } : {}) }
    : { name: (args.name as string | undefined)?.trim() || nextFlowName(flows.map((f) => f.flow.name ?? "")), ...(args.description ? { description: args.description as string } : {}), position: keyBetween(flows.length ? (flows[flows.length - 1].flow.position ?? "") : "", null, "LOW") };
  env.write(own ? "Rename flow" : "Add starting point", () => {
    const s = env.ed.engine.setProps([n.id], { prototypeStartingPoint: next } as never);
    if (s !== 0) throw new ToolError(`The engine refused the starting point (status ${s}).`);
  });
  const r = textResult({ flows: flowsOf(env, n.pageId!).map(flowView) });
  r.touched = [n.id];
  return r;
}

export function removeFlowTool(env: ToolEnv, args: Spec): ToolResult {
  const look = protoLookup(env);
  const n = sourceInfo(env, look, args.nodeId);
  if (!readP(env, n.id, ["prototypeStartingPoint"])?.prototypeStartingPoint) throw new ToolError(`"${n.name}" is not a flow starting point.`);
  env.write("Remove starting point", () => void env.ed.engine.setProps([n.id], { prototypeStartingPoint: null } as never));
  const r = textResult({ flows: flowsOf(env, n.pageId!).map(flowView) });
  r.touched = [n.id];
  return r;
}

// ---- Settings ---------------------------------------------------------------------------------------------------------

function pageRef(env: ToolEnv, v: unknown): Guid {
  if (v === undefined || v === null || v === "") {
    const p = env.ed.store.page;
    if (!p) throw new ToolError("No current page.");
    return p;
  }
  const pages = env.ed.engine.pages();
  const p = pages.find((x) => x.guid === normId(v) || x.name === v);
  if (!p) throw new ToolError(`pageId: no page ${JSON.stringify(v)} (has ${pages.map((x) => `${x.name} (${x.guid})`).join(", ")}).`);
  return p.guid;
}

function deviceOfArg(v: unknown, errors: Errors): Obj | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "NONE") return null;
  if (v === "PRESENTATION") return { type: "PRESENTATION" };
  const o: Obj = typeof v === "string" ? { type: "PRESET", presetIdentifier: v } : v && typeof v === "object" ? (v as Obj) : {};
  const type = String(o.type ?? (o.presetIdentifier ? "PRESET" : o.size ? "CUSTOM" : "")).toUpperCase();
  const rotation = o.rotation === undefined ? "NONE" : String(o.rotation).toUpperCase() === "LANDSCAPE" ? "CCW_90" : String(o.rotation).toUpperCase();
  if (!["NONE", "CCW_90"].includes(rotation)) errors.push("device.rotation: NONE or CCW_90 (landscape)");
  const sizeOf = (s: unknown) => {
    const x = s && typeof s === "object" ? ((s as Obj).x ?? (s as Obj).width) : undefined;
    const y = s && typeof s === "object" ? ((s as Obj).y ?? (s as Obj).height) : undefined;
    return typeof x === "number" && typeof y === "number" && x > 0 && y > 0 ? { x, y } : null;
  };
  if (type === "NONE") return null;
  if (type === "PRESENTATION") return { type };
  if (type === "PRESET") {
    const p = devicePreset(String(o.presetIdentifier ?? ""));
    if (!p) return void errors.push(`device.presetIdentifier: ${JSON.stringify(o.presetIdentifier)} is not a preset (IPHONE_16, IPHONE_16_PRO, IPHONE_16_PRO_MAX, IPHONE_SE, GOOGLE_PIXEL_8, SAMSUNG_GALAXY_S24, ANDROID_COMPACT, IPAD_MINI, IPAD_PRO_11, IPAD_PRO_13, MACBOOK_AIR, MACBOOK_PRO_14, MACBOOK_PRO_16, DESKTOP, APPLE_WATCH …)`);
    return { type, presetIdentifier: o.presetIdentifier, size: { x: p[2], y: p[3] }, rotation };
  }
  if (type === "CUSTOM") {
    const size = sizeOf(o.size);
    if (!size) return void errors.push("device.size: {x, y} (or {width, height}) above 0");
    return { type, size, rotation };
  }
  return void errors.push(`device: null, "PRESENTATION", a preset id, or {type: PRESET | CUSTOM | PRESENTATION | NONE, presetIdentifier, size, rotation} (got ${JSON.stringify(v)})`);
}

export function setPrototypeSettingsTool(env: ToolEnv, args: Spec): ToolResult {
  const page = pageRef(env, args.pageId);
  const errors: Errors = [];
  const pageFields: Obj = {};
  const device = deviceOfArg(args.device, errors);
  if (device !== undefined) pageFields.prototypeDevice = device;
  if (args.backgroundColor !== undefined) {
    if (args.backgroundColor === null) pageFields.prototypeBackgroundColor = null;
    else {
      const c = parseColorValue(args.backgroundColor);
      if (!c) errors.push(`backgroundColor: a colour "#RRGGBB" (got ${JSON.stringify(args.backgroundColor)})`);
      else pageFields.prototypeBackgroundColor = c;
    }
  }
  const look = protoLookup(env);
  const nodeWrites: { id: Guid; fields: Obj }[] = [];
  if (args.nodes !== undefined) {
    if (!Array.isArray(args.nodes)) errors.push("nodes: a list of {nodeId, …settings}");
    else
      args.nodes.forEach((x, i) => {
        if (!x || typeof x !== "object") return void errors.push(`nodes[${i}]: {nodeId, …settings}`);
        const o = x as Obj;
        for (const k of Object.keys(o)) if (k !== "nodeId" && !(SETTING_KEYS as readonly string[]).includes(k)) errors.push(`nodes[${i}].${k}: unknown setting (takes ${SETTING_KEYS.join(", ")})`);
        const n = look.node(normId(o.nodeId));
        if (!n) return void errors.push(`nodes[${i}].nodeId: no layer ${JSON.stringify(o.nodeId)}`);
        const fields = settingsToDoc(o, `nodes[${i}]`, errors);
        if (Object.keys(fields).length) nodeWrites.push({ id: n.id, fields });
      });
  }
  if (errors.length) throw fail(errors, "set_prototype_settings' description lists the values");
  if (!Object.keys(pageFields).length && !nodeWrites.length) throw new ToolError("Nothing to set: device, backgroundColor or nodes.");
  env.write("Prototype settings", () => {
    if (Object.keys(pageFields).length) {
      const s = env.ed.engine.setProps([page], pageFields as never);
      if (s !== 0) throw new ToolError(`The engine refused the page settings (status ${s}).`);
    }
    for (const w of nodeWrites) {
      const s = env.ed.engine.setProps([w.id], w.fields as never);
      if (s !== 0) throw new ToolError(`The engine refused the settings of ${w.id} (status ${s}).`);
    }
  });
  const r = textResult(prototypeOf(env, page));
  r.touched = nodeWrites.map((w) => w.id);
  return r;
}

// ---- Reads ------------------------------------------------------------------------------------------------------------

export function prototypeOf(env: ToolEnv, page: Guid): Obj {
  const pageNode = readP(env, page, ["name", "prototypeDevice", "prototypeBackgroundColor"]);
  const nodes = env.ed.engine.readNodes([page], { subtree: true, fields: PROTO_FIELDS }) as ProtoNode[];
  const interactions: Obj[] = [];
  const settings: Obj[] = [];
  for (const n of nodes) {
    if (n.guid === page) continue;
    const reactions = reactionsFromDoc(n.prototypeInteractions);
    if (reactions.length) interactions.push({ nodeId: n.guid, name: n.name ?? "", reactions });
    const s = settingsFromDoc(n);
    delete s.flowStartingPoint;
    if (Object.keys(s).length) settings.push({ nodeId: n.guid, name: n.name ?? "", ...s });
  }
  const bg = pageNode?.prototypeBackgroundColor as { r: number; g: number; b: number; a?: number } | undefined;
  return {
    page: { id: page, name: pageNode?.name ?? "" },
    device: pageNode?.prototypeDevice ?? null,
    ...(bg ? { backgroundColor: hex(bg) } : {}),
    flows: flowsOf(env, page).map(flowView),
    interactions,
    settings,
  };
}

const hex = (c: { r: number; g: number; b: number; a?: number }) => `#${[c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

export function getPrototypeTool(env: ToolEnv, args: Spec): ToolResult {
  return textResult(prototypeOf(env, pageRef(env, args.pageId)));
}

/** A layer's prototype part for get_design_context: reactions and settings (only what's set). */
export function prototypeContext(n: NodeChange): Obj {
  const p = n as ProtoNode;
  const out: Obj = {};
  const reactions = reactionsFromDoc(p.prototypeInteractions);
  if (reactions.length) out.reactions = reactions;
  Object.assign(out, settingsFromDoc(p));
  return out;
}

/** set_properties' prototype fields: Reactions or the document's shape → the document's, with errors. */
export function prototypeField(env: ToolEnv, field: string, v: unknown, sourceIds: readonly Guid[], errors: Errors): { value?: unknown; overlays: OverlayWrite[] } {
  const look = protoLookup(env);
  const overlays: OverlayWrite[] = [];
  if (field !== "prototypeInteractions") return { overlays };
  if (v === null || (Array.isArray(v) && !v.length)) return { value: null, overlays };
  if (!Array.isArray(v)) {
    errors.push("prototypeInteractions: a list of Reactions [{trigger, actions}] (or use add_interaction)");
    return { overlays };
  }
  if (isDocShape(v)) return { value: docInteractions(v, look, field, errors), overlays };
  const source = look.node(sourceIds[0]);
  if (!source) return { overlays };
  const before = errors.length;
  const list = v.map((r, i) => reactionToDoc(r, look, source, `${field}[${i}]`, errors, overlays));
  if (errors.length > before) errors.push("prototypeInteractions: add_interaction takes one interaction in the same shape (describe_schema Reaction)");
  return { value: list.filter(Boolean), overlays };
}

