// The chats list's search, filter and sort (the list's top bar: "Search chats", the filter menu): pure, so it is tested
// without a panel. Chats are kept per file, so the filter is by agent only.
import type { Chat, ChatMessage, MessagePart } from "./service";

export type ChatSort = "recent" | "oldest";
export interface ChatFilter {
  query: string;
  /** An agent's id (Chat.providerId); null: all agents */
  agent: string | null;
  sort: ChatSort;
}
export const NO_FILTER: ChatFilter = { query: "", agent: null, sort: "recent" };

/** A message's words: the prompt, or the answer's text parts (else its error). */
export function messageText(m: ChatMessage): string {
  if (m.role === "user") return m.text ?? "";
  const parts = (m.parts ?? []).filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("");
  return parts || m.text || m.error || "";
}

/** The newest message holding the query, cut around it: where to read the match in context. */
export function matchSnippet(chat: Chat, query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const m of [...chat.messages].reverse()) {
    const t = messageText(m);
    const at = t.toLowerCase().indexOf(q);
    if (at < 0) continue;
    const from = Math.max(0, at - 30);
    return `${from > 0 ? "…" : ""}${t.slice(from, from + 120).replace(/\s+/g, " ")}`;
  }
  return null;
}

/** The chats the filter lets through, in its order (every word of the query is found in the title or a message). */
export function filterChats(chats: Chat[], f: ChatFilter): Chat[] {
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out = chats.filter((c) => {
    if (f.agent && c.providerId !== f.agent) return false;
    if (!words.length) return true;
    const hay = `${c.title}\n${c.messages.map(messageText).join("\n")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return out.sort((a, b) => (f.sort === "oldest" ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
}

/** `text` cut at the query's matches: [text, matched, text, matched…] (the odd ones are matches). */
export function splitMatches(text: string, query: string): string[] {
  const words = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
  if (!words.length) return [text];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re);
}

// ---- A chat's short title and status line (the list's rows, the chat's header) ----

const TITLE_WORDS = 4;
const TITLE_CHARS = 32;
const STATUS_CHARS = 60;
/** Openers a title doesn't need ("Can you make…" → "Make…"): English and Turkish. */
const FILLER = /^(?:(?:please|pls|can you|could you|would you|i want you to|i'd like you to|i would like you to|let's|lütfen|bana|bir)\s+)+/i;

/** A message cut to a few words for a title: "Can you make the mobile version of this login screen?" → "Make the mobile version". */
export function shortTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(FILLER, "");
  const first = flat.split(/(?<=[.!?:])\s/)[0].replace(/[.!?:,;…]+$/, "");
  let out = "";
  for (const w of first.split(" ").slice(0, TITLE_WORDS)) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > TITLE_CHARS && out) break;
    out = next;
  }
  out = out.slice(0, TITLE_CHARS).replace(/[,;:–—-]+$/, "").trim();
  return out ? out[0].toLocaleUpperCase() + out.slice(1) : "";
}

/** An answer's first sentence, ≤ 60 characters: "Four designs are ready on the canvas." */
export function shortStatus(text: string): string {
  const flat = text.replace(/[#*_`>]+/g, "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const first = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat;
  return first.length <= STATUS_CHARS ? first : `${first.slice(0, STATUS_CHARS - 1).replace(/\s+\S*$/, "")}…`;
}

/** The chat's status line as kept, else from its last answer (older chats). */
export function chatStatus(chat: Chat): string {
  if (chat.status) return chat.status;
  const last = [...chat.messages].reverse().find((m) => m.role === "assistant");
  return last ? shortStatus(messageText(last)) : "";
}
