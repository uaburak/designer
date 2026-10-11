import { randomInt } from "node:crypto";

/**
 * Plugins › Development › New plugin… (docs/plugins.md §6): the "Create a plugin" modal's templates — Figma design:
 * Default, Run once, Custom UI; Dev Mode: Inspect, Code Generator. Each is plain JavaScript with no build step
 * (`manifest.json`, `code.js`, and `ui.html` when it has a UI), written by main into the folder the person picks.
 * The code is ours, shaped like Figma's quickstart samples.
 */

export type TemplateId = "default" | "run-once" | "custom-ui" | "inspect" | "codegen";
export const TEMPLATE_IDS: readonly TemplateId[] = ["default", "run-once", "custom-ui", "inspect", "codegen"];
/** Which editor each template is for */
export const TEMPLATE_EDITOR: Record<TemplateId, "figma" | "dev"> = { default: "figma", "run-once": "figma", "custom-ui": "figma", inspect: "dev", codegen: "dev" };

/** A 19-digit decimal id, like the ids Figma gives plugins */
export const newPluginId = () => String(randomInt(1, 10)) + Array.from({ length: 18 }, () => randomInt(0, 10)).join("");

const UI_STYLE = `body { font: 12px Inter, system-ui, sans-serif; margin: 0; padding: 16px; color: var(--figma-color-text, #000); background: var(--figma-color-bg, #fff); }
    h2 { font-size: 13px; margin: 0 0 12px; }
    input { width: 100%; box-sizing: border-box; height: 32px; padding: 0 8px; margin-bottom: 12px; }
    button { height: 32px; padding: 0 12px; margin-right: 8px; }`;

const DEFAULT_CODE = `// This plugin creates rectangles on the screen.

// The code here runs in Figma's plugin sandbox (no browser APIs); it reaches the document through the figma global.
// The UI, if any, lives in ui.html and talks to this code with messages.

const COUNT = 5;
const nodes = [];
for (let i = 0; i < COUNT; i++) {
  const rect = figma.createRectangle();
  rect.x = i * 150;
  rect.fills = [{ type: "SOLID", color: { r: 1, g: 0.5, b: 0 } }];
  figma.currentPage.appendChild(rect);
  nodes.push(rect);
}
figma.currentPage.selection = nodes;
figma.viewport.scrollAndZoomIntoView(nodes);

// Always close the plugin when it is done; otherwise "Running <name>" stays until it is cancelled.
figma.closePlugin();
`;

const RUN_ONCE_CODE = `// A plugin that runs once and closes: it counts the selected layers.

const count = figma.currentPage.selection.length;
figma.closePlugin(count === 1 ? "1 layer selected" : count + " layers selected");
`;

const CUSTOM_UI_CODE = `// This plugin shows a UI (ui.html) that asks how many rectangles to create.

figma.showUI(__html__, { themeColors: true, width: 240, height: 160 });

// Messages from the UI arrive here: parent.postMessage({ pluginMessage: … }, "*") in ui.html.
figma.ui.onmessage = (msg) => {
  if (msg.type === "create-rectangles") {
    const nodes = [];
    for (let i = 0; i < msg.count; i++) {
      const rect = figma.createRectangle();
      rect.x = i * 150;
      rect.fills = [{ type: "SOLID", color: { r: 1, g: 0.5, b: 0 } }];
      figma.currentPage.appendChild(rect);
      nodes.push(rect);
    }
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
    figma.ui.postMessage({ type: "created", count: nodes.length });
  }
  if (msg.type === "cancel") figma.closePlugin();
};
`;

const CUSTOM_UI_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
    ${UI_STYLE}
    </style>
  </head>
  <body>
    <h2>Rectangle Creator</h2>
    <label for="count">Count</label>
    <input id="count" type="number" value="5" min="1" max="100" />
    <button id="create">Create</button>
    <button id="cancel">Cancel</button>
    <script>
      document.getElementById("create").onclick = () => {
        const count = Number(document.getElementById("count").value) || 0;
        parent.postMessage({ pluginMessage: { type: "create-rectangles", count } }, "*");
      };
      document.getElementById("cancel").onclick = () => parent.postMessage({ pluginMessage: { type: "cancel" } }, "*");
      // Messages from code.js: figma.ui.postMessage(…) arrives as event.data.pluginMessage.
      onmessage = (event) => {
        const msg = event.data.pluginMessage;
        if (msg && msg.type === "created") document.querySelector("h2").textContent = "Created " + msg.count;
      };
    </script>
  </body>
</html>
`;

const INSPECT_CODE = `// A Dev Mode plugin that shows details of the selected layer in the Plugins panel.

figma.showUI(__html__, { themeColors: true });

function describe() {
  const node = figma.currentPage.selection[0];
  figma.ui.postMessage(node ? { name: node.name, type: node.type, width: Math.round(node.width), height: Math.round(node.height) } : null);
}

figma.on("selectionchange", describe);
describe();
`;

const INSPECT_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
    ${UI_STYLE}
    </style>
  </head>
  <body>
    <div id="out">Select a layer</div>
    <script>
      onmessage = (event) => {
        const info = event.data.pluginMessage;
        document.getElementById("out").textContent = info ? info.name + " — " + info.type + ", " + info.width + " × " + info.height : "Select a layer";
      };
    </script>
  </body>
</html>
`;

const CODEGEN_CODE = `// A Dev Mode codegen plugin: Inspect › Code shows what "generate" returns for the selected layer.

figma.codegen.on("generate", async (event) => {
  const node = event.node;
  const lines = [
    "width: " + Math.round(node.width) + "px;",
    "height: " + Math.round(node.height) + "px;",
  ];
  if ("opacity" in node && node.opacity !== 1) lines.push("opacity: " + node.opacity + ";");
  return [{ language: "CSS", code: lines.join("\\n"), title: node.name }];
});
`;

export interface TemplateFiles {
  "manifest.json": string;
  "code.js": string;
  "ui.html"?: string;
}

/** The files of a new plugin made from `template`, named `name`. */
export function templateFiles(template: TemplateId, name: string, id = newPluginId()): TemplateFiles {
  const editor = TEMPLATE_EDITOR[template];
  const withUi = template === "custom-ui" || template === "inspect";
  const manifest: Record<string, unknown> = {
    name,
    id,
    api: "1.0.0",
    main: "code.js",
    ...(withUi ? { ui: "ui.html" } : {}),
    editorType: [editor],
    ...(template === "inspect" ? { capabilities: ["inspect"] } : {}),
    ...(template === "codegen" ? { capabilities: ["codegen"], codegenLanguages: [{ label: "CSS", value: "css" }] } : {}),
    documentAccess: "dynamic-page",
    networkAccess: { allowedDomains: ["none"] },
  };
  const code = { default: DEFAULT_CODE, "run-once": RUN_ONCE_CODE, "custom-ui": CUSTOM_UI_CODE, inspect: INSPECT_CODE, codegen: CODEGEN_CODE }[template];
  const files: TemplateFiles = { "manifest.json": JSON.stringify(manifest, null, 2) + "\n", "code.js": code };
  if (template === "custom-ui") files["ui.html"] = CUSTOM_UI_HTML;
  if (template === "inspect") files["ui.html"] = INSPECT_HTML;
  return files;
}
