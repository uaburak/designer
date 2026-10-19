// @vitest-environment happy-dom
// Agent settings' building blocks (comparison 2026-10-18, Group 4): a path is read whole however narrow the page — the
// home folder as "~", the middle cut, never its last part, the full path in its tooltip; a row keeps its state.
import { describe, expect, it } from "vitest";
import { mount } from "@/ds/__tests__/dom";
import { PathText, Row } from "../panels/agents/settingsParts";

describe("Agent settings parts", () => {
  it("PathText: ~ for the home folder, the last part apart from the head, the whole path in the tooltip", () => {
    const view = mount(PathText, { path: "/Users/you/.local/bin/agy" });
    const el = document.querySelector<HTMLElement>("[data-path]")!;
    expect([...el.children].map((c) => c.textContent)).toEqual(["~/.local/bin", "/agy"]);
    expect(el.getAttribute("data-tooltip")).toBe("/Users/you/.local/bin/agy");
    view.unmount();
  });

  it("PathText: a path of one part is its tail alone", () => {
    const view = mount(PathText, { path: "agy" });
    expect([...document.querySelector("[data-path]")!.children].map((c) => c.textContent)).toEqual(["agy"]);
    view.unmount();
  });

  it("Row: the name and the state are apart (the name gives way, the state stays)", () => {
    const view = mount(Row, { icon: "16.chevron.right", label: "Antigravity (Google AI)", status: "Connected", on: true, onClick: () => {}, statusProps: { "data-provider-state": "" } });
    expect(document.querySelector("[data-provider-state]")!.textContent).toBe("Connected");
    expect(document.querySelector("button")!.textContent).toContain("Antigravity (Google AI)");
    view.unmount();
  });
});
