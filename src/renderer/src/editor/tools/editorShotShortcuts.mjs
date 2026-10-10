// editor-shot's Keyboard shortcuts section (EDITOR_ONLY=shortcuts): Figma's bottom panel, as the owner's screenshots of
// live Figma show it (docs/research/shortcuts-panel/), and the owner's own keys.
//
// 1. ⌃⇧? and the main menu's Help and account ▸ Keyboard shortcuts open it (the "?" too); ⌃⇧? and ✕ close it. Docked
//    along the bottom, the full width, 240 high: the panels end over it, the bottom toolbar sits 12 over it, "?" is
//    hidden, the canvas keeps its size.
// 2. Every tab shows its rows with key caps (Essential its three numbered ones, Layout the keyboard).
// 3. A shortcut used lights its row (⇧R → Rulers).
// 4. A row's caps record new keys: Group selection becomes ⌥⇧⌘J and groups on the canvas (⌘G doesn't); a key another
//    command has asks first (Rulers ← ⇧G: "already used for Layout guides", Replace); Esc cancels, ⌫ clears; Reset to
//    default and Reset all bring Figma's keys back.
// 5. Layout: German QWERTZ relabels the drawn keyboard (Z where the U.S. Y is).
/* global window, document */

const RED = { r: 1, g: 0, b: 0, a: 1 };

function frames() {
  const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const frame = (guid, pos, name, x) => ({ guid, phase: "CREATED", type: "FRAME", name, parentIndex: { guid: "0:1", position: pos }, size: { x: 200, y: 150 }, transform: at(x, 0), fillPaints: [{ type: "SOLID", color: RED, opacity: 1, visible: true, blendMode: "NORMAL" }] });
  return [frame("8:1", "!", "One", 0), frame("8:2", '"', "Two", 300)];
}

const box = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
}, sel);

