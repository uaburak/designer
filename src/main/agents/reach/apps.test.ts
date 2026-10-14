// Local apps (docs/agents-reach.md §9) with Electron's desktopCapturer faked: Wecra's own windows aren't offered, the
// owner's pick is the consent, Always allow lets the same window be seen again, a missing permission is said plainly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanReachSettings } from "../../../shared/agents/reach";
import type { RunContext } from "./hub";

const state = vi.hoisted(() => ({ permission: "granted", sources: [] as { id: string; name: string }[] }));
vi.mock("electron", () => {
  const image = (w: number) => ({ isEmpty: () => false, toDataURL: () => "data:image/png;base64,AA", toPNG: () => Buffer.from("png"), toJPEG: () => Buffer.from("jpg"), getSize: () => ({ width: w, height: Math.round(w / 2) }) });
  return {
    BrowserWindow: { getAllWindows: () => [{ getMediaSourceId: () => "window:1:0" }] },
    desktopCapturer: { getSources: vi.fn(async (o: { thumbnailSize: { width: number } }) => state.sources.map((s) => ({ ...s, thumbnail: image(o.thumbnailSize.width) }))) },
    systemPreferences: { getMediaAccessStatus: () => state.permission },
    shell: { openExternal: vi.fn() },
  };
});

const { appsRunner } = await import("./apps");
const ctx = (policy: "ask" | "allow", chatId = "c1"): RunContext => ({ turnId: "t", chatId, fileKey: "f", agent: "a", settings: cleanReachSettings({ policies: { apps: policy } }), policy, signal: new AbortController().signal });

beforeEach(() => {
  state.permission = "granted";
  state.sources = [
    { id: "window:1:0", name: "Wecra" },
    { id: "window:7:0", name: "Our B2C app — Simulator" },
  ];
});

describe("local apps", () => {
  it("offers other apps' windows only, captures the one picked", async () => {
    const pick = vi.fn(async (_c: RunContext, windows: { id: string; name: string }[]) => windows[0].id);
    const r = await appsRunner({ pick })("capture_app_window", {}, ctx("ask"));
    expect(pick.mock.calls[0][1].map((w) => w.name)).toEqual(["Our B2C app — Simulator"]);
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toEqual({ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" });
    expect(r.content[1]).toMatchObject({ text: expect.stringContaining("<untrusted-data") });
    expect(r.content[2]).toMatchObject({ text: expect.stringContaining("windowId: window:7:0") });
  });

  it("is refused when the owner doesn't pick; a made-up window id isn't taken", async () => {
    expect((await appsRunner({ pick: async () => null })("capture_app_window", {}, ctx("ask"))).content[0]).toMatchObject({ text: expect.stringContaining("didn't pick") });
    expect((await appsRunner({ pick: async () => "window:1:0" })("capture_app_window", {}, ctx("ask"))).isError).toBe(true);
  });

  it("sees the same window again without a card only under Always allow, in the same chat", async () => {
    const pick = vi.fn(async () => "window:7:0");
    const run = appsRunner({ pick });
    await run("capture_app_window", {}, ctx("allow"));
    await run("capture_app_window", { windowId: "window:7:0" }, ctx("allow"));
    expect(pick).toHaveBeenCalledTimes(1);
    await run("capture_app_window", { windowId: "window:7:0" }, ctx("allow", "other-chat"));
    expect(pick).toHaveBeenCalledTimes(2);
    await run("capture_app_window", { windowId: "window:7:0" }, ctx("ask"));
    expect(pick).toHaveBeenCalledTimes(3);
  });

  it("says how to give the Screen Recording permission", async () => {
    state.permission = "denied";
    const pick = vi.fn();
    const r = await appsRunner({ pick })("capture_app_window", {}, ctx("ask"));
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("Screen & System Audio Recording") });
    expect(pick).not.toHaveBeenCalled();
  });
});
