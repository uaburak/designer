// editor-shot's Layers polish section (EDITOR_ONLY=layers14, round 14): four owner reports, measured in the page.
//
// 1. A layer's name uses the room to the highlight's right edge and fades out there (a mask, no "…"); hovered, or
//    with a lock / closed eye kept on, the cut moves left by the cells' width — on plain, hovered and selected rows.
// 2. Every row is 32 with its name on the same line in every state (collapsed, expanded, hovered, selected, inside a
//    selected layer — the start, middle and end of the selection's block): expanding a selected layer no longer
//    moves its row's content 2 down (the block used to be made of the rows' margins).
// 3. A deep tree scrolls sideways: the highlight spans the rows, lock and eye stay at the visible right edge, every
//    name shows when scrolled, and a selection revealed in the list scrolls it so its name shows.
// 4. The navigation bar's tabs are icons only (tooltips name them), View › Additional labels being off by default.
// 5. (The owner's second report, with Figma's list scrolled to its end: docs/research/layers-polish/39.png.) The list
//    is as wide as its widest row's full extent — indent, glyph, whole name, then lock and eye: no sideways scroll
//    while every name fits; one long name makes it scroll exactly so far that, at the end, the name shows whole with
//    the lock and eye after it. The vertical scrollbar overlays the rows: when the list starts to overflow, no row,
//    name or fade moves.
//
// Crops of the left side go to the run's folder (docs/research/layers-polish/ for the committed ones).
/* global window, document, atob, Blob, createImageBitmap, OffscreenCanvas, getComputedStyle */
import path from "node:path";

const LONG = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaassdddddddddddddddddddddddddddddddd end";
const MANY = 40;
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
  // "Many": forty children — opened, the list overflows (the vertical scrollbar appears).
  out.push(frame("9:50", "0:1", "&", "Many", 800, 300, 400));
  for (let i = 0; i < MANY; i++) out.push(frame(`9:${100 + i}`, "9:50", String.fromCharCode(33 + i), `Child ${i + 1}`, (i % 8) * 48, Math.floor(i / 8) * 48, 40));
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

/** The list's viewport: scroll, sizes, visible edges (page px), the fade's cut it sets. */
const listOf = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('[data-layer-list] [data-ds="VirtualList"]').parentElement;
    const vb = v.getBoundingClientRect();
    return { scrollLeft: v.scrollLeft, scrollWidth: v.scrollWidth, clientWidth: v.clientWidth, scrollHeight: v.scrollHeight, clientHeight: v.clientHeight, left: vb.left, right: vb.left + v.clientWidth, clip: v.style.getPropertyValue("--layer-clip-right") };
  });

/**
 * Each drawn row's full extent in the list's content (px from its left): where its name starts, the name's text width
 * (a DOM Range over the text, not the span), then 24 to the lock, lock and eye, 8 — Figma's rule (39.png).
 */
