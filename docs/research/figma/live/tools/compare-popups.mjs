// node compare-popups.mjs <live.txt> <ours.txt> [block]: compares the POPUPS blocks (the popup's place, then its
// entries matched by aria label / text) — by default every block in order; [block] picks one (0-based, -1 = last).
import { readFileSync } from "node:fs";
const [livePath, oursPath, which] = process.argv.slice(2);
const blocks = (text) => {
  const lines = text.split("\n");
  const s = lines.indexOf("POPUPS");
  const out = [];
  for (const l of lines.slice(s + 1)) {
    if (l === "RIGHT" || l === "LEFT") break;
    const at = /^@(-?\d+),(-?\d+) (\d+)x(\d+)/.exec(l);
    if (at) { out.push({ at: at.slice(1).map(Number), entries: [] }); continue; }
    const m = /^(-?\d+),(-?\d+) (\d+)x(\d+) (.*)$/.exec(l);
    if (!m || !out.length) continue;
    const [, x, y, w, h, rest] = m;
    const aria = /\[([^\]]+)\]/.exec(rest)?.[1];
    const txt = /^"([^"]*)" (\S+)/.exec(rest);
    const key = aria ? "[" + aria + "]" : txt ? '"' + txt[1] + '" ' + txt[2] : null;
    if (key) out[out.length - 1].entries.push({ key, x: +x, y: +y, w: +w, h: +h, line: l });
  }
  return out;
};
const live = blocks(readFileSync(livePath, "utf8"));
const ours = blocks(readFileSync(oursPath, "utf8"));
const pick = (list) => (which === undefined ? list : [list.at(Number(which))].filter(Boolean));
const L = pick(live), O = pick(ours);
const report = [];
for (const [bi, a] of L.entries()) {
  const b = O[bi];
  if (!b) { report.push(`MISSING popup @${a.at.join(",")}`); continue; }
  const dd = a.at.map((v, i) => v - b.at[i]);
  report.push(`${dd.some((v) => Math.abs(v) > 1) ? "DIFF    " : "same    "} popup live @${a.at[0]},${a.at[1]} ${a.at[2]}x${a.at[3]}  ours @${b.at[0]},${b.at[1]} ${b.at[2]}x${b.at[3]}`);
  const used = new Set();
  for (const e of a.entries) {
    let best = null;
    for (const [i, f] of b.entries.entries()) {
      if (used.has(i) || f.key.toLowerCase() !== e.key.toLowerCase()) continue;
      const d = Math.abs(e.x - f.x) + Math.abs(e.y - f.y);
      if (!best || d < best.d) best = { i, f, d };
    }
    if (!best) { report.push(`MISSING  ${e.line}`); continue; }
    used.add(best.i);
    const f = best.f;
    if ([e.x - f.x, e.y - f.y, e.w - f.w, e.h - f.h].some((v) => Math.abs(v) > 1)) report.push(`DIFF     ${e.key}  live ${e.x},${e.y} ${e.w}x${e.h}  ours ${f.x},${f.y} ${f.w}x${f.h}`);
  }
  for (const [i, f] of b.entries.entries()) if (!used.has(i)) report.push(`EXTRA    ${f.line}`);
}
console.log(report.join("\n"));
