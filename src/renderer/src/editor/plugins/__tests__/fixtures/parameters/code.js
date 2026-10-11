// Quick Actions parameters: suggestions while typing, then the run with the values.
figma.parameters.on("input", ({ key, query, result }) => {
  if (key === "shape") result.setSuggestions(["Rectangle", "Ellipse", "Star"].filter((s) => s.toLowerCase().startsWith(query.toLowerCase())));
  else if (!/^\d*$/.test(query)) result.setError("Type a number");
  else result.setSuggestions([]);
});
figma.on("run", ({ parameters }) => {
  const n = parseInt(parameters.count, 10) || 1;
  for (let i = 0; i < n; i++) {
    const node = parameters.shape === "Ellipse" ? figma.createEllipse() : parameters.shape === "Star" ? figma.createStar() : figma.createRectangle();
    node.x = i * 120;
  }
  figma.closePlugin();
});
