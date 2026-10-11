// Reads the selection's solid fills (hex) and reports them, with figma.getSelectionColors().
const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const found = [];
for (const node of figma.currentPage.selection) {
  if ("fills" in node && Array.isArray(node.fills)) for (const p of node.fills) if (p.type === "SOLID") found.push(hex(p.color));
}
const colors = figma.getSelectionColors();
figma.root.setPluginData("result", JSON.stringify({ found, paints: colors ? colors.paints.length : 0 }));
figma.notify(found.length ? found.join(", ") : "Nothing selected");
figma.closePlugin();
