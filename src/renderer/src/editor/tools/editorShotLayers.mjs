// editor-shot's Layers polish section (EDITOR_ONLY=layers14, round 14): four owner reports, measured in the page.
//
// 1. A layer's name uses the room to the highlight's right edge and fades out there (a mask, no "…"); hovered, or
//    with a lock / closed eye kept on, the cut moves left by the cells' width — on plain, hovered and selected rows.
// 2. Every row is 32 with its name on the same line in every state (collapsed, expanded, hovered, selected, inside a
//    selected layer — the start, middle and end of the selection's block): expanding a selected layer no longer
//    moves its row's content 2 down (the block used to be made of the rows' margins).
// 3. A deep tree scrolls sideways (live: rows 263 wide in the 240 panel with one level open — the list's width plus
//    the deepest row's indent): the highlight spans the rows, lock and eye stay at the visible right edge, every
//    name shows when scrolled, and a selection revealed in the list scrolls it so its name shows.
// 4. The navigation bar's tabs are icons only (tooltips name them), View › Additional labels being off by default.
//
// Crops of the left side go to the run's folder (docs/research/layers-polish/ for the committed ones).
/* global window, document, atob, Blob, createImageBitmap, OffscreenCanvas, getComputedStyle */
import path from "node:path";

const LONG = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaassdddddddddddddddddddddddddddddddd end";
/** Frame 20 … Frame 9: twelve levels, each inside the one before. */
const DEEP = Array.from({ length: 12 }, (_, i) => ({ guid: `9:${20 + i}`, name: `Frame ${20 - i}`, depth: i }));

function nodes() {
  const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const fill = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
  const frame = (guid, parent, pos, name, x, y, size, extra = {}) => ({ guid, phase: "CREATED", type: "FRAME", name, parentIndex: { guid: parent, position: pos }, size: { x: size, y: size }, transform: at(x, y), fillPaints: fill, ...extra });
  const out = [
    frame("9:1", "0:1", "!", LONG, 0, 0, 100),
    frame("9:2", "0:1", '"', LONG, 200, 0, 100, { locked: true }),
    frame("9:3", "0:1", "#", LONG, 400, 0, 100, { visible: false }),
    frame("9:4", "0:1", "$", "Short", 600, 0, 100),
  ];
  DEEP.forEach((d, i) => out.push(frame(d.guid, i === 0 ? "0:1" : DEEP[i - 1].guid, i === 0 ? "%" : "!", d.name, i === 0 ? 0 : 4, i === 0 ? 300 : 4, 600 - i * 10)));
  return out;
}

/** The rightmost column (page x) of a region where the pixels differ from its top-left pixel (the row's ground). */
async function inkRight(page, clip) {
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async ({ b64, x0 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
      const bg = [data[0], data[1], data[2]];
      let right = -1;
      for (let x = 0; x < width; x++)
        for (let y = 0; y < height; y++) {
          const i = (y * width + x) * 4;
          if (Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2])) > 48) {
            right = x;
            break;
          }
        }
      return right < 0 ? null : x0 + right;
    },
    { b64: png.toString("base64"), x0: clip.x }
  );
}

/** A row's boxes: the row, its highlight's box, its name and cells (page px). */
const rowBoxes = (page, id) =>
  page.evaluate((id) => {
    const row = document.querySelector(`[data-ds="LayerRow"][data-id="${id}"]`);
    if (!row) return null;
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
    };
    const name = row.querySelector("[data-layer-name]");
    return { row: r(row), box: r(row.firstElementChild), name: r(name), lock: r(row.querySelector('[data-cell="lock"]')), eye: r(row.querySelector('[data-cell="visible"]')) };
  }, id);

/** Where the name's ink stops on a row (the text band of its highlight, from the name's left to `to`). */
async function nameInk(page, id, to) {
  const b = await rowBoxes(page, id);
  const clip = { x: Math.round(b.name.left), y: Math.round(b.box.top) + 2, width: Math.round(to - b.name.left), height: Math.round(b.box.height) - 4 };
  return { ink: await inkRight(page, clip), b };
}

