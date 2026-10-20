// Dumps a file's page: its tree to a depth, every layer with interactions and what they do (one-off exploration).
//   UD=<copy> node scripts/proto-bench/explore.mjs <fileKey> [depth]
import { launch, openFile, close, sleep } from "./lib.mjs";
const key = process.argv[2];
try {
  await launch();
  await sleep(1000);
  const { page } = await openFile(key);
  await sleep(1500);
  const r = await page.evaluate((depth) => {
    const e = window.__designerEditor.engine;
    const st = window.__designerEditor.store;
    const lines = [`pages: ${st.pages.map((p) => p.guid + " " + p.name).join(" | ")}  current ${st.page}`];
    const walk = (id, d) => {
      const n = e.readNode(id, { fields: ["type", "name", "prototypeInteractions", "size", "transform", "componentKey", "symbolData", "transitionNodeID", "prototypeStartNodeID"], childIds: true });
      const ix = (n.prototypeInteractions ?? []).map((i) => `${i.event?.interactionType}${i.event?.transitionTimeout ? "(" + i.event.transitionTimeout + ")" : ""}→` + (i.actions ?? []).map((a) => `${a.navigationType ?? a.connectionType}:${a.transitionNodeID ?? ""}:${a.transitionType ?? ""}${a.transitionShouldSmartAnimate ? "+SA" : ""}:${a.transitionDuration ?? ""}:${a.easingType ?? ""}`).join(",")).join(" ; ");
      if (d <= depth || ix) lines.push(`${"  ".repeat(d)}${id} ${n.type} "${n.name}" ${n.size ? Math.round(n.size.x) + "x" + Math.round(n.size.y) : ""} ${ix ? "IX " + ix : ""}`);
      for (const c of n.childIds ?? []) walk(c, d + 1);
    };
    walk(st.page, 0);
    lines.push("flows: " + JSON.stringify(e.readNode(st.page, { fields: ["prototypeStartingPoints", "prototypeDevice"] })));
    return lines.join("\n");
  }, Number(process.argv[3] ?? 3));
  console.log(r);
} catch (e) {
  console.error(e);
} finally {
  await close();
}
