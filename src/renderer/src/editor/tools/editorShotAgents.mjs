// editor-shot's Agents section (EDITOR_ONLY=agents; docs/research/figma/R12-agents-mcp.md): the Agents tab and the
// right panel's MCP section in a browser, with a stand-in for main (`window.__designerAgents`, installed before the
// page loads) that plays an agent's turn — its text, its steps, and real tool calls run by the page on the engine —
// so the flagship flow is driven end to end: a desktop frame selected → "Make the mobile version of this" → a 390
// frame next to it, one undo step, Undo / Apply from the chat. Then an image turn with a rectangle selected, held at
// each stage (gates the shots open): the placeholder over the rectangle and the chat's image card the moment the
// prompt is sent, the Thinking… row, generate_image in the same placeholder, the picture landing as the rectangle's
// fill with the reveal (frozen part-way for the shots), then gone; a prompt that asked for a picture the agent never
// made (the placeholder fades, the card goes); and Stop while one is made. No real agent or model is involved.
// AGENTS_UX_DIR=<folder> also saves close-ups of the Thinking… row, the image card and the canvas placeholder there.
/* global window, document, setTimeout, getComputedStyle, process, atob, btoa, navigator, Blob, ClipboardItem, ClipboardEvent, DataTransfer, DragEvent, File, TextEncoder */
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
    // A place of its own on the page, as agents often give: the selected layer is filled all the same.
    const r = await call(turnId, "place_image", { data: picture(), name: "Cowboy waitress", x: 0, y: 0 });
    window.__designerAgentsLog.push({ name: "place_image", isError: !!r.isError, text: r.content.find((c) => c.type === "text")?.text?.slice(0, 200) });
    emit(turnId, req.chatId, { type: "tool", id: "p1", name: "place_image", state: r.isError ? "error" : "done" });
    emit(turnId, req.chatId, { type: "text", delta: "\n\nThe selected rectangle is filled with the picture." });
    emit(turnId, req.chatId, { type: "done" });
  };
  // "… çiz …" to an agent that makes no pictures: it answers in words only.
  const wordsTurn = async (turnId, req) => {
    emit(turnId, req.chatId, { type: "status", text: "Starting LM Studio…" });
    await gate("words");
    emit(turnId, req.chatId, { type: "text", delta: "I can't make pictures; I can draw it with shapes if you like." });
    emit(turnId, req.chatId, { type: "done" });
  };
  // A message with files attached: the agent "looks" and answers in words (and its turn used some of the session).
  let claudeSession = 42;
  const filesTurn = async (turnId, req) => {
    emit(turnId, req.chatId, { type: "status", text: "Starting Claude Code…" });
    await wait(60);
    emit(turnId, req.chatId, { type: "text", delta: `I looked at ${req.attachments.map((a) => a.name).join(" and ")}: a red rectangle on white, and a one-page brief.` });
    claudeSession = 44;
    emit(turnId, req.chatId, { type: "limits", windows: [{ label: "Current session", usedPct: claudeSession, resetText: "Oct 10 at 3:59am" }] });
    emit(turnId, req.chatId, { type: "usage", usage: { input: 1200, output: 84 } });
    emit(turnId, req.chatId, { type: "done" });
  };
  // Main's copies in the chat's folder (the stand-in keeps none: the path is what the turn carries).
  let attachSeq = 0;
  const kindOf = (b) => (b[0] === 0x25 && b[1] === 0x50 ? "application/pdf" : b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : null);
  const toBase64 = (b) => {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  };
  const saved = (chatId, name, mime, size, thumb) => ({ id: `a${++attachSeq}`, name, mime, size, path: `/Users/you/Library/Application Support/DesignerV2/agents/work/${chatId}/attachments/a${attachSeq}-${name}`, ...(thumb ? { thumb } : {}) });
  window.__designerAgentsLog = [];
  window.__designerAgents = {
    attach: async (chatId, files) => {
      window.__designerAgentsLog.push({ attach: files.map((f) => f.name) });
      const attachments = [];
      const errors = [];
      for (const f of files) {
        const mime = kindOf(f.bytes);
        if (!mime) errors.push(`“${f.name}” isn’t a PDF, PNG, JPEG, WebP or GIF`);
        else attachments.push(saved(chatId, f.name, mime, f.bytes.length, mime.startsWith("image/") ? `data:${mime};base64,${toBase64(f.bytes)}` : undefined));
      }
      return { attachments, errors };
    },
    pickAttachments: async (chatId) => (window.__designerAgentsLog.push({ pick: chatId }), { attachments: [saved(chatId, "Brief.pdf", "application/pdf", 182_400)], errors: [] }),
    // A browser has no system clipboard for main to read: the paste's own bytes are used.
    attachClipboard: async () => ({ attachments: [], errors: [] }),
    usage: async (id) =>
      id === "claude-code"
        ? { providerId: id, at: Date.now(), windows: [{ label: "Current session", usedPct: claudeSession, resetText: "Oct 10 at 3:59am" }, { label: "Current week (Fable)", usedPct: 66, resetText: "Oct 14 at 1:59pm" }] }
        : id === "antigravity"
          ? { providerId: id, at: Date.now(), windows: [{ label: "5-hour limit", group: "Gemini Models", usedPct: 81, resetsAt: Date.now() + 77 * 60_000 }, { label: "Weekly limit", group: "Gemini Models", usedPct: 12, resetsAt: Date.now() + 6.8 * 86_400_000 }, { label: "5-hour limit", group: "Claude and GPT models", usedPct: 0 }] }
          : null,
    providers: async () => [
      { id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, detail: "/Users/you/.local/bin/claude", models: ["default", "opus", "sonnet", "haiku"], efforts: ["high", "low", "medium", "xhigh", "max"], auth: { state: "connected", account: "you@example.com", plan: "Claude Pro" } },
      { id: "antigravity", kind: "antigravity", label: "Antigravity (Google AI)", note: "Google’s agent with your Google AI plan — Gemini models and image generation.", available: true, detail: "/Users/you/.local/bin/agy", models: ["gemini-3.8-flash-medium", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.1-pro-high", "gemini-3.1-pro-low"], modelLabels: { "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)", "gemini-3.8-flash-high": "Gemini 3.8 Flash (High)", "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)", "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)", "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)" }, auth: { state: "connected", account: "you@gmail.com", plan: "Google AI Ultra" }, install: { command: "curl -fsSL https://antigravity.google/cli/install.sh | bash", page: "https://antigravity.google/docs/cli/install" } },
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
      if (req.attachments?.length) {
        setTimeout(() => void filesTurn(turnId, req), 30);
        return { turnId };
      }
      if (/image|resmi/i.test(req.prompt)) {
        setTimeout(() => void imageTurn(turnId, req), 30);
        return { turnId };
      }
      if (/çiz/i.test(req.prompt)) {
        setTimeout(() => void wordsTurn(turnId, req), 30);
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
  const menus = async () => ({ model: ((await page.locator("[data-composer] [data-model-menu]").textContent()) ?? "").trim(), effort: (await page.locator("[data-composer] [data-effort-menu]").count()) ? ((await page.locator("[data-composer] [data-effort-menu]").textContent()) ?? "").trim() : null });
  const first = await menus();
  check("Agents: the composer's menus name the model short (Sonnet) and its effort (High), no agent name", JSON.stringify(first) === JSON.stringify({ model: "Sonnet", effort: "High" }) && !((await page.locator("[data-composer]").textContent()) ?? "").includes("Claude Code"), JSON.stringify(first));
  await page.locator("[data-composer]").getByRole("combobox", { name: "Model" }).click();
  await page.waitForTimeout(100);
  const picker = await page.evaluate(() => {
    const list = document.querySelector('[role="listbox"]');
    const r = list?.getBoundingClientRect();
    return { headers: [...(list?.querySelectorAll("[data-select-header]") ?? [])].map((h) => h.textContent), options: list?.querySelectorAll('[role="option"]').length ?? 0, labels: [...(list?.querySelectorAll('[role="option"]') ?? [])].map((o) => o.textContent.trim()), top: r?.top ?? -1, bottom: r?.bottom ?? 1e9, height: window.innerHeight, scroll: list ? list.scrollHeight - list.clientHeight : 0 };
  });
  check("Agents: the model menu lists only connected agents, each a heading over its models (Antigravity's efforts folded: 3.8 Flash, 3.1 Pro)", JSON.stringify(picker.headers) === JSON.stringify(["Claude Code", "Antigravity (Google AI)", "LM Studio"]) && picker.options === 8 && JSON.stringify(picker.labels.slice(4, 6)) === JSON.stringify(["3.8 Flash", "3.1 Pro"]), JSON.stringify(picker));
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

  // An image turn (Antigravity's way: generate_image, then place_image), held at each stage, with a rectangle selected:
  // the placeholder covers it as soon as the prompt is sent, and the picture becomes its fill.
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
    const fill = [{ type: "SOLID", color: { r: 0.85, g: 0.87, b: 0.9, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: "7:40", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Photo", parentIndex: { guid: "0:1", position: "~" }, size: { x: 480, y: 320 }, transform: at(0, 1124), fillPaints: fill, cornerRadius: 24 }] });
    ed.engine.setSelection(["7:40"]);
    ed.engine.command("ZOOM_TO_SELECTION");
  });
  await settle(page);
  const pageLayers = () => page.evaluate(() => window.__designerEditor.engine.readNode(window.__designerEditor.store.page, { childIds: true }).childIds.length);
  const layersBefore = await pageLayers();
  /** The selected rectangle and the placeholder on screen. */
  const measure = () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-agent-image-placeholder]");
      const r = el?.getBoundingClientRect();
      const ed = window.__designerEditor;
      const c = ed.engine.getCamera();
      const cr = ed.canvas.getBoundingClientRect();
      const f = ed.engine.readNode("7:40", { fields: ["size", "transform", "fillPaints"] });
      return {
        state: el?.getAttribute("data-agent-image-placeholder") ?? null,
        fills: el?.hasAttribute("data-fills") ?? false,
        radius: el ? getComputedStyle(el).borderTopLeftRadius : null,
        r: r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        rect: { x: Math.round(cr.left + f.transform.m02 * c.zoom + c.x), y: Math.round(cr.top + f.transform.m12 * c.zoom + c.y), w: Math.round(f.size.x * c.zoom), h: Math.round(f.size.y * c.zoom), radius: `${Math.round(24 * c.zoom * 100) / 100}px` },
        fill: f.fillPaints?.[0] && { type: f.fillPaints[0].type, scaleMode: f.fillPaints[0].imageScaleMode },
        count: document.querySelectorAll("[data-agent-image-placeholder]").length,
      };
    });
  const covers = (m) => !!m.r && Math.abs(m.r.x - m.rect.x) <= 1 && Math.abs(m.r.y - m.rect.y) <= 1 && Math.abs(m.r.w - m.rect.w) <= 1 && Math.abs(m.r.h - m.rect.h) <= 1;
  await page.locator("[data-agents-input]").fill("bu kareye bir kovboy garson resmi koy");
  await page.locator("[data-agents-input]").press("Enter");
  const last = page.locator('[data-message="assistant"]').last();
  // At once — before the agent has said or done anything.
  await page.locator('[data-agent-image-placeholder="active"]').waitFor({ timeout: 2000 });
  await last.locator('[data-image-card="generating"]').waitFor({ timeout: 2000 });
  const early = await measure();
  check("Agents: right after sending, the placeholder covers the selected rectangle exactly (bounds, corners)", early.count === 1 && early.fills && covers(early) && early.radius === early.rect.radius, JSON.stringify(early));
  check("Agents: right after sending, the chat shows the image card, before any step", (await last.locator("[data-tool]").count()) === 0 && (await last.locator('[data-image-card="generating"]').count()) === 1);
  await last.locator("[data-thinking]").waitFor({ timeout: 5000 });
  check("Agents: while the agent thinks, a Thinking… row shimmers under its words", ((await last.locator("[data-thinking-label]").textContent()) ?? "") === "Thinking…");
  await shot(page, `405a-agents-image-asked-${theme}`);
  await last.locator("[data-thinking-time]").waitFor({ timeout: 9000 });
  check("Agents: after 5 s the row shows the seconds", /^\d+s$/.test(((await last.locator("[data-thinking-time]").textContent()) ?? "").trim()));
  await closeUp(page, '[data-message="assistant"]:last-child [data-thinking]', `thinking-row-${theme}`, 16);
  // Pan: it follows the canvas.
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    const c = ed.engine.getCamera();
    ed.engine.setCamera({ ...c, x: c.x - 60, y: c.y + 40 });
  });
  await settle(page);
  const panned = await measure();
  check("Agents: the placeholder follows pan and zoom", covers(panned), JSON.stringify(panned));
  await page.evaluate(() => window.__agentsOpen("think"));
  await last.locator('[data-tool="generate_image"]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  const making = await measure();
  check("Agents: generate_image shows in the same placeholder and card (no second one)", making.count === 1 && making.state === "active" && covers(making) && (await last.locator("[data-image-card]").count()) === 1, JSON.stringify(making));
  check("Agents: the running step says Making an image…", ((await last.locator('[data-tool="generate_image"] [data-thinking-label]').textContent()) ?? "") === "Making an image…");
  await shot(page, `405-agents-image-making-${theme}`);
  await closeUp(page, '[data-message="assistant"]:last-child [data-image-card]', `image-card-making-${theme}`, 16);
  await closeUp(page, "[data-agent-image-placeholder]", `canvas-placeholder-making-${theme}`, 48);
  // The picture lands. The reveal's timers are held and its animations frozen part-way for the shots, then let go.
  await page.evaluate(() => {
    const reveal = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ds-duration-reveal"));
    const orig = window.setTimeout;
    const held = [];
    window.setTimeout = (fn, ms, ...a) => (ms === reveal ? (held.push(() => fn(...a)), 0) : orig(fn, ms, ...a));
    window.__revealAt = (f) => document.getAnimations().forEach((an) => {
      const d = an.effect?.getTiming().duration;
      if (an.effect?.getTiming().iterations !== 1 || typeof d !== "number") return;
      an.pause();
      an.currentTime = reveal * f;
    });
    window.__releaseReveal = () => {
      window.setTimeout = orig;
      document.getAnimations().forEach((an) => an.playState === "paused" && an.play());
      held.splice(0).forEach((f) => f());
    };
  });
  await page.evaluate(() => window.__agentsOpen("made"));
  await page.locator('[data-agent-image-placeholder="revealing"]').waitFor({ timeout: 8000 });
  await last.locator('[data-image-card="placed"][data-reveal="play"]').waitFor({ timeout: 5000 });
  await page.evaluate(() => window.__revealAt(0.3));
  await settle(page);
  const revealing = await measure();
  check("Agents: the picture lands as the selected rectangle's fill (FILL), no new layer", revealing.fill?.type === "IMAGE" && revealing.fill?.scaleMode === "FILL" && (await pageLayers()) === layersBefore, JSON.stringify({ ...revealing, layersBefore }));
  check("Agents: the reveal plays over it, on the canvas and in the chat", revealing.state === "revealing" && covers(revealing) && (await last.locator('[data-reveal="play"] img').count()) === 1, JSON.stringify(revealing));
  await shot(page, `406a-agents-image-revealing-${theme}`);
  await closeUp(page, '[data-message="assistant"]:last-child [data-image-card]', `image-card-revealing-sweep-${theme}`, 16);
  await closeUp(page, "[data-agent-image-placeholder]", `canvas-placeholder-revealing-sweep-${theme}`, 48);
  await page.evaluate(() => window.__revealAt(0.7));
  await page.waitForTimeout(50);
  await closeUp(page, '[data-message="assistant"]:last-child [data-image-card]', `image-card-revealing-dissolve-${theme}`, 16);
  await closeUp(page, "[data-agent-image-placeholder]", `canvas-placeholder-revealing-dissolve-${theme}`, 48);
  await page.evaluate(() => window.__releaseReveal());
  await page.waitForFunction(() => !document.querySelector("[data-agent-image-placeholder]"), null, { timeout: 3000 });
  await page.waitForSelector('[data-message="assistant"][data-state="done"] [data-image-card="placed"]:not([data-reveal]) img', { timeout: 5000 });
  await settle(page);
  check("Agents: then the placeholder is gone and the card shows the picture", (await measure()).count === 0 && (await last.locator('[data-image-card="placed"] img').count()) === 1);
  check("Agents: no Thinking… row once the turn is over", (await last.locator("[data-thinking]").count()) === 0);
  await shot(page, `406-agents-image-placed-${theme}`);
  await closeUp(page, '[data-message="assistant"]:last-child [data-image-card]', `image-card-placed-${theme}`, 16);
  if (process.env.AGENTS_UX_DIR) {
    // The rectangle on the canvas, filled with the picture.
    const m = await measure();
    const pad = 48;
    await page.screenshot({ path: path.join(process.env.AGENTS_UX_DIR, `canvas-placed-${theme}.png`), clip: { x: Math.max(0, m.rect.x - pad), y: Math.max(0, m.rect.y - pad), width: m.rect.w + pad * 2, height: m.rect.h + pad * 2 } });
  }
  // Asked for in words, but the agent makes none: the placeholder fades out, the card goes.
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);
  await page.locator("[data-agents-input]").fill("bir kovboy çiz");
  await page.locator("[data-agents-input]").press("Enter");
  await page.locator('[data-agent-image-placeholder="active"]').waitFor({ timeout: 2000 });
  check("Agents: with nothing selected the placeholder sits mid-view", !(await measure()).fills);
  await page.evaluate(() => window.__agentsOpen("words"));
  await page.locator('[data-agent-image-placeholder="leaving"]').waitFor({ timeout: 3000 });
  await page.waitForFunction(() => !document.querySelector("[data-agent-image-placeholder]"), null, { timeout: 3000 });
  await page.waitForFunction(() => !document.querySelector('[data-message="assistant"]:last-child [data-image-card]'), null, { timeout: 3000 });
  check("Agents: no picture after all: the placeholder fades out and the chat's card goes", (await page.locator('[data-message="assistant"]').last().locator("[data-image-card]").count()) === 0);
  // Stop while an image is made: the placeholder fades out, the card says it wasn't placed.
  await page.locator("[data-agents-input]").fill("One more image, please");
  await page.locator("[data-agents-input]").press("Enter");
  await page.locator('[data-message="assistant"]').last().locator("[data-thinking]").waitFor({ timeout: 5000 });
  await page.evaluate(() => window.__agentsOpen("think"));
  await page.locator('[data-message="assistant"]').last().locator('[data-tool="generate_image"]').waitFor({ timeout: 5000 });
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
  await composerSection(page, theme, { settle, shot, check, menus });
}