export async function shortcutsSection(page, theme, { open, settle, shot, check }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 300, y: 200, zoom: 1 });
  }, frames());
  await settle(page);
  const panel = page.locator("[data-shortcuts-panel]");
  const canvasBefore = await box(page, "#engine-canvas");

  // 1. ⌃⇧? opens it, docked along the bottom.
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Control+Shift+Slash");
  await settle(page);
  check(`Shortcuts (${theme}): ⌃⇧? opens the Keyboard shortcuts panel on Essential`, (await panel.count()) === 1 && (await panel.getByRole("tab", { name: "Essential" }).getAttribute("aria-selected")) === "true");
  const p = await box(page, "[data-shortcuts-panel]");
  const vp = page.viewportSize();
  check(`Shortcuts (${theme}): docked along the bottom, the full width, 240 high`, p.x === 0 && p.w === vp.width && p.h === 240 && p.bottom === vp.height, JSON.stringify(p));
  const toolbar = await box(page, '[data-ds="EditorToolbar"]');
  check(`Shortcuts (${theme}): the bottom toolbar sits 12 over it (live)`, toolbar && p.y - toolbar.bottom === 12, JSON.stringify(toolbar));
  const left = await box(page, '[data-panel="left"]');
  const right = await box(page, '[data-panel="right"]');
  check(`Shortcuts (${theme}): the left and right panels end over it`, left?.bottom === p.y && right?.bottom === p.y, `${left?.bottom} ${right?.bottom} ${p.y}`);
  check(`Shortcuts (${theme}): the canvas keeps its size (the panel lies over it)`, JSON.stringify(await box(page, "#engine-canvas")) === JSON.stringify(canvasBefore));
  check(`Shortcuts (${theme}): the "?" is hidden while it is open`, (await page.locator('[data-ds="HelpButton"]').count()) === 0);
  check(`Shortcuts (${theme}): Essential — the heading and the three numbered ones`, (await panel.getByText("Essential keyboard shortcuts").count()) === 1 && (await panel.locator("[data-shortcut-row]").count()) === 3 && (await panel.getByText("Component search").count()) === 1);
  await shot(page, `400-shortcuts-essential-${theme}`);

  // 2. Every tab: rows, each with caps.
  const tabs = ["Tools", "View", "Zoom", "Text", "Shape", "Selection", "Cursor", "Edit", "Transform", "Arrange", "Components"];
  for (const name of tabs) {
    await panel.getByRole("tab", { name, exact: true }).click();
    await settle(page);
    const rows = await panel.locator("[data-shortcut-row]").evaluateAll((els) => els.map((e) => e.querySelectorAll('[data-ds="KeyCap"]').length));
    check(`Shortcuts (${theme}): ${name} — ${rows.length} rows, each with its key caps`, rows.length >= 3 && rows.every((n) => n > 0), JSON.stringify(rows));
    if (theme === "dark" && ["Tools", "Text", "Selection", "Arrange"].includes(name)) await shot(page, `401-shortcuts-${name.toLowerCase()}-${theme}`);
  }
  await panel.getByRole("tab", { name: "Layout", exact: true }).click();
  await settle(page);
  check(`Shortcuts (${theme}): Layout — "Keyboard layout:" Generic and the keyboard drawn`, (await panel.getByText("Keyboard layout:").count()) === 1 && (await panel.locator('[data-keyboard="generic"] [data-ds="KeyCap"]').count()) === 59);
  await shot(page, `402-shortcuts-layout-${theme}`);

  // 3. A shortcut used is lit: ⇧R (Rulers), twice.
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Shift+KeyR");
  await page.keyboard.press("Shift+KeyR");
  await panel.getByRole("tab", { name: "View", exact: true }).click();
  await settle(page);
  check(`Shortcuts (${theme}): ⇧R used lights Rulers (Pixel grid not)`, (await panel.locator('[data-shortcut-row="view.rulers"][data-lit]').count()) === 1 && (await panel.locator('[data-shortcut-row="view.pixel-grid"][data-lit]').count()) === 0);
  await shot(page, `403-shortcuts-used-${theme}`);

  // 4. New keys for Group selection: ⌥⇧⌘J, then it groups on the canvas; ⌘G doesn't.
  await panel.getByRole("tab", { name: "Selection", exact: true }).click();
  await settle(page);
  await panel.locator('[data-shortcut-caps="object.group"]').click();
  await settle(page);
  check(`Shortcuts (${theme}): a click on Group selection's caps records ("Press keys…")`, (await panel.locator("[data-shortcut-recording]").getByText("Press keys…").count()) === 1);
  await shot(page, `404-shortcuts-recording-${theme}`);
  await page.keyboard.press("Meta+Alt+Shift+KeyJ");
  await settle(page);
  const groupCaps = await panel.locator('[data-shortcut-caps="object.group"]').innerText();
  check(`Shortcuts (${theme}): Group selection now shows ⌥ ⇧ ⌘ J, with Reset to default and Reset all`, /⌥\s*⇧\s*⌘\s*J/.test(groupCaps) && (await panel.locator('[data-shortcut-reset="object.group"]').count()) === 1 && (await panel.locator("[data-shortcut-reset-all]").count()) === 1, JSON.stringify(groupCaps));
  const select = () => page.evaluate(() => window.__designerEditor.engine.setSelection(["8:1", "8:2"]));
  // A group is a FRAME (resized to fit) in Figma's schema: the frames have a new parent.
  const grouped = () => page.evaluate(() => window.__designerEditor.engine.readNode("8:1").parentIndex.guid !== "0:1");
  await select();
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Meta+KeyG");
  await settle(page);
  check(`Shortcuts (${theme}): ⌘G no longer groups`, (await page.evaluate(() => window.__designerEditor.selection.length)) === 2);
  await page.keyboard.press("Meta+Alt+Shift+KeyJ");
  await settle(page);
  check(`Shortcuts (${theme}): ⌥⇧⌘J groups the selection on the canvas`, await grouped());
  check(`Shortcuts (${theme}): …and lit Group selection (used)`, (await panel.locator('[data-shortcut-row="object.group"][data-lit]').count()) === 1);
  await page.keyboard.press("Meta+KeyZ");
  await settle(page);

  // Esc cancels recording; the keys stay.
  await panel.locator('[data-shortcut-caps="object.group"]').click();
  await page.keyboard.press("Escape");
  await settle(page);
  check(`Shortcuts (${theme}): Esc cancels recording`, (await panel.locator("[data-shortcut-recording]").count()) === 0 && /J/.test(await panel.locator('[data-shortcut-caps="object.group"]').innerText()));

  // A key another command has: Rulers ← ⇧G asks (Layout guides), Replace.
  await panel.getByRole("tab", { name: "View", exact: true }).click();
  await settle(page);
  await panel.locator('[data-shortcut-caps="view.rulers"]').click();
  await page.keyboard.press("Shift+KeyG");
  await settle(page);
  const conflict = page.getByRole("dialog", { name: "Shortcut already in use" });
  check(`Shortcuts (${theme}): ⇧G for Rulers asks first, naming Layout guides`, (await conflict.count()) === 1 && /already used for Layout guides/.test(await conflict.innerText()));
  await shot(page, `405-shortcuts-conflict-${theme}`);
  await conflict.locator("[data-shortcut-replace]").click();
  await settle(page);
  check(`Shortcuts (${theme}): Replace — Rulers ⇧ G, Layout guides none`, /⇧\s*G/.test(await panel.locator('[data-shortcut-caps="view.rulers"]').innerText()) && /None/.test(await panel.locator('[data-shortcut-caps="view.layout-guides"]').innerText()));
  const rulers = () => page.evaluate(() => !!window.__designerEditor.ui.get().rulers);
  const before = await rulers();
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Shift+KeyG");
  await settle(page);
  check(`Shortcuts (${theme}): ⇧G on the canvas now toggles the rulers`, (await rulers()) !== before);
  await page.keyboard.press("Shift+KeyG");

  // ⌫ clears a command's keys.
  await panel.locator('[data-shortcut-caps="view.pixel-grid"]').click();
  await page.keyboard.press("Backspace");
  await settle(page);
  check(`Shortcuts (${theme}): ⌫ while recording clears Pixel grid's keys`, /None/.test(await panel.locator('[data-shortcut-caps="view.pixel-grid"]').innerText()));

  // Reset to default (Rulers), then Reset all.
  await panel.locator('[data-shortcut-reset="view.rulers"]').click();
  await settle(page);
  check(`Shortcuts (${theme}): Reset to default — Rulers ⇧ R again`, /⇧\s*R/.test(await panel.locator('[data-shortcut-caps="view.rulers"]').innerText()));
  await panel.locator("[data-shortcut-reset-all]").click();
  await settle(page);
  check(
    `Shortcuts (${theme}): Reset all — Figma's keys everywhere (Layout guides ⇧ G, Pixel grid ⇧ ′), no reset left`,
    /⇧\s*G/.test(await panel.locator('[data-shortcut-caps="view.layout-guides"]').innerText()) && /⇧/.test(await panel.locator('[data-shortcut-caps="view.pixel-grid"]').innerText()) && (await panel.locator("[data-shortcut-reset-all], [data-shortcut-reset]").count()) === 0
  );
  await select();
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Meta+KeyG");
  await settle(page);
  check(`Shortcuts (${theme}): ⌘G groups again`, await grouped());
  await page.keyboard.press("Meta+KeyZ");

  // 5. Layout: German QWERTZ.
  await panel.getByRole("tab", { name: "Layout", exact: true }).click();
  await panel.getByRole("combobox", { name: "Keyboard layout" }).click();
  await page.getByRole("option", { name: "German QWERTZ" }).click();
  await settle(page);
  check(`Shortcuts (${theme}): German QWERTZ relabels the keyboard (Z at the U.S. Y, Ü at [)`, (await panel.locator('[data-keyboard="de"] [data-key="KeyY"]').innerText()) === "Z" && (await panel.locator('[data-keyboard="de"] [data-key="BracketLeft"]').innerText()) === "Ü");
  await shot(page, `406-shortcuts-layout-de-${theme}`);
  await panel.getByRole("combobox", { name: "Keyboard layout" }).click();
  await page.getByRole("option", { name: "Generic" }).click();
  await settle(page);

  // Closing: ✕, then the "?" and the main menu open it, ⌃⇧? closes it.
  await panel.getByRole("button", { name: "Close" }).click();
  await settle(page);
  check(`Shortcuts (${theme}): ✕ closes it; the "?" is back`, (await panel.count()) === 0 && (await page.locator('[data-ds="HelpButton"]').count()) === 1);
  await page.locator('[data-ds="HelpButton"]').click();
  await settle(page);
  check(`Shortcuts (${theme}): the "?" opens it`, (await panel.count()) === 1);
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Control+Shift+Slash");
  await settle(page);
  check(`Shortcuts (${theme}): ⌃⇧? closes it`, (await panel.count()) === 0);
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("menuitem", { name: /^Help and account/ }).hover();
  await page.getByRole("menuitem", { name: /^Keyboard shortcuts/ }).click();
  await settle(page);
  check(`Shortcuts (${theme}): the main menu's Help and account ▸ Keyboard shortcuts opens it`, (await panel.count()) === 1);
  await page.keyboard.press("Escape");
}
