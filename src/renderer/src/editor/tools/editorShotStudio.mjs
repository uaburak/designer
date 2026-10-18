// editor-shot's Studio section (EDITOR_ONLY=studio; docs/studio.md §2.3, §2.4, §4.1, §5.2, §6.1): the manager's cards in
// the Agents tab, with a stand-in for main (`window.__designerAgents`, installed before the page loads) whose manager
// turn calls the manager's real tools, answered by the page — two worker tasks (one running, one queued on it), the
// choice card, the brand form, the review with its boxes on the frame's thumbnail — and whose worker turns finish when
// the shot opens their gate. Then a task card's prompt edited and run again: a new task in the same answer; and the
// Brands tab (docs/studio.md §3.2): the brand the chat's form saved, its page, a product added with its label texts.
// No real agent or model is involved.
/* global window, document, setTimeout */
import { desktopFrame, installMockAgents } from "./editorShotAgents.mjs";

/** The stand-in's manager and workers, on top of the Agents section's stand-in (its providers, settings, events). */
export function installMockManager() {
  const base = window.__designerAgents;
  const listeners = new Set();
  let toolHandler = null;
  let reqId = 0;
  const emit = (turnId, chatId, event) => listeners.forEach((cb) => cb({ turnId, chatId, event }));
  const call = (turnId, name, args) => toolHandler({ reqId: ++reqId, turnId, client: "Claude Code", name, args });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const gates = {};
  const opened = {};
  const gate = (name) => new Promise((r) => (opened[name] ? (delete opened[name], r()) : (gates[name] = r)));
  window.__studioOpen = (name) => (gates[name] ? (gates[name](), delete gates[name]) : (opened[name] = true));
  window.__studioLog = [];
  let seq = 0;
  // The manager: hands out two tasks, asks which image model, opens the brand form, then reports a review.
  const managerTurn = async (turnId, req) => {
    emit(turnId, req.chatId, { type: "text", delta: "I’ll hand this out: the frame first, then its relayout." });
    const first = JSON.parse((await call(turnId, "delegate_task", { title: "Frame: Liq Humus — Post v1", prompt: "Make one social post frame for Partner Agro.\n1. A top-level FRAME named exactly “Liq Humus — Post v1”, 1080 × 1350.\n2. Its bottom layer: a RECTANGLE named exactly “Picture”." })).content[0].text);
    const second = JSON.parse((await call(turnId, "delegate_task", { title: "Relayout: Liq Humus — Post v1", prompt: "Move the logo inside the safe area.", dependsOn: [first.taskId] })).content[0].text);
    window.__studioLog.push({ first, second });
    const choice = await call(turnId, "ask_choice", {
      question: "Which image model should make the pictures?",
      options: [
        { id: "gemini-pro", label: "Nano Banana Pro", detail: "Gemini API · the best text and detail" },
        { id: "gemini", label: "Nano Banana", detail: "Gemini API · quick" },
        { id: "antigravity", label: "Antigravity", detail: "Your Google AI plan" },
      ],
      remember: true,
    });
    window.__studioLog.push({ choice: choice.content[0].text });
    const form = await call(turnId, "show_form", { form: "brand", prefill: { name: "Partner Agro" } });
    window.__studioLog.push({ form: form.content[0].text });
    await call(turnId, "wait_tasks", { taskIds: [first.taskId, second.taskId], timeoutSec: 60 });
    const review = call(turnId, "report_review", {
      report: {
        items: [
          {
            nodeId: "7:1",
            ok: false,
            problems: [
              { id: "p1", kind: "sharp-text", detail: "“LIQ HUMUS” reads “LIQ HUMOS”", box: { x: 80, y: 160, width: 1100, height: 94 } },
              { id: "p2", kind: "layout", detail: "the button sits under the cards’ row", box: { x: 80, y: 350, width: 200, height: 56 } },
            ],
          },
          { nodeId: "7:8", ok: true, problems: [] },
        ],
      },
    });
    window.__studioLog.push({ review: (await review).content[0].text });
    emit(turnId, req.chatId, { type: "text", delta: "\n\nThe review is above: tell me what to fix." });
    emit(turnId, req.chatId, { type: "done" });
  };
  // A worker: a step, its words, done when its gate opens (the first one's "worker", the next ones' "worker-<n>").
  const workerTurn = async (turnId, req, n) => {
    emit(turnId, req.chatId, { type: "tool", id: `w${n}`, name: "create_nodes", state: "running" });
    await wait(40);
    emit(turnId, req.chatId, { type: "tool", id: `w${n}`, name: "create_nodes", state: "done" });
    await gate(n === 1 ? "worker" : `worker-${n}`);
    emit(turnId, req.chatId, { type: "text", delta: `Made “Liq Humus — Post v1” (${n}).` });
    emit(turnId, req.chatId, { type: "usage", usage: { input: 4000, output: 1000 } });
    emit(turnId, req.chatId, { type: "done" });
  };
  window.__designerAgents = {
    ...base,
    // The manager on (the Agents section's stand-in has it off).
    settings: async () => {
      const s = await base.settings();
      return { ...s, manager: { ...s.manager, enabled: true } };
    },
    onEvent: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    onToolCall: (h) => ((toolHandler = h), () => (toolHandler = null)),
    stop: async () => {},
    turn: async (req) => {
      const turnId = `turn-${++seq}`;
      window.__studioLog.push({ role: req.role ?? null, prompt: req.prompt.slice(-80) });
      if (req.role === "worker") setTimeout(() => void workerTurn(turnId, req, seq - 1), 30);
      else setTimeout(() => void managerTurn(turnId, req), 30);
      return { turnId };
    },
  };
}

