// editor-shot's agents' reach section (EDITOR_ONLY=reach; docs/agents-reach.md §2, §3, §9): Agent settings › Access with
// a stand-in for main's side (`reach` on `window.__designerAgents`, installed before the page loads) — the group's rows
// and their policies, the Web page (Ask each time, an allowed local address added), GitHub's connection, Local files'
// folders, Local apps' Screen Recording, the access log — and in a chat the consent card of a web page and the window
// picker of Local apps, each answered. No real browser call, repository, folder or window is involved.
/* global window, document, setTimeout */
import { installMockAgents } from "./editorShotAgents.mjs";

/** Main's reach and a turn that asks for it, on top of the Agents section's stand-in. */
export function installMockReach() {
  const base = window.__designerAgents;
  const listeners = new Set();
  const consents = new Set();
  const answers = new Map();
  let seq = 0;
  const emit = (turnId, chatId, event) => listeners.forEach((cb) => cb({ turnId, chatId, event }));
  const view = {
    settings: { policies: { web: "ask", github: "off", files: "allow", apps: "ask" }, web: { allowedHosts: [] }, github: { repos: [] }, files: { folders: ["/Users/you/Projects/b2c-web"] } },
    forcedOff: ["github"],
    github: { connected: false, login: null, via: null, deviceFlow: false },
    screenPermission: "denied",
  };
  const log = [
    { at: Date.now() - 60_000, capability: "web", tool: "open_web_page", target: "https://example.com/pricing", outcome: "ok", agent: "Claude Code" },
    { at: Date.now() - 50_000, capability: "web", tool: "capture_web_design", target: "http://192.168.1.20/", outcome: "refused", detail: "a private address", agent: "Claude Code" },
    { at: Date.now() - 40_000, capability: "files", tool: "read_file", target: "/Users/you/Projects/b2c-web/tailwind.config.ts", outcome: "ok", agent: "Claude Code" },
    { at: Date.now() - 30_000, capability: "apps", tool: "capture_app_window", target: "", outcome: "denied", agent: "Claude Code" },
  ];
  window.__reachLog = [];
  const connectors = [{ id: "con_notion", name: "Notion", transport: { kind: "http", url: "https://mcp.notion.com/mcp", hasKey: false }, enabled: true, tools: [], state: "sign-in" }];
  const copy = () => JSON.parse(JSON.stringify(view));
  // A thumbnail of a window: a grey title bar over a coloured body.
  const thumb = (color) => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 100;
    const g = c.getContext("2d");
    g.fillStyle = color;
    g.fillRect(0, 0, 160, 100);
    g.fillStyle = "#d9d9d9";
    g.fillRect(0, 0, 160, 14);
    return c.toDataURL("image/png");
  };
  const ask = (turnId, chatId, tool, access) =>
    new Promise((resolve) => {
      const reqId = ++seq;
      answers.set(reqId, resolve);
      consents.forEach((cb) => cb({ reqId, turnId, chatId, connectorId: "reach", connector: "Claude Code", tool, args: {}, access }));
    });
  const reachTurn = async (turnId, req) => {
    emit(turnId, req.chatId, { type: "text", delta: "I’ll look at the page first." });
    const web = await ask(turnId, req.chatId, "open_web_page", { capability: "web", action: "open a web page", target: "https://example.com/pricing" });
    window.__reachLog.push({ web });
    emit(turnId, req.chatId, { type: "text", delta: " Now the app’s window." });
    const app = await ask(turnId, req.chatId, "capture_app_window", { capability: "apps", action: "see a window", target: "", windows: [{ id: "w1", name: "Safari — Pricing", thumb: thumb("#e8f0fe") }, { id: "w2", name: "Xcode — B2C", thumb: thumb("#2b2d42") }, { id: "w3", name: "Notes", thumb: thumb("#fff5cc") }] });
    window.__reachLog.push({ app });
    emit(turnId, req.chatId, { type: "text", delta: "\n\nDone." });
    emit(turnId, req.chatId, { type: "done" });
  };
  window.__designerAgents = {
    ...base,
    onEvent: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    onConsent: (cb) => (consents.add(cb), () => consents.delete(cb)),
    answerConsent: (reqId, allow, remember, windowId) => {
      answers.get(reqId)?.({ allow, remember: !!remember, ...(windowId ? { windowId } : {}) });
      answers.delete(reqId);
    },
    turn: async (req) => {
      const turnId = `turn-${++seq}`;
      setTimeout(() => void reachTurn(turnId, req), 30);
      return { turnId };
    },
    // A connector whose server wants a sign-in (OAuth, docs/ai.md §2.11): signed in "in the browser", then its tools.
    connectors: async () => connectors.map((c) => ({ ...c })),
    updateConnector: async () => connectors,
    removeConnector: async () => connectors,
    testConnector: async (id) => connectors.find((c) => c.id === id),
    signInConnector: async (id) => {
      window.__reachLog.push({ signIn: id });
      Object.assign(connectors[0], { state: "connected", transport: { ...connectors[0].transport, signedIn: true }, tools: [{ name: "search", description: "Search pages", policy: "ask" }, { name: "create_page", description: "Create a page", policy: "ask" }] });
      return { ...connectors[0] };
    },
    signOutConnector: async () => (Object.assign(connectors[0], { state: "sign-in", transport: { ...connectors[0].transport, signedIn: false }, tools: [] }), connectors),
    reach: {
      view: async () => copy(),
      set: async (p) => {
        window.__reachLog.push({ set: p });
        if (p.policies) Object.assign(view.settings.policies, p.policies);
        if (p.allowedHosts) view.settings.web.allowedHosts = p.allowedHosts;
        if (p.repos) view.settings.github.repos = p.repos;
        if (p.folders) view.settings.files.folders = p.folders;
        return copy();
      },
      addFolder: async () => (view.settings.files.folders.push("/Users/you/Projects/design-tokens"), copy()),
      log: async () => log.slice().reverse(),
      clearLog: async () => void log.splice(0),
      githubToken: async () => copy(),
      githubDeviceStart: async () => ({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900 }),
      githubDevicePoll: async () => ({ state: "pending" }),
      githubDisconnect: async () => copy(),
      githubRepos: async () => [],
      openScreenSettings: async () => void window.__reachLog.push({ screenSettings: true }),
    },
  };
}

