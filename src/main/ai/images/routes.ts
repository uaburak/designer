import type { ImageRouteInfo } from "../../../shared/ai/types";
import { NANO_BANANA, NANO_BANANA_2, NANO_BANANA_PRO } from "./gemini";
import { OPENAI_IMAGE_MODEL } from "./openai";
import { t } from "../../../shared/i18n";

/**
 * The image routes and whether each can run now (`ai:image-routes`, docs/studio.md §2.4): what the chat's model choice
 * card and Settings › AI offer. The Nano Banana ids are Google's (ai.google.dev/gemini-api/docs/models, checked
 * 2026-10-13); the views never hard-code them.
 */

/** First is the default: Pro for products with labels (docs/studio.md §2.4). */
const NANO_BANANAS: ImageRouteInfo["models"] = [
  { id: NANO_BANANA_PRO, label: "Nano Banana Pro", detail: "The best text and detail, for labelled products" },
  { id: NANO_BANANA_2, label: "Nano Banana 2", detail: "Quick and cheaper" },
  { id: NANO_BANANA, label: "Nano Banana", detail: "Quick, with a free API tier" },
];

export interface ImageRouteDeps {
  imageKey(provider: "openai" | "gemini"): string | null;
  agyPath(): string | null;
  geminiPath(): string | null;
  /** The nanobanana extension is installed for the Gemini CLI (~/.gemini/extensions/nanobanana) */
  nanobanana(): boolean;
}

export function imageRoutes(d: ImageRouteDeps): ImageRouteInfo[] {
  const gemini = !!d.imageKey("gemini");
  const cli = d.geminiPath();
  const nano = !!cli && d.nanobanana();
  return [
    {
      providerId: "gemini-images",
      label: "Gemini API",
      models: NANO_BANANAS,
      available: gemini,
      ...(gemini ? {} : { reason: t("Add a Gemini API key in Settings › AI") }),
      references: true,
    },
    {
      providerId: "gemini-cli",
      label: "Gemini CLI",
      // The extension's tools take one input picture (geminiCli.ts)
      models: NANO_BANANAS,
      available: nano,
      ...(!cli ? { reason: t("Install the Gemini CLI") } : !nano ? { reason: t("Install the nanobanana extension: {command}", { command: "gemini extensions install https://github.com/gemini-cli-extensions/nanobanana" }) } : {}),
      references: true,
    },
    {
      providerId: "antigravity",
      label: "Antigravity",
      models: [],
      available: !!d.agyPath(),
      ...(d.agyPath() ? {} : { reason: t("Set up Antigravity in Settings › Agents") }),
      references: true,
    },
    {
      providerId: "openai-images",
      label: "OpenAI Images",
      models: [{ id: OPENAI_IMAGE_MODEL, label: "GPT Image 1" }],
      available: !!d.imageKey("openai"),
      ...(d.imageKey("openai") ? {} : { reason: t("Add an OpenAI API key in Settings › AI") }),
      references: true,
    },
  ];
}