/** In the page: a small PNG (a red rectangle on white) as a screenshot would be copied, and a PDF (window.__samples). */
function samples() {
  const c = document.createElement("canvas");
  c.width = 120;
  c.height = 80;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 120, 80);
  g.fillStyle = "#e5483b";
  g.fillRect(20, 16, 80, 48);
  const png = Uint8Array.from(atob(c.toDataURL("image/png").split(",")[1]), (ch) => ch.charCodeAt(0));
  const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
  window.__samples = { png, pdf };
}

/**
 * The composer, Claude's desktop composer in Figma's chrome (r13-composer): "+" (main's dialog), ⌘V of a picture (the
 * system clipboard through the real keys, then the paste event's own bytes), a drop, chips with ✕, the sent message's
 * chips and the paths in the turn; the model and effort menus (Antigravity's effort from its slugs, Claude Code's flag);
 * the usage ring and its card.
 */
async function composerSection(page, theme, { settle, shot, check, menus }) {
  await page.getByRole("button", { name: "New chat" }).click();
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);
  const composer = page.locator("[data-composer]");
  const input = page.locator("[data-agents-input]");
  const chips = composer.locator("[data-attachment-chip]");
  const layers = () => page.evaluate(() => window.__designerEditor.engine.readNode(window.__designerEditor.store.page, { childIds: true }).childIds.length);
  const layersBefore = await layers();

  // The bar: "+" on the left; model, effort, the usage ring and Send on the right, in one row.
  const bar = await page.evaluate(() => {
    const q = (s) => document.querySelector(`[data-composer] ${s}`)?.getBoundingClientRect();
    const r = { plus: q("[data-attach]"), model: q("[data-model-menu]"), effort: q("[data-effort-menu]"), ring: q("[data-usage]"), send: q("[data-agents-send]"), box: q("") ?? document.querySelector("[data-composer]").getBoundingClientRect() };
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && { x: Math.round(v.x), y: Math.round(v.y + v.height / 2), r: Math.round(v.right) }]));
  });
  check("Composer: + at the left; model, effort, usage ring, Send at the right, in order on one line", bar.plus.x < bar.model.x && bar.model.r <= bar.effort.x && bar.effort.r <= bar.ring.x && bar.ring.r <= bar.send.x && new Set([bar.plus.y, bar.model.y, bar.effort.y, bar.ring.y, bar.send.y]).size <= 2 && bar.send.r <= bar.box.r, JSON.stringify(bar));

  // "+": main's dialog (the stand-in picks a PDF).
  await composer.locator("[data-attach]").click();
  await chips.first().waitFor({ timeout: 3000 });
  check("Composer: + adds the picked file as a chip (a document glyph for a PDF)", (await chips.count()) === 1 && ((await chips.first().textContent()) ?? "").includes("Brief.pdf") && (await chips.first().locator("img").count()) === 0);

  // ⌘V of a picture copied anywhere (a screenshot): the real keys on the system clipboard.
  await page.evaluate(samples);
  let viaKeys = false;
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(async () => {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([window.__samples.png], { type: "image/png" }) })]);
    });
    await input.click();
    await page.keyboard.press("ControlOrMeta+V");
    await chips.nth(1).waitFor({ timeout: 1500 });
    viaKeys = true;
  } catch {
    // Headless keys may not reach the system clipboard: the paste event itself, as the OS sends it.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([window.__samples.png], "image.png", { type: "image/png" }));
      const el = document.querySelector("[data-agents-input]");
      el.focus();
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await chips.nth(1).waitFor({ timeout: 3000 });
  }
  await settle(page);
  check(`Composer: ⌘V of a copied picture attaches it as a chip with its thumbnail (${viaKeys ? "real keys, system clipboard" : "the paste event"})`, (await chips.count()) === 2 && (await chips.nth(1).locator("img").count()) === 1);
  check("Composer: ⌘V in the composer isn't the canvas's paste (no layer added), and no text went in", (await layers()) === layersBefore && (await input.inputValue()) === "");
  // Text still pastes as text.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "plain words");
    document.querySelector("[data-agents-input]").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check("Composer: a text paste stays text (no chip)", (await chips.count()) === 2);

  // A drop: a PDF and a file that isn't one of the kinds.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([window.__samples.pdf], "Spec.pdf", { type: "application/pdf" }));
    dt.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    const el = document.querySelector("[data-composer]");
    const r = el.getBoundingClientRect();
    const at = { clientX: r.x + r.width / 2, clientY: r.y + 20 };
    window.__drag = (type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    window.__drag("dragenter");
    window.__drag("dragover");
  });
  await page.locator("[data-composer][data-dragging]").waitFor({ timeout: 2000 });
  const highlighted = (await page.locator("[data-composer][data-dragging]").count()) === 1;
  await page.evaluate(() => window.__drag("drop"));
  await chips.nth(2).waitFor({ timeout: 3000 });
  await settle(page);
  check("Composer: dragging files over it highlights it; the drop attaches the PDF and says why the text file can't go", highlighted && (await page.locator("[data-composer][data-dragging]").count()) === 0 && (await chips.count()) === 3 && ((await composer.locator("[data-attach-problem]").textContent()) ?? "").includes("notes.txt"));
  check("Composer: the drop isn't the canvas's (no layer added)", (await layers()) === layersBefore);
  await input.fill("What's in these?");
  await shot(page, `407-agents-composer-files-${theme}`);
  await closeUp(page, "[data-composer]", `composer-attachments-${theme}`, 8);
  // ✕ takes one out.
  await chips.nth(2).locator("[data-attachment-remove]").click();
  check("Composer: ✕ removes a chip", (await chips.count()) === 2);

  // The usage ring (Claude Code: 42 % of the session, 66 % of the week — the week shows) and its card on hover.
  const ring = composer.locator("[data-usage]");
  check("Composer: the usage ring shows the plan's most used limit", (await ring.getAttribute("data-usage")) === "ok" && (await ring.locator("[data-usage-pct]").getAttribute("data-usage-pct")) === "66");
  await input.focus();
  await ring.hover();
  await page.locator("[data-usage-card]").waitFor({ timeout: 2000 });
  const cardText = (await page.locator("[data-usage-card]").textContent()) ?? "";
  check("Composer: hovering the ring shows the plan, each limit with its reset, and this chat's tokens", cardText.includes("Claude Pro") && (await page.locator("[data-usage-card] [data-usage-window]").count()) === 2 && cardText.includes("Resets Oct 10 at 3:59am") && cardText.includes("No tokens yet"), cardText);
  check("Composer: the card doesn't take the focus from the message", await page.evaluate(() => document.activeElement?.hasAttribute("data-agents-input")));
  await shot(page, `408-agents-usage-card-${theme}`);
  await closeUp(page, "[data-usage-card]", `composer-usage-card-${theme}`, 12);
  await page.mouse.move(10, 10);
  await page.locator("[data-usage-card]").waitFor({ state: "detached", timeout: 2000 });

  // Send: the message shows its files; the turn carries their paths.
  await input.press("Enter");
  await page.waitForSelector('[data-message="assistant"][data-state="done"]', { timeout: 8000 });
  await settle(page);
  const sent = await page.evaluate(() => [...window.__designerAgentsLog].reverse().find((l) => l.chatId && l.attachments));
  const userChips = page.locator('[data-message="user"] [data-message-attachments] [data-attachment-chip]');
  check("Composer: the sent message shows its files as chips; the composer is empty again", (await userChips.count()) === 2 && (await chips.count()) === 0 && (await input.inputValue()) === "");
  check("Composer: the turn tells the agent the files' paths in the chat's own folder", sent?.attachments?.length === 2 && sent.attachments.every((a) => a.path.includes(`/agents/work/${sent.chatId}/attachments/`)) && JSON.stringify(sent.attachments.map((a) => a.mime)) === JSON.stringify(["application/pdf", "image/png"]) && sent.effort === "high", JSON.stringify(sent?.attachments));
  await ring.hover();
  await page.locator("[data-usage-card]").waitFor({ timeout: 2000 });
  const after = (await page.locator("[data-usage-card]").textContent()) ?? "";
  check("Composer: after the turn the card counts its tokens and the session limit it reported", after.includes("1.3k tokens") && after.includes("44% used"), after);
  await page.mouse.move(10, 10);
  await shot(page, `409-agents-composer-sent-${theme}`);
  await closeUp(page, '[data-message="user"]', `composer-sent-${theme}`, 8);

  // Antigravity: 3.8 Flash keeps the effort picked (High, now its slug); its Gemini 5-hour limit at 81 % warns.
  await composer.getByRole("combobox", { name: "Model" }).click();
  await page.waitForTimeout(100);
  await closeUp(page, '[role="listbox"]', `composer-model-menu-${theme}`, 8);
  await page.getByRole("option", { name: "3.8 Flash" }).click();
  await settle(page);
  const agy = await menus();
  check("Composer: picking 3.8 Flash keeps the effort (High, as its slug); the ring warns at 81 %", JSON.stringify(agy) === JSON.stringify({ model: "3.8 Flash", effort: "High" }) && (await ring.getAttribute("data-usage")) === "warn", JSON.stringify(agy));
  await composer.getByRole("combobox", { name: "Effort" }).click();
  await page.waitForTimeout(100);
  const efforts = await page.locator('[role="listbox"] [role="option"]').allTextContents();
  check("Composer: the effort menu lists the model's efforts in order", JSON.stringify(efforts.map((e) => e.trim())) === JSON.stringify(["Low", "Medium", "High"]), JSON.stringify(efforts));
  await closeUp(page, '[role="listbox"]', `composer-effort-menu-${theme}`, 8);
  await page.getByRole("option", { name: "Low" }).click();
  await settle(page);
  await shot(page, `410-agents-composer-antigravity-${theme}`);
  await closeUp(page, "[data-composer]", `composer-antigravity-${theme}`, 8);
  await input.fill("Thanks");
  await input.press("Enter");
  await page.waitForTimeout(300);
  const agyTurn = await page.evaluate(() => [...window.__designerAgentsLog].reverse().find((l) => l.chatId));
  check("Composer: mid-chat the turn goes to Antigravity with the slug of the effort picked (gemini-3.8-flash-low)", agyTurn?.providerId === "antigravity" && agyTurn?.model === "gemini-3.8-flash-low" && !agyTurn?.effort, JSON.stringify({ p: agyTurn?.providerId, m: agyTurn?.model, e: agyTurn?.effort }));
  // 3.1 Pro has Low: the effort is kept.
  await composer.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "3.1 Pro" }).click();
  await settle(page);
  check("Composer: switching to 3.1 Pro keeps Low", JSON.stringify(await menus()) === JSON.stringify({ model: "3.1 Pro", effort: "Low" }));
  // LM Studio has no effort: the menu goes.
  await composer.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "qwen2.5-coder-14b" }).click();
  await settle(page);
  check("Composer: an agent without efforts hides the effort menu; one without limits leaves the ring empty", (await menus()).effort === null && (await ring.getAttribute("data-usage")) === "none");
}
