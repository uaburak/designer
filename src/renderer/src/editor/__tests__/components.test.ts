// Components as data (model/components.ts): variant names and Combine as variants, the default variant, a variant
// switch's target, property defs / values / bindings, overrides and Reset ▸, Assets grouping and search, ids.
import { describe, expect, it } from "vitest";
import {
  assetLabel,
  assignedValue,
  bindingsOf,
  canBind,
  changedGroups,
  combineNames,
  defaultVariant,
  derivedId,
  formatVariantName,
  groupAssets,
  guidStr,
  guidVal,
  isPreferred,
  newPropertyDef,
  newPropertyName,
  nextDefId,
  overrideAt,
  parseDerivedId,
  parseVariantName,
  propertyApiName,
  renameInVariantName,
  searchAssets,
  sortedDefs,
  unbindAll,
  variantFor,
  variantProperties,
  variantValues,
  withAssignment,
  withBinding,
  withOverride,
  withoutOverrides,
  DEF_ID_BASE,
  type CNode,
  type ComponentAsset,
  type ComponentPropDef,
} from "../model/components";
import { fromPropValue, instanceMessage, toPropValue } from "../components";

const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const id = (l: number) => ({ sessionID: 1, localID: l });

describe("variants", () => {
  it("parses and formats Figma's variant names", () => {
    expect(parseVariantName("State=Hover, Size=Large")).toEqual([
      ["State", "Hover"],
      ["Size", "Large"],
    ]);
    expect(parseVariantName("Button/Primary")).toBeNull();
    expect(formatVariantName([["State", "Default"]])).toBe("State=Default");
  });

  it("Combine as variants: slash names become Variant, Property 2…; Prop=Value names keep theirs; no repeats", () => {
    expect(combineNames(["Button/Primary/Large", "Button/Secondary/Small"])).toEqual({
      properties: ["Variant", "Property 2", "Property 3"],
      values: [
        ["Button", "Primary", "Large"],
        ["Button", "Secondary", "Small"],
      ],
    });
    expect(combineNames(["State=Default", "State=Hover, Size=Large"]).properties).toEqual(["State", "Size"]);
    expect(combineNames(["A", "A"]).values).toEqual([["A"], ["A 2"]]);
  });

  const defs: ComponentPropDef[] = [
    { id: id(10), name: "State", type: "VARIANT" },
    { id: id(11), name: "Size", type: "VARIANT" },
  ];
  const v = (guid: string, state: string, size: string, x: number, y: number): CNode => ({
    guid,
    type: "SYMBOL",
    name: `State=${state}, Size=${size}`,
    transform: at(x, y),
    variantPropSpecs: [
      { propDefId: id(10), value: state },
      { propDefId: id(11), value: size },
    ],
  });
  const variants = [v("1:42", "Hover", "Small", 140, 20), v("1:41", "Default", "Small", 20, 20), v("1:43", "Default", "Large", 20, 60), v("1:44", "Hover", "Large", 140, 60)];

  it("the default variant is the top-left one", () => {
    expect(defaultVariant(variants)?.guid).toBe("1:41");
  });

  it("a switch keeps the other values where a variant has them", () => {
    expect(variantFor(variants[1], variants, defs, "State", "Hover")?.guid).toBe("1:42");
    expect(variantFor(variants[2], variants, defs, "State", "Hover")?.guid).toBe("1:44");
    expect(variantFor(variants[1], variants, defs, "State", "Pressed")).toBeNull();
    expect(variantValues(variants[0], defs).get("State")).toBe("Hover");
  });

  it("lists a set's properties in its value order", () => {
    const set: CNode = { guid: "1:40", type: "FRAME", isStateGroup: true, componentPropDefs: defs, stateGroupPropertyValueOrders: [{ property: "State", values: ["Default", "Hover"] }] };
    const props = variantProperties(set, variants);
    expect(props.map((p) => p.name)).toEqual(["State", "Size"]);
    expect(props[0].values).toEqual(["Default", "Hover"]);
    expect(props[1].values).toEqual(["Small", "Large"]);
  });

  it("renames a property or a value inside variant names", () => {
    expect(renameInVariantName("State=Hover, Size=Small", "State", { property: "Status" })).toBe("Status=Hover, Size=Small");
    expect(renameInVariantName("State=Hover, Size=Small", "State", { value: ["Hover", "Over"] })).toBe("State=Over, Size=Small");
    expect(renameInVariantName("State=Hover", "Size", { property: "X" })).toBeNull();
  });
});

