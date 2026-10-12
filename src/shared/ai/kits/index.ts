/**
 * First Draft's "Library" choices (docs/ai.md §3): "App wireframe", "Website wireframe", "App design", "Website design"
 * [our names], plus Auto (picked from the prompt).
 */
import { APP_BLOCKS, WEB_BLOCKS } from "./blocks";
import { DESIGN_THEMES, WIREFRAME_THEMES } from "./themes";
import type { Kit, KitId } from "./types";

export * from "./types";
export { APP_BLOCKS, WEB_BLOCKS } from "./blocks";
export { COLOR_PRESETS, DESIGN_THEMES, FONT_CHOICES, WIREFRAME_THEMES } from "./themes";

export const KITS: readonly Kit[] = [
  { id: "app-wireframe", name: "App wireframe", platform: "app", style: "wireframe", width: 390, blocks: APP_BLOCKS, themes: WIREFRAME_THEMES },
  { id: "web-wireframe", name: "Website wireframe", platform: "web", style: "wireframe", width: 1440, blocks: WEB_BLOCKS, themes: WIREFRAME_THEMES },
  { id: "app-design", name: "App design", platform: "app", style: "design", width: 390, blocks: APP_BLOCKS, themes: DESIGN_THEMES },
  { id: "web-design", name: "Website design", platform: "web", style: "design", width: 1440, blocks: WEB_BLOCKS, themes: DESIGN_THEMES },
];

export type LibraryChoice = KitId | "auto";
export const LIBRARY_CHOICES: readonly { id: LibraryChoice; label: string }[] = [{ id: "auto", label: "Auto" }, ...KITS.map((k) => ({ id: k.id, label: k.name }))];

export const kitById = (id: KitId): Kit => KITS.find((k) => k.id === id)!;

const WEB_WORDS = /\b(web ?site|landing|home ?page|web ?page|marketing|desktop|saas|blog|portfolio|dashboard)\b/i;
const WIRE_WORDS = /\b(wire ?frames?|low[- ]fi|lo[- ]fi|sketch)\b/i;

/** Auto: a website when the prompt speaks of one, else an app; a wireframe when it asks for one, else a design. */
export function autoKit(prompt: string): Kit {
  const web = WEB_WORDS.test(prompt);
  const wire = WIRE_WORDS.test(prompt);
  return kitById(`${web ? "web" : "app"}-${wire ? "wireframe" : "design"}` as KitId);
}

export const kitFor = (choice: LibraryChoice, prompt: string): Kit => (choice === "auto" ? autoKit(prompt) : kitById(choice));
