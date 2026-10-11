// A Dev Mode codegen: width, height and the first fill as CSS.
figma.codegen.on("generate", async ({ node, language }) => {
  const lines = [`width: ${node.width}px;`, `height: ${node.height}px;`];
  const fills = "fills" in node && Array.isArray(node.fills) ? node.fills : [];
  const fill = fills.find((p) => p.type === "SOLID");
  if (fill && fill.type === "SOLID") lines.push(`background: rgb(${[fill.color.r, fill.color.g, fill.color.b].map((v) => Math.round(v * 255)).join(", ")});`);
  return [{ language: "CSS", code: lines.join("\n"), title: `${node.name} (${language})` }];
});
