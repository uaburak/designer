// @vitest-environment happy-dom
// Figma's visual bells (docs/research/atlas/02-editor-chrome.md §7): one at a time, first in first out; 3 s, 6 s over
// 25 characters, 10 s with a button, errors until dismissed; halved for each one waiting; a repeat counts up.
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastHost, dismissToast, showToast, toastDuration } from "../components/Toast";
import { mount, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  act(() => {
    for (let i = 0; i < 20; i++) dismissToast();
  });
  m?.unmount();
  m = null;
  vi.useRealTimers();
});

const shown = () => document.querySelector('[data-ds="Toast"] span:not([data-toast-count])')?.textContent ?? null;
const count = () => document.querySelector("[data-toast-count]")?.textContent ?? null;
const Host = () => createElement(ToastHost);

describe("toast durations", () => {
  it("follows Figma's rule", () => {
    expect(toastDuration({ message: "Copied link" })).toBe(3000);
    expect(toastDuration({ message: "A message that runs past twenty-five characters" })).toBe(6000);
    expect(toastDuration({ message: "Moved", action: { label: "Undo", onAction: () => {} } })).toBe(10000);
    expect(toastDuration({ message: "Couldn't save", kind: "error" })).toBe(Infinity);
    expect(toastDuration({ message: "Saved", duration: 5000 })).toBe(5000);
    expect(toastDuration({ message: "Saved", duration: 0 })).toBe(Infinity);
  });

  it("halves a suggested time for each toast waiting behind it, not an exact one", () => {
    expect(toastDuration({ message: "Copied link" }, 2)).toBe(1500);
    expect(toastDuration({ message: "Copied link" }, 3)).toBe(750);
    expect(toastDuration({ message: "Copied link", timeoutType: "exact" }, 3)).toBe(3000);
  });
});

describe("the toast queue", () => {
  it("shows one at a time, in order", () => {
    vi.useFakeTimers();
    m = mount(Host, {});
    act(() => {
      showToast({ message: "First" });
      showToast({ message: "Second" });
    });
    expect(shown()).toBe("First");
    // Two queued: the first's 3 s halved.
    act(() => vi.advanceTimersByTime(1500));
    expect(shown()).toBe("Second");
    act(() => vi.advanceTimersByTime(3000));
    expect(shown()).toBeNull();
  });

  it("counts a repeat instead of queueing it twice", () => {
    vi.useFakeTimers();
    m = mount(Host, {});
    let a = 0;
    let b = 0;
    act(() => {
      a = showToast({ message: "Copied" });
      b = showToast({ message: "Copied" });
    });
    expect(b).toBe(a);
    expect(count()).toBe("2");
  });

  it("shows a delayed toast only after its delay, and drops it when dismissed before", () => {
    vi.useFakeTimers();
    m = mount(Host, {});
    let id = 0;
    act(() => {
      id = showToast({ message: "Later", delay: 500 });
    });
    expect(shown()).toBeNull();
    act(() => vi.advanceTimersByTime(500));
    expect(shown()).toBe("Later");
    act(() => {
      dismissToast(id);
      id = showToast({ message: "Never", delay: 500 });
      dismissToast(id);
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(shown()).toBeNull();
  });

  it("keeps an error until it is dismissed, with a ×", () => {
    vi.useFakeTimers();
    m = mount(Host, {});
    act(() => {
      showToast({ message: "Couldn't save", kind: "error" });
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(shown()).toBe("Couldn't save");
    const close = document.querySelector<HTMLButtonElement>('[data-ds="Toast"] [data-ds="IconButton"]');
    expect(close).not.toBeNull();
    act(() => close!.click());
    expect(shown()).toBeNull();
  });
});
