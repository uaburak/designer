// Under documentAccess "dynamic-page" the synchronous lookups throw; the async ones work.
(async () => {
  const out = {};
  const page = figma.currentPage;
  try {
    figma.getNodeById(page.id);
    out.sync = "worked";
  } catch (e) {
    out.sync = String(e.message);
  }
  try {
    figma.currentPage = page;
    out.setPage = "worked";
  } catch (e) {
    out.setPage = String(e.message);
  }
  const again = await figma.getNodeByIdAsync(page.id);
  out.async = again === page;
  await figma.loadAllPagesAsync();
  out.pages = figma.root.children.length;
  figma.root.setPluginData("result", JSON.stringify(out));
  figma.closePlugin();
})();
