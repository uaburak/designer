// @vitest-environment happy-dom
// A design's status reads the same everywhere (2026-10-12): the owner's label and dot in Dev Mode's left list, the
// Inspect header, developer previews, the Ready for dev cards and focus view; Figma's "Changed" is a yellow marker
// beside Ready to Dev, not instead of its label and green dot.
import { afterEach, describe, expect, it } from "vitest";
import { StatusTag } from "../devmode/StatusTag";
import { FRAME_STATUS_COLOR, statusShown } from "../workflowStatus";
import { mount, type Mounted } from "../../ds/__tests__/dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("status tags", () => {
  it("show the owner's label; Changed only beside Ready to Dev", () => {
    expect(statusShown("ready-to-dev", "CHANGED")).toEqual({ label: "Ready to Dev", color: FRAME_STATUS_COLOR["ready-to-dev"], changed: true });
    expect(statusShown("ready-to-dev", "READY_FOR_DEV").changed).toBe(false);
    expect(statusShown("done", "CHANGED")).toMatchObject({ label: "Done", changed: false });
    expect(statusShown("process", null)).toMatchObject({ label: "Process", changed: false });
  });

  it("a dot tag (lists, cards): the label with its dot, then the Changed marker", () => {
    m = mount(StatusTag, { workflow: "ready-to-dev", dev: "CHANGED", variant: "dot" });
    const tag = m.host.querySelector('[data-status="ready-to-dev"]')!;
    expect(tag.textContent).toBe("Ready to DevChanged");
    expect((tag.querySelector("[aria-hidden]") as HTMLElement).style.background).toBe(FRAME_STATUS_COLOR["ready-to-dev"]);
    expect(tag.querySelector("[data-status-changed]")?.textContent).toBe("Changed");
  });

  it("a chip (Inspect, focus view) is the owner's label; no 'Ready for dev' / 'Completed'", () => {
    m = mount(StatusTag, { workflow: "done", dev: "COMPLETED", variant: "chip" });
    expect(m.host.textContent).toBe("Done");
    m.rerender(StatusTag, { workflow: "ready-to-dev", dev: "READY_FOR_DEV", variant: "chip", onClick: () => {} });
    expect(m.host.querySelector("button[data-status-chip]")?.textContent).toBe("Ready to Dev");
    expect(m.host.querySelector("[data-status-changed]")).toBeNull();
  });
});
