// Checks that Wecra's Inter font files load (status 200) and are in use. Throwaway.
/* global window, document, getComputedStyle */
import { BASE, launch } from "./lib.mjs";
const b = await launch();
const p = await b.newPage();
const seen = [];
p.on("response", (r) => { if (/\.(woff2?|ttf)(\?|$)/.test(r.url())) seen.push(`${r.status()} ${r.url().replace(/^.*\/node_modules\//, "nm/")}`); });
await p.goto(`${BASE}/?editor&doc=capture`);
await p.waitForFunction(() => window.__designerEditor, null, { timeout: 30000 });
await p.waitForTimeout(1500);
console.log(seen.join("\n"));
console.log(await p.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => /Inter/i.test(f.family)).map((f) => `${f.family} ${f.weight} ${f.status}`).join(" | "); }));
console.log(await p.evaluate(() => getComputedStyle(document.querySelector('[data-panel="right"]') ?? document.body).fontFamily));
await b.close();
