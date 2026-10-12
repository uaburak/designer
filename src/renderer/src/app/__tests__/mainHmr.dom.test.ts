// @vitest-environment happy-dom
// The entry is safe to run again on the same page (a hot update reaching it): it renders into the root it made, where
// a second createRoot on the container used to throw ("createRoot() on a container that has already been passed").
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/files/FilesApp", () => ({ default: () => "Home" }));

afterEach(() => {
  document.getElementById("root")?.remove();
});

describe("main.tsx", () => {
  it("re-running reuses the root", async () => {
    const container = document.createElement("div");
    container.id = "root";
    document.body.appendChild(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      await import("../../main");
    });
    const first = (container as unknown as { __designerRoot?: unknown }).__designerRoot;
    expect(first).toBeDefined();
    vi.resetModules();
    await act(async () => {
      await import("../../main");
    });
    expect((container as unknown as { __designerRoot?: unknown }).__designerRoot).toBe(first);
    await vi.waitFor(() => expect(container.textContent).toBe("Home"));
    expect(errors.mock.calls.flat().join(" ")).not.toContain("already been passed");
    errors.mockRestore();
    await act(async () => (first as { unmount(): void }).unmount());
  });
});
