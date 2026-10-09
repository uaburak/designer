// editor-shot's input section (EDITOR_ONLY=input): two owner reports, checked in the page.
//
// 1. Keys typed into a text field are the field's, never the canvas's shortcuts: N (Zoom to next frame), the tool
//    letters, [ ], ⇧V, ⇧1 / ⇧2, a digit (opacity)… typed into the Agents composer, a Design panel field, Find, a layer's
//    rename field and a `plaintext-only` contenteditable change nothing on the canvas — while the same keys on the
//    canvas still work. (The desktop app's own leak — macOS handing the menu bar the letters a field left unhandled — is
//    main's: src/shared/commands.ts runsFromMenuBar, unit-tested in commands.test.ts and fieldKeys.test.ts.)
// 2. The canvas spans the editor and the panels sit over it (Figma UI3): a panel drag never resizes, warps or moves it —
//    no viewport change, and every composited frame of a scripted drag (the page's screencast, one image per frame)
//    shows a known 400 × 300 red frame at 100 % at its exact size and place. A window resize does resize it, drawn in
//    the same frame: never stretched (WebGPU kept the old picture scaled to the new box) nor blank (WebGL2 painted the
//    cleared buffer). Zoom to selection centres between the panels. The bottom toolbar is centred on the window: a
//    panel drag neither moves it (its box on every animation frame), nor changes its DOM, nor its pixels in any frame.
/* global window, document, atob, Blob, createImageBitmap, OffscreenCanvas, MutationObserver, requestAnimationFrame */
import { installMockAgents } from "./editorShotAgents.mjs";

const RED = { r: 1, g: 0, b: 0, a: 1 };

/** Two frames side by side (N goes from one to the other) as NODE_CHANGES. */
function twoFrames() {
  const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const frame = (guid, pos, name, x) => ({ guid, phase: "CREATED", type: "FRAME", name, parentIndex: { guid: "0:1", position: pos }, size: { x: 400, y: 300 }, transform: at(x, 0), fillPaints: [{ type: "SOLID", color: RED, opacity: 1, visible: true, blendMode: "NORMAL" }] });
  return [frame("7:1", "!", "Red", 0), frame("7:2", '"', "Other", 1000)];
}

/** What a leaked shortcut would change. */
const snapshot = (page) =>
  page.evaluate(() => {
    const ed = window.__designerEditor;
    const n = ed.engine.readNode("7:1");
    return JSON.stringify({ camera: ed.engine.getCamera(), tool: ed.store.tool, selection: ed.selection, opacity: n.opacity ?? 1, position: n.parentIndex?.position, flip: n.transform?.m00, autoLayout: n.stackMode ?? "NONE" });
  });

// Tool letters (V Move, R Rectangle, T Text, F Frame, O Ellipse, L Line, P Pen, K Scale, H Hand), N / ⇧N frames, [ ]
// order, ⇧V / ⇧H flips, ⇧1 / ⇧2 zooms, 5 opacity, ⇧R rulers (Playwright types ⇧1 as "1"), ⇧A auto layout.
const KEYS = ["n", "N", "v", "r", "t", "f", "o", "l", "p", "k", "h", "[", "]", "Shift+V", "Shift+H", "Shift+1", "Shift+2", "5", "Shift+R", "Shift+A"];

