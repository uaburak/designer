// Design system v2, step 6c: the Button set as a fixed variant grid (rows Variant × Size, columns State), as Figma lays
// variant sets out; the buttons themselves stay auto layout.
import { connect } from "../ui-kit/mcp.mjs";
const mcp = await connect();
const call = async (name, args) => { const r = await mcp.rpc("tools/call", { name, arguments: args }); const t = r.content.map((c) => c.text ?? "").join(""); if (r.isError) throw new Error(t); return t; };
const set = "6291457:1238";
const V = ["Primary", "Secondary", "Ghost", "Destructive", "Destructive secondary"], S = ["Default", "Large"], ST = ["Default", "Hover", "Pressed", "Focus", "Selected", "Disabled"];
const tree = await call("get_metadata", { nodeId: set, depth: 1 });
const comps = [...tree.matchAll(/<component id="([^"]+)" name="([^"]*)"/g)].map((m) => ({ id: m[1], props: Object.fromEntries(m[2].split(", ").map((p) => p.split("="))) }));
const COL = 104, ROW = 52, PAD = 24;
await call("update_nodes", { updates: [{ nodeId: set, layoutMode: "NONE" }] });
const updates = comps.map((c) => {
  const row = V.indexOf(c.props.Variant) * 2 + S.indexOf(c.props.Size);
  const col = ST.indexOf(c.props.State);
  const h = c.props.Size === "Large" ? 32 : 24;
  return { nodeId: c.id, x: PAD + col * COL, y: PAD + row * ROW + (ROW - 8 - h) / 2 };
});
await call("update_nodes", { updates });
await call("update_nodes", { updates: [{ nodeId: set, width: PAD * 2 + 6 * COL - 24, height: PAD * 2 + 10 * ROW - 8 }] });
console.log(comps.length, "placed");
