/** The two block sets (docs/ai.md §3): web and app. Descriptions and props are what the model plans with. */
import type { KitBlock } from "./types";

export const WEB_BLOCKS: readonly KitBlock[] = [
  { id: "nav", description: "Top navigation bar: brand, links, a call to action button", props: { brand: "brand name", links: "list of 3–5 link labels", cta: "button label" } },
  { id: "hero", description: "Hero: headline, supporting text, buttons, an image", props: { eyebrow: "short label above the title", title: "headline", body: "one or two sentences", primary: "primary button label", secondary: "secondary button label", image: "what the image shows" } },
  { id: "logo-row", description: "A row of customer or partner logos", props: { title: "short heading", logos: "list of 4–6 company names" } },
  { id: "feature-grid", description: "A grid of features, each with a title and text", props: { title: "section heading", body: "section intro", features: "list of 3–6 feature titles", details: "list of one-sentence descriptions, same order" } },
  { id: "stats", description: "A row of key numbers", props: { values: "list of 3–4 numbers like 98%", labels: "list of labels, same order" } },
  { id: "pricing", description: "Pricing plans side by side", props: { title: "section heading", plans: "list of 2–3 plan names", prices: "list of prices like $12/mo, same order", features: "list of 3–5 features every plan lists", cta: "button label" } },
  { id: "testimonial", description: "A customer quote with its author", props: { quote: "the quote", author: "name", role: "role and company" } },
  { id: "faq", description: "Frequently asked questions", props: { title: "section heading", questions: "list of 3–6 questions", answers: "list of short answers, same order" } },
  { id: "cta", description: "A closing call to action band", props: { title: "headline", body: "one sentence", cta: "button label" } },
  { id: "form", description: "A form: fields and a submit button", props: { title: "heading", fields: "list of field labels", submit: "button label" } },
  { id: "table", description: "A data table", props: { title: "heading", columns: "list of 3–5 column names", rows: "list of rows, each a comma-separated line of cells" } },
  { id: "footer", description: "Footer: brand, link columns, legal line", props: { brand: "brand name", links: "list of 4–8 link labels", legal: "copyright line" } },
];

export const APP_BLOCKS: readonly KitBlock[] = [
  { id: "status-bar", description: "The phone's status bar (time, signal, battery)", props: { time: "like 9:41" } },
  { id: "top-bar", description: "Screen title bar with optional back and action", props: { title: "screen title", back: "\"yes\" to show a back arrow", action: "action label at the right" } },
  { id: "search", description: "A search field", props: { placeholder: "placeholder text" } },
  { id: "chips", description: "A row of filter chips", props: { chips: "list of 3–6 chip labels", selected: "the selected chip's label" } },
  { id: "list-rows", description: "A list of rows with title, subtitle and trailing value", props: { title: "section heading", items: "list of row titles", subtitles: "list of subtitles, same order", values: "list of trailing values, same order" } },
  { id: "card", description: "A card with an image, title, text and button", props: { image: "what the image shows", title: "card title", body: "one or two sentences", cta: "button label" } },
  { id: "profile-header", description: "A profile header: avatar, name, details, stats", props: { name: "person's name", detail: "handle or role", stats: "list of 2–3 stats like 120 Posts" } },
  { id: "settings-list", description: "Grouped settings rows with switches or values", props: { title: "group heading", items: "list of setting names", values: "list of values or On / Off, same order" } },
  { id: "form-fields", description: "Labelled input fields", props: { title: "heading", fields: "list of field labels", placeholders: "list of placeholders, same order" } },
  { id: "buttons", description: "Primary and secondary buttons stacked", props: { primary: "primary label", secondary: "secondary label" } },
  { id: "empty-state", description: "An empty state: illustration, title, text, button", props: { title: "title", body: "one sentence", cta: "button label" } },
  { id: "chat", description: "A conversation of message bubbles", props: { messages: "list of 3–6 messages, alternating them and me, starting with them" } },
  { id: "checkout-summary", description: "An order summary with line items and a total", props: { items: "list of item names", prices: "list of prices, same order", total: "the total", cta: "button label" } },
  { id: "tab-bar", description: "The bottom tab bar", props: { tabs: "list of 3–5 tab labels", selected: "the selected tab's label" } },
];
