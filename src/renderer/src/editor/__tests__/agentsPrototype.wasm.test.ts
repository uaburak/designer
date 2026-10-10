// @vitest-environment happy-dom
// The agents' prototype tools (r17-mcp-prototype) on the real engine: a Splash → Home flow with a TR / EN language
// switch made only through tool calls (add_interaction, set_flow_starting_point, set_prototype_settings), read back in
// the same Plugin API shape (get_prototype, get_design_context, get_metadata), validated with errors naming the field,
// set_properties taking prototypeInteractions, describe_schema, and the presentation player switching the mode (the
// bound texts follow).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PointerType, Status } from "@/engine/abi";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { TOOL_BY_NAME, type ToolResult } from "@shared/agents/tools";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";
import { liveInteractions, type PrototypeInteraction } from "../model/prototype";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Prototype tools" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const turns = new AgentTurns(ed);
  const env: ToolEnv = { ed, write: (_l, fn) => turns.write(null, "Claude Code", fn) };
  const call = async (name: string, args: Record<string, unknown>) => runTool(env, name, args);
  return { ed, engine, call };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const json = (r: ToolResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r));
};
const interactions = (engine: Engine, id: string) => liveInteractions((engine.readNode(id) as { prototypeInteractions?: PrototypeInteraction[] } | null)?.prototypeInteractions);

/** Splash and Home (375 × 812) side by side; Home holds a bound title and a language toggle. */
async function app() {
  const t = await editor();
  const { engine, call } = t;
  const created = json(
    await call("create_nodes", {
      nodes: [
        { type: "FRAME", name: "Splash", x: 2000, y: 0, width: 375, height: 812 },
        { type: "FRAME", name: "Home", x: 2500, y: 0, width: 375, height: 812, children: [{ type: "TEXT", name: "Title", characters: "Merhaba", x: 20, y: 200 }, { type: "RECTANGLE", name: "Toggle", x: 20, y: 20, width: 100, height: 40 }] },
        { type: "FRAME", name: "Sheet", x: 3000, y: 0, width: 375, height: 300 },
      ],
    }),
  ).created as { id: string }[];
  const [splash, home, sheet] = created.map((c) => c.id);
  const [title, toggle] = engine.readNode(home, { childIds: true })!.childIds!;
  const c = json(await call("create_variable_collection", { name: "Content", modes: ["TR", "EN"] })).collection;
  const v = json(await call("create_variable", { collectionId: "Content", name: "title", type: "STRING", values: { TR: "Merhaba", EN: "Hello" } })).variable;
  json(await call("bind_variable", { nodeId: title, field: "characters", variableId: v.id }));
  return { ...t, splash, home, sheet, title, toggle, collection: c, variable: v };
}

