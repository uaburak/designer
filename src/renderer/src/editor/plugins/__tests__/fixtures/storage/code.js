// figma.clientStorage: counts its runs, keeps bytes.
(async () => {
  const runs = ((await figma.clientStorage.getAsync("runs")) || 0) + 1;
  await figma.clientStorage.setAsync("runs", runs);
  await figma.clientStorage.setAsync("bytes", new Uint8Array([1, 2, 3]));
  const bytes = await figma.clientStorage.getAsync("bytes");
  const keys = await figma.clientStorage.keysAsync();
  figma.root.setPluginData("result", JSON.stringify({ runs, bytes: Array.from(bytes), keys: keys.sort() }));
  figma.closePlugin();
})();
