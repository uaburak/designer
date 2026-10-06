// @vitest-environment happy-dom
import { createElement, Fragment } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, type DialogProps } from "../components/Dialog";
import { Button } from "../components/Button";
import { $, click, key, mount, pointer, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
let opener: HTMLButtonElement | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  opener?.remove();
  opener = null;
});

const h = createElement;

/** A "Delete page?" dialog with a field, opened from a button that had focus. */
function setup(props: Partial<DialogProps> = {}, withField = true) {
  opener = document.createElement("button");
  opener.textContent = "Open";
  document.body.appendChild(opener);
  opener.focus();
  const onClose = spy<[]>();
  const onDelete = spy<[]>();
  const all = { title: "Delete page?", open: true, onClose, ...props } as DialogProps;
  const body = withField ? h("input", { "aria-label": "Name", defaultValue: "Archive" }) : h("p", null, "Sure?");
  const footer = h(Fragment, null, h(Button, { variant: "secondary", onClick: onClose, children: "Cancel" }), h(Button, { variant: "destructive", onClick: onDelete, children: "Delete" }));
  const render = (p: DialogProps) => h(Dialog, { ...p, footer }, body);
  m = mount(render, all);
  return { onClose, onDelete, rerender: (p: Partial<DialogProps>) => m!.rerender(render, { ...all, ...p }) };
}

const dialog = () => $('[role="dialog"]');
const tab = (shiftKey = false) => key(document.activeElement!, "Tab", { shiftKey });

describe("Dialog focus", () => {
  it("moves focus to the first field when it opens", () => {
    setup();
    expect(document.activeElement).toBe($('input[aria-label="Name"]'));
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(dialog().getAttribute("aria-labelledby")).toBe($('[role="dialog"] h2').id);
  });

  it("prefers [data-autofocus], else the panel itself when there is no field", () => {
    setup({}, false);
    expect(document.activeElement).toBe(dialog());
  });

  it("traps Tab: from the last control to the first and back with ⇧Tab", () => {
    setup();
    const close = $('[role="dialog"] [aria-label="Close"]');
    const del = [...dialog().querySelectorAll("button")].find((b) => b.textContent === "Delete")!;
    del.focus();
    tab();
    expect(document.activeElement).toBe(close);
    tab(true);
    expect(document.activeElement).toBe(del);
  });

  it("Esc closes; focus goes back to the opener when it closes", () => {
    const { onClose, rerender } = setup();
    key(document.activeElement!, "Escape");
    expect(onClose.calls).toHaveLength(1);
    rerender({ open: false });
    expect($('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Enter clicks the primary (here the destructive) button, but not from a button", () => {
    const { onDelete, onClose } = setup();
    key(document.activeElement!, "Enter");
    expect(onDelete.calls).toHaveLength(1);
    const cancel = [...dialog().querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    cancel.focus();
    key(cancel, "Enter");
    expect(onDelete.calls).toHaveLength(1);
    click(cancel);
    expect(onClose.calls).toHaveLength(1);
  });

  it("closes from the scrim only when the press lands on the scrim", () => {
    const { onClose } = setup();
    const scrim = dialog().parentElement!;
    pointer(dialog(), "pointerdown");
    expect(onClose.calls).toHaveLength(0);
    pointer(scrim, "pointerdown");
    expect(onClose.calls).toHaveLength(1);
  });

  it("keeps the scrim when closeOnScrim is false; static dialogs don't take focus", () => {
    const { onClose } = setup({ closeOnScrim: false });
    pointer(dialog().parentElement!, "pointerdown");
    expect(onClose.calls).toHaveLength(0);
    m!.unmount();
    m = null;
    opener!.focus();
    m = mount(Dialog, { title: "Static", open: true, onClose: () => {}, static: true, children: h("input", { "aria-label": "X" }) });
    expect(document.activeElement).toBe(opener);
    expect(dialog().getAttribute("aria-modal")).toBe("false");
  });
});
