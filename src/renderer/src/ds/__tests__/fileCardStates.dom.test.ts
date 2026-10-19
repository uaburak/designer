// @vitest-environment happy-dom
// Home's file card as the owner designed it (2026-10-19, docs/research/figma/live/owner-2026-10-19:
// owner-home-drafts-design.txt "FileCard", owner-home-card-states.webp): 260 × 208 (5:4), radius 9, the thumbnail
// over a 60 high footer with the name and its date only, the star box always at the thumbnail's top right; at rest a
// 1px border ring, on hover a 2px card-border-hover ring, selected a 2px border-selected ring — inside strokes drawn
// over the content, so nothing moves between the states.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FileCard, type FileCardProps } from "../components/FileCard";
import { renderTokensCss } from "../tokensCss";
import { $, click, mount, spy, type Mounted } from "./dom";

const css = readFileSync(join(__dirname, "../components/FileCard.module.css"), "utf8");
/** A rule's declarations, by its selector as written */
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return "";
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
};

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

function card(props: Partial<FileCardProps> = {}) {
  m = mount((p: FileCardProps) => h(FileCard, p), { id: "f1", title: "Portfolio", subtitle: "Edited 34 minutes ago", onStar: () => {}, ...props });
  return $('[data-ds="FileCard"]');
}

describe("FileCard states (the owner's design)", () => {
  it("at rest: the name over its date in the footer, no kind badge; the star box at the top right", () => {
    const el = card();
    expect(el.getAttribute("aria-selected")).toBe("false");
    expect(el.hasAttribute("data-hover")).toBe(false);
    const footer = el.querySelector("[class*='footer']")!;
    expect(footer.textContent).toBe("PortfolioEdited 34 minutes ago");
    expect(footer.querySelector('[data-ds="FileKindIcon"]')).toBeNull();
    const star = el.querySelector("[class*='star'] button")!;
    expect(star.getAttribute("aria-label")).toBe("Star");
  });

  it("hover and selected are the card's own states", () => {
    expect(card({ forceHover: true }).hasAttribute("data-hover")).toBe(true);
    m?.unmount();
    expect(card({ selected: true }).getAttribute("aria-selected")).toBe("true");
  });

  it("the star toggles without selecting the card", () => {
    const onStar = spy<[boolean]>();
    const onSelect = spy<[unknown]>();
    const el = card({ onStar: (on) => onStar(on), onSelect: (e) => onSelect(e), starred: false });
    click(el.querySelector("[class*='star'] button")!);
    expect(onStar.calls).toEqual([[true]]);
    expect(onSelect.calls.length).toBe(0);
  });

  it("is drawn as designed: 5:4, radius 9, 1px ring at rest, 2px grey on hover, 2px blue selected; a 60 footer", () => {
    expect(rule(".card")).toMatch(/aspect-ratio: 5 \/ 4/);
    expect(rule(".card")).toMatch(/border-radius: var\(--ds-radius-medium-large\)/);
    expect(rule(".card::after")).toMatch(/border: 1px solid var\(--figma-color-border\)/);
    expect(rule(".card:hover::after, .card[data-hover]::after")).toMatch(/border-width: 2px; border-color: var\(--ds-color-card-border-hover\)/);
    expect(rule('.card[aria-selected="true"]::after')).toMatch(/border-width: 2px; border-color: var\(--figma-color-border-selected\)/);
    expect(rule(".star")).toMatch(/top: var\(--ds-space-1-5\); right: var\(--ds-space-1-5\)/);
    expect(rule(".footer")).toMatch(/height: var\(--ds-size-card-footer\)/);
    expect(renderTokensCss()).toMatch(/--ds-size-card-width: 260px/);
    expect(renderTokensCss()).toMatch(/--ds-size-card-footer: 60px/);
    expect(renderTokensCss()).toMatch(/--ds-radius-medium-large: 9px/);
  });
});
