/**
 * The AI actions' prompts (docs/ai.md §3). Every system prompt starts with the same line; the context is a compact
 * layer outline — one line per layer: id, type, name, size, text (≤ 200 characters) — children indented, to depth 6,
 * at most 400 layers per call (the editor batches more). The answers' schemas are in `schemas.ts`.
 */
import type { Kit } from "./kits/types";

export const SYSTEM_PREFIX = "You are Figma AI inside a design editor. Answer with JSON only, matching the schema.";

export const OUTLINE_MAX_LAYERS = 400;
export const OUTLINE_MAX_DEPTH = 6;
export const OUTLINE_MAX_TEXT = 200;

export interface OutlineNode {
  id: string;
  type: string;
  name: string;
  width: number;
  height: number;
  text?: string;
  /** A note after the line: "rename", "repeat 2", "frame", "button?" … */
  mark?: string;
  children?: OutlineNode[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The outline as indented lines: `id TYPE "name" W×H "text" [mark]`. */
export function formatOutline(nodes: readonly OutlineNode[], depth = 0): string {
  const lines: string[] = [];
  const walk = (n: OutlineNode, d: number) => {
    const text = n.text !== undefined ? ` text=${JSON.stringify(clip(n.text, OUTLINE_MAX_TEXT))}` : "";
    lines.push(`${"  ".repeat(d)}${n.id} ${n.type} ${JSON.stringify(n.name)} ${Math.round(n.width)}×${Math.round(n.height)}${text}${n.mark ? ` [${n.mark}]` : ""}`);
    if (d - depth < OUTLINE_MAX_DEPTH - 1) for (const c of n.children ?? []) walk(c, d + 1);
  };
  for (const n of nodes) walk(n, depth);
  return lines.join("\n");
}

export interface PromptPair {
  system: string;
  prompt: string;
}

const system = (...lines: string[]) => [SYSTEM_PREFIX, ...lines].join("\n");

/** Rename layers: the layers marked [rename] get names (their parents are context). */
export function renamePrompt(outline: string): PromptPair {
  return {
    system: system(
      "Task: rename layers the way a careful designer would. Names are short (1–4 words, at most 60 characters), describe the layer's role or content (\"Header\", \"Sign up button\", \"Avatar\", \"Product card\"), use sentence case, and never repeat the layer type alone (\"Frame\", \"Group\").",
      "A text layer's name is its role, not its whole text. An image's name says what the image is for. Siblings that repeat take the same name.",
      'Answer {"names": [{"id", "name"}]} with one entry for every layer marked [rename], and none for the others.'
    ),
    prompt: `Layers (indented by nesting):\n${outline}`,
  };
}

export type TextTask = { kind: "rewrite"; prompt: string } | { kind: "shorten" } | { kind: "translate"; language: string };

/** Rewrite this… / Shorten / Translate to…: every listed text, rewritten. */
export function textPrompt(task: TextTask, texts: readonly { id: string; characters: string }[], context: string): PromptPair {
  const what =
    task.kind === "rewrite"
      ? `Rewrite each text as asked: ${JSON.stringify(task.prompt)}. Keep its meaning unless asked otherwise.`
      : task.kind === "shorten"
        ? "Shorten each text: keep its meaning and tone, use fewer words. A text that is already one or two words stays as it is."
        : `Translate each text to ${task.language}. Keep names of products and people, numbers, and line breaks.`;
  return {
    system: system(`Task: ${what}`, "Keep each text's role: a button stays a button label, a heading stays a heading. Keep line breaks where the text has them.", 'Answer {"texts": [{"id", "characters"}]} with one entry for every text listed.'),
    prompt: `Texts:\n${texts.map((t) => `${t.id}: ${JSON.stringify(t.characters)}`).join("\n")}\n\nWhere they are:\n${context}`,
  };
}

/**
 * Replace content: placeholder texts become realistic copy. `groups` lists the ids of repeated siblings (cards, rows),
 * whose texts must differ.
 */
export function replaceContentPrompt(texts: readonly { id: string; characters: string }[], groups: readonly (readonly string[])[], context: string, prompt?: string): PromptPair {
  return {
    system: system(
      "Task: replace placeholder content with realistic content that fits the design: names, titles, prices, dates, messages, descriptions. Match each text's role and roughly its length.",
      "Texts in the same group are repeated layers (list items, cards): give each a different, plausible value.",
      'Answer {"texts": [{"id", "characters"}]} with one entry for every text listed.'
    ),
    prompt: [
      prompt?.trim() ? `What the content is about: ${JSON.stringify(prompt.trim())}` : "",
      `Texts:\n${texts.map((t) => `${t.id}: ${JSON.stringify(t.characters)}`).join("\n")}`,
      groups.length ? `Groups (must differ):\n${groups.map((g) => g.join(", ")).join("\n")}` : "",
      `Where they are:\n${context}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/** Add interactions: connect the selected top-level frames. */
export function interactionsPrompt(frames: readonly { id: string; name: string }[], outline: string): PromptPair {
  return {
    system: system(
      "Task: prototype the flow between these screens. For each layer a person would click to go somewhere (buttons, links, tabs, list rows, cards) add an interaction: NAVIGATE to the screen it leads to, or BACK for back arrows, Cancel and Close.",
      "Only use the listed screens as destinations; never navigate a screen to itself. Layers marked [button?] are likely buttons. Leave out layers that don't lead anywhere.",
      'Answer {"interactions": [{"sourceId", "trigger": "ON_CLICK", "action": "NAVIGATE" | "BACK", "destinationId"}]}.'
    ),
    prompt: `Screens: ${frames.map((f) => `${f.id} ${JSON.stringify(f.name)}`).join(", ")}\n\nLayers:\n${outline}`,
  };
}

/** The kit's block catalogue as the model reads it. */
export function blockCatalogue(kit: Kit): string {
  return kit.blocks.map((b) => `- ${b.id}: ${b.description}. Props: ${Object.entries(b.props).map(([k, v]) => `${k} (${v})`).join("; ")}`).join("\n");
}

/** First Draft: a plan of the kit's blocks for the prompt (`previous`: the plan to change, for Make changes). */
export function firstDraftPrompt(prompt: string, kit: Kit, previous?: unknown): PromptPair {
  return {
    system: system(
      `Task: plan one ${kit.platform === "web" ? "website page (1440 wide)" : "mobile app screen (390 wide)"} from the blocks of this library, top to bottom, with realistic content in the blocks' props.`,
      kit.platform === "app" ? "An app screen usually starts with status-bar and top-bar and may end with tab-bar." : "A page usually starts with nav and ends with footer.",
      `Blocks:\n${blockCatalogue(kit)}`,
      `Answer {"name", "platform": "${kit.platform}", "blocks": [{"block", "props"}]}: name is the screen's name; use only the blocks above; lists are arrays of strings.`
    ),
    prompt: previous ? `The current plan:\n${JSON.stringify(previous)}\n\nChange it: ${prompt}` : prompt,
  };
}

/** Translate to…'s languages (Figma's list is [unverified]: these are ours, most used first). */
export const TRANSLATE_LANGUAGES: readonly string[] = [
  "English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Dutch",
  "Turkish",
  "Polish",
  "Russian",
  "Ukrainian",
  "Arabic",
  "Hebrew",
  "Hindi",
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Indonesian",
  "Vietnamese",
  "Thai",
  "Swedish",
  "Norwegian",
  "Danish",
  "Finnish",
  "Greek",
  "Czech",
];

/** First Draft's suggestions under the prompt [ours] */
export const FIRST_DRAFT_SUGGESTIONS: readonly string[] = ["A sign up screen for a meditation app", "A landing page for a coffee subscription", "A settings screen for a banking app", "A pricing page for a design tool"];
