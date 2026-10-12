/**
 * The `discovery_text` room job's client side (docs/governance.md §2.11): every text-bearing node of the document as
 * `DiscoveryTextItem`s, which the room diffs against its own table into Discovery's insert / update / delete events.
 *
 * - TEXT nodes → `in_file` (their characters);
 * - Dev Mode annotations → `dev_mode_annotation` (each note's markdown, else its plain label; one item per note);
 * - components and component sets → `component_documentation_description` (the description) and
 *   `component_documentation_link` (each documentation link's URI).
 *
 * Read from the engine in one `readNodes` per page (subtree, only the fields used), so a version in a scratch engine
 * answers the same way. Instance sublayers are left out: their text is the component's, or an override the room
 * would see again under every instance (ours; Figma doesn't say). Empty texts are left out.
 */
import type { Engine } from "@/engine/Engine";
import type { DiscoveryTextItem } from "../../../../shared/org/governance";

type Reader = Pick<Engine, "pages" | "readNodes">;

const FIELDS = ["type", "textData", "annotations", "description", "symbolLinks", "isStateGroup", "isSoftDeleted"];

interface Row {
  guid: string;
  type?: string;
  textData?: { characters?: string };
  annotations?: { label?: string; labelV2?: string }[];
  description?: string;
  symbolLinks?: { uri?: string }[];
  isStateGroup?: boolean;
  isSoftDeleted?: boolean;
}

/** Instance sublayers carry Figma's path ids ("I1:2;3:4") */
const isInstanceSublayer = (guid: string) => guid.startsWith("I") || guid.includes(";");

export function discoveryText(engine: Reader): DiscoveryTextItem[] {
  const out: DiscoveryTextItem[] = [];
  for (const page of engine.pages()) {
    const rows = engine.readNodes([page.guid], { subtree: true, fields: FIELDS }) as unknown as Row[];
    for (const n of rows) {
      if (!n?.guid || n.isSoftDeleted || isInstanceSublayer(n.guid)) continue;
      if (n.type === "TEXT") {
        const text = n.textData?.characters ?? "";
        if (text) out.push({ nodeId: n.guid, textType: "in_file", text });
      }
      for (const a of n.annotations ?? []) {
        const text = a?.labelV2 || a?.label || "";
        if (text) out.push({ nodeId: n.guid, textType: "dev_mode_annotation", text });
      }
      const component = n.type === "SYMBOL" || (n.type === "FRAME" && n.isStateGroup === true);
      if (!component) continue;
      if (n.description) out.push({ nodeId: n.guid, textType: "component_documentation_description", text: n.description });
      for (const l of n.symbolLinks ?? []) if (l?.uri) out.push({ nodeId: n.guid, textType: "component_documentation_link", text: l.uri });
    }
  }
  return out;
}
