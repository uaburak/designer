/**
 * Four themes per style (docs/ai.md §3: colours light / dark, radius, spacing, title / body / label fonts). Ours: neutral
 * greys for wireframes, four palettes for designs; every face is Inter or a Google Fonts family under the OFL.
 */
import type { KitFont, KitPalette, KitTheme } from "./types";

const inter = (style: string): KitFont => ({ family: "Inter", style });

const grey = (o: Partial<KitPalette> = {}): KitPalette => ({ background: "#FFFFFF", surface: "#F2F2F2", text: "#1E1E1E", muted: "#757575", primary: "#2C2C2C", onPrimary: "#FFFFFF", border: "#D9D9D9", placeholder: "#E3E3E3", ...o });
const greyDark = (o: Partial<KitPalette> = {}): KitPalette => ({ background: "#1E1E1E", surface: "#2C2C2C", text: "#F5F5F5", muted: "#A0A0A0", primary: "#F5F5F5", onPrimary: "#1E1E1E", border: "#444444", placeholder: "#383838", ...o });

export const WIREFRAME_THEMES: readonly KitTheme[] = [
  { id: "plain", name: "Plain", light: grey(), dark: greyDark(), radius: 8, spacing: 8, fonts: { title: inter("Bold"), body: inter("Regular"), label: inter("Medium") } },
  { id: "rounded", name: "Rounded", light: grey({ surface: "#F5F5F5" }), dark: greyDark(), radius: 16, spacing: 8, fonts: { title: inter("Semi Bold"), body: inter("Regular"), label: inter("Medium") } },
  { id: "sharp", name: "Sharp", light: grey({ border: "#B3B3B3" }), dark: greyDark({ border: "#5C5C5C" }), radius: 0, spacing: 8, fonts: { title: inter("Bold"), body: inter("Regular"), label: inter("Semi Bold") } },
  { id: "airy", name: "Airy", light: grey({ surface: "#F7F7F7" }), dark: greyDark(), radius: 12, spacing: 12, fonts: { title: inter("Medium"), body: inter("Regular"), label: inter("Medium") } },
];

const palette = (primary: string, o: Partial<KitPalette> = {}): KitPalette => ({ background: "#FFFFFF", surface: "#F5F5F7", text: "#141414", muted: "#6B6B76", primary, onPrimary: "#FFFFFF", border: "#E3E3E8", placeholder: "#E8E8EE", ...o });
const paletteDark = (primary: string, o: Partial<KitPalette> = {}): KitPalette => ({ background: "#111114", surface: "#1C1C21", text: "#F5F5F7", muted: "#9A9AA5", primary, onPrimary: "#FFFFFF", border: "#2E2E36", placeholder: "#2A2A31", ...o });

export const DESIGN_THEMES: readonly KitTheme[] = [
  { id: "indigo", name: "Indigo", light: palette("#4F46E5"), dark: paletteDark("#818CF8", { onPrimary: "#111114" }), radius: 10, spacing: 8, fonts: { title: inter("Bold"), body: inter("Regular"), label: inter("Semi Bold") } },
  { id: "forest", name: "Forest", light: palette("#14804A", { surface: "#F2F7F3" }), dark: paletteDark("#3DD68C", { onPrimary: "#0B1F14" }), radius: 6, spacing: 8, fonts: { title: { family: "Lora", style: "Bold" }, body: inter("Regular"), label: inter("Medium") } },
  { id: "sunset", name: "Sunset", light: palette("#E5532D", { surface: "#FFF4EE" }), dark: paletteDark("#FF8A65", { onPrimary: "#1A0B05" }), radius: 20, spacing: 8, fonts: { title: { family: "DM Sans", style: "Bold" }, body: { family: "DM Sans", style: "Regular" }, label: { family: "DM Sans", style: "Medium" } } },
  { id: "mono", name: "Mono", light: palette("#141414", { surface: "#F4F4F4" }), dark: paletteDark("#FAFAFA", { onPrimary: "#111114" }), radius: 2, spacing: 10, fonts: { title: { family: "Space Grotesk", style: "Bold" }, body: inter("Regular"), label: { family: "Space Grotesk", style: "Medium" } } },
];

/** The Make changes › Color presets (the primary colour) [ours] */
export const COLOR_PRESETS: readonly { name: string; color: string }[] = [
  { name: "Indigo", color: "#4F46E5" },
  { name: "Blue", color: "#0D99FF" },
  { name: "Green", color: "#14804A" },
  { name: "Orange", color: "#E5532D" },
  { name: "Pink", color: "#D6336C" },
  { name: "Black", color: "#141414" },
];

/** The Make changes › Typography families (Inter and OFL Google Fonts) */
export const FONT_CHOICES: readonly string[] = ["Inter", "DM Sans", "Space Grotesk", "Lora", "Roboto"];