describe("properties", () => {
  const bool = newPropertyDef("BOOL", id(1), "Show icon");
  const text = newPropertyDef("TEXT", id(2), "Label");
  const variant = newPropertyDef("VARIANT", id(3), "State");

  it("new properties get Figma's defaults and names", () => {
    expect(bool.initialValue).toEqual({ boolValue: true });
    expect(text.initialValue).toEqual({ textValue: { characters: "Text" } });
    expect(newPropertyName([{ ...bool, name: "Property 1" }])).toBe("Property 2");
    expect(propertyApiName(text)).toBe("Label#1:2");
    expect(propertyApiName(variant)).toBe("State");
    expect(sortedDefs([bool, variant, text]).map((d) => d.name)).toEqual(["State", "Show icon", "Label"]);
  });

  it("an instance's value: its assignment, else the default; one entry per property", () => {
    expect(assignedValue(text, undefined)).toEqual({ textValue: { characters: "Text" } });
    const a = withAssignment(withAssignment(undefined, text, { textValue: { characters: "Sign in" } }), text, { textValue: { characters: "Log in" } });
    expect(a).toHaveLength(1);
    expect(assignedValue(text, a)).toEqual({ textValue: { characters: "Log in" } });
  });

  it("binds a layer's field as a PROP_REF entry, and unbinds", () => {
    const layer: CNode = { guid: "1:3", type: "TEXT" };
    const map = withBinding(layer, "TEXT_DATA", text);
    expect(map.entries[0]).toEqual({ variableField: "TEXT_DATA", variableData: { dataType: "PROP_REF", resolvedDataType: "TEXT_DATA", value: { propRefValue: { defId: id(2) } } } });
    const bound = { ...layer, parameterConsumptionMap: map };
    expect(guidStr(bindingsOf(bound).get("TEXT_DATA"))).toBe("1:2");
    expect(withBinding(bound, "TEXT_DATA", null).entries).toEqual([]);
    expect(unbindAll([bound, { guid: "1:4" }], text)).toEqual([{ guid: "1:3", parameterConsumptionMap: { entries: [] } }]);
    expect(canBind(text, "TEXT")).toBe(true);
    expect(canBind(text, "FRAME")).toBe(false);
    expect(canBind({ type: "INSTANCE_SWAP" }, "INSTANCE")).toBe(true);
  });

  it("engine values ⇄ schema values", () => {
    expect(toPropValue("BOOL", false)).toEqual({ boolValue: false });
    expect(toPropValue("INSTANCE_SWAP", "1:20")).toEqual({ guidValue: id(20) });
    expect(fromPropValue("TEXT", { textValue: { characters: "Hi" } })).toBe("Hi");
    expect(fromPropValue("INSTANCE_SWAP", { guidValue: id(21) })).toBe("1:21");
  });
});

describe("overrides", () => {
  it("one entry per path, merged; Reset removes fields; the groups Reset ▸ lists", () => {
    let sd = withOverride({ symbolID: id(1) }, [], { fillPaints: [] });
    sd = withOverride(sd, [id(3)], { fontSize: 14 });
    sd = withOverride(sd, [id(3)], { textData: { characters: "x" } });
    expect(sd.symbolOverrides).toHaveLength(2);
    expect(overrideAt(sd, [id(3)])).toMatchObject({ fontSize: 14, textData: { characters: "x" } });
    expect(overrideAt(sd, [])).toMatchObject({ fillPaints: [] });
    const inst: CNode = { guid: "2:2", type: "INSTANCE", symbolData: sd, componentPropAssignments: [{ defID: id(2) }] };
    expect(changedGroups(inst).map((g) => g.label)).toEqual(["Fill", "Text", "Text style", "Properties"]);
    expect(withoutOverrides(sd, ["fontSize", "textData"]).symbolOverrides).toHaveLength(1);
    expect(withoutOverrides(sd, null).symbolOverrides).toEqual([]);
  });

  it("derived ids (docs/schema.md §5.1)", () => {
    expect(derivedId("2:2", [id(2), id(22)])).toBe("I2:2;1:2;1:22");
    expect(parseDerivedId("I2:2;1:2")).toEqual({ instance: "2:2", path: [id(2)] });
    expect(parseDerivedId("2:2")).toBeNull();
    expect(guidVal("3:4")).toEqual({ sessionID: 3, localID: 4 });
  });

  it("definition ids count down from the top of the session's range", () => {
    const first = nextDefId(1, []);
    expect(first.localID).toBeGreaterThan(DEF_ID_BASE);
    expect(nextDefId(1, [first]).localID).toBe(first.localID - 1);
    expect(nextDefId(2, [first])).toEqual({ sessionID: 2, localID: first.localID });
  });

  it("an inserted instance carries the main's root fields and its link", () => {
    const m = instanceMessage({ guid: "1:1", type: "SYMBOL", name: "Button", size: { x: 120, y: 40 }, componentPropDefs: [], key: "k", parentIndex: { guid: "0:3", position: "!" } }, { x: 10, y: 20 });
    const n = m.nodeChanges[0] as CNode;
    expect(n.type).toBe("INSTANCE");
    expect(n.size).toEqual({ x: 120, y: 40 });
    expect(n.symbolData?.symbolID).toEqual(id(1));
    expect(n.componentPropDefs).toBeUndefined();
    expect(n.transform?.m02).toBe(10);
  });
});

describe("assets", () => {
  const a = (id: string, name: string, page: string, frame: string | null): ComponentAsset => ({ id, name, kind: "component", target: id, page, pageName: page === "0:1" ? "Screens" : "Components", frame, frameName: frame ? "Icons" : null });
  const list = [a("1:21", "Icons/Heart", "0:3", "1:30"), a("1:1", "Button", "0:3", null), a("1:20", "Icons/Star", "0:3", "1:30"), a("9:1", "Card", "0:1", null)];

  it("groups by page (the file's order), then frame (on-page first), names in order", () => {
    const g = groupAssets(list, ["0:1", "0:3"]);
    expect(g.map((x) => x.pageName)).toEqual(["Screens", "Components"]);
    expect(g[1].frames.map((f) => f.frameName)).toEqual([null, "Icons"]);
    expect(g[1].frames[1].items.map((i) => assetLabel(i.name))).toEqual(["Heart", "Star"]);
  });

  it("search matches every word in the name, page or frame", () => {
    expect(searchAssets(list, "icons star").map((x) => x.id)).toEqual(["1:20"]);
    expect(searchAssets(list, "screens").map((x) => x.id)).toEqual(["9:1"]);
    expect(searchAssets(list, "")).toHaveLength(4);
  });

  it("preferred values match by GUID string (local) or key (published)", () => {
    expect(isPreferred(list[2], "1:20")).toBe(true);
    expect(isPreferred({ ...list[2], key: "abc" }, "abc")).toBe(true);
    expect(isPreferred(list[2], "1:21")).toBe(false);
  });
});