export async function reachSection(page, theme, { open, settle, shot, check }) {
  await page.addInitScript(installMockAgents);
  await page.addInitScript(installMockReach);
  await open(page, "&doc=empty");
  await settle(page);
  await page.locator('[data-rail-tab="agents"]').click();
  await page.waitForSelector("[data-composer]");
  await page.getByRole("button", { name: "Agent settings" }).first().click();
  await page.waitForSelector("[data-access]");
  const policies = await page.$$eval("[data-access]", (els) => els.map((e) => `${e.getAttribute("data-access")}:${e.getAttribute("data-access-policy")}`));
  check("Access: the group lists Web, GitHub, Local files, Local apps with their policies (GitHub turned off by the org)", JSON.stringify(policies) === JSON.stringify(["web:ask", "github:forced-off", "files:allow", "apps:ask"]), JSON.stringify(policies));
  await page.locator('[data-access="web"]').scrollIntoViewIfNeeded();
  await shot(page, `480-reach-access-group-${theme}`);

  // Web: Ask each time, an allowed local address.
  await page.locator('[data-access="web"]').click();
  await page.waitForSelector('[data-access-page="web"]');
  await page.locator("[data-allowed-host-input] input").fill("localhost:5173");
  await page.locator("[data-allowed-host-add]").click();
  await page.waitForSelector('[data-allowed-host="localhost:5173"]');
  check("Access › Web: an allowed local address is added", (await page.evaluate(() => JSON.stringify(window.__reachLog.at(-1)))) === JSON.stringify({ set: { allowedHosts: ["localhost:5173"] } }));
  await shot(page, `481-reach-web-${theme}`);
  await page.getByRole("button", { name: "Back" }).first().click();

  // GitHub, turned off by the organization: its select disabled, the reason said.
  await page.locator('[data-access="github"]').click();
  await page.waitForSelector('[data-access-page="github"]');
  check("Access › GitHub: turned off by the organization — the select disabled, the reason said", (await page.locator('[data-access-select="github"] [role="combobox"]').isDisabled()) && ((await page.locator('[data-access-page="github"]').textContent()) ?? "").includes("Your organization turned this off"));
  await shot(page, `482-reach-github-${theme}`);
  await page.getByRole("button", { name: "Back" }).first().click();

  // Local files: the granted folder, Add folder….
  await page.locator('[data-access="files"]').click();
  await page.waitForSelector('[data-access-page="files"]');
  await page.locator("[data-access-add-folder]").click();
  await page.waitForFunction(() => document.querySelectorAll("[data-access-folder]").length === 2);
  check("Access › Local files: the granted folders, one more from Add folder…", (await page.locator("[data-access-folder]").count()) === 2);
  await shot(page, `483-reach-files-${theme}`);
  await page.getByRole("button", { name: "Back" }).first().click();

  // Local apps: Screen Recording not allowed yet, Open System Settings.
  await page.locator('[data-access="apps"]').click();
  await page.waitForSelector('[data-access-page="apps"]');
  check("Access › Local apps: Screen Recording not allowed yet, with Open System Settings", (await page.locator('[data-screen-permission="denied"]').count()) === 1 && (await page.locator("[data-screen-settings]").count()) === 1);
  await shot(page, `484-reach-apps-${theme}`);
  await page.getByRole("button", { name: "Back" }).first().click();

  // The access log, newest first, each outcome.
  await page.locator('[data-settings-row="access-log"]').click();
  await page.waitForSelector("[data-access-log]");
  const outcomes = await page.$$eval("[data-log-outcome]", (els) => els.map((e) => e.getAttribute("data-log-outcome")));
  check("Access log: the calls newest first, with their outcomes", JSON.stringify(outcomes) === JSON.stringify(["denied", "ok", "refused", "ok"]), JSON.stringify(outcomes));
  await shot(page, `485-reach-log-${theme}`);
  await page.getByRole("button", { name: "Back" }).first().click();

  // A connector whose server wants a sign-in (OAuth): Sign in needed in the list; its page signs in, then lists its tools.
  const notion = page.locator('[data-connector="con_notion"]');
  await notion.scrollIntoViewIfNeeded();
  check("Connectors: a server that wants a sign-in says Sign in needed", ((await notion.textContent()) ?? "").includes("Sign in needed"), (await notion.textContent()) ?? "");
  await notion.click();
  await page.waitForSelector('[data-connector-page="con_notion"]');
  check("Connectors › Notion: Not signed in, with Sign in", (await page.locator('[data-connector-account="signed-out"]').count()) === 1 && (await page.locator("[data-connector-sign-in]").count()) === 1);
  await shot(page, `488-reach-connector-sign-in-${theme}`);
  await page.locator("[data-connector-sign-in]").click();
  await page.waitForSelector('[data-connector-account="signed-in"]');
  check("Connectors › Notion: signed in — its tools listed at Ask, Sign out offered, Sign in gone", (await page.locator("[data-connector-tool]").count()) === 2 && (await page.locator("[data-connector-sign-out]").count()) === 1 && (await page.locator("[data-connector-sign-in]").count()) === 0);
  await shot(page, `489-reach-connector-signed-in-${theme}`);
  await page.getByRole("button", { name: "Back" }).first().click();
  await page.getByRole("button", { name: "Back" }).first().click();

  // In a chat: the web page's card, then the window picker; each answered.
  await page.waitForSelector("[data-composer]");
  await page.locator("[data-composer] textarea").fill("Look at example.com/pricing and the app, then design it");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-access-consent="web"]');
  check("A chat: the web card names the page, with Allow once / Always allow / Deny", ((await page.locator('[data-access-consent="web"]').textContent()) ?? "").includes("https://example.com/pricing") && (await page.locator("[data-consent-once], [data-consent-always], [data-consent-deny]").count()) === 3);
  await shot(page, `486-reach-web-card-${theme}`);
  await page.locator("[data-consent-once]").click();
  await page.waitForSelector('[data-access-consent="apps"]');
  check("A chat: the window picker lists the windows as tiles, with Deny", (await page.locator("[data-window-pick]").count()) === 3 && (await page.locator("[data-consent-deny]").count()) === 1);
  await shot(page, `487-reach-window-picker-${theme}`);
  await page.locator('[data-window-pick="w2"]').click();
  await page.waitForFunction(() => window.__reachLog.some((e) => e.app));
  const answered = await page.evaluate(() => window.__reachLog.filter((e) => e.web || e.app));
  check("A chat: Allow once answers the web card; a tile's click is the window picked", JSON.stringify(answered) === JSON.stringify([{ web: { allow: true, remember: false } }, { app: { allow: true, remember: false, windowId: "w2" } }]), JSON.stringify(answered));
}
