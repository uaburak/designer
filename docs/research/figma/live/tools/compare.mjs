// node compare.mjs <live.txt> <ours.txt>: matches entries by aria label / text and prints position/size differences.
import { readFileSync } from "node:fs";
const [livePath, oursPath] = process.argv.slice(2);
const parse = (text, live) => {
  let lines = text.split("\n");
  if (live) {
    const s = lines.findIndex((l) => l === "RIGHT");
    const e = lines.findIndex((l, i) => i > s && (l === "LEFT" || l === "POPUPS"));
    lines = lines.slice(s + 1, e < 0 ? undefined : e);
  }
  const out = [];
  for (const l of lines) {
    const m = /^(-?\d+),(-?\d+) (\d+)x(\d+) (.*)$/.exec(l);
    if (!m) continue;
    const [, x, y, w, h, rest] = m;
    if (+x < 0 || +y < 0) continue;
    const aria = /\[([^\]]+)\]/.exec(rest)?.[1];
    const txt = /^"([^"]*)" (\S+)/.exec(rest);
    let key = null;
    if (aria) key = "[" + aria + "]";
    else if (txt) key = '"' + txt[1] + '" ' + txt[2];
    if (!key) continue;
    out.push({ key, x: +x, y: +y, w: +w, h: +h, line: l });
  }
  return out;
};
const live = parse(readFileSync(livePath, "utf8"), true);
const ours = parse(readFileSync(oursPath, "utf8"), false);
const used = new Set();
const report = [];
for (const a of live) {
  // nearest unused match by key
  let best = null;
  for (const [i, b] of ours.entries()) {
    if (used.has(i) || b.key.toLowerCase() !== a.key.toLowerCase()) continue;
    const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (!best || d < best.d) best = { i, b, d };
  }
  if (!best) {
    report.push(`MISSING  ${a.line}`);
    continue;
  }
  used.add(best.i);
  const b = best.b;
  const dd = [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h];
  if (dd.some((v) => Math.abs(v) > 1)) report.push(`DIFF     ${a.key}  live ${a.x},${a.y} ${a.w}x${a.h}  ours ${b.x},${b.y} ${b.w}x${b.h}`);
}
for (const [i, b] of ours.entries()) if (!used.has(i)) report.push(`EXTRA    ${b.line}`);
console.log(report.join("\n") || "identical (±1px)");
