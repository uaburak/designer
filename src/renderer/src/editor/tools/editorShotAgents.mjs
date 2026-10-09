// editor-shot's Agents section (EDITOR_ONLY=agents; docs/research/figma/R12-agents-mcp.md): the Agents tab and the
// right panel's MCP section in a browser, with a stand-in for main (`window.__designerAgents`, installed before the
// page loads) that plays an agent's turn — its text, its steps, and real tool calls run by the page on the engine —
// so the flagship flow is driven end to end: a desktop frame selected → "Make the mobile version of this" → a 390
// frame next to it, one undo step, Undo / Apply from the chat. No real agent or model is involved.
/* global window, setTimeout */

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
  window.__designerAgentsLog = [];
  window.__designerAgents = {
    providers: async () => [
      { id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, detail: "/Users/you/.local/bin/claude", models: ["default", "sonnet", "opus", "haiku"] },
      { id: "codex", kind: "codex", label: "Codex", available: false, models: ["default"], problem: "codex isn't installed" },
      { id: "ollama", kind: "openai-compatible", label: "Ollama", available: false, detail: "http://localhost:11434/v1", models: [], problem: "Not running at http://localhost:11434/v1" },
      { id: "lmstudio", kind: "openai-compatible", label: "LM Studio", available: true, detail: "http://localhost:1234/v1", models: ["qwen2.5-coder-14b", "llama-3.1-8b"] },
    ],
    settings: async () => settings,
    setSettings: async (p) => Object.assign(settings, p.providerId !== undefined ? { providerId: p.providerId } : {}, p.models ? { models: { ...settings.models, ...p.models } } : {}),
    addServer: async () => settings,
    removeServer: async () => settings,
    test: async () => ({ ok: true, models: ["default"] }),
    stop: async () => {},
    onEvent: (cb) => (listeners.event.add(cb), () => listeners.event.delete(cb)),
    onToolCall: (h) => ((toolHandler = h), () => (toolHandler = null)),
    mcp: async () => mcp,
    onMcpState: (cb) => (listeners.mcp.add(cb), () => listeners.mcp.delete(cb)),
    clients: async () => [
      { id: "claude-code", label: "Claude Code", installed: true, configPath: "~/.claude.json", connected: true },
      { id: "cursor", label: "Cursor", installed: true, configPath: "~/.cursor/mcp.json", connected: false },
      { id: "vscode", label: "VS Code", installed: true, configPath: "~/Library/Application Support/Code/User/mcp.json", connected: false },
      { id: "antigravity", label: "Antigravity", installed: true, configPath: "~/.gemini/config/mcp_config.json", connected: false },
      { id: "gemini", label: "Gemini CLI", installed: false, configPath: "~/.gemini/settings.json", connected: false },
      { id: "codex", label: "Codex", installed: false, configPath: "~/.codex/config.toml", connected: false },
    ],
    connect: async () => ({ ok: true, path: "~/.cursor/mcp.json" }),
    disconnect: async () => ({ ok: true, path: "" }),
    clientConfig: async () => ({ path: "~/.cursor/mcp.json", text: "{}", stdio: "{}" }),
    // The scripted agent: reads the selected frame, makes its mobile version, selects it, answers.
    turn: async (req) => {
      const turnId = `turn-${Date.now()}`;
      window.__designerAgentsLog.push(req);
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
  check("Agents: the steps are listed", (await page.locator('[data-message="assistant"] [data-tool]').count()) === 4);
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

  // Agent settings: the agents found, a server by URL, the MCP server and Connect.
  await page.locator("[data-agents-settings]").click();
  await page.waitForSelector("[data-agent-settings]");
  await page.waitForTimeout(150);
  check("Agents: settings list Claude Code (found) and Ollama (not running)", (await page.locator('[data-provider="claude-code"][data-available]').count()) === 1 && (await page.locator('[data-provider="ollama"]:not([data-available])').count()) === 1);
  check("Agents: Connect to Antigravity / Cursor / VS Code, and Claude Code connected", (await page.getByRole("button", { name: "Connect to Antigravity" }).count()) === 1 && (await page.getByRole("button", { name: "Connect to Cursor" }).count()) === 1 && (await page.getByRole("button", { name: "Connect to VS Code" }).count()) === 1 && (await page.locator('[data-client="claude-code"][data-connected]').count()) === 1);
  check("Agents: the MCP server's URL is shown", ((await page.locator("[data-mcp-url]").textContent()) ?? "").includes("127.0.0.1"));
  await shot(page, `403-agents-settings-${theme}`);
  await page.locator("[data-agent-settings]").getByRole("button", { name: "Back" }).click();
  await settle(page);
  check("Agents: Back lists the chat", (await page.locator("[data-chat]").count()) === 1);
  await shot(page, `404-agents-chats-${theme}`);
}
