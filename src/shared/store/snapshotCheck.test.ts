import { describe, expect, it } from "vitest";
import { newDocumentMessage, type NodeChange } from "../schema/codec";
import { NodeTable } from "../schema/patch";
import { snapshotLosses } from "./snapshotCheck";

const node = (extra: Partial<NodeChange>): NodeChange => ({ guid: { sessionID: 1, localID: 1 }, phase: "CREATED", type: "FRAME", name: "F", parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "!" }, ...extra }) as NodeChange;
const table = (n: NodeChange, derivedDataVersion = 0) => {
  const m = newDocumentMessage();
  m.nodeChanges!.push(n);
  if (derivedDataVersion) m.derivedDataVersion = derivedDataVersion;
  return NodeTable.fromMessage(m);
};

describe("an engine snapshot against the head (docs/data.md §5.5)", () => {
  it("counts lost nodes and values; derived fields, defaults and empty maps aren't losses; changed values aren't either", () => {
    const binding = { entries: [{ variableField: "STACK_PADDING_RIGHT", variableData: { value: { alias: { guid: { sessionID: 9, localID: 9 } } }, dataType: "ALIAS", resolvedDataType: "FLOAT" } }] };
    const head = table(node({ opacity: 1, visible: true, codeSyntax: { entries: [] }, stackPaddingRight: 8, cornerRadius: 3, parameterConsumptionMap: binding } as Partial<NodeChange>));
    // Values may change, to their default (absent) too: a resolved binding, corrected geometry.
    expect(snapshotLosses(head, table(node({ cornerRadius: 5, fillGeometry: [], parameterConsumptionMap: binding } as Partial<NodeChange>), 4)).total).toBe(0);
    // A reference may not go.
    const lost = snapshotLosses(head, table(node({ cornerRadius: 3, stackPaddingRight: 8 })));
    expect(lost).toMatchObject({ missingNodes: 0, droppedFields: { parameterConsumptionMap: 1 }, total: 1 });
    const gone = snapshotLosses(head, NodeTable.fromMessage(newDocumentMessage()));
    expect(gone.missingNodes).toBe(1);
  });
});
