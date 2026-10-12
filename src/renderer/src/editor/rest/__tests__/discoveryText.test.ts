// The `discovery_text` job's client side (docs/governance.md §2.11) on a fake engine reader: one read per page with the
// fields it needs, TEXT characters, annotations, component (set) descriptions and documentation links; instance
// sublayers, deleted nodes and empty texts left out.
import { describe, expect, it } from "vitest";
import { discoveryText } from "../discoveryText";

describe("discoveryText", () => {
  it("lists every text-bearing node by its Discovery text type", () => {
    const reads: { refs: readonly string[]; options: unknown }[] = [];
    const pages: Record<string, unknown[]> = {
      "0:1": [
        { guid: "0:1", type: "CANVAS" },
        { guid: "1:2", type: "TEXT", textData: { characters: "Hello" } },
        { guid: "1:3", type: "TEXT", textData: { characters: "" } },
        { guid: "1:4", type: "FRAME", annotations: [{ label: "plain", labelV2: "**md**" }, { label: "only plain" }, { label: "" }] },
        { guid: "I5:6;1:2", type: "TEXT", textData: { characters: "From the component" } },
        { guid: "1:7", type: "TEXT", textData: { characters: "Gone" }, isSoftDeleted: true },
      ],
      "0:2": [
        { guid: "2:1", type: "SYMBOL", description: "A button", symbolLinks: [{ uri: "https://x.co/button" }, { uri: "" }] },
        { guid: "2:2", type: "FRAME", isStateGroup: true, description: "Buttons" },
        { guid: "2:3", type: "FRAME", description: "not a component" },
      ],
    };
    const engine = {
      pages: () => [{ guid: "0:1" }, { guid: "0:2" }],
      readNodes: (refs: readonly string[], options: unknown) => {
        reads.push({ refs, options });
        return pages[refs[0]];
      },
    };
    expect(discoveryText(engine as never)).toEqual([
      { nodeId: "1:2", textType: "in_file", text: "Hello" },
      { nodeId: "1:4", textType: "dev_mode_annotation", text: "**md**" },
      { nodeId: "1:4", textType: "dev_mode_annotation", text: "only plain" },
      { nodeId: "2:1", textType: "component_documentation_description", text: "A button" },
      { nodeId: "2:1", textType: "component_documentation_link", text: "https://x.co/button" },
      { nodeId: "2:2", textType: "component_documentation_description", text: "Buttons" },
    ]);
    expect(reads).toHaveLength(2);
    expect(reads[0].options).toMatchObject({ subtree: true });
  });
});
