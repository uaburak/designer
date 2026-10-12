// @vitest-environment happy-dom
/**
 * The upload panel (docs/multiplayer.md §5.1): its title and rows as uploads go, are done, fail and are cancelled; Retry
 * and Cancel reach the store; collapse; close only when nothing goes; hidden 4 s after everything is done.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadEvent, UploadProgress } from "@shared/multiplayer/uploads";
import { click, mount, type Mounted } from "@/ds/__tests__/dom";
import { formatBytes, panelTitle, UPLOAD_PANEL_HIDE_MS, Uploads, type UploadSource } from "../UploadPanel";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const MB = 1_000_000;
const up = (over: Partial<UploadProgress>): UploadProgress => ({ id: "u1", fileKey: "f1", name: "Big file", destination: "Anex Tour › Design › KOC", bytesSent: 0, bytesTotal: 340 * MB, state: "uploading", startedAt: 1, retryable: true, ...over });

function fakeSource(initial: UploadProgress[] = []) {
  const listeners = new Set<(e: UploadEvent) => void>();
  const did: string[] = [];
  const source: UploadSource = {
    uploads: async () => initial,
    watchUploads: (l) => (listeners.add(l), () => listeners.delete(l)),
    retryUpload: async (id) => void did.push(`retry ${id}`),
    cancelUpload: async (id) => void did.push(`cancel ${id}`),
  };
  const say = (e: UploadEvent) => act(() => listeners.forEach((l) => l(e)));
  return { source, say, did };
}

const panel = () => document.querySelector('[data-ds="UploadPanel"]') as HTMLElement | null;
const text = () => panel()?.textContent ?? "";
const button = (label: string) => panel()?.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const buttonText = (label: string) => [...(panel()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label) ?? null;
const flush = () => act(async () => {});

describe("the upload panel", () => {
  it("shows nothing until an upload starts, then where it goes and how far along it is", async () => {
    const s = fakeSource();
    m = mount(Uploads, { source: s.source });
    await flush();
    expect(panel()).toBeNull();
    s.say({ upload: up({ state: "queued", bytesTotal: 0 }) });
    expect(text()).toContain("Uploading 1 file");
    expect(text()).toContain("Waiting to upload…");
    s.say({ upload: up({ bytesSent: 12_400_000 }) });
    expect(text()).toContain("Big file");
    expect(text()).toContain("Anex Tour › Design › KOC");
    expect(text()).toContain("12.4 MB of 340 MB");
    expect(text()).toContain("3%");
    expect(panel()!.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("3");
    // No close while it goes; Cancel (shown on hover) reaches the store
    expect(button("Close")).toBeNull();
    click(button("Cancel upload")!);
    await flush();
    expect(s.did).toEqual(["cancel u1"]);
    s.say({ upload: up({ state: "retrying", attempt: 2, bytesSent: 0 }) });
    expect(text()).toContain("Trying again (2)…");
  });

  it("counts files going, then says Uploaded with a check, and hides 4 s after all are done", async () => {
    vi.useFakeTimers();
    const s = fakeSource();
    m = mount(Uploads, { source: s.source });
    await flush();
    s.say({ upload: up({ id: "a", name: "One" }) });
    s.say({ upload: up({ id: "b", name: "Two", startedAt: 2 }) });
    expect(text()).toContain("Uploading 2 files");
    s.say({ upload: up({ id: "a", name: "One", state: "done", bytesSent: 340 * MB }) });
    expect(text()).toContain("Uploading 1 file");
    expect(panel()!.querySelectorAll('[aria-label="Uploaded"]').length).toBe(1);
    s.say({ upload: up({ id: "b", name: "Two", startedAt: 2, state: "done", bytesSent: 340 * MB }) });
    expect(text()).toContain("Uploaded 2 files");
    expect(button("Close")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(UPLOAD_PANEL_HIDE_MS - 10));
    expect(panel()).not.toBeNull();
    act(() => void vi.advanceTimersByTime(20));
    expect(panel()).toBeNull();
  });

  it("says a failure in red with Retry (none for a library publish), stays until closed", async () => {
    vi.useFakeTimers();
    const s = fakeSource();
    m = mount(Uploads, { source: s.source });
    await act(async () => {});
    s.say({ upload: up({ state: "failed", error: "The server is busy. Try again in a moment.", bytesSent: 40 * MB }) });
    expect(text()).toContain("Upload failed");
    const alert = panel()!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("The server is busy. Try again in a moment.");
    click(buttonText("Retry")!);
    await act(async () => {});
    expect(s.did).toEqual(["retry u1"]);
    act(() => void vi.advanceTimersByTime(UPLOAD_PANEL_HIDE_MS * 2));
    expect(panel()).not.toBeNull();
    s.say({ upload: up({ id: "lib", state: "failed", error: "No access", retryable: false, startedAt: 3 }) });
    expect(panel()!.querySelectorAll("button").length).toBeGreaterThan(0);
    expect([...panel()!.querySelectorAll("li")].find((li) => li.getAttribute("aria-label") === "Big file" && li.dataset.state === "failed" && li.textContent!.includes("No access"))!.textContent).not.toContain("Retry");
    click(button("Close")!);
    expect(panel()).toBeNull();
  });

  it("drops a cancelled upload, collapses to its header, and picks up uploads already going when it opens", async () => {
    const s = fakeSource([up({ id: "resumed", name: "Resumed", bytesSent: 170 * MB })]);
    m = mount(Uploads, { source: s.source, placement: "editor" });
    await flush();
    expect(text()).toContain("Resumed");
    expect(text()).toContain("50%");
    click(button("Collapse")!);
    expect(panel()!.querySelector("ul")).toBeNull();
    expect(text()).toContain("Uploading 1 file");
    click(button("Expand")!);
    expect(panel()!.querySelectorAll("li").length).toBe(1);
    s.say({ removed: "resumed" });
    expect(panel()).toBeNull();
  });
});

describe("its words", () => {
  it("sizes as macOS says them and titles by what goes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(820_000)).toBe("820 KB");
    expect(formatBytes(12_400_000)).toBe("12.4 MB");
    expect(formatBytes(340_000_000)).toBe("340 MB");
    expect(formatBytes(1_250_000_000)).toBe("1.3 GB");
    expect(panelTitle([up({}), up({ id: "2", state: "queued" })])).toBe("Uploading 2 files");
    expect(panelTitle([up({ state: "failed" }), up({ id: "2", state: "done" })])).toBe("Upload failed");
    expect(panelTitle([up({ state: "done" })])).toBe("Uploaded 1 file");
  });
});
