// Renames the selection: "number" gives "Layer 1…n", "upper" upper case; the undo step is then split once.
const sel = figma.currentPage.selection;
sel.forEach((node, i) => {
  node.name = figma.command === "upper" ? node.name.toUpperCase() : "Layer " + (i + 1);
});
figma.commitUndo();
if (sel[0]) sel[0].name = sel[0].name + " (first)";
figma.closePlugin();
