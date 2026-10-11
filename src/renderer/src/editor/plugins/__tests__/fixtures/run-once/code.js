// The "Run once" template's shape: do the work, then close. A frame with auto layout, a text inside, plugin data.
(async () => {
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  const frame = figma.createFrame();
  frame.name = "Card";
  frame.layoutMode = "VERTICAL";
  frame.itemSpacing = 8;
  frame.paddingTop = frame.paddingBottom = frame.paddingLeft = frame.paddingRight = 16;
  frame.primaryAxisSizingMode = "AUTO";
  frame.counterAxisSizingMode = "AUTO";
  const text = figma.createText();
  text.characters = "Hello from a plugin";
  text.fontSize = 20;
  frame.appendChild(text);
  frame.setPluginData("kind", "card");
  frame.setSharedPluginData("fixtures.shared", "made", "yes");
  figma.closePlugin("Made a card");
})();