export async function inputSection(page, theme, { open, settle, check }) {
  await page.addInitScript(installMockAgents);
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setSelection(["7:1"]);
    ed.engine.setCamera({ x: 200, y: 200, zoom: 1 });
  }, twoFrames());
  await settle(page);

  const typeInto = async (what, focus, expectText = true) => {
    await focus();
    await settle(page);
    const focused = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName.toLowerCase()}${a.isContentEditable ? "[contenteditable]" : ""}` : "none";
    });
    const before = await snapshot(page);
    for (const key of KEYS) await page.keyboard.press(key);
    await settle(page);
    const after = await snapshot(page);
    const text = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? ("value" in a ? a.value : a.textContent) : "";
    });
    check(`Input: keys typed into ${what} (${focused}) change nothing on the canvas — N, ⇧A, tool letters, [ ], ⇧V, ⇧1, 5…`, before === after, before === after ? "" : `${before} → ${after}`);
    if (expectText) check(`Input: …and ${what} got them as text`, text.includes("nNvrtfolpkh[]VH125RA"), JSON.stringify(text));
  };

  // The Agents composer.
  await page.locator('[data-rail-tab="agents"]').click();
  await page.waitForSelector("[data-composer] textarea");
  await typeInto("the Agents composer", () => page.locator("[data-composer] textarea").click());
  await page.locator("[data-composer] textarea").fill("");

  // A Design panel field (Width), left with Esc.
  await page.locator('[data-rail-tab="file"]').click();
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["7:1"]));
  await settle(page);
  const width = page.locator('[data-panel="right"]').getByRole("textbox", { name: "Width", exact: true });
  await typeInto("the Design panel's Width field", async () => {
    await width.click();
    await page.keyboard.press("Meta+a");
  }, false);
  await page.keyboard.press("Escape");
  await settle(page);
  check("Input: the Width field's Esc leaves the frame 400 wide", (await page.evaluate(() => window.__designerEditor.engine.readNode("7:1").size.x)) === 400);

  // Find (⌘F from the canvas), then closed.
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Meta+KeyF");
  await settle(page);
  await typeInto("Find", () => page.locator("[data-find-query] input").focus());
  await page.locator("[data-find-query] input").fill("");
  await page.keyboard.press("Escape");
  await settle(page);

  // A layer's rename field.
  await page.evaluate(() => window.__designerEditor.ui.set({ renaming: { kind: "layer", id: "7:1" } }));
  await settle(page);
  await typeInto("a layer's rename field", () => page.locator('[data-ds="LayerRow"] input').first().focus());
  await page.keyboard.press("Escape");
  await settle(page);
  check("Input: the layer keeps its name after Esc", (await page.evaluate(() => window.__designerEditor.engine.readNode("7:1").name)) === "Red");

  // A plaintext-only contenteditable (the kind the keyboard layer missed: only '' and 'true' were fields).
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "plaintext-only");
    el.id = "input-check-editable";
    Object.assign(el.style, { position: "fixed", left: "400px", top: "60px", width: "200px", height: "24px", zIndex: "9999", background: "white", color: "black" });
    document.body.appendChild(el);
  });
  await typeInto("a plaintext-only contenteditable", () => page.locator("#input-check-editable").focus());
  await page.evaluate(() => document.getElementById("input-check-editable")?.remove());

  // The same keys on the canvas still work.
  await page.evaluate(() => {
    window.__designerEditor.engine.setSelection(["7:1"]);
    window.__designerEditor.engine.setCamera({ x: 200, y: 200, zoom: 1 });
  });
  await page.locator("#engine-canvas").focus();
  const cam0 = await page.evaluate(() => JSON.stringify(window.__designerEditor.engine.getCamera()));
  await page.keyboard.press("n");
  await settle(page);
  const cam1 = await page.evaluate(() => JSON.stringify(window.__designerEditor.engine.getCamera()));
  check("Input: N on the canvas zooms to the next frame", cam0 !== cam1, `${cam0} → ${cam1}`);
  await page.keyboard.press("r");
  await settle(page);
  check("Input: R on the canvas picks the Rectangle tool", (await page.evaluate(() => window.__designerEditor.store.tool)) === "RECTANGLE");
  await page.keyboard.press("v");
  await settle(page);

  await panelResize(page, settle, check);
}

/**
 * The canvas spans the editor and the panels sit over it (Figma UI3): dragging a panel's edge resizes nothing of the
 * canvas — no viewport change reaches the engine, and every composited frame shows the red frame at its exact size and
 * place (no stretch, no blank, no shift). A window resize does resize the canvas: its frames are drawn in the same
 * frame as the layout (CanvasController.observeSize), so they too are never blank or stretched.
 */
async function panelResize(page, settle, check) {
  const gfx = await page.evaluate(() => window.__designerEditor.engine.gfx);
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    ed.engine.setSelection([]);
    ed.engine.setCamera({ x: 500, y: 200, zoom: 1 });
    // Every viewport change the engine gets.
    window.__viewports = 0;
    const set = ed.engine.setViewport.bind(ed.engine);
    ed.engine.setViewport = (...a) => {
      window.__viewports++;
      return set(...a);
    };
  });
  await page.mouse.move(700, 700);
  await settle(page);
  await page.waitForTimeout(200);
  const cdp = await page.context().newCDPSession(page);
  const capture = async (act) => {
    const frames = [];
    const onFrame = async (f) => {
      frames.push(f.data);
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await page.waitForTimeout(150);
    await act();
    await page.waitForTimeout(250);
    await cdp.send("Page.stopScreencast");
    cdp.off("Page.screencastFrame", onFrame);
    return frames;
  };
  const measure = (frames) =>
    page.evaluate(async (frames) => {
      const out = [];
      for (const data of frames) {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
        g.drawImage(bmp, 0, 0);
        const { data: px, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
        let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (px[i] > 230 && px[i + 1] < 30 && px[i + 2] < 30) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        out.push(maxX < 0 ? "none" : `${maxX - minX + 1}x${maxY - minY + 1} at ${minX},${minY}`);
      }
      return out;
    }, frames);
  // The bottom toolbar's pixels in each frame (a hash of its box, a little wider for the shadow): it is placed on the
  // window alone, so a panel drag must neither move nor repaint it.
  const toolbarHashes = (frames, box) =>
    page.evaluate(
      async ({ frames, box }) => {
        const out = [];
        for (const data of frames) {
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
          const k = bmp.width / window.innerWidth;
          const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
          g.drawImage(bmp, 0, 0);
          const x = Math.max(0, Math.floor((box.x - 12) * k));
          const y = Math.max(0, Math.floor((box.y - 12) * k));
          const w = Math.min(bmp.width - x, Math.ceil((box.width + 24) * k));
          const h = Math.min(bmp.height - y, Math.ceil((box.height + 24) * k));
          const px = g.getImageData(x, y, w, h).data;
          let hash = 2166136261;
          for (let i = 0; i < px.length; i++) hash = Math.imul(hash ^ px[i], 16777619) >>> 0;
          out.push(hash.toString(16));
        }
        return out;
      },
      { frames, box }
    );
  const toolbarSel = '[data-ds="EditorToolbar"]';
  const want = "400x300 at 500,200";
  for (const side of ["right", "left"]) {
    const before = await page.evaluate(() => ({ n: window.__viewports, w: document.getElementById("engine-canvas").width, h: document.getElementById("engine-canvas").height }));
    const toolbarBox = await page.locator(toolbarSel).first().boundingBox();
    // The toolbar's box on every animation frame of the drag, and every change made to its DOM.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      window.__toolbarBoxes = new Set();
      window.__toolbarWatch = true;
      window.__toolbarMutations = 0;
      window.__toolbarObserver = new MutationObserver((m) => (window.__toolbarMutations += m.length));
      window.__toolbarObserver.observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
      const tick = () => {
        if (!window.__toolbarWatch) return;
        const r = el.getBoundingClientRect();
        window.__toolbarBoxes.add(`${r.left},${r.top},${r.width},${r.height}`);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, toolbarSel);
    const frames = await capture(async () => {
      const handle = page.locator(`[data-panel="${side}"] [data-ds="ResizeHandle"][aria-orientation="horizontal"]`).first();
      const b = await handle.boundingBox();
      const x0 = b.x + b.width / 2;
      const y0 = b.y + Math.min(300, b.height / 2);
      const dir = side === "right" ? -1 : 1;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1, 0]) {
        await page.mouse.move(x0 + dir * i * 15, y0);
        await page.waitForTimeout(50);
      }
      await page.mouse.up();
    });
    const after = await page.evaluate(() => ({ n: window.__viewports, w: document.getElementById("engine-canvas").width, h: document.getElementById("engine-canvas").height }));
    check(`Input: dragging the ${side} panel's edge never resizes the canvas (no viewport change, the same ${before.w} × ${before.h} buffer)`, after.n === before.n && after.w === before.w && after.h === before.h, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    const sizes = await measure(frames);
    const bad = sizes.filter((s) => s !== want);
    check(`Input: dragging the ${side} panel's edge (${gfx}) — every composited frame shows the 400 × 300 frame at 400 × 300, in place (no stretch, no blank, no shift)`, frames.length >= 10 && bad.length === 0, `${frames.length} frames; ${bad.length ? `off: ${[...new Set(bad)].join(" | ")}` : `all ${want}`}`);
    const { boxes, mutations } = await page.evaluate(() => {
      window.__toolbarWatch = false;
      window.__toolbarObserver.disconnect();
      return { boxes: [...window.__toolbarBoxes], mutations: window.__toolbarMutations };
    });
    check(`Input: dragging the ${side} panel's edge never moves or touches the bottom toolbar (one box on every animation frame, no DOM change)`, boxes.length === 1 && mutations === 0, `${boxes.join(" | ")}; ${mutations} mutations`);
    const hashes = new Set(await toolbarHashes(frames, toolbarBox));
    check(`Input: dragging the ${side} panel's edge (${gfx}) — the bottom toolbar's pixels are the same in every composited frame`, frames.length >= 10 && hashes.size === 1, `${frames.length} frames, ${hashes.size} distinct`);
  }
  const centre = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { toolbar: r.left + r.width / 2, window: window.innerWidth / 2, bottom: window.innerHeight - r.bottom };
  }, toolbarSel);
  check("Input: the bottom toolbar is centred on the window, 12 over its bottom", Math.abs(centre.toolbar - centre.window) <= 0.5 && centre.bottom === 12, JSON.stringify(centre));
  // A window resize: the canvas follows, drawn in the same frame. (The editor's own box narrowed step by step stands in
  // for the window: an emulated viewport change rescales the whole screencast image, not just the canvas.)
  const frames = await capture(async () => {
    for (const right of [40, 80, 120, 80, 40, 0]) {
      await page.evaluate((r) => (document.querySelector("[data-editor]").style.right = `${r}px`), right);
      await page.waitForTimeout(80);
    }
  });
  await page.evaluate(() => document.querySelector("[data-editor]").style.removeProperty("right"));
  const sizes = await measure(frames);
  const bad = sizes.filter((s) => s !== want);
  check(`Input: resizing the window (${gfx}) — the canvas follows and every frame shows the 400 × 300 frame in place (no stretch, no blank)`, frames.length >= 4 && bad.length === 0, `${frames.length} frames; ${bad.length ? `off: ${[...new Set(bad)].join(" | ")}` : `all ${want}`}`);
  // Zoom to selection centres in the part between the panels.
  const centred = await page.evaluate(() => {
    const ed = window.__designerEditor;
    ed.engine.setSelection(["7:1"]);
    ed.engine.command("ZOOM_TO_SELECTION");
    const cam = ed.engine.getCamera();
    const c = ed.canvas.getBoundingClientRect();
    const v = document.querySelector("[data-canvas-view]").getBoundingClientRect();
    return { frame: c.left + cam.x + 200 * cam.zoom, view: v.left + v.width / 2, canvasMid: c.left + c.width / 2 };
  });
  check("Input: zoom to selection centres the frame between the panels, not on the window", Math.abs(centred.frame - centred.view) <= 1 && Math.abs(centred.view - centred.canvasMid) > 10, JSON.stringify(centred));
  await cdp.detach();
}