const extents = (page) =>
  page.evaluate(() => {
    const list = document.querySelector('[data-layer-list] [data-ds="VirtualList"]');
    const left = list.getBoundingClientRect().left;
    return [...list.querySelectorAll('[data-ds="LayerRow"]')].map((row) => {
      const name = row.querySelector("[data-layer-name]");
      const range = document.createRange();
      range.selectNodeContents(name);
      const text = range.getBoundingClientRect().width;
      const start = name.getBoundingClientRect().left - left;
      return { id: row.dataset.id, start, text, extent: start + text + 24 + 48 + 8 };
    });
  });

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
    // The long names make the list wider than the panel: at rest a name fades at the list's visible right edge.
    const l = await listOf(page);
    const edge = (b) => Math.min(b.box.right, l.right - 8);
    const plain = await nameInk(page, "9:1", edge(await rowBoxes(page, "9:1")));
    check(`Layers14 fade: a long name runs to the visible right edge (the highlight's, 8 in) and fades there (ink ends within 12 + 4 of it; no fixed cut, no …)`, plain.ink !== null && plain.ink <= edge(plain.b) && plain.ink >= edge(plain.b) - 16, `ink ${plain.ink} edge ${edge(plain.b)}`);
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
    const sel = await nameInk(page, "9:1", edge(await rowBoxes(page, "9:1")));
    check(`Layers14 fade: selected, the name fades into the blue the same way`, sel.ink !== null && sel.ink <= edge(sel.b) && sel.ink >= edge(sel.b) - 16, `ink ${sel.ink} edge ${edge(sel.b)}`);
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
    const list = () => listOf(page);
    const l0 = await list();
    const widest = Math.ceil(Math.max(...(await extents(page)).map((e) => e.extent)));
    check(`Layers14 scroll: eleven levels open, the rows are as wide as the widest row's full extent (name + lock and eye) and the list scrolls sideways`, Math.abs(l0.scrollWidth - widest) <= 1 && l0.scrollWidth > l0.clientWidth, `${JSON.stringify(l0)} widest ${widest}`);
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
      `Layers14 scroll: scrolled sideways by its indent, every level's name shows whole (Frame 20 … Frame 9: ≥ 30 px of ink from its start; at 0 "Frame 9" is out of view; the end is the rows' width less the list's)`,
      l1.scrollLeft === l1.scrollWidth - l1.clientWidth && shown.every(([, w]) => w >= 30) && deepAt0 < 30,
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

  // ---- 5. The list's width is its content's (Figma, 39.png); the vertical scrollbar moves nothing. ------------------
  {
    const LONGS = ["9:1", "9:2", "9:3"];
    const rename = (ids, name) => page.evaluate(({ ids, name }) => window.__designerEditor.engine.setProps(ids, { name }), { ids, name });
    const scrollTo = async (x) => {
      await page.evaluate((x) => {
        document.querySelector('[data-layer-list] [data-ds="VirtualList"]').parentElement.scrollLeft = x;
      }, x);
      await settle(page);
    };
    const xBar = () => page.evaluate(() => document.querySelectorAll('[data-layer-list] [data-scrollbar="x"]').length);
    await page.evaluate(() => {
      window.__designerEditor.engine.setSelection([]);
      window.__designerEditor.ui.set({ expanded: new Set() });
    });
    await rename(LONGS, "Frame with a name");
    await scrollTo(0);
    await away();
    await settle(page);
    // (a) Every name fits: no sideways scroll — top-level rows, and with two levels open.
    const fit0 = await listOf(page);
    await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set(["9:20", "9:21"]) }));
    await settle(page);
    const fit2 = await listOf(page);
    const bars = await xBar();
    check(`Layers14 width: every name fits — the list doesn't scroll sideways (top-level rows, and two levels open; no sideways scrollbar)`, fit0.scrollWidth === fit0.clientWidth && fit2.scrollWidth === fit2.clientWidth && bars === 0, `${JSON.stringify(fit0)} ${JSON.stringify(fit2)} bars ${bars}`);
    await crop("layers14-width-fits");

    // (b) One long name: the list scrolls exactly to that row's full extent; at the end its whole name shows, then lock and eye.
    await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set() }));
    await rename(["9:1"], LONG);
    await settle(page);
    await settle(page);
    const l = await listOf(page);
    const ext = await extents(page);
    const long = ext.find((e) => e.id === "9:1");
    const widest = Math.ceil(Math.max(...ext.map((e) => e.extent)));
    check(`Layers14 width: one long name — the list is as wide as that row (its indent, glyph, whole name, 24, lock and eye, 8): ${Math.round(long.extent)}`, Math.abs(l.scrollWidth - Math.ceil(long.extent)) <= 1 && widest === Math.ceil(long.extent), `scrollWidth ${l.scrollWidth} extent ${long.extent} widest ${widest}`);
    // At rest (not scrolled), the name fades at the visible edge, the cut 8 in.
    const rest = await nameInk(page, "9:1", l.right - 8);
    check(`Layers14 width: not scrolled, the long name fades at the list's visible edge`, rest.ink !== null && rest.ink <= l.right - 8 && rest.ink >= l.right - 8 - 16 && parseFloat(l.clip) === l.scrollWidth - l.clientWidth, `ink ${rest.ink} edge ${l.right - 8} clip ${l.clip}`);
    await scrollTo(100000);
    const end = await listOf(page);
    await page.locator('[data-ds="LayerRow"][data-id="9:1"]').hover({ position: { x: Math.round(end.scrollLeft + 100), y: 16 } });
    await settle(page);
    const hb = await rowBoxes(page, "9:1");
    const whole = { ink: await inkRight(page, { x: Math.round(end.left), y: Math.round(hb.box.top) + 2, width: Math.round(hb.lock.left - end.left), height: Math.round(hb.box.height) - 4 }) };
    const textEnd = hb.name.left + long.text;
    check(
      `Layers14 width: scrolled to the end and hovered, the whole name shows (its ink ends at its text's end), then the lock and eye, not over it (≥ 12 between) — as in Figma's 39.png`,
      end.scrollLeft === end.scrollWidth - end.clientWidth && whole.ink !== null && Math.abs(whole.ink - textEnd) <= 2 && whole.ink <= hb.lock.left - 12 && Math.round(hb.eye.right) === Math.round(end.right - 8) && Math.round(hb.lock.right) === Math.round(hb.eye.left) && parseFloat(end.clip) === 0,
      `ink ${whole.ink} text end ${textEnd} lock ${hb.lock.left} eye ${hb.eye.right} edge ${end.right} clip ${end.clip}`
    );
    const hl = await page.evaluate(() => {
      const row = document.querySelector('[data-ds="LayerRow"][data-id="9:1"]');
      const list = document.querySelector('[data-layer-list] [data-ds="VirtualList"]');
      const b = row.firstElementChild.getBoundingClientRect();
      const c = list.getBoundingClientRect();
      return { left: b.left - c.left, right: c.right - b.right, width: c.width };
    });
    check(`Layers14 width: the highlight spans the whole scroll width (8 in from either end)`, Math.round(hl.left) === 8 && Math.round(hl.right) === 8 && Math.round(hl.width) === end.scrollWidth, JSON.stringify(hl));
    // Clicked there (selected, as in 39.png), the list stays scrolled: only a selection made elsewhere scrolls it to a name.
    await page.mouse.down();
    await page.mouse.up();
    await settle(page);
    await settle(page);
    const clicked = await listOf(page);
    const sel = await page.evaluate(() => document.querySelector('[data-ds="LayerRow"][data-id="9:1"]').getAttribute("aria-selected"));
    check(`Layers14 width: a row clicked in the list scrolled to its end is selected and the list stays where it is`, sel === "true" && clicked.scrollLeft === end.scrollLeft, `selected ${sel} scrollLeft ${end.scrollLeft} → ${clicked.scrollLeft}`);
    await crop("layers14-long-scrolled-end");
    await away();
    await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
    await scrollTo(0);

    // (c) The vertical scrollbar: opening "Many" (named long for this, so its name fades at the list's edge) overflows
    //     the list; its row, name, eye and fade don't move sideways, the list keeps its width.
    await rename(["9:50"], LONG);
    await settle(page);
    const snap = async () => {
      const lst = await listOf(page);
      const r = await rowBoxes(page, "9:50");
      const ink = await nameInk(page, "9:50", lst.right - 8);
      // The Layers header: a list overflowing its section once squeezed it 40 → 24 (the owner's "jump").
      const header = await page.evaluate(() => Math.round(document.querySelector("[data-layer-list]").previousElementSibling.getBoundingClientRect().height));
      return { header, clientWidth: lst.clientWidth, scrollWidth: lst.scrollWidth, clip: lst.clip, overflow: lst.scrollHeight > lst.clientHeight, row: [r.row.top, r.row.left, r.row.width, r.box.left, r.box.width], name: [r.name.left, r.name.width], eye: [r.eye.left, r.eye.right], fade: ink.ink };
    };
    const before = await snap();
    await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set(["9:50"]) }));
    await settle(page);
    await page.locator('[data-layer-list]').hover({ position: { x: 120, y: 200 } });
    await settle(page);
    await away();
    await settle(page);
    const after = await snap();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check(
      `Layers14 width: opening "Many" overflows the list (the vertical scrollbar appears) and nothing moves — the Layers header (40), the list's width, the row's, highlight's and name's boxes, the eye, the fade`,
      before.header === 40 && after.header === 40 && !before.overflow && after.overflow && before.clientWidth === after.clientWidth && before.scrollWidth === after.scrollWidth && before.clip === after.clip && same(before.row, after.row) && same(before.name, after.name) && same(before.eye, after.eye) && before.fade === after.fade,
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`
    );
    await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set() }));
    await settle(page);
    const back = await snap();
    check(`Layers14 width: closing it again (the scrollbar goes) moves nothing either`, !back.overflow && back.header === 40 && same(before.row, back.row) && same(before.name, back.name) && same(before.eye, back.eye) && before.fade === back.fade && before.clientWidth === back.clientWidth, `${JSON.stringify(back)}`);
    await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set(["9:50"]) }));
    await page.locator('[data-layer-list]').hover({ position: { x: 120, y: 200 } });
    await crop("layers14-vscroll");
    await away();
    await rename(LONGS.slice(1), LONG);
    await rename(["9:50"], "Many");
  }
}
