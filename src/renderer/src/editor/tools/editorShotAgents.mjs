// editor-shot's Agents section (EDITOR_ONLY=agents; docs/research/figma/R12-agents-mcp.md): the Agents tab and the
// right panel's MCP section in a browser, with a stand-in for main (`window.__designerAgents`, installed before the
// page loads) that plays an agent's turn — its text, its steps, and real tool calls run by the page on the engine —
// so the flagship flow is driven end to end: a desktop frame selected → "Make the mobile version of this" → a 390
// frame next to it, one undo step, Undo / Apply from the chat. Then an image turn held at each stage (gates the shots
// open): the Thinking… row, the image card and the canvas placeholder while the picture is made, the picture placed
// where the placeholder was; and Stop while one is made (the placeholder fades out). No real agent or model is involved.
// AGENTS_UX_DIR=<folder> also saves close-ups of the Thinking… row, the image card and the canvas placeholder there.
/* global window, document, setTimeout, process */
import { mkdirSync } from "node:fs";
import path from "node:path";

/** The stand-in for main's side (src/shared/agents/types.ts AgentsApi), in the page. */
function installMockAgents() {
  const listeners = { event: new Set(), mcp: new Set() };
  let toolHandler = null;
  let reqId = 0;
  const settings = { providerId: "claude-code", models: { "claude-code": "sonnet" }, custom: [] };
  const mcp = { running: true, url: "http://127.0.0.1:3917/mcp", connections: [{ id: "s1", client: "Claude Code", chat: false, fileKey: null }] };
  const emit = (turnId, chatId, event) => listeners.event.forEach((cb) => cb({ turnId, chatId, event }));
  const call = async (turnId, name, args) => (toolHandler ? toolHandler({ reqId: ++reqId, turnId, client: "Claude Code", name, args }) : { content: [{ type: "text", text: "{}" }] });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // The image turn waits at each gate until the shot opens it (window.__agentsOpen(name)).
  const gates = {};
  const opened = {};
  const gate = (name) =>
    new Promise((r) => {
      if (opened[name]) {
        delete opened[name];
        return r();
      }
      gates[name] = r;
    });
  window.__agentsOpen = (name) => {
    if (!gates[name]) return void (opened[name] = true);
    gates[name]();
    delete gates[name];
  };
  let stopTurn = null;
  // A square picture, as an agent's generate_image would save it: a warm gradient with a sun.
  const picture = () => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    const sky = g.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0, "#f6b26b");
    sky.addColorStop(1, "#8e5a9b");
    g.fillStyle = sky;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = "#ffe08a";
    g.beginPath();
    g.arc(128, 150, 54, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#4a2c3a";
    g.fillRect(0, 196, 256, 60);
    return c.toDataURL("image/png").split(",")[1];
  };
  // "… image …": Antigravity's image turn (generate_image, then place_image with no place of its own).
  const imageTurn = async (turnId, req) => {
    const stopped = new Promise((r) => (stopTurn = r));
    const held = (name) => Promise.race([gate(name), stopped.then(() => "stop")]);
    emit(turnId, req.chatId, { type: "status", text: "Starting Antigravity…" });
    await wait(50);
    emit(turnId, req.chatId, { type: "text", delta: "I’ll make the picture, then put it on the canvas." });
    if ((await held("think")) === "stop") return emit(turnId, req.chatId, { type: "done", stopped: true });
    emit(turnId, req.chatId, { type: "tool", id: "g1", name: "generate_image", args: { aspect_ratio: "1:1" }, state: "running" });
    if ((await held("made")) === "stop") return emit(turnId, req.chatId, { type: "done", stopped: true });
    emit(turnId, req.chatId, { type: "tool", id: "g1", name: "generate_image", state: "done", summary: "cowboy_waitress.png" });
    emit(turnId, req.chatId, { type: "tool", id: "p1", name: "place_image", state: "running" });
    const r = await call(turnId, "place_image", { data: picture(), name: "Cowboy waitress" });
    window.__designerAgentsLog.push({ name: "place_image", isError: !!r.isError, text: r.content.find((c) => c.type === "text")?.text?.slice(0, 200) });
    emit(turnId, req.chatId, { type: "tool", id: "p1", name: "place_image", state: r.isError ? "error" : "done" });
    emit(turnId, req.chatId, { type: "text", delta: "\n\nThe picture is on the canvas, inside the selected frame." });
    emit(turnId, req.chatId, { type: "done" });
  };
  window.__designerAgentsLog = [];
  window.__designerAgents = {
    providers: async () => [
      { id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, detail: "/Users/you/.local/bin/claude", models: ["default", "sonnet", "opus", "haiku"], auth: { state: "connected", account: "you@example.com", plan: "Claude Pro" } },
      { id: "antigravity", kind: "antigravity", label: "Antigravity (Google AI)", note: "Google’s agent with your Google AI plan — Gemini models and image generation.", available: true, detail: "/Users/you/.local/bin/agy", models: ["gemini-3.8-flash-medium", "gemini-3.1-pro-high"], modelLabels: { "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)", "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)" }, auth: { state: "connected", account: "you@gmail.com", plan: "Google account" }, install: { command: "curl -fsSL https://antigravity.google/cli/install.sh | bash", page: "https://antigravity.google/docs/cli/install" } },
      { id: "codex", kind: "codex", label: "Codex", available: false, models: ["default"], problem: "codex isn't installed", auth: { state: "not-installed" }, install: { command: "npm install -g @openai/codex", page: "https://developers.openai.com/codex/cli" } },
      { id: "cursor-agent", kind: "cursor-agent", label: "Cursor Agent", available: false, detail: "/Users/you/.local/bin/cursor-agent", models: ["auto"], problem: "Signed out", auth: { state: "signed-out" } },
      { id: "ollama", kind: "openai-compatible", label: "Ollama", available: false, detail: "http://localhost:11434/v1", models: [], problem: "Not running at http://localhost:11434/v1" },
      { id: "lmstudio", kind: "openai-compatible", label: "LM Studio", available: true, detail: "http://localhost:1234/v1", models: ["qwen2.5-coder-14b", "llama-3.1-8b"] },
    ],
    settings: async () => settings,
    setSettings: async (p) => Object.assign(settings, p.providerId !== undefined ? { providerId: p.providerId } : {}, p.models ? { models: { ...settings.models, ...p.models } } : {}),
    addServer: async () => settings,
    removeServer: async () => settings,
    test: async () => ({ ok: true, models: ["default"] }),
    auth: async () => ({ state: "connected", account: "you@example.com", plan: "Claude Pro" }),
    signIn: async () => ({ state: "signing-in" }),
    signOut: async () => ({ state: "signed-out" }),
    install: async (id) => (window.__designerAgentsLog.push({ install: id }), { ok: true, opened: "installed" }),
    stop: async () => stopTurn?.(),
    onEvent: (cb) => (listeners.event.add(cb), () => listeners.event.delete(cb)),
    onToolCall: (h) => ((toolHandler = h), () => (toolHandler = null)),
    mcp: async () => mcp,
    onMcpState: (cb) => (listeners.mcp.add(cb), () => listeners.mcp.delete(cb)),
    clients: async () => [
      { id: "claude-code", label: "Claude Code", installed: true, configPath: "~/.claude.json", connected: true },
      { id: "cursor", label: "Cursor", installed: true, configPath: "~/.cursor/mcp.json", connected: false },
      { id: "vscode", label: "VS Code", installed: true, configPath: "~/Library/Application Support/Code/User/mcp.json", connected: false },
      { id: "antigravity", label: "Antigravity", installed: true, configPath: "~/.gemini/config/mcp_config.json", connected: false },
      { id: "codex", label: "Codex", installed: false, configPath: "~/.codex/config.toml", connected: false },
    ],
    connect: async () => ({ ok: true, path: "~/.cursor/mcp.json" }),
    disconnect: async () => ({ ok: true, path: "" }),
    clientConfig: async () => ({ path: "~/.cursor/mcp.json", text: "{}", stdio: "{}" }),
    // The scripted agent: reads the selected frame, makes its mobile version, selects it, answers.
    turn: async (req) => {
      const turnId = `turn-${Date.now()}`;
      window.__designerAgentsLog.push(req);
      if (/image/i.test(req.prompt)) {
        setTimeout(() => void imageTurn(turnId, req), 30);
        return { turnId };
      }
      setTimeout(async () => {
        const id = req.context.selection[0]?.id;
        emit(turnId, req.chatId, { type: "status", text: "Starting Claude Code…" });
        await wait(80);
        emit(turnId, req.chatId, { type: "text", delta: "I’ll read the frame, then make a 390 wide version next to it." });
        const steps = [
          ["t1", "get_design_context", { nodeId: id }],
          ["t2", "get_screenshot", { nodeId: id, maxSize: 512 }],
          ["t3", "create_responsive_variant", { nodeId: id, width: 390 }],
        ];
        let made = null;
        for (const [tid, name, args] of steps) {
          emit(turnId, req.chatId, { type: "tool", id: tid, name, args, state: "running" });
          const r = await call(turnId, name, args);
          window.__designerAgentsLog.push({ name, isError: !!r.isError, text: r.content.find((c) => c.type === "text")?.text?.slice(0, 200) });
          if (name === "create_responsive_variant" && !r.isError) made = JSON.parse(r.content[0].text).created.id;
          emit(turnId, req.chatId, { type: "tool", id: tid, name, state: r.isError ? "error" : "done" });
        }
        if (made) {
          emit(turnId, req.chatId, { type: "tool", id: "t4", name: "update_nodes", state: "running" });
          await call(turnId, "update_nodes", { updates: [{ nodeId: made, fills: "#FFFFFF" }] });
          emit(turnId, req.chatId, { type: "tool", id: "t4", name: "update_nodes", state: "done" });
          await call(turnId, "set_selection", { nodeIds: [made] });
        }
        // A failed step whose error is Google's JSON inside the CLI's message: the chat opens it to the inner message.
        const quota = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-image", status: "RESOURCE_EXHAUSTED" } });
        emit(turnId, req.chatId, { type: "tool", id: "t5", name: "generate_image", state: "running" });
        emit(turnId, req.chatId, { type: "tool", id: "t5", name: "generate_image", state: "error", summary: `MCP tool 'generate_image' reported tool error for function call: ${JSON.stringify([{ functionResponse: { response: { error: { content: [{ type: "text", text: `Error: ${quota}` }] } } } }])}` });
        emit(turnId, req.chatId, { type: "text", delta: "\n\nDone: **Desktop — Mobile** is to the right of the original — one column, the cards stacked, headings scaled for 390." });
        emit(turnId, req.chatId, { type: "done" });
      }, 30);
      return { turnId };
    },
  };
}

