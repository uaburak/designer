// One request inside the manifest's networkAccess, one outside it.
(async () => {
  const out = {};
  try {
    const r = await fetch("https://api.example.com/v1/hello");
    out.allowed = { status: r.status, body: await r.json() };
  } catch (e) {
    out.allowed = { error: String(e.message || e) };
  }
  try {
    await fetch("https://evil.example.org/steal");
    out.refused = "reached";
  } catch (e) {
    out.refused = String(e.message || e);
  }
  figma.root.setPluginData("result", JSON.stringify(out));
  figma.closePlugin();
})();
