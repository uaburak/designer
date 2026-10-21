// The chats list's top bar and composer (r17-agents-list, the owner's 81 / 82.png): search by title and message text,
// the filter menu's agent and sort, and the composer sticky at the bottom with the list fading into the panel.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Chat } from "../agents/service";
import { NO_FILTER, chatStatus, filterChats, matchSnippet, shortStatus, shortTitle, splitMatches } from "../agents/chatList";

const chat = (id: string, title: string, updatedAt: number, providerId: string | null, texts: string[] = []): Chat => ({
  id,
  title,
  updatedAt,
  providerId,
  messages: texts.map((t, i) => (i % 2 === 0 ? { id: `${id}u${i}`, role: "user" as const, text: t } : { id: `${id}a${i}`, role: "assistant" as const, parts: [{ kind: "text" as const, id: `p${i}`, text: t }] })),
});
const chats = [
  chat("a", "Login screen", 300, "claude-code", ["Design a login screen", "Here is a login with a green button"]),
  chat("b", "Rename layers", 100, "antigravity", ["Rename these layers", "Renamed 12 layers"]),
  chat("c", "Pricing page", 200, "claude-code", ["Make a pricing table", "Done: three plans"]),
];

describe("filterChats", () => {
  it("lists by recency, or oldest first", () => {
    expect(filterChats(chats, NO_FILTER).map((c) => c.id)).toEqual(["a", "c", "b"]);
    expect(filterChats(chats, { ...NO_FILTER, sort: "oldest" }).map((c) => c.id)).toEqual(["b", "c", "a"]);
  });
  it("searches the title and every message's text, all words, ignoring case", () => {
    expect(filterChats(chats, { ...NO_FILTER, query: "LOGIN" }).map((c) => c.id)).toEqual(["a"]);
    expect(filterChats(chats, { ...NO_FILTER, query: "three plans" }).map((c) => c.id)).toEqual(["c"]);
    expect(filterChats(chats, { ...NO_FILTER, query: "green rename" })).toEqual([]);
    expect(filterChats(chats, { ...NO_FILTER, query: "  " })).toHaveLength(3);
  });
  it("filters by agent, together with the query", () => {
    expect(filterChats(chats, { ...NO_FILTER, agent: "claude-code" }).map((c) => c.id)).toEqual(["a", "c"]);
    expect(filterChats(chats, { ...NO_FILTER, agent: "claude-code", query: "table" }).map((c) => c.id)).toEqual(["c"]);
  });
  it("shows where a message matched, and cuts the text at the matches", () => {
    expect(matchSnippet(chats[0], "green")).toContain("green button");
    expect(matchSnippet(chats[0], "nothing here")).toBeNull();
    expect(splitMatches("Make a login, Login!", "login")).toEqual(["Make a ", "login", ", ", "Login", "!"]);
    expect(splitMatches("a.b", "a.b")).toEqual(["", "a.b", ""]);
  });
});

describe("the chats list's layout", () => {
  const dir = join(__dirname, "../panels/agents");
  const css = readFileSync(join(dir, "Agents.module.css"), "utf8");
  const tsx = readFileSync(join(dir, "AgentsPanel.tsx"), "utf8");
  it("has the composer sticky under the list, with a gradient fade above it", () => {
    expect(css).toMatch(/\.listFoot \{[^}]*flex: none;[^}]*background: var\(--figma-color-bg\)/);
    expect(css).toMatch(/\.listFoot::before \{[^}]*bottom: 100%;[^}]*linear-gradient\(to bottom, transparent, var\(--figma-color-bg\)\)[^}]*pointer-events: none/);
  });
  it("puts the search, the filter menu and the more menu on top, the composer (no chat) at the bottom", () => {
    const list = tsx.slice(tsx.indexOf("function ChatList("), tsx.indexOf("function Highlighted("));
    expect(list).toContain('placeholder={t("Search chats")}');
    expect(list).toContain('label={t("Filter chats")}');
    expect(list).toContain('label={t("More")}');
    expect(list).toContain("Delete all chats…");
    expect(list).toContain("<Composer service={service} chat={null}");
    expect(list.indexOf("Search chats")).toBeLessThan(list.indexOf("<Composer"));
  });
});

describe("a chat's short title and status line", () => {
  it("cuts the first message to a few words, without the polite opener", () => {
    expect(shortTitle("Can you make the mobile version of this login screen?")).toBe("Make the mobile version");
    expect(shortTitle("please redesign the agent panel. It is too busy")).toBe("Redesign the agent panel");
    expect(shortTitle("  ")).toBe("");
  });
  it("takes the answer's first sentence, at most 60 characters", () => {
    expect(shortStatus("Four designs are ready on the canvas. I used auto layout.")).toBe("Four designs are ready on the canvas.");
    const long = shortStatus("I finished the remaining screens of the onboarding flow and the settings with dark mode");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });
  it("reads the kept status, else the last answer's", () => {
    expect(chatStatus(chats[2])).toBe("Done: three plans");
    expect(chatStatus({ ...chats[2], status: "Kept." })).toBe("Kept.");
  });
});