export async function layersSection(page, theme, { open, settle, check, outDir }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setSelection([]);
    ed.ui.set({ expanded: new Set() });
  }, nodes());
  await settle(page);
  const panel = await page.evaluate(() => {
    const b = document.querySelector('[data-panel="left"]').getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  });
  const rail = await page.evaluate(() => {
    const b = document.querySelector('[data-ds="Rail"]').getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  });
  const crop = async (name, clip = { x: 0, y: 0, width: Math.round(panel.x + panel.width) + 1, height: 620 }) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
  };
  const away = () => page.mouse.move(800, 860);

  // ---- 4. The navigation bar: icons only, their names in tooltips. -------------------------------------------------
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-ds="Rail"] [data-ds="RailItem"][data-rail-tab]')].map((el) => {
      const b = el.getBoundingClientRect();
      return { tab: el.dataset.railTab, text: el.innerText.trim(), height: Math.round(b.height), labels: el.closest('[data-ds="Rail"]').hasAttribute("data-labels") };
    })
  );
  check(`Layers14 rail: File, Agents, Assets, Tools, Variables drawn as icons only (no names under them; Additional labels off by default)`, tabs.length === 5 && tabs.every((t) => t.text === "" && !t.labels), JSON.stringify(tabs));
  check(`Layers14 rail: each tab is its 32 tile and 8 around it (40 apart)`, tabs.every((t) => t.height === 40), tabs.map((t) => t.height).join());
  await page.locator('[data-rail-tab="assets"]').hover();
  await page.waitForTimeout(900);
  const tip = await page.evaluate(() => [...document.querySelectorAll('[data-ds="Tooltip"]')].map((t) => (t.style.visibility === "hidden" ? "" : t.textContent)).join("|"));
  check(`Layers14 rail: hovering a tab names it in a tooltip with its shortcut`, /Assets/.test(tip) && /⌥2/.test(tip), tip);
  await crop("layers14-rail", { x: 0, y: 0, width: Math.round(rail.width) + 1, height: 360 });
  await away();
  await page.waitForTimeout(300);

  // ---- 1. The name's fade, at the highlight's edge or before the cells showing. -------------------------------------
  {
    const flat = await page.evaluate(() => document.querySelectorAll('[data-layer-list] [data-scrollbar="x"]').length);
    check(`Layers14 scroll: nothing open (every row top-level), the list doesn't scroll sideways`, flat === 0, String(flat));
    const plain = await nameInk(page, "9:1", (await rowBoxes(page, "9:1")).box.right);
    const fadeEnd = plain.b.box.right;
    check(`Layers14 fade: a long name runs to the highlight's right edge and fades there (ink ends within 12 + 4 of it; no fixed cut, no …)`, plain.ink !== null && plain.ink <= fadeEnd && plain.ink >= fadeEnd - 16, `ink ${plain.ink} edge ${fadeEnd}`);
    const text = await page.evaluate(() => getComputedStyle(document.querySelector('[data-id="9:1"] [data-layer-name]')).textOverflow);
    check(`Layers14 fade: no ellipsis (text-overflow clip, a mask fades it)`, text === "clip", text);

    await page.locator('[data-ds="LayerRow"][data-id="9:1"]').hover({ position: { x: 60, y: 16 } });
    await settle(page);
    const hovered = await nameInk(page, "9:1", (await rowBoxes(page, "9:1")).lock.left + 2);
    check(`Layers14 fade: hovered, the cut moves left of the lock and eye (ink ends within 16 before the lock)`, hovered.ink !== null && hovered.ink < hovered.b.lock.left && hovered.ink >= hovered.b.lock.left - 18, `ink ${hovered.ink} lock ${hovered.b.lock.left}`);
    await crop("layers14-fade-hover");
    await away();

    const locked = await nameInk(page, "9:2", (await rowBoxes(page, "9:2")).lock.left + 2);
    check(`Layers14 fade: a locked layer (lock kept on) cuts before the lock`, locked.ink !== null && locked.ink < locked.b.lock.left && locked.ink >= locked.b.lock.left - 18, `ink ${locked.ink} lock ${locked.b.lock.left}`);
    const hidden = await nameInk(page, "9:3", (await rowBoxes(page, "9:3")).eye.left + 2);
    check(`Layers14 fade: a hidden layer (closed eye kept on) cuts before the eye only`, hidden.ink !== null && hidden.ink < hidden.b.eye.left && hidden.ink >= hidden.b.eye.left - 18, `ink ${hidden.ink} eye ${hidden.b.eye.left}`);

    await page.evaluate(() => window.__designerEditor.engine.setSelection(["9:1"]));
    await away();
    await settle(page);
    const sel = await nameInk(page, "9:1", (await rowBoxes(page, "9:1")).box.right);
    check(`Layers14 fade: selected, the name fades into the blue the same way`, sel.ink !== null && sel.ink <= sel.b.box.right && sel.ink >= sel.b.box.right - 16, `ink ${sel.ink} edge ${sel.b.box.right}`);
    await crop("layers14-fade");
  }

  // ---- 2. Every row 32, the content on one line in every state. ----------------------------------------------------
  {
    const measure = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-layer-list] [data-ds="LayerRow"]')].map((row) => {
          const r = row.getBoundingClientRect();
          const n = row.querySelector("[data-layer-name]").getBoundingClientRect();
          const box = row.firstElementChild.getBoundingClientRect();
          return { id: row.dataset.id, top: r.top, height: r.height, name: +(n.top + n.height / 2 - r.top).toFixed(2), box: +(box.top - r.top).toFixed(2), boxH: box.height, run: row.dataset.run ?? "", sel: row.getAttribute("aria-selected"), exp: row.getAttribute("aria-expanded") };
        })
      );
    // Frame 20 selected and collapsed, then expanded (its row starts the selection's block).
    await page.evaluate(() => window.__designerEditor.engine.setSelection(["9:20"]));
    await settle(page);
    const before = (await measure()).find((r) => r.id === "9:20");
    await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set(["9:20", "9:21", "9:22"]) }));
    await settle(page);
    const after = (await measure()).find((r) => r.id === "9:20");
    check(`Layers14 rows: expanding a selected layer leaves its row as it was (32 high, its name on the same line)`, before && after && before.height === 32 && after.height === 32 && before.name === after.name && before.top === after.top, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    // Every state at once: hovered, selected (start / middle / end of a block), collapsed, expanded, leaves.
    await page.locator('[data-ds="LayerRow"][data-id="9:4"]').hover({ position: { x: 60, y: 16 } });
    await settle(page);
    const all = await measure();
    const runs = new Set(all.map((r) => r.run));
    const pitch = all.slice(1).every((r, i) => Math.abs(r.top - all[i].top - 32) < 0.01);
    check(
      `Layers14 rows: every row 32 apart and 32 high, its name's middle and its highlight's box at the same offset — collapsed, expanded, hovered, selected, inside the selection (${[...runs].filter(Boolean).join(" / ")})`,
      pitch && all.every((r) => r.height === 32 && r.name === all[0].name && r.box === all[0].box && r.boxH === all[0].boxH) && runs.has("start") && runs.has("middle") && runs.has("end"),
      JSON.stringify(all.map((r) => [r.id, r.height, r.name, r.box, r.run]))
    );
    // The block is one piece: the gap between two of its rows is the selection's colour, not the panel's.
    const gap = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-layer-list] [data-ds="LayerRow"][data-run]')];
      return rows.map((r) => {
        const s = getComputedStyle(r.firstElementChild, "::before");
        return [r.dataset.run, s.top, s.bottom, s.backgroundColor];
      });
    });
    check(`Layers14 rows: the selection's block reaches over the 4 between its rows (start: down, middle: both, end: up)`, gap.length >= 3 && gap.every(([run, top, bottom]) => (run === "start" ? top === "0px" && bottom === "-4px" : run === "middle" ? top === "-4px" && bottom === "-4px" : run === "end" ? top === "-4px" && bottom === "0px" : true)), JSON.stringify(gap));
    await crop("layers14-rows");
    await away();
  }

  // ---- 3. A deep tree scrolls sideways. -----------------------------------------------------------------------------
  {
    await page.evaluate((ids) => window.__designerEditor.ui.set({ expanded: new Set(ids) }), DEEP.map((d) => d.guid));
    await page.evaluate(() => window.__designerEditor.engine.setSelection(["9:20"]));
    await settle(page);
    const list = () =>
      page.evaluate(() => {
        const v = document.querySelector('[data-layer-list] [data-ds="VirtualList"]').parentElement;
        const vb = v.getBoundingClientRect();
        return { scrollLeft: v.scrollLeft, scrollWidth: v.scrollWidth, clientWidth: v.clientWidth, left: vb.left, right: vb.left + v.clientWidth };
      });
    const l0 = await list();
    check(`Layers14 scroll: eleven levels open, the rows are the list's width plus 11 × 24 and it scrolls sideways`, l0.scrollWidth === l0.clientWidth + 11 * 24, JSON.stringify(l0));
    const deepRow = await rowBoxes(page, "9:31");
    check(`Layers14 scroll: the highlight spans the rows' width (8 in from either end of the scrolled content)`, Math.round(deepRow.box.width) === l0.scrollWidth - 16, `${deepRow.box.width} vs ${l0.scrollWidth}`);
    await crop("layers14-deep-scrolled-0");
    // Hovering the deepest row at scroll 0: lock and eye at the list's visible right edge, the sideways scrollbar shown.
    await page.locator('[data-ds="LayerRow"][data-id="9:31"]').hover({ position: { x: 60, y: 16 } });
    await settle(page);
    const hov = await rowBoxes(page, "9:31");
    const bar = await page.evaluate(() => {
      const t = document.querySelector('[data-layer-list] [data-scrollbar="x"][data-visible]');
      const s = document.querySelector('[data-layer-list] [data-ds="ScrollArea"]');
      if (!t || !s) return null;
      const a = t.getBoundingClientRect();
      const b = s.getBoundingClientRect();
      const thumb = t.firstElementChild.getBoundingClientRect();
      return { bottom: Math.round(b.bottom - a.bottom), width: Math.round(thumb.width), track: Math.round(a.width) };
    });
    check(`Layers14 scroll: a sideways scrollbar at the list's bottom while the pointer is over it (thumb shorter than its track)`, !!bar && bar.bottom === 0 && bar.width < bar.track, JSON.stringify(bar));
    check(`Layers14 scroll: lock and eye stay at the visible right edge (eye flush 8 from it, lock 24 before)`, Math.round(hov.eye.right) === Math.round(l0.right - 8) && Math.round(hov.lock.right) === Math.round(hov.eye.left), `eye ${hov.eye.right} lock ${hov.lock.right} edge ${l0.right}`);
    await away();
    // How much of a level's name shows (ink from the name's start, in the visible part of the list).
    const shownName = async (guid) => {
      const l = await list();
      const b = await rowBoxes(page, guid);
      const left = Math.max(b.name.left, l.left);
      const width = Math.round(l.right - 8 - left);
      const ink = width > 4 && b.name.left >= l.left - 1 ? await inkRight(page, { x: Math.round(left), y: Math.round(b.box.top) + 2, width, height: Math.round(b.box.height) - 4 }) : null;
      return ink === null ? 0 : Math.round(ink - b.name.left);
    };
    const scrollTo = async (x) => {
      await page.evaluate((x) => {
        document.querySelector('[data-layer-list] [data-ds="VirtualList"]').parentElement.scrollLeft = x;
      }, x);
      await settle(page);
    };
    const deepAt0 = await shownName("9:31");
    // Scrolled by a level's indent, that level's name has a top-level row's room: every one shows whole.
    const shown = [];
    for (const d of DEEP) {
      await scrollTo(d.depth * 24);
      shown.push([d.name, await shownName(d.guid)]);
    }
    await scrollTo(10000);
    const l1 = await list();
    check(
      `Layers14 scroll: scrolled sideways by its indent, every level's name shows whole (Frame 20 … Frame 9: ≥ 30 px of ink from its start; at 0 "Frame 9" is out of view; the end is 11 × 24)`,
      l1.scrollLeft === 11 * 24 && shown.every(([, w]) => w >= 30) && deepAt0 < 30,
      `end ${l1.scrollLeft} at0 ${deepAt0} ${JSON.stringify(shown)}`
    );
    await page.locator('[data-ds="LayerRow"][data-id="9:31"]').hover({ position: { x: 300, y: 16 } });
    await crop("layers14-deep-scrolled-end");
    const hov2 = await rowBoxes(page, "9:31");
    check(`Layers14 scroll: scrolled, lock and eye still at the visible right edge`, Math.round(hov2.eye.right) === Math.round(l1.right - 8), `eye ${hov2.eye.right} edge ${l1.right}`);
    await away();
    // Scrolled back to 0, the deepest layer selected (as from the canvas): the list scrolls so its name shows.
    await page.evaluate(() => {
      const v = document.querySelector('[data-layer-list] [data-ds="VirtualList"]').parentElement;
      v.scrollLeft = 0;
    });
    await settle(page);
    await page.evaluate(() => window.__designerEditor.engine.setSelection(["9:31"]));
    await settle(page);
    await settle(page);
    const l2 = await list();
    const b = await rowBoxes(page, "9:31");
    const ink = await inkRight(page, { x: Math.round(Math.max(b.name.left, l2.left)), y: Math.round(b.box.top) + 2, width: Math.round(l2.right - 8 - Math.max(b.name.left, l2.left)), height: Math.round(b.box.height) - 4 });
    check(`Layers14 scroll: selecting the deepest layer scrolls the list sideways to its name ("Frame 9" shows)`, l2.scrollLeft === 11 * 24 && ink !== null && ink - b.name.left >= 30, `scrollLeft ${l2.scrollLeft} ink ${ink} name ${b.name.left}`);
    await crop("layers14-deep-revealed");
  }
}
