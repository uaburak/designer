/**
 * describe_schema: the JSON shape of any property or type the tools take — a layer property (update_nodes' names),
 * a document field (set_properties' names), a schema definition (Paint, Effect, PrototypeAction …), "Def.field", or
 * the prototype shapes (Reaction, Trigger, Action, Transition, Easing, VariableData) — from the same tables the tools
 * use (layerProps.ts, docSchema.ts over schema/document.kiwi, prototypeSchema.ts).
 */
import { MODEL } from "../schema/model";
import { enumValues, structSchema, toolFields, typeSchema } from "./docSchema";
import { LAYER_PROP_NAMES, NAMED_PROPS, layerPropsSchema, propForField } from "./layerProps";
import { actionSchema, deviceSchema, easingSchema, reactionSchema, transitionSchema, triggerSchema, variableDataSchema } from "./prototypeSchema";

type Obj = Record<string, unknown>;

const PROTOTYPE: Record<string, { schema: Obj; note: string }> = {
  reaction: { schema: reactionSchema, note: "add_interaction / update_interaction take it; get_prototype and get_design_context (reactions) give it." },
  reactions: { schema: { type: "array", items: reactionSchema }, note: "A layer's interactions. Write with add_interaction / update_interaction / remove_interaction, or set_properties {prototypeInteractions: [Reaction, …]} (replaces them all)." },
  prototypeinteractions: { schema: { type: "array", items: reactionSchema }, note: "set_properties takes this list as Reactions (Plugin API shape) or in the document's PrototypeInteraction shape (describe_schema PrototypeInteraction). Prefer add_interaction." },
  trigger: { schema: triggerSchema, note: "Reaction.trigger" },
  action: { schema: actionSchema, note: "Reaction.actions[i]" },
  transition: { schema: transitionSchema, note: "Action.transition" },
  easing: { schema: easingSchema, note: "Transition.easing" },
  variabledata: { schema: variableDataSchema, note: "SET_VARIABLE's variableValue, CONDITIONAL's condition (the document's own VariableData: describe_schema VariableData.value)" },
  device: { schema: deviceSchema, note: "set_prototype_settings.device (a page's prototypeDevice)" },
  flowstartingpoints: { schema: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, name: { type: "string" }, description: { type: "string" } } } }, note: "A page's flows: set_flow_starting_point / remove_flow_starting_point write them, get_prototype lists them." },
};

const all = (): string[] => [...LAYER_PROP_NAMES, ...MODEL.def("NodeChange").fields.map((f) => f.name), ...MODEL.defs.keys(), "Reaction", "Trigger", "Action", "Transition", "Easing", "flowStartingPoints"];

/** The shape of `name`, or an error with names close to it. */
export function describeSchema(name0: string): { ok: true; value: Obj } | { ok: false; error: string } {
  const name = name0.trim();
  const proto = PROTOTYPE[name.toLowerCase()];
  if (proto && !MODEL.defs.has(name)) return { ok: true, value: { name, schema: proto.schema, note: proto.note } };
  const props = layerPropsSchema();
  if (name in NAMED_PROPS || (LAYER_PROP_NAMES.includes(name) && !MODEL.def("NodeChange").byName.has(name)))
    return { ok: true, value: { name, kind: "layer property (create_nodes / update_nodes)", documentFields: NAMED_PROPS[name]?.fields ?? [name], schema: props[name] } };
  const nc = MODEL.def("NodeChange");
  const f = nc.byName.get(name);
  if (f) {
    const viaProp = propForField(name);
    return {
      ok: true,
      value: {
        name,
        kind: "document field (set_properties; schema/document.kiwi NodeChange)",
        type: `${f.type}${f.isArray ? "[]" : ""}`,
        schema: typeSchema(f.type!, f.isArray, 2),
        ...(viaProp && viaProp !== name ? { layerProperty: viaProp } : {}),
        ...(name === "prototypeInteractions" ? { note: PROTOTYPE.prototypeinteractions.note } : {}),
      },
    };
  }
  const dot = name.indexOf(".");
  if (dot > 0) {
    const def = MODEL.defs.get(name.slice(0, dot));
    const field = def && def.kind !== "ENUM" ? toolFields(def.name).find((x) => x.name === name.slice(dot + 1) || x.field.name === name.slice(dot + 1)) : null;
    if (field) return { ok: true, value: { name, type: `${field.field.type}${field.field.isArray ? "[]" : ""}`, schema: typeSchema(field.field.type!, field.field.isArray, 2) } };
  }
  const def = MODEL.defs.get(name);
  if (def) {
    if (def.kind === "ENUM") return { ok: true, value: { name, kind: "enum", values: enumValues(name) } };
    return { ok: true, value: { name, kind: "schema definition", schema: structSchema(name, 2) } };
  }
  const q = name.toLowerCase();
  const close = [...new Set(all())].filter((n) => n.toLowerCase().includes(q) || q.includes(n.toLowerCase())).slice(0, 20);
  return { ok: false, error: `No property, field or type named ${JSON.stringify(name0)}.${close.length ? ` Close: ${close.join(", ")}.` : ""} Try a layer property (fills, layoutMode), a document field (stackSpacing, prototypeInteractions), a type (Paint, Effect, PrototypeAction) or Reaction / Trigger / Action / Transition / Easing.` };
}
