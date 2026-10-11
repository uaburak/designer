// Relaunch buttons on the selection; a relaunched run records the command it came from.
if (figma.command === "edit") {
  figma.root.setPluginData("relaunched", figma.command);
  figma.closePlugin();
} else {
  for (const node of figma.currentPage.selection) node.setRelaunchData({ edit: "Change this shape", open: "" });
  figma.closePlugin();
}