export async function studioSection(page, theme, { open, settle, shot, check }) {
  await page.addInitScript(installMockAgents);
  await page.addInitScript(installMockManager);
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.command("ZOOM_TO_FIT");
  }, desktopFrame());
  await settle(page);
  await page.locator('[data-rail-tab="agents"]').click();
  await page.waitForSelector("[data-composer]");
  await page.locator("[data-composer] textarea").fill("Partner Agro’s Liq Humus needs a post");
  await page.keyboard.press("Enter");

  // Two task cards: the first running, the second queued on it; the choice card waits.
  await page.waitForSelector('[data-card="choice"][data-card-open]');
  const states = () => page.$$eval("[data-task]", (els) => els.map((e) => e.getAttribute("data-task-state")));
  check("Studio: the manager's answer shows a task card per task — running, then queued on it", JSON.stringify(await states()) === JSON.stringify(["running", "queued"]), JSON.stringify(await states()));
  const meta = ((await page.locator("[data-task]").first().textContent()) ?? "").trim();
  check("Studio: a task card names its agent and model and its state", /Claude Code · Sonnet 5\.5 · Running/.test(meta), meta);
  check("Studio: the choice card lists its options with “Use this for this chat”", (await page.locator("[data-choice]").count()) === 3 && (await page.locator("[data-choice-remember]").count()) === 1);
  await shot(page, `470-studio-tasks-choice-${theme}`);
  await page.locator('[data-choice="gemini-pro"]').click();

  // The brand form in the chat, prefilled.
  await page.waitForSelector('[data-card="brand-form"][data-card-open]');
  check("Studio: the brand form opens in the chat, its name prefilled", (await page.locator('[data-card="brand-form"] input[aria-label="Brand name"]').inputValue()) === "Partner Agro");
  await page.locator('[data-card="brand-form"]').getByRole("button", { name: "Add colour" }).click();
  await page.locator('[data-card="brand-form"] input[aria-label="Colour 1 name"]').fill("Leaf");
  await page.locator('[data-card="brand-form"] input[aria-label="Colour 1 hex"]').fill("#1BA37A");
  await page.locator('[data-card="brand-form"] input[aria-label="Colour 1 hex"]').press("Enter");
  await shot(page, `471-studio-brand-form-${theme}`);
  await page.locator('[data-card="brand-form"] [data-save]').click();
  await page.waitForFunction(() => window.__studioLog.some((e) => e.form && e.form.includes("brandId")));

  // The workers finish: both cards done, with their credits; the review card with its boxes on the thumbnail.
  await page.evaluate(() => window.__studioOpen("worker"));
  await page.waitForFunction(() => document.querySelectorAll('[data-task][data-task-state="running"]').length === 1);
  await page.evaluate(() => window.__studioOpen("worker-2"));
  await page.waitForSelector('[data-card="review"][data-card-open]');
  await page.waitForFunction(() => document.querySelector("[data-review-item] img"));
  check("Studio: both tasks done, with their credits", JSON.stringify(await states()) === JSON.stringify(["done", "done"]) && ((await page.locator("[data-task]").first().textContent()) ?? "").includes("2 credits"), JSON.stringify(await states()));
  const boxes = await page.$$eval('[data-review-item="7:1"] [class*="reviewBox"]', (els) => els.map((e) => e.style.left));
  check("Studio: the review card lists each frame, its problems with their boxes on its thumbnail; the frame without problems ✓", boxes.length === 2 && (await page.locator("[data-problem]").count()) === 2 && (await page.locator('[data-review-item="7:8"][data-review-ok]').count()) === 1, JSON.stringify(boxes));
  await page.locator("[data-review-item]").first().scrollIntoViewIfNeeded();
  await shot(page, `472-studio-review-${theme}`);
  await page.locator("[data-review-leave]").click();
  await page.waitForSelector("[data-agents-send]");

  // Run again (§5.2): the first card opened, its prompt edited, a new task beside it in the same answer.
  await page.locator("[data-task]").first().locator("[data-task-toggle]").click();
  await page.locator("[data-task]").first().locator("summary").click();
  await page.locator("[data-task-edit]").click();
  const edit = page.locator("[data-task-prompt-edit]");
  check("Studio: Edit puts the task's prompt in a text box", ((await edit.inputValue()) ?? "").startsWith("Make one social post frame"));
  await edit.fill("Make the headline larger, “Liq Humus” in the brand’s green.");
  await page.locator("[data-task]").first().scrollIntoViewIfNeeded();
  await shot(page, `473-studio-task-edit-${theme}`);
  await page.locator("[data-task-again]").click();
  await page.waitForFunction(() => document.querySelectorAll("[data-task]").length === 3);
  const again = await page.evaluate(() => window.__studioLog.filter((e) => e.role === "worker").at(-1)?.prompt ?? "");
  check("Studio: Run again starts a worker with the edited prompt, a third card in the same answer", again.endsWith("Make the headline larger, “Liq Humus” in the brand’s green.") && JSON.stringify(await states()) === JSON.stringify(["done", "done", "running"]), JSON.stringify(again.slice(-60)));
  await page.evaluate(() => window.__studioOpen("worker-3"));
  await page.waitForFunction(() => document.querySelectorAll('[data-task][data-task-state="done"]').length === 3);
  await shot(page, `474-studio-run-again-${theme}`);

  // The Brands tab: the brand the chat's form saved, its page, a product added with its label texts, the product's page.
  await page.locator('[data-rail-tab="brands"]').click();
  await page.waitForSelector("[data-brand]");
  check("Brands: the brand saved from the chat's form is listed", ((await page.locator("[data-brand]").textContent()) ?? "").includes("Partner Agro"));
  await shot(page, `475-studio-brands-list-${theme}`);
  await page.locator("[data-brand]").click();
  await page.waitForSelector("[data-brand-page]");
  const brandPage = (await page.locator("[data-brand-page]").textContent()) ?? "";
  check("Brands: the brand's page shows its colour and formats", brandPage.includes("#1BA37A") && brandPage.includes("1080 × 1350"), brandPage.slice(0, 120));
  await shot(page, `476-studio-brand-page-${theme}`);
  await page.getByRole("button", { name: "Add product" }).click();
  const form = page.locator("[data-product-form]");
  await form.locator('input[aria-label="Product name"]').fill("Liq Humus");
  await form.locator('textarea[aria-label="Shape"]').fill("20 L white jerrycan, handle top left");
  await form.getByRole("button", { name: "Add text" }).click();
  await form.locator('input[aria-label="Label text 1"]').fill("LIQ HUMUS");
  await form.getByRole("button", { name: "Add text" }).click();
  await form.locator('input[aria-label="Label text 2"]').fill("İçindekiler: hümik asit %12");
  await shot(page, `477-studio-product-form-${theme}`);
  await form.locator("[data-save]").click();
  await page.waitForSelector("[data-product-page]");
  const productPage = (await page.locator("[data-product-page]").textContent()) ?? "";
  check("Brands: the product's page shows its shape, its label texts and Read label off without a photo", productPage.includes("20 L white jerrycan") && (await page.locator('[data-product-page] input[aria-label="Label text"]').count()) === 2 && (await page.locator("[data-read-labels]").isDisabled()), productPage.slice(0, 120));
  await shot(page, `478-studio-product-page-${theme}`);
}
