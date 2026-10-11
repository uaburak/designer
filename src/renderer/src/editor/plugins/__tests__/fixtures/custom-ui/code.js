// The "Custom UI" template's shape: the UI asks for n rectangles; the code makes them and answers.
figma.showUI(__html__, { width: 232, height: 208, themeColors: true });
figma.ui.onmessage = (msg) => {
  if (msg.type === "create-shapes") {
    const nodes = [];
    for (let i = 0; i < msg.count; i++) {
      const shape = msg.shape === "ellipse" ? figma.createEllipse() : figma.createRectangle();
      shape.x = i * 150;
      shape.fills = [{ type: "SOLID", color: { r: 0, g: 0.5, b: 1 } }];
      figma.currentPage.appendChild(shape);
      nodes.push(shape);
    }
    figma.currentPage.selection = nodes;
    figma.ui.postMessage({ type: "created", ids: nodes.map((n) => n.id) });
  }
  if (msg.type === "cancel") figma.closePlugin();
};
