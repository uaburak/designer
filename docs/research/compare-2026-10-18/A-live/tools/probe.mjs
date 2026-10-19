// Measures the size-label pill (selection blue or component purple) in live canvas captures: its box and the
// handle squares, to tell each capture's device scale. node probe.mjs name…
import { analyse, launch, liveFile } from "./lib.mjs";

const browser = await launch();
const page = await browser.newPage();
for (const name of process.argv.slice(2)) {
  const r = await analyse(page, name.includes("/") ? name : liveFile(name), ({ w, h, d }) => {
    const isBlue = (i) => d[i] < 90 && d[i + 1] > 110 && d[i + 1] < 175 && d[i + 2] > 200;
    const isPurple = (i) => d[i] > 110 && d[i] < 170 && d[i + 1] < 90 && d[i + 2] > 200;
    // Rows with a long run of fill colour = the pill.
    const runs = [];
    for (const test of [isBlue, isPurple]) {
      for (let y = 0; y < h; y++) {
        let best = 0, cur = 0, end = 0;
        for (let x = 0; x < w; x++) {
          if (test((y * w + x) * 4)) { cur++; if (cur > best) { best = cur; end = x; } } else cur = 0;
        }
        if (best >= 6 && best <= 180) runs.push({ y, x0: end - best + 1, x1: end, kind: test === isBlue ? "blue" : "purple" });
      }
    }
    // Group consecutive rows.
    const groups = [];
    for (const r of runs) {
      const g = groups.find((g) => g.kind === r.kind && r.y - g.y1 <= 14 && r.x0 <= g.x1 + 2 && r.x1 >= g.x0 - 2);
      if (g) { g.y1 = r.y; g.x0 = Math.min(g.x0, r.x0); g.x1 = Math.max(g.x1, r.x1); } else groups.push({ kind: r.kind, y0: r.y, y1: r.y, x0: r.x0, x1: r.x1 });
    }
    return { w, h, pills: groups.filter((g) => g.y1 - g.y0 >= 6).map((g) => `${g.kind} x${g.x0}-${g.x1} (${g.x1 - g.x0 + 1}) y${g.y0}-${g.y1} (${g.y1 - g.y0 + 1})`) };
  });
  console.log(name, JSON.stringify(r));
}
await browser.close();
