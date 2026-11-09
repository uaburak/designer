// @vitest-environment happy-dom
/**
 * The manager's choice card (ask_choice): when none of the options fits, the owner writes his own answer under them —
 * Enter or Send answers the card with {text}; Shift+Enter is a new line; an empty field sends nothing. The image-model
 * card ("Use this for this chat") has no field. Owner's request, 2026-11-07.
 */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { $, click, key, mount } from "@/ds/__tests__/dom";
import { ManagerCard } from "../panels/agents/StudioCards";
import type { AgentsService } from "../agents/service";
import type { ViewCard } from "../agents/managerTools";

const card = (extra: Partial<Extract<ViewCard, { kind: "choice" }>> = {}): ViewCard =>
  ({ kind: "choice", id: "c1", question: "3 post hangi ürünler için olsun?", options: [{ id: "hib", label: "Stoller HIB serisi" }, { id: "hm", label: "Harvest More serisi" }], ...extra }) as ViewCard;

function fakeService() {
  const answerCard = vi.fn();
  return { service: { cardOpen: () => true, answerCard, currentChat: () => null, get: () => ({ running: {} }) } as unknown as AgentsService, answerCard };
}

function write(el: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("choice card: the owner's own answer", () => {
  it("Send and Enter answer the card with the typed text", () => {
    const { service, answerCard } = fakeService();
    const m = mount(ManagerCard, { card: card(), service });
    const field = $("[data-choice-own]", m.host) as HTMLTextAreaElement;
    expect(field).toBeTruthy();
    click($("[data-choice-send]", m.host));
    expect(answerCard).not.toHaveBeenCalled();
    write(field, "  Algrow, B-Hold ve Maxtech  ");
    key(field, "Enter", { shiftKey: true });
    expect(answerCard).not.toHaveBeenCalled();
    key(field, "Enter");
    expect(answerCard).toHaveBeenCalledWith("c1", { text: "Algrow, B-Hold ve Maxtech" });
    m.unmount();
  });

  it("an answered card shows what was written; the image-model card has no field", () => {
    const { service } = fakeService();
    const answered = mount(ManagerCard, { card: card({ answer: { text: "Algrow ve B-Hold" } }), service: { ...service, cardOpen: () => false } as unknown as AgentsService });
    expect(answered.host.textContent).toContain("Algrow ve B-Hold");
    expect($("[data-choice-own]", answered.host)).toBeNull();
    answered.unmount();
    const image = mount(ManagerCard, { card: card({ remember: true }), service });
    expect($("[data-choice-own]", image.host)).toBeNull();
    image.unmount();
  });
});