/** A desktop landing page as NODE_CHANGES: a nav, a hero, three cards in a row, an image. */
function desktopFrame() {
  const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const fill = (hex) => [{ type: "SOLID", color: { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
  const text = (guid, parent, pos, name, chars, size, x, y, w, color = 0x111111) => ({ guid, phase: "CREATED", type: "TEXT", name, parentIndex: { guid: parent, position: pos }, size: { x: w, y: Math.round(size * 1.3) }, transform: at(x, y), fillPaints: fill(color), textData: { characters: chars }, fontSize: size, fontName: { family: "Inter", style: size > 40 ? "Bold" : "Regular", postscript: "" }, textAutoResize: "HEIGHT" });
  const frame = (guid, parent, pos, name, x, y, w, h, color, extra = {}) => ({ guid, phase: "CREATED", type: "FRAME", name, parentIndex: { guid: parent, position: pos }, size: { x: w, y: h }, transform: at(x, y), fillPaints: color === null ? [] : fill(color), ...extra });
  const row = { stackMode: "HORIZONTAL", stackSpacing: 32, stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" };
  const card = { stackMode: "VERTICAL", stackSpacing: 12, stackHorizontalPadding: 24, stackVerticalPadding: 24, stackPaddingRight: 24, stackPaddingBottom: 24, stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED", cornerRadius: 12 };
  return [
    frame("7:1", "0:1", "!", "Desktop", 0, 0, 1440, 1024, 0xffffff),
    frame("7:2", "7:1", "!", "Nav", 0, 0, 1440, 80, 0x111111, { stackMode: "HORIZONTAL", stackPrimaryAlignItems: "SPACE_BETWEEN", stackCounterAlignItems: "CENTER", stackHorizontalPadding: 80, stackPaddingRight: 80, stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" }),
    text("7:3", "7:2", "!", "Brand", "Brand", 24, 0, 0, 90, 0xffffff),
    text("7:4", "7:2", '"', "Menu", "Products   Pricing   About", 16, 0, 0, 240, 0xffffff),
    text("7:5", "7:1", '"', "Title", "Design at the speed of thought", 72, 80, 160, 1100),
    text("7:6", "7:1", "#", "Lead", "A short paragraph under the headline that explains the product in a sentence or two.", 20, 80, 270, 720, 0x555555),
    frame("7:7", "7:1", "$", "Button", 80, 350, 200, 56, 0x0d99ff, { cornerRadius: 8 }),
    frame("7:8", "7:1", "%", "Cards", 80, 460, 1280, 300, null, row),
    ...[0, 1, 2].flatMap((i) => [
      frame(`7:${10 + i * 3}`, "7:8", String.fromCharCode(33 + i), `Card ${i + 1}`, 0, 0, 405, 300, 0xf5f5f5, card),
      text(`7:${11 + i * 3}`, `7:${10 + i * 3}`, "!", "Heading", `Feature ${i + 1}`, 28, 0, 0, 357),
      text(`7:${12 + i * 3}`, `7:${10 + i * 3}`, '"', "Body", "Short body copy about this feature.", 16, 0, 0, 357, 0x555555),
    ]),
    frame("7:30", "7:1", "&", "Image", 80, 800, 1280, 180, 0xcfd8e3, { cornerRadius: 12 }),
  ];
}

/** A close-up for docs/research/agents-ux/ (AGENTS_UX_DIR), with some room around the element. */
async function closeUp(page, selector, name, pad = 12) {
  const dir = process.env.AGENTS_UX_DIR;
  if (!dir) return;
  const box = await page.locator(selector).first().boundingBox();
  if (!box) return;
  mkdirSync(dir, { recursive: true });
  const view = page.viewportSize();
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({ path: path.join(dir, `${name}.png`), clip: { x, y, width: Math.min(view.width - x, box.width + pad * 2), height: Math.min(view.height - y, box.height + pad * 2) } });
}

export async function agentsSection(page, theme, { open, settle, shot, check }) {
  await page.addInitScript(installMockAgents);
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setSelection(["7:1"]);
    ed.engine.command("ZOOM_TO_FIT");
  }, desktopFrame());
  await settle(page);

  // The right panel's MCP section (nothing selected): "MCP", "1 connection", Set up agents.
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);
  const mcp = page.locator("[data-mcp-section]");
  check("Agents: the MCP section shows with nothing selected", (await mcp.count()) === 1);
  check("Agents: MCP counts 1 connection (Claude Code)", ((await mcp.textContent()) ?? "").includes("1 connection"), (await mcp.textContent()) ?? "");
  await shot(page, `400-agents-mcp-section-${theme}`);
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["7:1"]));
  await settle(page);
  check("Agents: the MCP section is gone with a selection", (await mcp.count()) === 0);

  // The tab: a new chat with the selection as context and suggestions.
  await page.locator('[data-rail-tab="agents"]').click();
  await page.waitForSelector("[data-composer]");
  await page.waitForTimeout(150);
  check("Agents: the composer shows the selected frame as context", ((await page.locator("[data-composer] [data-context-chip]").textContent()) ?? "").includes("Desktop"));
  check("Agents: suggestions for a selection", (await page.locator("[data-suggestion]").count()) === 3);
  check("Agents: the agent picker names Claude Code · sonnet", ((await page.locator("[data-composer]").textContent()) ?? "").includes("Claude Code · sonnet"));
  await page.locator("[data-composer]").getByRole("combobox", { name: "Agent and model" }).click();
  await page.waitForTimeout(100);
  const picker = await page.evaluate(() => {
    const list = document.querySelector('[role="listbox"]');
    const r = list?.getBoundingClientRect();
    return { headers: [...(list?.querySelectorAll("[data-select-header]") ?? [])].map((h) => h.textContent), options: list?.querySelectorAll('[role="option"]').length ?? 0, top: r?.top ?? -1, bottom: r?.bottom ?? 1e9, height: window.innerHeight, scroll: list ? list.scrollHeight - list.clientHeight : 0 };
  });
  check("Agents: the picker lists only connected agents, grouped under their names", JSON.stringify(picker.headers) === JSON.stringify(["Claude Code", "Antigravity (Google AI)", "LM Studio"]) && picker.options === 8, JSON.stringify(picker));
  check("Agents: the picker's list is whole on screen (not cut)", picker.top >= 0 && picker.bottom <= picker.height && picker.scroll <= 1, JSON.stringify(picker));
  await shot(page, `401b-agents-picker-${theme}`);
  await page.keyboard.press("Escape");
  await shot(page, `401-agents-new-chat-${theme}`);

  // The flagship flow: "Make the mobile version of this".
  await page.locator("[data-agents-input]").fill("Make the mobile version of this");
  await page.locator("[data-agents-input]").press("Enter");
  await page.waitForSelector('[data-message="assistant"][data-state="done"]', { timeout: 15000 });
  await settle(page);
  const result = await page.evaluate(() => {
    const ed = window.__designerEditor;
    const sel = ed.selection;
    const n = sel[0] ? ed.engine.readNode(sel[0], { childIds: true }) : null;
    return { sel, name: n?.name, width: n?.size?.x, mode: n?.stackMode, x: n?.transform?.m02, kids: n?.childIds?.length ?? 0, undo: ed.store.undo.undoLabel, log: window.__designerAgentsLog };
  });
  check("Agents: the turn's request carries the selection as context", result.log[0]?.context?.selection?.[0]?.id === "7:1", JSON.stringify(result.log[0]?.context));
  check("Agents: the agent's tool calls ran on the engine", result.log.slice(1).every((l) => !l.isError), result.log.slice(1).map((l) => `${l.name}${l.isError ? " (error)" : ""}`).join(", "));
  check("Agents: a 390 wide vertical auto layout frame next to the desktop one, selected", result.width === 390 && result.mode === "VERTICAL" && result.x >= 1440 + 100 && result.kids >= 5 && result.name === "Desktop — Mobile", JSON.stringify({ ...result, log: undefined }));
  check("Agents: the turn is one undo step labelled for the agent", result.undo === "Claude Code edit", result.undo);
  check("Agents: the steps are listed", (await page.locator('[data-message="assistant"] [data-tool]').count()) === 5);
  const failed = page.locator('[data-tool="generate_image"][data-tool-state="error"]');
  await failed.locator("[data-tool-toggle]").click();
  const errText = (await failed.locator("[data-tool-error]").textContent()) ?? "";
  check("Agents: a failed step opens to its whole error, the nested JSON read down to Google's message", errText.startsWith("You exceeded your current quota.") && errText.includes("limit: 0") && !errText.includes("{"), errText);
  check("Agents: the changes row offers Undo", (await page.locator("[data-turn-undo]").count()) === 1);
  await shot(page, `402-agents-mobile-version-${theme}`);
  const made = result.sel[0];
  await page.locator("[data-turn-undo]").click();
  await settle(page);
  check("Agents: Undo in the chat takes the whole turn back", (await page.evaluate((id) => window.__designerEditor.engine.readNode(id), made)) === null);
  check("Agents: then it offers Apply", (await page.locator("[data-turn-apply]").count()) === 1);
  await page.locator("[data-turn-apply]").click();
  await settle(page);
  check("Agents: Apply brings it back", (await page.evaluate((id) => window.__designerEditor.engine.readNode(id)?.size?.x, made)) === 390);

  // An image turn (Antigravity's way: generate_image, then place_image), held at each stage.
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    ed.engine.setSelection(["7:1"]);
    ed.engine.command("ZOOM_TO_SELECTION");
  });
  await settle(page);
  await page.locator("[data-agents-input]").fill("Make an image of a cowboy waitress and put it in this frame");
  await page.locator("[data-agents-input]").press("Enter");
  const last = page.locator('[data-message="assistant"]').last();
  await last.locator("[data-thinking]").waitFor({ timeout: 5000 });
  check("Agents: while the agent thinks, a Thinking… row shimmers under its words", ((await last.locator("[data-thinking-label]").textContent()) ?? "") === "Thinking…");
  await last.locator("[data-thinking-time]").waitFor({ timeout: 9000 });
  check("Agents: after 5 s the row shows the seconds", /^\d+s$/.test(((await last.locator("[data-thinking-time]").textContent()) ?? "").trim()));
  await closeUp(page, '[data-message="assistant"]:last-child [data-thinking]', `thinking-row-${theme}`, 16);
  await page.evaluate(() => window.__agentsOpen("think"));
  await page.locator('[data-image-card="generating"]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  const ph = await page.evaluate(() => {
    const el = document.querySelector('[data-agent-image-placeholder="active"]');
    const r = el?.getBoundingClientRect();
    const ed = window.__designerEditor;
    const c = ed.engine.getCamera();
    const cr = ed.canvas.getBoundingClientRect();
    const f = ed.engine.readNode(ed.selection[0], { fields: ["size", "transform"] });
    const fx = cr.left + f.transform.m02 * c.zoom + c.x;
    const fy = cr.top + f.transform.m12 * c.zoom + c.y;
    return { r: r && { x: r.x, y: r.y, w: r.width, h: r.height }, frame: { x: fx, y: fy, w: f.size.x * c.zoom, h: f.size.y * c.zoom }, layers: ed.engine.readNode(ed.selection[0], { childIds: true }).childIds.length };
  });
  const inside = ph.r && ph.r.x >= ph.frame.x - 1 && ph.r.y >= ph.frame.y - 1 && ph.r.x + ph.r.w <= ph.frame.x + ph.frame.w + 1 && ph.r.y + ph.r.h <= ph.frame.y + ph.frame.h + 1;
  check("Agents: generate_image puts a placeholder on the canvas, square, inside the selected frame", !!inside && Math.abs(ph.r.w - ph.r.h) <= 1 && ph.r.w > 20, JSON.stringify(ph));
  check("Agents: the chat shows the image card being made, and the running step says Making an image…", (await last.locator('[data-image-card="generating"]').count()) === 1 && ((await last.locator('[data-tool="generate_image"] [data-thinking-label]').textContent()) ?? "") === "Making an image…");
  await shot(page, `405-agents-image-making-${theme}`);
  await closeUp(page, '[data-message="assistant"]:last-child [data-image-card]', `image-card-making-${theme}`, 16);
  await closeUp(page, "[data-agent-image-placeholder]", `canvas-placeholder-${theme}`, 48);
  const childrenBefore = ph.layers;
  await page.evaluate(() => window.__agentsOpen("made"));
  await page.waitForSelector('[data-message="assistant"][data-state="done"] [data-image-card="placed"] img', { timeout: 8000 });
  await settle(page);
  const placed = await page.evaluate(() => {
    const ed = window.__designerEditor;
    const log = window.__designerAgentsLog.filter((l) => l.name === "place_image").pop();
    const id = log && JSON.parse(log.text).nodeId;
    const n = id && ed.engine.readNode(id, { fields: ["size", "transform", "parentIndex", "fillPaints", "name"] });
    const frame = ed.engine.readNode(ed.selection[0] ?? "", { childIds: true });
    return { n: n && { w: n.size.x, h: n.size.y, x: n.transform.m02, y: n.transform.m12, parent: n.parentIndex?.guid, fill: n.fillPaints?.[0]?.type, name: n.name }, placeholders: document.querySelectorAll("[data-agent-image-placeholder]").length, undo: ed.store.undo.undoLabel, frameKids: frame?.childIds?.length };
  });
  check("Agents: place_image lands where the placeholder was (in the frame, fitted and centred) and the placeholder goes", placed.n && placed.n.fill === "IMAGE" && placed.n.w === 512 && placed.n.h === 512 && placed.n.x === 464 && placed.n.y === 256 && placed.n.parent === "7:1" && placed.placeholders === 0, JSON.stringify({ ...placed, ph }));
  check("Agents: the image card shows the picture", (await last.locator('[data-image-card="placed"] img').count()) === 1);
  check("Agents: no Thinking… row once the turn is over", (await last.locator("[data-thinking]").count()) === 0);
  await shot(page, `406-agents-image-placed-${theme}`);
  await closeUp(page, '[data-message="assistant"]:last-child [data-image-card]', `image-card-placed-${theme}`, 16);
  check("Agents: the image is one more layer of the frame", placed.frameKids === childrenBefore + 1, `${childrenBefore} → ${placed.frameKids}`);
  // Stop while an image is made: the placeholder fades out, the card says it wasn't placed.
  await page.locator("[data-agents-input]").fill("One more image, please");
  await page.locator("[data-agents-input]").press("Enter");
  await page.locator('[data-message="assistant"]').last().locator("[data-thinking]").waitFor({ timeout: 5000 });
  await page.evaluate(() => window.__agentsOpen("think"));
  await page.locator('[data-agent-image-placeholder="active"]').waitFor({ timeout: 5000 });
  await page.locator("[data-agents-stop]").click();
  await page.locator('[data-agent-image-placeholder="leaving"]').waitFor({ timeout: 3000 });
  await page.waitForFunction(() => !document.querySelector("[data-agent-image-placeholder]"), null, { timeout: 3000 });
  check("Agents: Stop fades the placeholder out and the card says Image not placed", ((await page.locator('[data-message="assistant"]').last().locator('[data-image-card="failed"]').textContent()) ?? "").includes("Image not placed"));

  // Agent settings: a list in three groups (one row each: name, state, chevron); a row opens its own page.
  await page.locator("[data-agents-settings]").click();
  await page.waitForSelector('[data-agent-settings][data-settings-page="list"]');
  await page.waitForTimeout(150);
  const settings = page.locator("[data-agent-settings]");
  const groups = await settings.locator("h3").allTextContents();
  check("Agents: settings open as a list grouped On this computer / Servers / Connect other apps", JSON.stringify(groups) === JSON.stringify(["On this computer", "Servers", "Connect other apps"]), JSON.stringify(groups));
  check("Agents: the list has no paragraphs but one short line", (await settings.locator("p").count()) === 1);
  const row = (id) => page.locator(`[data-provider="${id}"]`);
  const stateOf = async (id) => ((await row(id).locator("[data-provider-state]").textContent()) ?? "").trim();
  const states = { claude: await stateOf("claude-code"), antigravity: await stateOf("antigravity"), codex: await stateOf("codex"), cursor: await stateOf("cursor-agent"), ollama: await stateOf("ollama"), lm: await stateOf("lmstudio") };
  check("Agents: each row has one state — Connected / Sign in needed / Not installed / Not running", JSON.stringify(states) === JSON.stringify({ claude: "Connected", antigravity: "Connected", codex: "Not installed", cursor: "Sign in needed", ollama: "Not running", lm: "Connected" }), JSON.stringify(states));
  check("Agents: settings list Claude Code (found) and Ollama (not running)", (await page.locator('[data-provider="claude-code"][data-available]').count()) === 1 && (await page.locator('[data-provider="ollama"]:not([data-available])').count()) === 1);
  const rowBox = await row("claude-code").boundingBox();
  check("Agents: rows are 32 px", Math.round(rowBox?.height ?? 0) === 32, JSON.stringify(rowBox));
  check("Agents: no Gemini CLI anywhere; the MCP server row counts 1 connection; Claude Code is connected as an app", !((await settings.textContent()) ?? "").includes("Gemini CLI") && (await page.locator('[data-settings-row="gemini-key"]').count()) === 0 && ((await page.locator('[data-settings-row="mcp"]').textContent()) ?? "").includes("1 connection") && (await page.locator('[data-client="claude-code"][data-connected]').count()) === 1);
  await shot(page, `403-agents-settings-${theme}`);
  const openRow = async (sel) => {
    await page.locator(sel).click();
    await page.waitForTimeout(100);
  };
  const back = async () => {
    await settings.getByRole("button", { name: "Back" }).click();
    await page.waitForTimeout(100);
  };
  const card = (id) => page.locator(`[data-agent-settings] [data-provider="${id}"]`);
  await openRow('[data-provider="claude-code"]');
  check("Agents: Claude Code's page says Connected with its account and offers Sign out and its model", ((await card("claude-code").textContent()) ?? "").includes("you@example.com") && (await card("claude-code").locator("[data-sign-out]").count()) === 1 && (await card("claude-code").getByRole("combobox", { name: "Model" }).count()) === 1);
  await back();
  check("Agents: Back from a page returns to the list", (await page.locator('[data-agent-settings][data-settings-page="list"]').count()) === 1);
  await openRow('[data-provider="codex"]');
  check("Agents: Codex's page: Not installed with Install", ((await card("codex").locator("[data-provider-state]").textContent()) ?? "") === "Not installed" && (await card("codex").locator("[data-install]").count()) === 1);
  await back();
  await openRow('[data-provider="cursor-agent"]');
  check("Agents: Cursor Agent's page: Sign in needed with Sign in", ((await card("cursor-agent").locator("[data-provider-state]").textContent()) ?? "") === "Sign in needed" && (await card("cursor-agent").locator("[data-sign-in]").count()) === 1);
  await back();
  const order = await settings.locator('[aria-label="On this computer"] [data-provider]').evaluateAll((els) => els.map((e) => e.getAttribute("data-provider")));
  check("Agents: Antigravity is listed first after Claude Code", order[0] === "claude-code" && order[1] === "antigravity", JSON.stringify(order));
  await openRow('[data-provider="antigravity"]');
  check("Agents: Antigravity's page: Connected with the Google account, its model by its own name, Sign out", ((await card("antigravity").textContent()) ?? "").includes("you@gmail.com") && ((await card("antigravity").getByRole("combobox", { name: "Model" }).textContent()) ?? "").includes("Gemini 3.8 Flash (Medium)") && (await card("antigravity").locator("[data-sign-out]").count()) === 1);
  await shot(page, `403c-agents-settings-antigravity-${theme}`);
  await back();
  await openRow('[data-client="cursor"]');
  check("Agents: Cursor's app page offers Connect to Cursor", (await page.getByRole("button", { name: "Connect to Cursor" }).count()) === 1);
  await back();
  await openRow('[data-client="antigravity"]');
  check("Agents: Antigravity's app page offers Connect to Antigravity", (await page.getByRole("button", { name: "Connect to Antigravity" }).count()) === 1);
  await back();
  await openRow('[data-settings-row="mcp"]');
  check("Agents: the MCP server's URL is shown", ((await page.locator("[data-mcp-url]").textContent()) ?? "").includes("127.0.0.1"));
  await back();

  await page.locator("[data-agent-settings]").getByRole("button", { name: "Back" }).click();
  await settle(page);
  check("Agents: Back lists the chat", (await page.locator("[data-chat]").count()) === 1);
  await shot(page, `404-agents-chats-${theme}`);
}
