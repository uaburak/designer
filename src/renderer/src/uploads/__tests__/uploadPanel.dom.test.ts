// @vitest-environment happy-dom
/**
 * The upload panel (docs/multiplayer.md §5.1): its title and rows as uploads go, are done, fail and are cancelled; Retry
 * and Cancel reach the store; collapse; close only when nothing goes; hidden 4 s after everything is done.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadEvent, UploadProgress } from "@shared/multiplayer/uploads";
import { click, mount, type Mounted } from "@/ds/__tests__/dom";
import { formatBytes, panelTitle, speedText, timeLeftText, UPLOAD_PANEL_HIDE_MS, Uploads, type UploadSource } from "../UploadPanel";

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

describe("the speed line (docs/cloud.md §4)", () => {
  it("shows the speed and the time left while a file goes, nothing before the speed is known or once done", async () => {
    const s = fakeSource();
    m = mount(Uploads, { source: s.source });
    await flush();
    s.say({ upload: up({ bytesSent: 12 * MB }) });
    expect(panel()!.querySelector("[data-upload-speed]")).toBeNull();
    s.say({ upload: up({ bytesSent: 40 * MB, bytesPerSecond: 3.2 * MB, secondsLeft: 93.75 }) });
    expect(panel()!.querySelector("[data-upload-speed]")!.textContent).toBe("3.2 MB/s · About 2 minutes left");
    s.say({ upload: up({ state: "done", bytesSent: 340 * MB }) });
    expect(panel()!.querySelector("[data-upload-speed]")).toBeNull();
  });

  it("words the time left as seconds, then about minutes and hours", () => {
    expect(timeLeftText(0.2)).toBe("1 second left");
    expect(timeLeftText(42)).toBe("42 seconds left");
    expect(timeLeftText(65)).toBe("About 1 minute left");
    expect(timeLeftText(30 * 60)).toBe("About 30 minutes left");
    expect(timeLeftText(2.4 * 3600)).toBe("About 2 hours left");
    expect(speedText({ state: "uploading", bytesPerSecond: 820_000 })).toBe("820 KB/s");
    expect(speedText({ state: "retrying", bytesPerSecond: 820_000, secondsLeft: 3 })).toBeNull();
  });
});

describe("downloads in the panel (Wecra 1.1.1, docs/cloud.md §4.1)", () => {
  const dn = (over: Partial<UploadProgress>) => up({ id: "d1", name: "Brand book", destination: "Downloading images", direction: "download", bytesTotal: 330 * MB, ...over });

  it("a “Downloading images” row per file: how far, the speed and the time left; no Cancel; hidden once done", async () => {
    vi.useFakeTimers();
    const s = fakeSource();
    m = mount(Uploads, { source: s.source });
    await flush();
    s.say({ upload: dn({ state: "queued", bytesSent: 0 }) });
    expect(text()).toContain("Downloading 1 file");
    expect(text()).toContain("Waiting to download…");
    s.say({ upload: dn({ bytesSent: 120 * MB, bytesPerSecond: 4 * MB, secondsLeft: 52.5 }) });
    expect(text()).toContain("Brand book");
    expect(text()).toContain("Downloading images");
    expect(text()).toContain("120 MB of 330 MB");
    expect(panel()!.querySelector("[data-upload-speed]")!.textContent).toBe("4 MB/s · 53 seconds left");
    expect(panel()!.getAttribute("aria-label")).toBe("Transfers");
    expect(button("Cancel upload")).toBeNull();
    // Both ways at once
    s.say({ upload: up({ id: "u2" }) });
    expect(text()).toContain("Transferring 2 files");
    s.say({ upload: up({ id: "u2", state: "done" }) });
    s.say({ upload: dn({ state: "done", bytesSent: 330 * MB }) });
    expect(panel()!.querySelector('[aria-label="Downloaded"]')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(UPLOAD_PANEL_HIDE_MS));
    expect(panel()).toBeNull();
  });

  it("a failed download offers Retry, which reaches the store", async () => {
    const s = fakeSource();
    m = mount(Uploads, { source: s.source });
    await flush();
    s.say({ upload: dn({ state: "failed", error: "3 images couldn’t download. Check your connection." }) });
    expect(text()).toContain("Download failed");
    expect(text()).toContain("3 images couldn’t download.");
    click(buttonText("Retry")!);
    await flush();
    expect(s.did).toEqual(["retry d1"]);
  });

  it("titles downloads apart from uploads", () => {
    expect(panelTitle([dn({ state: "failed" })])).toBe("Download failed");
    expect(panelTitle([dn({ state: "done" }), dn({ id: "d2", state: "done" })])).toBe("Downloaded 2 files");
    expect(panelTitle([dn({ state: "done" }), up({ state: "done" })])).toBe("Uploaded 2 files");
  });
});
