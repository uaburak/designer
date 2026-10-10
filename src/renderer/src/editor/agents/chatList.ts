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