describe("MCP prototype tools", () => {
  it("lists the prototype tools with schemas", () => {
    for (const n of ["get_prototype", "add_interaction", "update_interaction", "remove_interaction", "set_flow_starting_point", "remove_flow_starting_point", "set_prototype_settings", "describe_schema"]) expect(TOOL_BY_NAME.get(n), n).toBeTruthy();
    expect(JSON.stringify(TOOL_BY_NAME.get("add_interaction")!.inputSchema)).toContain("SET_VARIABLE_MODE");
  });

  it("wires a Splash → Home flow and a TR / EN toggle through tool calls, one undo step each; reads round-trip", async () => {
    const { engine, call, splash, home, sheet, toggle, collection, title } = await app();
    json(await call("set_flow_starting_point", { nodeId: splash, name: "Onboarding", description: "First run" }));
    const after = json(await call("add_interaction", { nodeId: splash, trigger: { type: "AFTER_TIMEOUT", timeout: 1.5 }, actions: [{ type: "NAVIGATE", destinationId: home, transition: { type: "PUSH", direction: "LEFT", duration: 0.4, easing: "EASE_IN_AND_OUT" } }] }));
    expect(after.nodes[0].reactions[0]).toMatchObject({ index: 0, trigger: { type: "AFTER_TIMEOUT", timeout: 1.5 }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: home, transition: { type: "PUSH", direction: "LEFT", duration: 0.4, easing: { type: "EASE_IN_AND_OUT" } } }] });
    // The document's shape, as the panel writes it.
    expect(interactions(engine, splash)[0]).toMatchObject({ event: { interactionType: "AFTER_TIMEOUT", transitionTimeout: 1.5 }, actions: [{ connectionType: "INTERNAL_NODE", navigationType: "NAVIGATE", transitionType: "PUSH_FROM_RIGHT", easingType: "INOUT_CUBIC" }] });
    json(await call("add_interaction", { nodeId: toggle, trigger: { type: "ON_CLICK" }, actions: [{ type: "SET_VARIABLE_MODE", variableCollectionId: "Content", variableModeId: "EN" }] }));
    expect(interactions(engine, toggle)[0].actions![0]).toMatchObject({ connectionType: "SET_VARIABLE_MODE", targetVariableModeID: expect.any(Object), targetVariableSetID: { guid: expect.any(Object) } });
    json(await call("add_interaction", { nodeId: home, trigger: { type: "KEY_DOWN", keys: "Shift+O" }, actions: [{ type: "OPEN_OVERLAY", destinationId: sheet, transition: { type: "MOVE_IN", direction: "TOP", easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { mass: 1, stiffness: 200, damping: 20 } } }, overlay: { position: "BOTTOM_CENTER", background: "#00000066", closeOnClickOutside: true } }] }));
    expect(engine.readNode(sheet)).toMatchObject({ overlayPositionType: "BOTTOM_CENTER", overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE" });
    json(await call("set_prototype_settings", { device: "IPHONE_16", backgroundColor: "#101010", nodes: [{ nodeId: home, overflowDirection: "VERTICAL" }, { nodeId: toggle, scrollBehavior: "FIXED" }] }));

    // get_prototype: flows, device, interactions and settings in the Plugin API's shape.
    const p = json(await call("get_prototype", {}));
    expect(p.flows).toEqual([{ name: "Onboarding", nodeId: splash, nodeName: "Splash", description: "First run" }]);
    expect(p.device).toMatchObject({ type: "PRESET", presetIdentifier: "IPHONE_16", size: { x: 393, y: 852 } });
    expect(p.backgroundColor).toBe("#101010");
    const byNode = Object.fromEntries(p.interactions.map((x: { nodeId: string; reactions: unknown[] }) => [x.nodeId, x.reactions]));
    expect(byNode[toggle][0]).toMatchObject({ trigger: { type: "ON_CLICK" }, actions: [{ type: "SET_VARIABLE_MODE", variableCollectionId: collection.id, variableModeId: collection.modes[1].id }] });
    expect(byNode[home][0]).toMatchObject({ trigger: { type: "ON_KEY_DOWN", keyCodes: [16, 79], device: "KEYBOARD" }, actions: [{ type: "NODE", navigation: "OVERLAY", destinationId: sheet, transition: { type: "MOVE_IN", direction: "TOP", easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { stiffness: 200 } } } }] });
    expect(p.settings).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: home, overflowDirection: "VERTICAL" }), expect.objectContaining({ nodeId: toggle, scrollBehavior: "FIXED" }), expect.objectContaining({ nodeId: sheet, overlayPositionType: "BOTTOM_CENTER", overlayBackground: { type: "SOLID_COLOR", color: "#00000066" }, overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE" })]));

    // get_design_context and get_metadata carry them too.
    const ctx = json(await call("get_design_context", { nodeId: home }));
    expect(ctx.nodes[0].reactions[0].actions[0].destinationId).toBe(sheet);
    expect(ctx.nodes[0].overflowDirection).toBe("VERTICAL");
    expect(ctx.nodes[0].children.find((x: { id: string }) => x.id === toggle).reactions[0].trigger.type).toBe("ON_CLICK");
    expect(json(await call("get_design_context", { nodeId: splash })).nodes[0].flowStartingPoint).toEqual({ name: "Onboarding", description: "First run" });
    const meta = text(await call("get_metadata", { nodeId: home }));
    expect(meta).toContain('interactions="1"');
    expect(meta).toContain("<prototype>");
    expect(text(await call("get_metadata", { nodeId: splash }))).toContain('flow="Onboarding"');

    // What was read is written back unchanged (one shape); update by index keeps the id.
    const before = interactions(engine, home)[0];
    json(await call("update_interaction", { nodeId: home, index: 0, trigger: byNode[home][0].trigger, actions: byNode[home][0].actions }));
    expect(interactions(engine, home)[0]).toEqual(before);
    json(await call("update_interaction", { nodeId: home, interactionId: byNode[home][0].id, trigger: "WHILE_HOVERING" }));
    expect(interactions(engine, home)[0]).toMatchObject({ id: before.id, event: { interactionType: "ON_HOVER" }, actions: before.actions });

    // One undo step per call.
    engine.undo();
    expect(interactions(engine, home)[0].event?.interactionType).toBe("ON_KEY_DOWN");
    json(await call("remove_interaction", { nodeId: home, index: 0 }));
    expect(interactions(engine, home)).toHaveLength(0);
    json(await call("remove_flow_starting_point", { nodeId: splash }));
    expect(json(await call("get_prototype", {})).flows).toEqual([]);
    void title;
  });

  it("refuses bad interactions with errors naming the field and what it takes; nothing changes", async () => {
    const { engine, call, splash, home, toggle, title } = await app();
    const bad = async (args: Record<string, unknown>, ...parts: string[]) => {
      const r = await call("add_interaction", args);
      expect(r.isError, text(r)).toBe(true);
      for (const p of parts) expect(text(r)).toContain(p);
    };
    await bad({ nodeId: toggle, trigger: { type: "ON_TAPP" }, actions: [] }, "trigger.type", "ON_CLICK, ON_DRAG");
    await bad({ nodeId: toggle, trigger: "ON_CLICK", actions: [{ type: "NAVIGATE", destinationId: title }] }, "actions[0].destinationId", "not a top-level frame");
    await bad({ nodeId: toggle, trigger: "ON_CLICK", actions: [{ type: "NAVIGATE", destinationId: home, transition: { type: "PUSH", direction: "SIDEWAYS" } }] }, "actions[0].transition.direction");
    await bad({ nodeId: toggle, trigger: "ON_CLICK", actions: [{ type: "NAVIGATE", destinationId: home, transition: { type: "DISSOLVE", duration: 300 } }] }, "durationMs");
    await bad({ nodeId: toggle, trigger: "ON_CLICK", actions: [{ type: "SET_VARIABLE_MODE", variableCollectionId: "Content", variableModeId: "DE" }] }, "has no mode", "TR");
    await bad({ nodeId: toggle, trigger: "ON_CLICK", actions: [{ type: "SET_VARIABLE", variableId: "title", value: 3 }] }, "a STRING value");
    await bad({ nodeId: toggle, trigger: "ON_CLICK", actions: [{ type: "NAVIGATE", destinationId: home, destination: home }] }, "actions[0].destination: unknown field");
    expect(interactions(engine, toggle)).toHaveLength(0);
    // A SET_VARIABLE and a CONDITIONAL with an expression are fine.
    json(await call("add_interaction", { nodeId: splash, trigger: { type: "ON_CLICK" }, actions: [{ type: "SET_VARIABLE", variableId: "title", variableValue: { type: "STRING", value: "Hi" } }, { type: "CONDITIONAL", conditionalBlocks: [{ condition: { type: "EXPRESSION", value: { expressionFunction: "EQUALS", expressionArguments: [{ type: "VARIABLE_ALIAS", id: "title" }, "Hi"] } }, actions: [{ type: "NAVIGATE", destinationId: home }] }, { actions: [{ type: "BACK" }] }] }] }));
    const r = json(await call("get_prototype", {})).interactions.find((x: { nodeId: string }) => x.nodeId === splash).reactions[0];
    expect(r.actions[0]).toMatchObject({ type: "SET_VARIABLE", variableValue: { type: "STRING", value: "Hi" } });
    expect(r.actions[1].conditionalBlocks[0].condition).toMatchObject({ type: "EXPRESSION", value: { expressionFunction: "EQUALS" } });
    expect(r.actions[1].conditionalBlocks[1]).toEqual({ actions: [{ type: "BACK" }] });
  });

  it("set_properties takes prototypeInteractions (Plugin API or the document's shape) and points flows elsewhere", async () => {
    const { engine, call, toggle, home } = await app();
    const r1 = json(await call("set_properties", { nodeId: toggle, properties: { prototypeInteractions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "SET_VARIABLE_MODE", variableCollectionId: "Content", variableModeId: "EN" }] }] } }));
    expect(r1.summary, JSON.stringify(r1)).toContain("everything applied");
    expect(interactions(engine, toggle)[0].actions![0].connectionType).toBe("SET_VARIABLE_MODE");
    // The document's own shape with "1:2" ids (what the in-app agent first tried) — no opaque status.
    const r2 = json(await call("set_properties", { nodeId: toggle, properties: { prototypeInteractions: [{ event: { interactionType: "ON_CLICK" }, actions: [{ connectionType: "INTERNAL_NODE", navigationType: "NAVIGATE", transitionNodeID: home, transitionType: "DISSOLVE" }] }] } }));
    expect(r2.summary, JSON.stringify(r2)).toContain("everything applied");
    expect(interactions(engine, toggle)[0]).toMatchObject({ id: expect.any(Object), actions: [{ transitionNodeID: { sessionID: Number(home.split(":")[0]), localID: Number(home.split(":")[1]) } }] });
    const r3 = JSON.parse(text(await call("set_properties", { nodeId: toggle, properties: { prototypeInteractions: [{ trigger: "ON_CLICK", actions: [{ type: "NAVIGATE", destinationId: "999:999" }] }], flowStartingPoints: [] } })));
    const reasons = JSON.stringify(r3);
    expect(reasons).toContain("no layer");
    expect(reasons).toContain("add_interaction");
    expect(reasons).toContain("set_flow_starting_point");
    expect(reasons).not.toContain("status -3");
  });

  it("describe_schema gives any field's shape", async () => {
    const { call } = await editor();
    expect(JSON.stringify(json(await call("describe_schema", { field: "Reaction" })))).toContain("trigger");
    expect(json(await call("describe_schema", { field: "EasingType" })).values).toContain("GENTLE_SPRING");
    const pa = json(await call("describe_schema", { field: "PrototypeAction" }));
    expect(Object.keys(pa.schema.properties)).toEqual(expect.arrayContaining(["transitionNodeID", "targetVariableData", "targetVariableSetID", "conditionalActions"]));
    expect(json(await call("describe_schema", { field: "prototypeInteractions" })).note).toContain("add_interaction");
    expect(json(await call("describe_schema", { field: "fills" })).kind).toContain("layer property");
    expect(json(await call("describe_schema", { field: "stackSpacing" })).layerProperty).toBe("itemSpacing");
    const unknown = await call("describe_schema", { field: "transition" });
    expect(unknown.isError).toBeFalsy();
    const nope = await call("describe_schema", { field: "zzzz" });
    expect(nope.isError).toBe(true);
  });

  it("the player's Set variable mode switches the collection's mode: the bound title turns English, back on stop", async () => {
    const { engine, call, home, toggle, title } = await app();
    json(await call("add_interaction", { nodeId: toggle, trigger: { type: "ON_CLICK" }, actions: [{ type: "SET_VARIABLE_MODE", variableCollectionId: "Content", variableModeId: "EN" }] }));
    json(await call("add_interaction", { nodeId: home, trigger: { type: "ON_KEY_DOWN", keys: "T" }, actions: [{ type: "SET_VARIABLE_MODE", variableCollectionId: "Content", variableModeId: "TR" }] }));
    expect(engine.readNode(title)!.textData?.characters).toBe("Merhaba");
    engine.setViewport(375, 812, 1, 375, 812);
    const page = engine.pages()[0].guid;
    expect(engine.presentStart({ page, node: home })).toBe(Status.OK);
    expect(engine.presentState().screen).toBe(home);
    // Toggle: (20, 20) 100 × 40 in Home, shown at its actual size.
    engine.presentPointer(PointerType.MOVE, 70, 40, 0, 0);
    engine.presentPointer(PointerType.DOWN, 70, 40, 1, 0);
    engine.presentPointer(PointerType.UP, 70, 40, 0, 0);
    expect(engine.readNode(title)!.textData?.characters).toBe("Hello");
    engine.presentKey("down", 84, 0);
    engine.presentKey("up", 84, 0);
    expect(engine.readNode(title)!.textData?.characters).toBe("Merhaba");
    engine.presentPointer(PointerType.DOWN, 70, 40, 1, 0);
    engine.presentPointer(PointerType.UP, 70, 40, 0, 0);
    expect(engine.readNode(title)!.textData?.characters).toBe("Hello");
    engine.presentStop();
    expect(engine.readNode(title)!.textData?.characters).toBe("Merhaba");
  });
});
